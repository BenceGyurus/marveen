import { query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execSync, spawn } from 'node:child_process'
import { PROJECT_ROOT } from './config.js'
import {
  getCliTypeForModel,
  resolveCliBinary,
  resolveConfiguredMainCliType,
  resolveConfiguredMainModel,
  stripCliModelPrefix,
  type CliType,
} from './cli-detector.js'

const TYPING_REFRESH_MS = 4000
import { logger } from './logger.js'
import { isFleetFrozen } from './web/fleet-freeze.js'
import { neutralizeAtMentions } from './web/pane-text.js'

const AGENT_TIMEOUT_MS = Number(process.env.MARVEEN_AGENT_TIMEOUT_MS) || 20 * 60 * 1000

// When runAgent is called for pure text generation (CLAUDE.md / SOUL.md /
// skill-md / prompt expansion / memory categorization), the model must not
// Write the file itself -- otherwise it sometimes does, then returns a short
// "Kész, létrehoztam" status instead of the markdown content, silently
// corrupting the target file the caller goes on to write.
const DEFAULT_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task']

// Result-event classification (issue #209). A usage-policy (AUP) block, an API
// error, or a max-turns/budget abort must NOT be propagated as if it were the
// generated content: the SDK can surface the block message in `result`, and a
// caller (generateClaudeMd / generateSoulMd / categorizeMemory, ...) would then
// write that block text straight into CLAUDE.md / SOUL.md, silently corrupting
// the file. We treat a result as USABLE only when it is a clean success
// (subtype 'success', is_error false, no api_error_status); anything else
// returns text=null -- so the callers' existing `if (!text) throw` guard fires
// -- plus a reason string for logging and an explicit caller signal.
//
// Scope note: we deliberately do NOT text-match soft model refusals ("I can't
// help with that") -- that is fragile and would false-positive on legitimate
// generated content. Hard safety/AUP blocks surface structurally via is_error /
// api_error_status / a non-success subtype, which is what we key on.
export interface AgentResultClassification {
  text: string | null
  blocked: boolean
  reason?: string
}

export function classifyAgentResult(event: {
  subtype?: string
  is_error?: boolean
  api_error_status?: number | null
  result?: unknown
  errors?: string[]
  stop_reason?: string | null
}): AgentResultClassification {
  const subtype = event.subtype
  const apiErr = event.api_error_status ?? null
  const isError = event.is_error === true
  if (subtype === 'success' && !isError && apiErr == null) {
    return { text: typeof event.result === 'string' ? event.result : null, blocked: false }
  }
  const bits: string[] = []
  if (subtype && subtype !== 'success') bits.push(`subtype=${subtype}`)
  if (isError) bits.push('is_error=true')
  if (apiErr != null) bits.push(`api_error_status=${apiErr}`)
  if (event.stop_reason) bits.push(`stop_reason=${event.stop_reason}`)
  if (Array.isArray(event.errors) && event.errors.length) {
    bits.push(`errors=${event.errors.slice(0, 3).join('; ').slice(0, 300)}`)
  }
  // A snippet of any policy/refusal text -- for the LOG only, never returned as content.
  if (typeof event.result === 'string' && event.result.trim()) {
    bits.push(`resultSnippet=${event.result.trim().slice(0, 200)}`)
  }
  return { text: null, blocked: true, reason: bits.join(' ') || 'unknown error result' }
}

// The bundled SDK's runtime libc detection picks the linux-x64-musl variant
// even on glibc Ubuntu/Debian/RHEL hosts, so its native binary fails to
// spawn ("ld-musl-* not found"). We pick the right subpackage ourselves and
// forward its absolute path through pathToClaudeCodeExecutable.
function detectLinuxLibc(): 'glibc' | 'musl' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown'
  try {
    const out = execSync('ldd --version 2>&1', { encoding: 'utf-8' })
    return /musl/i.test(out) ? 'musl' : 'glibc'
  } catch {
    return 'unknown'
  }
}

