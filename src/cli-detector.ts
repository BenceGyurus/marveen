import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnvContent } from './env-parse.js'
import {
  SAFE_MODEL_ID_RX,
  getCliProvider,
  listCliProviders,
  listNonClaudeCliProviders,
  registerCliProvider,
  isKnownModelForCli,
  resolveCliBinary,
  getCodexAvailableModels,
  getAgyAvailableModels,
  parseAgyModelsOutput,
  stampCodexWorkspaceTrust,
  stampAgyWorkspaceTrust,
  isHeadroomEnabled,
  resolveHeadroomBinary,
  resolveHeadroomLauncher,
  detectHeadroomInfo,
  syncCliMcpConfig,
  type CliType,
  type CliToolInfo,
  type CliModelEntry,
  type HeadroomToolInfo,
  type CliProviderAdapter,
  type TimelineEntryItem,
  type RawTranscriptEventItem,
  type ParsedAltTranscriptLine,
} from './cli-providers.js'

export {
  SAFE_MODEL_ID_RX,
  getCliProvider,
  listCliProviders,
  listNonClaudeCliProviders,
  registerCliProvider,
  resolveCliBinary,
  getCodexAvailableModels,
  getAgyAvailableModels,
  parseAgyModelsOutput,
  stampCodexWorkspaceTrust,
  stampAgyWorkspaceTrust,
  isHeadroomEnabled,
  resolveHeadroomBinary,
  resolveHeadroomLauncher,
  detectHeadroomInfo,
  syncCliMcpConfig,
  type CliType,
  type CliToolInfo,
  type CliModelEntry,
  type HeadroomToolInfo,
  type CliProviderAdapter,
  type TimelineEntryItem,
  type RawTranscriptEventItem,
  type ParsedAltTranscriptLine,
}

/**
 * Determine which CLI provider (`claude`, `codex`, `agy`, or any registered provider)
 * should execute a given model ID.
 *
 * Resolution order:
 * 1. Explicit provider prefix (`codex:`, `openai:`, `agy:`, `antigravity:`, `claude:`, ...)
 * 2. OpenRouter format (`provider/model`) -> routed to `claude`
 * 3. Dynamically discovered model catalogs per registered provider
 * 4. Provider `matchesModelFamily()` rules
 * 5. Default fallback -> `'claude'`
 */
export function getCliTypeForModel(model: string | null | undefined): CliType {
  if (!model || typeof model !== 'string') return 'claude'
  const m = model.trim().toLowerCase()
  if (!m) return 'claude'

  for (const provider of listCliProviders()) {
    for (const prefix of provider.modelPrefixes) {
      if (m.startsWith(prefix.toLowerCase())) return provider.id
    }
  }

  // OpenRouter models (`provider/model`) are served via Claude Code's Anthropic-compatible endpoint
  if (m.includes('/')) return 'claude'

  // Consult dynamically discovered model catalogs across all registered non-Claude providers
  for (const provider of listNonClaudeCliProviders()) {
    if (isKnownModelForCli(provider.id, m)) return provider.id
  }

  // Consult provider model-family matchers (non-Claude providers first, in registration order: agy before codex for claude-*-high variants)
  for (const id of ['agy', 'codex'] as const) {
    const p = getCliProvider(id)
    if (p.matchesModelFamily(m)) return p.id
  }
  for (const provider of listNonClaudeCliProviders()) {
    if (provider.id !== 'agy' && provider.id !== 'codex' && provider.matchesModelFamily(m)) {
      return provider.id
    }
  }

  return 'claude'
}

/**
 * Strip an optional explicit CLI prefix (`claude:`, `codex:`, `agy:`, `antigravity:`, or any registered prefix)
 * from a model ID and validate against `SAFE_MODEL_ID_RX` to prevent CLI option/flag injection.
 */
export function stripCliModelPrefix(model: string): string {
  let stripped = (model ?? '').trim()
  for (const provider of listCliProviders()) {
    for (const prefix of provider.modelPrefixes) {
      if (stripped.toLowerCase().startsWith(prefix.toLowerCase())) {
        stripped = stripped.slice(prefix.length).trim()
        break
      }
    }
  }
  if (!stripped || /^(?:default|auto|inherit)$/i.test(stripped)) return ''
  if (!SAFE_MODEL_ID_RX.test(stripped)) return ''
  return stripped
}

