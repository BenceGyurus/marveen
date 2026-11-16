import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveCliBinary, SAFE_MODEL_ID_RX, type CliType } from '../cli-providers.js'
import { stripCliModelPrefix } from '../cli-detector.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { fleetGovernor, type TurnPriority } from './fleet-governor.js'

export interface HeadlessAgentConfig {
  name: string
  session: string
  cliType: 'codex' | 'agy'
  model: string
  dir: string
  skipPermissions: boolean
  env?: Record<string, string>
  fresh?: boolean
}

export interface HeadlessAgentState {
  name: string
  session: string
  cliType: 'codex' | 'agy'
  model: string
  cleanModel: string
  dir: string
  skipPermissions: boolean
  env: Record<string, string>
  startedAt: number
  lastTurnAt: number | null
  turnStartedAt: number | null
  status: 'idle' | 'working' | 'queued' | 'stopped'
  turnCount: number
  threadId: string | null
  hasPriorTurn: boolean
  activeChild: ChildProcess | null
  logLines: string[]
  lastError: string | null
}

const MAX_LOG_LINES = 200
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000
const SESSIONS_FILE = join(STORE_DIR, 'headless-sessions.json')

const byName = new Map<string, HeadlessAgentState>()
const sessionToName = new Map<string, string>()

export function shouldUseHeadlessMode(
  cliType: CliType,
  opts: { host?: string | null; executionMode?: string | null; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (opts.host) return false
  if (cliType !== 'codex' && cliType !== 'agy') return false
  const env = opts.env ?? process.env
  if (env.MARVEEN_NON_CLAUDE_TMUX === '1') return false
  if (opts.executionMode === 'tmux') return false
  return true
}

function loadPersistedSessions(): Record<string, { threadId?: string; hasPriorTurn?: boolean }> {
  if (process.env.VITEST) return {}
  try {
    if (!existsSync(SESSIONS_FILE)) return {}
    const parsed = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function savePersistedSession(name: string, threadId: string | null, hasPriorTurn: boolean): void {
  if (process.env.VITEST) return
  try {
    mkdirSync(dirname(SESSIONS_FILE), { recursive: true, mode: 0o700 })
    const all = loadPersistedSessions()
    all[name] = { ...(threadId ? { threadId } : {}), hasPriorTurn }
    writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  } catch (err) {
    logger.debug({ err, name }, 'headless-runner: failed to persist session state')
  }
}

function appendLog(state: HeadlessAgentState, line: string): void {
  const clean = line.replace(/\r/g, '').trimEnd()
  if (!clean) return
  for (const part of clean.split('\n')) {
    state.logLines.push(part.length > 500 ? part.slice(0, 500) + '…' : part)
  }
  if (state.logLines.length > MAX_LOG_LINES) {
    state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES)
  }
}

export function buildHeadlessChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...overrides }
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  env.CI = '1'
  const existingNodeOpts = env.NODE_OPTIONS ?? ''
  if (!/--max-old-space-size\b/.test(existingNodeOpts)) {
    env.NODE_OPTIONS = `${existingNodeOpts} --max-old-space-size=1536`.trim()
  }
  return env
}

export interface HeadlessTurnSpec {
  bin: string
  args: string[]
  stdinText: string | null
  tempPromptFile: string | null
}