let cachedClaudeCodeBin: string | undefined | null = null
function resolveClaudeCodeBin(): string | undefined {
  // Return the cache only while it still points at a real file. A bare
  // `!== null` check memoised the resolution forever, so a node_modules
  // reinstall/rebuild under a long-lived process could leave a stale path (the
  // same staleness class makeLazyBinResolver guards against). Re-validate with
  // existsSync each call; anything else re-resolves (also self-heals the "bin
  // appeared later" case).
  if (typeof cachedClaudeCodeBin === 'string' && existsSync(cachedClaudeCodeBin)) {
    return cachedClaudeCodeBin
  }
  if (process.env.CLAUDE_CODE_BIN) {
    cachedClaudeCodeBin = process.env.CLAUDE_CODE_BIN
    return cachedClaudeCodeBin
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    cachedClaudeCodeBin = undefined
    return undefined
  }
  const libc = detectLinuxLibc()
  if (libc === 'unknown') {
    cachedClaudeCodeBin = undefined
    return undefined
  }
  const variant = libc === 'musl' ? 'linux-x64-musl' : 'linux-x64'
  const bin = join(
    PROJECT_ROOT, 'node_modules', '@anthropic-ai',
    `claude-agent-sdk-${variant}`, 'claude',
  )
  cachedClaudeCodeBin = existsSync(bin) ? bin : undefined
  return cachedClaudeCodeBin
}

// Backend selector (jun.15 subscription migration). 'worker' (default) routes
// to a persistent INTERACTIVE Claude Code session in tmux (subscription login);
// 'sdk' keeps the legacy Agent SDK `query` path (API billing) as an emergency
// rollback via MARVEEN_AGENT_BACKEND=sdk.
function agentBackend(): 'worker' | 'sdk' {
  return (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() === 'sdk' ? 'sdk' : 'worker'
}

export interface RunAgentOpts {
  // Per-call budget override (both backends). The global default is 20min --
  // far too generous to let a wedged 2-sentence generation hold the single
  // serialized worker away from heartbeats/digests/scaffolds.
  timeoutMs?: number
  // On timeout, return { text: null, error: 'timeout...' } instead of the
  // human-facing apology TEXT the SDK path historically produced. Callers
  // that CACHE or PERSIST the result (capability summaries) must set this:
  // the apology would otherwise be stored as if it were generated content.
  timeoutAsError?: boolean
  // Optional target model / CLI hint so non-Claude agents and orchestrators
  // can run headless text generation with their configured runtime.
  model?: string
  cliType?: CliType
}

export interface NonClaudeRunResult {
  text: string | null
  error?: string
}

/**
 * Execute a one-shot headless prompt via a non-Claude CLI (`codex` or `agy`).
 * Strips Claude auth env vars and cleans up temporary output files safely.
 */
export async function runViaNonClaudeCli(
  cliType: 'codex' | 'agy',
  prompt: string,
  opts: {
    cwd?: string
    model?: string
    timeoutMs?: number
    env?: Record<string, string | undefined>
    onTyping?: () => void
    binPath?: string | null
  } = {},
): Promise<NonClaudeRunResult> {
  const bin = opts.binPath !== undefined ? opts.binPath : resolveCliBinary(cliType)
  if (!bin) {
    return { text: null, error: `${cliType} CLI binary not found` }
  }

  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : PROJECT_ROOT
  const cleanModel = opts.model ? stripCliModelPrefix(opts.model) : ''
  const tmpOut = cliType === 'codex' ? join(tmpdir(), `marveen-codex-${randomUUID()}.out`) : null

  const args = cliType === 'codex'
    ? [
        'exec',
        '--skip-git-repo-check',
        '--sandbox', 'read-only',
        '--color', 'never',
        ...(cleanModel ? ['-m', cleanModel] : []),
        ...(tmpOut ? ['--output-last-message', tmpOut] : []),
        '-',
      ]
    : [
        '-p', prompt,
        '--output-format', 'text',
        '--dangerously-skip-permissions',
        ...(cleanModel ? ['--model', cleanModel] : []),
      ]

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    ...(process.getuid?.() === 0 && !process.env.IS_SANDBOX ? { IS_SANDBOX: '1' } : {}),
    ...(opts.env ?? {}),
  }
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
  delete childEnv.ANTHROPIC_API_KEY

  const typingInterval = opts.onTyping ? setInterval(opts.onTyping, TYPING_REFRESH_MS) : undefined

  try {
    return await new Promise<NonClaudeRunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false

      const child = spawn(bin, args, {
        cwd,
        env: childEnv as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ text: null, error: `${cliType} spawn error: ${err.message}` })
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (timedOut) {
          resolve({ text: null, error: `${cliType} timeout after ${Math.round(timeoutMs / 1000)}s` })
          return
        }
        let fileText = ''
        if (tmpOut && existsSync(tmpOut)) {
          try { fileText = readFileSync(tmpOut, 'utf-8') } catch { /* ignore */ }
        }
        const rawOut = (fileText.trim() ? fileText : stdout).trim()
        if (code === 0 && rawOut) {
          resolve({ text: rawOut })
          return
        }
        const detail = (stderr || rawOut || `exit code ${code ?? 'unknown'}`).trim().slice(0, 300)
        resolve({ text: null, error: `${cliType} exited with ${code}: ${detail}` })
      })

      if (cliType === 'codex' && child.stdin) {
        child.stdin.write(prompt)
      }
      child.stdin?.end()
    })
  } finally {
    if (typingInterval) clearInterval(typingInterval)
    if (tmpOut) {
      try { rmSync(tmpOut, { force: true }) } catch { /* ignore */ }
    }
  }
}