/**
 * Format a model identifier with its explicit CLI prefix (`codex:<model>`, `agy:<model>`)
 * when running on a non-Claude CLI so shared model names (e.g. `claude-opus-4-6` on Antigravity)
 * never collide with Claude Code's native model IDs.
 */
export function formatCliModelId(cliType: CliType, model: string): string {
  const clean = stripCliModelPrefix(model) || (model ?? '').trim()
  if (!clean) return ''
  if (cliType === 'claude') return clean
  return `${cliType}:${clean}`
}

let cachedClis: { at: number; value: Record<CliType, CliToolInfo> } | null = null
const CLI_CACHE_TTL_MS = 30_000

function probeOneCli(cli: CliType): CliToolInfo {
  const binPath = resolveCliBinary(cli)
  if (!binPath) return { name: cli, available: false, binPath: null, version: null }
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const firstLine = out.split('\n')[0]?.trim() || null
    return { name: cli, available: true, binPath, version: firstLine }
  } catch {
    return { name: cli, available: true, binPath, version: null }
  }
}

export function detectAvailableClis(): Record<CliType, CliToolInfo> {
  const now = Date.now()
  if (cachedClis && now - cachedClis.at < CLI_CACHE_TTL_MS) return cachedClis.value
  const value = {} as Record<CliType, CliToolInfo>
  for (const provider of listCliProviders()) {
    value[provider.id] = probeOneCli(provider.id)
  }
  cachedClis = { at: now, value }
  return value
}

/**
 * Ensure an agent/worker directory has instruction symlinks (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`, etc.)
 * pointing to whichever canonical regular instruction file exists (`AGENTS.md` preferred, or `CLAUDE.md`),
 * pre-trust the workspace in the target CLI provider's local config, and synchronize MCP servers
 * (including Headroom `headroom mcp serve` when available).
 */
export function prepareWorkspaceForCli(dir: string, cliType: CliType, opts?: { telegramReplyScript?: string }): void {
  const provider = getCliProvider(cliType)
  try {
    const isRegularFile = (p: string): boolean => {
      try { return !lstatSync(p).isSymbolicLink() && existsSync(p) } catch { return false }
    }
    const agentsMd = join(dir, 'AGENTS.md')
    const claudeMd = join(dir, 'CLAUDE.md')
    const canonicalName = isRegularFile(agentsMd) ? 'AGENTS.md' : isRegularFile(claudeMd) ? 'CLAUDE.md' : null
    if (canonicalName) {
      const instructionTargets = new Set<string>(['AGENTS.md', 'GEMINI.md', 'CLAUDE.md', ...provider.instructionFiles])
      instructionTargets.delete(canonicalName)
      for (const altName of instructionTargets) {
        const altPath = join(dir, altName)
        let exists = false
        try {
          lstatSync(altPath)
          exists = true
        } catch {
          exists = false
        }
        if (!exists) {
          try { symlinkSync(canonicalName, altPath) } catch { /* ignore */ }
        }
      }
    }
  } catch { /* best-effort instruction symlink */ }

  provider.stampWorkspaceTrust(dir)
  syncCliMcpConfig(cliType, join(dir, '.mcp.json'), opts)
}

/**
 * Resolve the canonical instruction file path for a workspace/agent directory,
 * preferring universal `AGENTS.md`, then `CLAUDE.md`, then `GEMINI.md`.
 */
export function resolveInstructionFilePath(dir: string): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return join(dir, 'AGENTS.md')
}

/**
 * Read the workspace/agent instruction markdown from `AGENTS.md`, falling back
 * to `CLAUDE.md` or `GEMINI.md`.
 */
export function readInstructionFile(dir: string, fallback = ''): string {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const p = join(dir, name)
    try {
      if (existsSync(p)) return readFileSync(p, 'utf-8')
    } catch { /* try next candidate */ }
  }
  return fallback
}

/**
 * Ensure `AGENTS.md` is the canonical regular file in `dir`, with relative
 * `GEMINI.md -> AGENTS.md` and `CLAUDE.md -> AGENTS.md` symlinks so every
 * agent CLI (`codex`, `agy`, `claude`, `opencode`, etc.) sees the same rules.
 */