export function buildHeadlessTurnSpec(opts: {
  cliType: 'codex' | 'agy'
  bin: string
  cleanModel: string
  prompt: string
  skipPermissions: boolean
  threadId: string | null
  hasPriorTurn: boolean
}): HeadlessTurnSpec {
  const safeModel = opts.cleanModel && SAFE_MODEL_ID_RX.test(opts.cleanModel) ? opts.cleanModel : ''

  if (opts.cliType === 'codex') {
    const args: string[] = ['exec']
    if (opts.threadId) {
      args.push('resume', opts.threadId)
    } else if (opts.hasPriorTurn) {
      args.push('resume', '--last')
    }
    args.push('--json')
    if (opts.skipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox')
    } else {
      args.push('--sandbox', 'workspace-write')
    }
    if (safeModel) {
      args.push('-m', safeModel)
    }
    args.push('-')
    return { bin: opts.bin, args, stdinText: opts.prompt, tempPromptFile: null }
  }

  // Google Antigravity CLI (`agy`) headless `-p` mode
  const args: string[] = []
  if (opts.hasPriorTurn) {
    args.push('--continue')
  }
  if (opts.skipPermissions) {
    args.push('--dangerously-skip-permissions')
  }
  if (safeModel) {
    args.push('--model', safeModel)
  }

  const needsFile = opts.prompt.length > 16_000 || opts.prompt.includes('\0')
  if (needsFile) {
    const tmpFile = join(tmpdir(), `marveen-agy-prompt-${randomBytes(8).toString('hex')}.txt`)
    writeFileSync(tmpFile, opts.prompt.replace(/\0/g, ''), { mode: 0o600 })
    args.push('-p', `Read and execute the full instructions in ${tmpFile}`)
    return { bin: opts.bin, args, stdinText: null, tempPromptFile: tmpFile }
  }

  args.push('-p', opts.prompt)
  return { bin: opts.bin, args, stdinText: null, tempPromptFile: null }
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, 'SIGTERM')
    } else {
      child.kill('SIGTERM')
    }
  } catch { /* already dead */ }

  const forceTimer = setTimeout(() => {
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, 'SIGKILL')
      } else {
        child.kill('SIGKILL')
      }
    } catch { /* already dead */ }
  }, 3000)
  if (typeof forceTimer.unref === 'function') forceTimer.unref()
}

export function registerHeadlessAgent(cfg: HeadlessAgentConfig): HeadlessAgentState {
  const existing = byName.get(cfg.name)
  if (existing && existing.activeChild) {
    killProcessGroup(existing.activeChild)
    existing.activeChild = null
  }
  fleetGovernor.cancelAgent(cfg.name)

  const persisted = cfg.fresh ? {} : (loadPersistedSessions()[cfg.name] ?? {})
  const cleanModel = stripCliModelPrefix(cfg.model)

  const state: HeadlessAgentState = {
    name: cfg.name,
    session: cfg.session,
    cliType: cfg.cliType,
    model: cfg.model,
    cleanModel,
    dir: cfg.dir,
    skipPermissions: cfg.skipPermissions,
    env: { ...(cfg.env ?? {}) },
    startedAt: Math.floor(Date.now() / 1000),
    lastTurnAt: null,
    turnStartedAt: null,
    status: 'idle',
    turnCount: 0,
    threadId: cfg.fresh ? null : (persisted.threadId ?? null),
    hasPriorTurn: cfg.fresh ? false : Boolean(persisted.hasPriorTurn),
    activeChild: null,
    logLines: [
      `[${new Date().toISOString()}] Headless ${cfg.cliType} agent ready (model: ${cleanModel || cfg.model}, dir: ${cfg.dir})`,
    ],
    lastError: null,
  }

  if (cfg.fresh) {
    savePersistedSession(cfg.name, null, false)
  }

  byName.set(cfg.name, state)
  sessionToName.set(cfg.session, cfg.name)
  logger.info({ name: cfg.name, session: cfg.session, cliType: cfg.cliType, model: cleanModel || cfg.model }, 'Headless agent registered (no tmux)')
  return state
}

export function unregisterHeadlessAgent(name: string): boolean {
  const state = byName.get(name)
  if (!state) return false
  fleetGovernor.cancelAgent(name)
  if (state.activeChild) {
    killProcessGroup(state.activeChild)
    state.activeChild = null
  }
  state.status = 'stopped'
  sessionToName.delete(state.session)
  byName.delete(name)
  logger.info({ name, session: state.session, cliType: state.cliType }, 'Headless agent stopped')
  return true
}

export function isHeadlessAgent(name: string): boolean {
  const st = byName.get(name)
  return Boolean(st && st.status !== 'stopped')
}

export function isHeadlessSession(session: string): boolean {
  const name = sessionToName.get(session)
  return name ? isHeadlessAgent(name) : false
}