function buildNonClaudeCandidates(opts: RunAgentOpts): Array<{ cli: 'codex' | 'agy'; model?: string }> {
  const configuredCli = opts.cliType ?? (opts.model ? getCliTypeForModel(opts.model) : resolveConfiguredMainCliType(PROJECT_ROOT))
  const configuredModel = opts.model || resolveConfiguredMainModel(PROJECT_ROOT)
  const list: Array<{ cli: 'codex' | 'agy'; model?: string }> = []
  if (configuredCli === 'agy' || configuredCli === 'codex') {
    list.push({ cli: configuredCli, model: configuredModel || undefined })
  }
  for (const fallbackCli of ['agy', 'codex'] as const) {
    if (!list.some((c) => c.cli === fallbackCli)) {
      list.push({ cli: fallbackCli })
    }
  }
  return list
}

async function tryNonClaudeBackends(
  prompt: string,
  cwd: string,
  env: Record<string, string | undefined> | undefined,
  opts: RunAgentOpts,
  onTyping?: () => void,
  onlyConfigured = false,
): Promise<{ text: string | null; error?: string; attempted: boolean }> {
  const configuredCli = opts.cliType ?? (opts.model ? getCliTypeForModel(opts.model) : resolveConfiguredMainCliType(PROJECT_ROOT))
  const candidates = buildNonClaudeCandidates(opts)
  const errors: string[] = []
  let attempted = false

  for (const cand of candidates) {
    if (onlyConfigured && cand.cli !== configuredCli) continue
    if (!resolveCliBinary(cand.cli)) continue
    attempted = true
    const res = await runViaNonClaudeCli(cand.cli, prompt, {
      cwd,
      model: cand.model,
      timeoutMs: opts.timeoutMs,
      env,
      onTyping,
    })
    if (res.text) return { text: res.text, attempted: true }
    if (res.error) errors.push(res.error)
  }

  return {
    text: null,
    error: errors.length ? errors.join(' | ') : undefined,
    attempted,
  }
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  allowTools = false,
  cwd: string = PROJECT_ROOT,
  env?: Record<string, string | undefined>,
  opts: RunAgentOpts = {},
): Promise<{ text: string | null; newSessionId?: string; error?: string }> {
  // KILLSWITCH1022: every dashboard-side Claude call (the daily digest, the
  // schedule-expansion routes, capability summaries...) goes through here, on a
  // session that runs tools. A frozen fleet starts none of them.
  if (isFleetFrozen()) {
    logger.warn({ caller: new Error().stack?.split('\n')[2]?.trim() }, 'runAgent refused: fleet frozen (KILLSWITCH1022)')
    return { text: null, error: 'fleet frozen (KILLSWITCH1022)' }
  }
  const timeoutMs = opts.timeoutMs ?? AGENT_TIMEOUT_MS
  // TYPINGPATHS1114: Claude Code turns an at-sign at the start of a prompt or
  // after whitespace into a file attachment, with no tool call (see
  // web/pane-text.ts, ENVATLEAK1114). The worker path types its prompt through
  // the common sender, which applies the mapping; the SDK path below hands the
  // prompt to the CLI directly and applied nothing. Whether the SDK prompt
  // attaches was NOT measured when this went in: the mapping is cheap, and the
  // fallback path must not differ from the main one. It runs ONCE here, for both
  // paths; it is idempotent, so the common sender's second pass changes nothing.
  // Only the at-sign step: the SDK takes a multi-line prompt, line breaks stay.
  const prompt = neutralizeAtMentions(message)

  // Non-Claude orchestrator/agent preference: when the active model targets `agy` or `codex`,
  // run headless generation directly with the configured non-Claude CLI instead of failing on
  // missing Claude Code binaries/credentials.
  const preferredCli = opts.cliType ?? (opts.model ? getCliTypeForModel(opts.model) : resolveConfiguredMainCliType(PROJECT_ROOT))
  if (preferredCli === 'agy' || preferredCli === 'codex') {
    const nonClaudeRes = await tryNonClaudeBackends(prompt, cwd, env, opts, onTyping, false)
    if (nonClaudeRes.text) {
      return { text: nonClaudeRes.text }
    }
    if (nonClaudeRes.attempted && !resolveClaudeCodeBin() && !process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { text: null, error: nonClaudeRes.error }
    }
  }

  let workerOutcome: { text: string | null; error?: string; authFailed?: boolean } | null = null
  if (agentBackend() === 'worker') {
    // The interactive worker is a single shared session with its own fixed,
    // isolated, NEUTRAL cwd/config -- so the SDK-era per-call cwd/env isolation
    // hacks (CLAUDE_CONFIG_DIR to dodge the telegram-plugin 409) are subsumed
    // and intentionally ignored here. resume/sessionId is unsupported (no caller
    // uses it). Dynamic import keeps the SDK module off the worker-path hot path
    // and avoids any load-order coupling.
    if (sessionId) logger.warn('runAgent(worker): resume/sessionId not supported on worker backend, ignoring')
    const { runViaWorker } = await import('./web/agent-worker.js')
    workerOutcome = await runViaWorker(prompt, timeoutMs)
    // authFailed = the worker could not recover its subscription auth even after
    // a reseed + clear-keychain + restart + retry. Fall through to the SDK path
    // so the call still completes (API billing) instead of dying silently (the
    // 2026-06-10 bake failure mode). Every other outcome returns as-is unless
    // Claude is absent/unusable and a non-Claude fallback CLI can handle it.
    if (!workerOutcome.authFailed) {
      if (workerOutcome.text !== null) return { text: workerOutcome.text, error: workerOutcome.error }
      if (preferredCli === 'claude') {
        const altFallback = await tryNonClaudeBackends(prompt, cwd, env, opts, onTyping, false)
        if (altFallback.text) return { text: altFallback.text }
      }
      return { text: workerOutcome.text, error: workerOutcome.error }
    }
    logger.error('runAgent: worker auth unrecoverable, falling back to SDK / non-Claude backend for this call')
  }
  // --- legacy SDK path (rollback: MARVEEN_AGENT_BACKEND=sdk; API billing) ---
  let newSessionId: string | undefined
  let resultText: string | null = null
  let blockedReason: string | undefined

  const typingInterval = onTyping ? setInterval(onTyping, TYPING_REFRESH_MS) : undefined
  const abortController = new AbortController()
  const timeout = setTimeout(() => {
    logger.warn({ timeoutMs }, 'Agent timeout, megszakitas...')
    abortController.abort()
  }, timeoutMs)

  const claudeCodeBin = resolveClaudeCodeBin()

  try {
    const events = query({
      prompt,
      options: {
        abortController,
        cwd,
        permissionMode: 'bypassPermissions',
        ...(claudeCodeBin ? { pathToClaudeCodeExecutable: claudeCodeBin } : {}),
        ...(allowTools ? {} : { disallowedTools: DEFAULT_DISALLOWED_TOOLS }),
        ...(sessionId ? { resume: sessionId } : {}),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
    })

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && (event as any).subtype === 'init') {
        newSessionId = (event as any).sessionId as string
      }
      if (event.type === 'result') {
        const c = classifyAgentResult(event as any)
        if (c.blocked) {
          // AUP block / API error / max-turns: do NOT propagate as content
          // (issue #209). text=null trips the caller's `if (!text) throw`.
          blockedReason = c.reason
          resultText = null
          logger.error({ reason: c.reason }, 'runAgent: result blocked/errored -- not propagated as content (possible AUP block, issue #209)')
        } else {
          resultText = c.text
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || abortController.signal.aborted) {
      logger.warn('Agent megszakitva timeout miatt')
      const mins = Math.round(timeoutMs / 60000)
      if (opts.timeoutAsError) {
        // Structured timeout for callers that persist the result: the apology
        // text below reads as content and would be cached/shipped verbatim.
        resultText = null
        blockedReason = `timeout after ${mins}min`
      } else {
        resultText = `A feldolgozas tullepte a ${mins} perces idokorlatot. Probald rovidebben megfogalmazni, vagy bontsd tobb lepesre.`
      }
    } else {
      // If Claude SDK threw (e.g. Claude binary/auth absent) and Codex/Antigravity is
      // installed, fall back before throwing.
      if (preferredCli === 'claude') {
        const altFallback = await tryNonClaudeBackends(prompt, cwd, env, opts, undefined, false)
        if (altFallback.text) {
          return { text: altFallback.text }
        }
      }
      logger.error({ err }, 'Agent hiba')
      throw err instanceof Error ? err : new Error(String(err))
    }
  } finally {
    clearTimeout(timeout)
    if (typingInterval) clearInterval(typingInterval)
  }

  return { text: resultText, newSessionId, error: blockedReason }
}