export function ensureUniversalInstructionFiles(
  dir: string,
  opts: { promoteExisting?: boolean } = {},
): void {
  const agentsPath = join(dir, 'AGENTS.md')
  const claudePath = join(dir, 'CLAUDE.md')
  const geminiPath = join(dir, 'GEMINI.md')

  const lstatOrNull = (p: string) => {
    try { return lstatSync(p) } catch { return null }
  }
  const agentsStat = lstatOrNull(agentsPath)
  const claudeStat = lstatOrNull(claudePath)
  const geminiStat = lstatOrNull(geminiPath)

  const shouldPromote = opts.promoteExisting !== false
  if (shouldPromote && claudeStat && !claudeStat.isSymbolicLink()) {
    if (!agentsStat || agentsStat.isSymbolicLink() || opts.promoteExisting === true) {
      if (agentsStat?.isSymbolicLink()) {
        try { rmSync(agentsPath, { force: true }) } catch { /* ignore */ }
      }
      renameSync(claudePath, agentsPath)
    }
  } else if (shouldPromote && !agentsStat && geminiStat && !geminiStat.isSymbolicLink()) {
    renameSync(geminiPath, agentsPath)
  }

  const finalAgents = lstatOrNull(agentsPath)
  if (!finalAgents || finalAgents.isSymbolicLink()) return

  for (const linkPath of [claudePath, geminiPath]) {
    const st = lstatOrNull(linkPath)
    if (!st) {
      try { symlinkSync('AGENTS.md', linkPath) } catch { /* ignore */ }
    } else if (st.isSymbolicLink() && !existsSync(linkPath)) {
      // Heal dangling symlink
      try { rmSync(linkPath, { force: true }); symlinkSync('AGENTS.md', linkPath) } catch { /* ignore */ }
    }
  }
}

/**
 * Write canonical `AGENTS.md` atomically and ensure `CLAUDE.md` and `GEMINI.md`
 * symlinks point to it.
 */
export function writeUniversalInstructionFile(dir: string, content: string): void {
  const agentsPath = join(dir, 'AGENTS.md')
  const st = (() => { try { return lstatSync(agentsPath) } catch { return null } })()
  if (st?.isSymbolicLink()) {
    try { rmSync(agentsPath, { force: true }) } catch { /* ignore */ }
  }
  const tmp = `${agentsPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, agentsPath)
  ensureUniversalInstructionFiles(dir, { promoteExisting: false })
  // Replace any stale regular copy or symlink for CLAUDE.md / GEMINI.md with symlink -> AGENTS.md
  for (const legacyName of ['CLAUDE.md', 'GEMINI.md']) {
    const legacyPath = join(dir, legacyName)
    const lst = (() => { try { return lstatSync(legacyPath) } catch { return null } })()
    if (!lst || !lst.isDirectory()) {
      try {
        if (lst) rmSync(legacyPath, { force: true })
        symlinkSync('AGENTS.md', legacyPath)
      } catch { /* ignore */ }
    }
  }
}

/**
 * Resolve the configured model ID for the main orchestrator session
 * from `<projectRoot>/.env` (`MAIN_AGENT_MODEL`), `process.env.MAIN_AGENT_MODEL`,
 * or `<projectRoot>/.claude/settings.json`.
 */
export function resolveConfiguredMainModel(projectRoot: string): string {
  try {
    const envPath = join(projectRoot, '.env')
    if (existsSync(envPath)) {
      const parsed = parseEnvContent(readFileSync(envPath, 'utf-8'), ['MAIN_AGENT_MODEL'])
      const fromEnv = parsed.MAIN_AGENT_MODEL?.trim()
      if (fromEnv) return fromEnv
    }
  } catch { /* ignore */ }

  const procModel = process.env.MAIN_AGENT_MODEL?.trim()
  if (procModel) return procModel

  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { model?: unknown }
      if (typeof parsed?.model === 'string' && parsed.model.trim()) {
        return parsed.model.trim()
      }
    }
  } catch { /* ignore */ }

  return ''
}

/**
 * Resolve the configured CLI runtime for the main orchestrator session
 * (`claude`, `codex`, `agy`, etc.) from `<projectRoot>/.env` (`MAIN_AGENT_MODEL`),
 * `process.env.MAIN_AGENT_MODEL`, or `<projectRoot>/.claude/settings.json`.
 * Defaults to `'claude'` when no non-Claude model is configured.
 */
export function resolveConfiguredMainCliType(projectRoot: string): CliType {
  const model = resolveConfiguredMainModel(projectRoot)
  return model ? getCliTypeForModel(model) : 'claude'
}