export function getHeadlessAgentState(nameOrSession: string): HeadlessAgentState | null {
  const byN = byName.get(nameOrSession)
  if (byN && byN.status !== 'stopped') return byN
  const resolved = sessionToName.get(nameOrSession)
  if (resolved) {
    const st = byName.get(resolved)
    if (st && st.status !== 'stopped') return st
  }
  return null
}

export function getHeadlessRunningSince(session: string): number | null {
  return getHeadlessAgentState(session)?.startedAt ?? null
}

export function captureHeadlessPane(session: string): string | null {
  const st = getHeadlessAgentState(session)
  if (!st) return null

  const isBusy = st.status === 'working' || st.status === 'queued' || fleetGovernor.isAgentActiveOrQueued(st.name)
  const queuePos = fleetGovernor.getAgentQueuePosition(st.name)
  const elapsed = st.turnStartedAt ? `${Math.round((Date.now() - st.turnStartedAt) / 1000)}s` : null
  const stateLabel = st.status === 'working'
    ? `running ${elapsed ?? '0s'}`
    : queuePos > 0
      ? `queued #${queuePos}`
      : 'idle (0 MB RAM)'

  const header = `[headless · ${st.cliType} · ${st.cleanModel || st.model} · turns: ${st.turnCount} · ${stateLabel}]`
  const tail = st.logLines.slice(-60).join('\n')
  const footer = isBusy ? '[marveen-headless:busy]' : '[marveen-headless:idle]'
  return `${header}\n${tail}\n${footer}`
}

function parseCodexJsonlLine(line: string, state: HeadlessAgentState, textOut: string[]): void {
  try {
    const ev = JSON.parse(line) as Record<string, unknown>
    if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id.trim()) {
      state.threadId = ev.thread_id.trim()
      return
    }
    if (ev.type === 'item.completed' && ev.item && typeof ev.item === 'object') {
      const item = ev.item as Record<string, unknown>
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        textOut.push(item.text)
        appendLog(state, item.text)
      } else if (item.type === 'command_execution' && typeof item.command === 'string') {
        appendLog(state, `$ ${item.command}`)
      }
      return
    }
    if (ev.type === 'error' && typeof ev.message === 'string') {
      appendLog(state, `[error] ${ev.message}`)
    }
  } catch {
    appendLog(state, line)
  }
}

export async function runOneHeadlessTurn(
  state: HeadlessAgentState,
  prompt: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; text: string; error?: string }> {
  const bin = resolveCliBinary(state.cliType)
  if (!bin) {
    const err = `${state.cliType} binary not found on PATH`
    state.lastError = err
    appendLog(state, `[error] ${err}`)
    return { ok: false, text: '', error: err }
  }

  const spec = buildHeadlessTurnSpec({
    cliType: state.cliType,
    bin,
    cleanModel: state.cleanModel,
    prompt,
    skipPermissions: state.skipPermissions,
    threadId: state.threadId,
    hasPriorTurn: state.hasPriorTurn,
  })

  const timeoutMs = opts.timeoutMs ?? (Number(process.env.MARVEEN_HEADLESS_TURN_TIMEOUT_MS) || DEFAULT_TURN_TIMEOUT_MS)
  const env = buildHeadlessChildEnv(process.env, state.env)

  state.status = 'working'
  state.turnStartedAt = Date.now()
  state.lastError = null
  appendLog(state, `> ${prompt.split('\n')[0]?.slice(0, 140) ?? '(prompt)'}`)

  return new Promise((resolve) => {
    let settled = false
    const textChunks: string[] = []
    let stdoutBuf = ''

    const child = spawn(spec.bin, spec.args, {
      cwd: state.dir,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    state.activeChild = child

    const cleanup = () => {
      if (spec.tempPromptFile) {
        try { rmSync(spec.tempPromptFile, { force: true }) } catch { /* ignore */ }
      }
      if (state.activeChild === child) {
        state.activeChild = null
      }
      state.turnStartedAt = null
      state.lastTurnAt = Date.now()
      if (state.status !== 'stopped') {
        state.status = 'idle'
      }
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killProcessGroup(child)
      cleanup()
      const err = `Headless turn timed out after ${Math.round(timeoutMs / 1000)}s`
      state.lastError = err
      appendLog(state, `[timeout] ${err}`)
      resolve({ ok: false, text: textChunks.join('\n').trim(), error: err })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killProcessGroup(child)
      cleanup()
      resolve({ ok: false, text: textChunks.join('\n').trim(), error: 'Turn aborted' })
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8')
      if (state.cliType === 'codex') {
        stdoutBuf += str
        let nl = stdoutBuf.indexOf('\n')
        while (nl !== -1) {
          const line = stdoutBuf.slice(0, nl).trim()
          stdoutBuf = stdoutBuf.slice(nl + 1)
          if (line) parseCodexJsonlLine(line, state, textChunks)
          nl = stdoutBuf.indexOf('\n')
        }
      } else {
        textChunks.push(str)
        appendLog(state, str)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf-8').trim()
      if (str) appendLog(state, `[stderr] ${str}`)
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      cleanup()
      state.lastError = err.message
      appendLog(state, `[error] ${err.message}`)
      resolve({ ok: false, text: textChunks.join('\n').trim(), error: err.message })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (state.cliType === 'codex' && stdoutBuf.trim()) {
        parseCodexJsonlLine(stdoutBuf.trim(), state, textChunks)
      }
      state.turnCount++
      state.hasPriorTurn = true
      savePersistedSession(state.name, state.threadId, state.hasPriorTurn)
      cleanup()
      const ok = code === 0
      if (!ok) {
        state.lastError = `Exited with code ${code}`
        appendLog(state, `[exit] code=${code}`)
      } else {
        appendLog(state, `[done] turn #${state.turnCount} complete`)
      }
      resolve({
        ok,
        text: textChunks.join('\n').trim(),
        ...(ok ? {} : { error: `Exited with code ${code}` }),
      })
    })

    if (spec.stdinText !== null && child.stdin) {
      child.stdin.write(spec.stdinText)
      child.stdin.end()
    } else {
      child.stdin?.end()
    }
  })
}

export function enqueueHeadlessPrompt(
  session: string,
  prompt: string,
  opts: { priority?: TurnPriority; timeoutMs?: number } = {},
): Promise<{ ok: boolean; text: string; error?: string }> {
  const st = getHeadlessAgentState(session)
  if (!st) {
    return Promise.resolve({ ok: false, text: '', error: `Headless session not found: ${session}` })
  }
  if (st.status === 'idle') {
    st.status = 'queued'
  }
  const priority = opts.priority ?? (st.name === 'marveen' ? 'critical' : 'high')
  return fleetGovernor.enqueue({
    agentKey: st.name,
    priority,
    run: (signal) => runOneHeadlessTurn(st, prompt, { timeoutMs: opts.timeoutMs, signal }),
  })
}

/**
 * Run a one-shot background worker turn for `codex` or `agy` without keeping
 * a persistent tmux worker session alive.
 */
export async function runHeadlessWorkerTurn(opts: {
  cliType: 'codex' | 'agy'
  model: string
  dir: string
  prompt: string
  timeoutMs: number
  priority?: TurnPriority
}): Promise<{ ok: boolean; text: string; error?: string }> {
  const cleanModel = stripCliModelPrefix(opts.model)
  const tempState: HeadlessAgentState = {
    name: `worker-${opts.cliType}`,
    session: `worker-${opts.cliType}`,
    cliType: opts.cliType,
    model: opts.model,
    cleanModel,
    dir: opts.dir,
    skipPermissions: true,
    env: {},
    startedAt: Math.floor(Date.now() / 1000),
    lastTurnAt: null,
    turnStartedAt: null,
    status: 'queued',
    turnCount: 0,
    threadId: null,
    hasPriorTurn: false,
    activeChild: null,
    logLines: [],
    lastError: null,
  }
  return fleetGovernor.enqueue({
    agentKey: `worker:${opts.cliType}`,
    priority: opts.priority ?? 'low',
    run: (signal) => runOneHeadlessTurn(tempState, opts.prompt, { timeoutMs: opts.timeoutMs, signal }),
  })
}
