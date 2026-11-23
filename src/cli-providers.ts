import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { tryResolveFromPath } from './platform.js'

export type CliType = 'claude' | 'codex' | 'agy'

/**
 * Strict allowlist for model identifiers passed to CLI `-m` / `--model` flags.
 * Must start with an alphanumeric character (blocks leading `-` option/flag injection)
 * and contain only safe model identifier characters (no whitespace, quotes, shell metacharacters, or control chars).
 */
export const SAFE_MODEL_ID_RX = /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/
const SAFE_CONV_ID_RX = /^[a-zA-Z0-9_-]{1,128}$/
const SAFE_JSONL_FILE_RX = /^[a-zA-Z0-9._-]+\.jsonl$/

export interface CliToolInfo {
  name: CliType
  available: boolean
  binPath: string | null
  version: string | null
}

export interface CliModelEntry {
  id: string
  rawId?: string
  cli?: CliType
  label: string
  description?: string
}

export interface HeadroomToolInfo {
  enabled: boolean
  available: boolean
  binPath: string | null
  version: string | null
  wrapTargets: CliType[]
}

export interface AltCliPaneState {
  cli: CliType
  box: string
  parked: boolean
  busy?: boolean
  booting?: boolean
}

export interface TimelineEntryItem {
  ts: string | null
  kind: 'in' | 'out' | 'action' | 'note'
  channel?: string
  chatId?: string
  text: string
}

export interface RawTranscriptEventItem {
  ts: string | null
  tipus: 'tool_use' | 'tool_result' | 'text' | 'thinking' | 'user'
  nev: string | null
  szoveg: string
}

export interface ParsedAltTranscriptLine {
  tsIso: string | null
  tsMs: number | null
  model?: string
  contextTokens?: number
  isTurnActivity?: boolean
  timelineItems: TimelineEntryItem[]
  transcriptEvents: RawTranscriptEventItem[]
}

/**
 * Self-contained adapter contract for an interactive CLI coding agent.
 * To add support for a new CLI agent (e.g. `opencode`, `aider`, `goose`),
 * implement this interface and register it via `registerCliProvider()`.
 */
export interface CliProviderAdapter {
  readonly id: CliType
  readonly displayName: string
  readonly binaryName: string
  readonly fallbackBinaryPaths?: readonly string[]
  readonly modelPrefixes: readonly string[]
  readonly instructionFiles: readonly string[]
  readonly headroomWrapTarget?: string | null
  readonly supportsClaudeChannelsFlag: boolean
  readonly supportsSlashRename: boolean
  readonly supportsSlashClear: boolean
  matchesModelFamily(lowerModelId: string): boolean
  discoverModels(opts?: Record<string, unknown>): CliModelEntry[]
  stampWorkspaceTrust(dir: string, customConfigPath?: string): boolean
  findTranscript(workingDir: string, homeDir: string): { file: string; mtimeMs: number } | null
  parseTranscriptLine(entry: Record<string, unknown>, clipText?: (s: string) => string): ParsedAltTranscriptLine
}

const providerRegistry = new Map<CliType, CliProviderAdapter>()
const knownModelIdsByCli = new Map<CliType, Set<string>>([
  ['claude', new Set<string>()],
  ['codex', new Set<string>()],
  ['agy', new Set<string>()],
])

export function registerCliProvider(adapter: CliProviderAdapter): void {
  providerRegistry.set(adapter.id, adapter)
  if (!knownModelIdsByCli.has(adapter.id)) {
    knownModelIdsByCli.set(adapter.id, new Set<string>())
  }
}

export function getCliProvider(cli: CliType): CliProviderAdapter {
  const found = providerRegistry.get(cli)
  if (!found) throw new Error(`Unknown CLI provider: ${cli}`)
  return found
}

export function listCliProviders(): CliProviderAdapter[] {
  return [...providerRegistry.values()]
}

export function listNonClaudeCliProviders(): CliProviderAdapter[] {
  return [...providerRegistry.values()].filter(p => p.id !== 'claude')
}

export function recordKnownModelForCli(cli: CliType, modelId: string): void {
  const clean = modelId.trim().toLowerCase()
  if (!clean) return
  let set = knownModelIdsByCli.get(cli)
  if (!set) {
    set = new Set<string>()
    knownModelIdsByCli.set(cli, set)
  }
  const stripped = clean.replace(/^(?:claude|codex|openai|agy|antigravity):/, '')
  set.add(`${cli}:${stripped}`)
  // Never let a non-Claude CLI claim an unprefixed `claude-*` model ID unless it carries an
  // Antigravity tier suffix (`-low`, `-medium`, `-high`, `-xhigh`), so e.g. `claude-opus-4-6`
  // remains unambiguously routed to Claude Code (`claude`) unless prefixed as `agy:claude-opus-4-6`.
  const isAmbiguousClaudeId =
    cli !== 'claude' &&
    stripped.startsWith('claude-') &&
    !/^claude-(?:opus|sonnet|haiku)-[\w.-]+-(?:low|medium|high|xhigh)$/.test(stripped)
  if (!isAmbiguousClaudeId) {
    set.add(stripped)
  }
}

export function isKnownModelForCli(cli: CliType, lowerModelId: string): boolean {
  return knownModelIdsByCli.get(cli)?.has(lowerModelId) ?? false
}

// ============================================================================
// Headroom Optimizer (`https://github.com/headroomlabs-ai/headroom`) Integration
// ============================================================================

export function isHeadroomEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MARVEEN_HEADROOM ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  return true
}

const headroomHealthCache = new Map<string, boolean>()

function headroomCacheKey(headroomBin: string): string {
  try {
    const st = statSync(headroomBin)
    return `${headroomBin}:${st.mtimeMs}:${st.size}`
  } catch {
    return headroomBin
  }
}

export function isHeadroomBinaryHealthy(headroomBin: string): boolean {
  const key = headroomCacheKey(headroomBin)
  const cached = headroomHealthCache.get(key)
  if (cached !== undefined) return cached
  let ok = false
  try {
    execFileSync(headroomBin, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    ok = true
  } catch {
    ok = false
  }
  headroomHealthCache.set(key, ok)
  return ok
}

export function resolveHeadroomBinary(opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): string | null {
  const env = opts.env ?? process.env
  if (!isHeadroomEnabled(env)) return null

  const explicit = (env.MARVEEN_HEADROOM_BIN ?? env.HEADROOM_BIN ?? '').trim()
  if (explicit) {
    try {
      if (existsSync(explicit) && statSync(explicit).isFile() && isHeadroomBinaryHealthy(explicit)) return explicit
    } catch { /* ignore */ }
    return null
  }

  // Keep unit tests hermetic unless MARVEEN_HEADROOM_BIN or homeDir is explicitly provided
  if (env.VITEST && !opts.homeDir) return null

  const home = opts.homeDir || homedir()
  const candidates = [
    join(home, '.local', 'bin', 'headroom'),
    join(home, '.local', 'share', 'marveen-headroom-venv', 'bin', 'headroom'),
    ...(env.FLEET_PYTHON_VENV ? [join(env.FLEET_PYTHON_VENV, 'bin', 'headroom')] : []),
  ]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile() && isHeadroomBinaryHealthy(c)) return c
    } catch { /* ignore */ }
  }

  if (!opts.homeDir) {
    const fromPath = tryResolveFromPath('headroom')
    if (fromPath && isHeadroomBinaryHealthy(fromPath)) return fromPath
  }
  return null
}

const headroomWrapProbeCache = new Map<string, Set<string>>()

function probeHeadroomWrapTargets(headroomBin: string): Set<string> {
  const key = headroomCacheKey(headroomBin)
  const cached = headroomWrapProbeCache.get(key)
  if (cached) return cached
  const targets = new Set<string>(['claude', 'codex'])
  try {
    const out = execFileSync(headroomBin, ['wrap', '--help'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toLowerCase()
    if (/\bagy\b/.test(out)) targets.add('agy')
    if (/\bantigravity\b/.test(out)) targets.add('antigravity')
  } catch {
    targets.clear()
  }
  headroomWrapProbeCache.set(key, targets)
  return targets
}

function quoteShellPathIfNeeded(p: string): string {
  if (/^[a-zA-Z0-9._/-]+$/.test(p)) return p
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * Return the CLI launch prefix for `cliType`, automatically wrapping with
 * `headroom wrap <target> --` when Headroom is installed and supports the target CLI.
 * Falls back transparently to `rawCliBin` when Headroom is absent or disabled.
 */
export function resolveHeadroomLauncher(
  cliType: CliType,
  rawCliBin: string,
  opts: { hasCustomBaseUrl?: boolean; env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string {
  const env = opts.env ?? process.env
  const headroomBin = resolveHeadroomBinary(opts)
  if (!headroomBin) return rawCliBin

  // When a custom API base URL is injected (e.g. Ollama / OpenRouter / OPENAI_BASE_URL / GEMINI_API_BASE),
  // avoid overriding the configured endpoint with Headroom's local proxy unless explicitly forced.
  if (opts.hasCustomBaseUrl && env.MARVEEN_HEADROOM_WRAP_CUSTOM_URL !== '1') {
    return rawCliBin
  }

  const provider = providerRegistry.get(cliType)
  let target = provider?.headroomWrapTarget ?? null
  const supported = probeHeadroomWrapTargets(headroomBin)
  if (target && !supported.has(target)) {
    target = null
  }
  if (!target && cliType === 'agy') {
    if (env.MARVEEN_HEADROOM_WRAP_AGY === '1') {
      target = 'agy'
    } else {
      if (supported.has('agy')) target = 'agy'
      else if (supported.has('antigravity')) target = 'antigravity'
    }
  }

  if (!target || !/^[a-zA-Z0-9_-]+$/.test(target)) return rawCliBin
  return `${quoteShellPathIfNeeded(headroomBin)} wrap ${target} --`
}

export function detectHeadroomInfo(opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}): HeadroomToolInfo {
  const env = opts.env ?? process.env
  const enabled = isHeadroomEnabled(env)
  const binPath = resolveHeadroomBinary(opts)
  if (!binPath) {
    return { enabled, available: false, binPath: null, version: null, wrapTargets: [] }
  }
  let version: string | null = null
  try {
    const out = execFileSync(binPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    version = out.split('\n')[0]?.trim() || null
  } catch { /* ignore */ }
  const targets = probeHeadroomWrapTargets(binPath)
  const wrapTargets: CliType[] = ['claude', 'codex']
  if (targets.has('agy') || targets.has('antigravity') || env.MARVEEN_HEADROOM_WRAP_AGY === '1') {
    wrapTargets.push('agy')
  }
  return { enabled, available: true, binPath, version, wrapTargets }
}

const SENSITIVE_MCP_ENV_KEY_RX = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PRIVATE)/i

interface SafeStdioMcpServer {
  command: string
  args: string[]
  env?: Record<string, string>
}

function readSafeStdioMcpServers(mcpJsonPath?: string): Record<string, SafeStdioMcpServer> {
  const out: Record<string, SafeStdioMcpServer> = {}
  if (!mcpJsonPath || !existsSync(mcpJsonPath)) return out
  try {
    if (lstatSync(mcpJsonPath).isSymbolicLink()) return out
    const raw = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as { mcpServers?: Record<string, unknown> }
    if (!raw?.mcpServers || typeof raw.mcpServers !== 'object') return out
    for (const [name, def] of Object.entries(raw.mcpServers)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !def || typeof def !== 'object') continue
      const srv = def as Record<string, unknown>
      if (typeof srv.command !== 'string' || !srv.command.trim()) continue
      const args = Array.isArray(srv.args) ? srv.args.filter((a): a is string => typeof a === 'string') : []
      const safeEnv: Record<string, string> = {}
      if (srv.env && typeof srv.env === 'object') {
        for (const [k, v] of Object.entries(srv.env as Record<string, unknown>)) {
          if (typeof v === 'string' && !SENSITIVE_MCP_ENV_KEY_RX.test(k) && !/[\r\n\0]/.test(v)) {
            safeEnv[k] = v
          }
        }
      }
      out[name] = {
        command: srv.command.trim(),
        args,
        ...(Object.keys(safeEnv).length > 0 ? { env: safeEnv } : {}),
      }
    }
  } catch { /* ignore */ }
  return out
}

/**
 * Synchronize MCP servers from an agent's `.mcp.json` AND automatically register
 * the Headroom MCP server (`headroom mcp serve`) when Headroom is installed,
 * covering `claude`, `codex`, and `agy`.
 */
export function syncCliMcpConfig(
  cliType: CliType,
  mcpJsonPath?: string,
  opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = opts.env ?? process.env
  if (env.VITEST && !opts.homeDir && !env.MARVEEN_HEADROOM_BIN) return false
  const home = opts.homeDir || homedir()
  const headroomBin = resolveHeadroomBinary({ env, homeDir: opts.homeDir })

  try {
    if (cliType === 'claude') {
      if (!headroomBin || !mcpJsonPath || !existsSync(mcpJsonPath)) return false
      if (lstatSync(mcpJsonPath).isSymbolicLink()) return false
      const data = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>
      const mcpServers =
        data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? (data.mcpServers as Record<string, unknown>)
          : {}
      const existing = mcpServers.headroom as { command?: unknown; args?: unknown } | undefined
      if (
        existing &&
        existing.command === headroomBin &&
        Array.isArray(existing.args) &&
        existing.args[0] === 'mcp' &&
        existing.args[1] === 'serve'
      ) {
        return false
      }
      mcpServers.headroom = { command: headroomBin, args: ['mcp', 'serve'] }
      data.mcpServers = mcpServers
      writeFileSync(mcpJsonPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      try { chmodSync(mcpJsonPath, 0o600) } catch { /* ignore */ }
      return true
    }

    const servers = readSafeStdioMcpServers(mcpJsonPath)
    if (headroomBin) {
      servers.headroom = { command: headroomBin, args: ['mcp', 'serve'] }
    }
    const baseDir = mcpJsonPath ? dirname(mcpJsonPath) : ''
    const replyMcpScript = baseDir ? join(baseDir, 'scripts', 'channel-reply-mcp.mjs') : ''
    if (replyMcpScript && existsSync(replyMcpScript) && !lstatSync(replyMcpScript).isSymbolicLink()) {
      servers.marveen_telegram = { command: process.execPath, args: [replyMcpScript] }
    }
    if (Object.keys(servers).length === 0) return false

    if (cliType === 'codex') {
      const configPath = join(home, '.codex', 'config.toml')
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
      if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) return false
      let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
      let changed = false
      for (const [name, srv] of Object.entries(servers)) {
        const header = `[mcp_servers.${name}]`
        if (!content.includes(header)) {
          if (content.length > 0 && !content.endsWith('\n')) content += '\n'
          content += `\n${header}\ncommand = ${JSON.stringify(srv.command)}\nargs = ${JSON.stringify(srv.args)}\n`
          if (srv.env && Object.keys(srv.env).length > 0) {
            content += `[mcp_servers.${name}.env]\n`
            for (const [k, v] of Object.entries(srv.env)) {
              if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
                content += `${k} = ${JSON.stringify(v)}\n`
              }
            }
          }
          changed = true
        }
      }
      if (changed) {
        writeFileSync(configPath, content, { mode: 0o600 })
        try { chmodSync(configPath, 0o600) } catch { /* ignore */ }
      }
      return changed
    }

    if (cliType === 'agy') {
      const configPath = join(home, '.gemini', 'config', 'mcp_config.json')
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
      if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) return false
      let data: Record<string, unknown> = {}
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf-8').trim()
        try {
          const parsed: unknown = content ? JSON.parse(content) : {}
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
          data = parsed as Record<string, unknown>
        } catch {
          return false
        }
      }
      const mcpServers =
        data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers)
          ? (data.mcpServers as Record<string, unknown>)
          : {}
      let changed = false
      for (const [name, srv] of Object.entries(servers)) {
        const prev = JSON.stringify(mcpServers[name])
        const next = JSON.stringify(srv)
        if (prev !== next) {
          mcpServers[name] = srv
          changed = true
        }
      }
      if (changed) {
        data.mcpServers = mcpServers
        writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
        try { chmodSync(configPath, 0o600) } catch { /* ignore */ }
      }
      return changed
    }
  } catch {
    return false
  }
  return false
}

// --- Shared workspace helper ---

export function workspaceAndGitRootPaths(dir: string): string[] {
  const paths = new Set<string>()
  const addSafe = (p: string) => {
    if (p && !/[\r\n\0]/.test(p)) paths.add(p)
  }
  addSafe(dir)
  try { addSafe(realpathSync(dir)) } catch { /* ignore */ }
  for (const base of [...paths]) {
    let cur = base
    for (let depth = 0; depth < 12; depth++) {
      if (existsSync(join(cur, '.git'))) {
        addSafe(cur)
        break
      }
      const parent = dirname(cur)
      if (!parent || parent === cur) break
      cur = parent
    }
  }
  return [...paths]
}

function parseIsoMs(ts: unknown): { tsIso: string | null; tsMs: number | null } {
  if (typeof ts !== 'string' || !ts.trim()) return { tsIso: null, tsMs: null }
  const ms = Date.parse(ts)
  return { tsIso: ts, tsMs: Number.isFinite(ms) ? ms : null }
}

// ============================================================================
// 1. Claude Code (`claude`) Provider Adapter
// ============================================================================

const claudeAdapter: CliProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code (Anthropic)',
  binaryName: 'claude',
  modelPrefixes: ['claude:'],
  instructionFiles: ['CLAUDE.md'],
  headroomWrapTarget: 'claude',
  supportsClaudeChannelsFlag: true,
  supportsSlashRename: true,
  supportsSlashClear: true,
  matchesModelFamily(lowerModelId: string): boolean {
    return lowerModelId.startsWith('claude-') || lowerModelId.includes('/')
  },
  discoverModels(): CliModelEntry[] {
    return []
  },
  stampWorkspaceTrust(): boolean {
    return false
  },
  findTranscript(): null {
    return null
  },
  parseTranscriptLine(entry: Record<string, unknown>): ParsedAltTranscriptLine {
    const { tsIso, tsMs } = parseIsoMs(entry.timestamp)
    return { tsIso, tsMs, timelineItems: [], transcriptEvents: [] }
  },
}

// ============================================================================
// 2. OpenAI Codex (`codex`) Provider Adapter
// ============================================================================

const CHATGPT_APP_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
let cachedCodexModels: { at: number; value: CliModelEntry[] } | null = null
const CODEX_MODELS_CACHE_TTL_MS = 30_000

export function stampCodexWorkspaceTrust(dir: string, customConfigPath?: string): boolean {
  if (process.env.VITEST && !customConfigPath) return false
  try {
    const configPath = customConfigPath || join(homedir(), '.codex', 'config.toml')
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
    if (existsSync(configPath) && lstatSync(configPath).isSymbolicLink()) return false
    let content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
    let added = false
    for (const p of workspaceAndGitRootPaths(dir)) {
      const header = `[projects.${JSON.stringify(p)}]`
      if (!content.includes(header)) {
        if (content.length > 0 && !content.endsWith('\n')) content += '\n'
        content += `\n${header}\ntrust_level = "trusted"\n`
        added = true
      }
    }
    if (added) {
      writeFileSync(configPath, content, { mode: 0o600 })
      try { chmodSync(configPath, 0o600) } catch { /* ignore */ }
    }
    return added
  } catch {
    return false
  }
}

export function getCodexAvailableModels(opts: { codexHome?: string; forceRefresh?: boolean } = {}): CliModelEntry[] {
  const now = Date.now()
  const isDefaultHome = !opts.codexHome
  if (isDefaultHome && !opts.forceRefresh && cachedCodexModels && now - cachedCodexModels.at < CODEX_MODELS_CACHE_TTL_MS) {
    return cachedCodexModels.value
  }

  const codexDir = opts.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  const seen = new Set<string>()
  const result: CliModelEntry[] = []

  const addEntry = (id: string, displayName?: string, description?: string) => {
    const cleanId = id.trim().replace(/^(?:codex|openai):/i, '')
    if (!cleanId || !SAFE_MODEL_ID_RX.test(cleanId) || seen.has(cleanId)) return
    seen.add(cleanId)
    recordKnownModelForCli('codex', cleanId)
    const prefixedId = `codex:${cleanId}`
    result.push({
      id: prefixedId,
      rawId: cleanId,
      cli: 'codex',
      label: `${(displayName || cleanId).trim()} (Codex)`,
      ...(description ? { description } : {}),
    })
  }

  try {
    if (existsSync(codexDir)) {
      const cacheFiles = readdirSync(codexDir)
        .filter(f => /^models_cache.*\.json$/i.test(f))
        .map(f => {
          const full = join(codexDir, f)
          let mtimeMs = 0
          try { mtimeMs = statSync(full).mtimeMs } catch { /* ignore */ }
          return { file: f, full, mtimeMs }
        })
        .sort((a, b) => {
          if (a.file === 'models_cache.json') return -1
          if (b.file === 'models_cache.json') return 1
          return b.mtimeMs - a.mtimeMs
        })

      for (const { full } of cacheFiles) {
        try {
          const data = JSON.parse(readFileSync(full, 'utf-8')) as {
            models?: Array<{
              slug?: string
              display_name?: string
              description?: string
              visibility?: string
              priority?: number
            }>
          }
          if (!Array.isArray(data.models)) continue
          const hasVisibility = data.models.some(m => typeof m.visibility === 'string')
          const visible = data.models.filter(
            m => typeof m.slug === 'string' && m.slug.trim().length > 0 && (!hasVisibility || m.visibility === 'list'),
          )
          for (const m of visible) {
            addEntry(m.slug!, m.display_name, m.description)
          }
          if (result.length > 0) break
        } catch { /* try next cache file */ }
      }

      const configPath = join(codexDir, 'config.toml')
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, 'utf-8')
          const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw)
          if (m && m[1]) addEntry(m[1])
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  if (isDefaultHome) {
    cachedCodexModels = { at: now, value: result }
  }
  return result
}

const codexAdapter: CliProviderAdapter = {
  id: 'codex',
  displayName: 'Codex (OpenAI)',
  binaryName: 'codex',
  fallbackBinaryPaths: [CHATGPT_APP_CODEX_BIN],
  modelPrefixes: ['codex:', 'openai:'],
  instructionFiles: ['AGENTS.md'],
  headroomWrapTarget: 'codex',
  supportsClaudeChannelsFlag: false,
  supportsSlashRename: false,
  supportsSlashClear: false,
  matchesModelFamily(m: string): boolean {
    return (
      m.startsWith('gpt-') ||
      /^o[134](?:$|[-_])/.test(m) ||
      m.startsWith('codex') ||
      m.startsWith('chatgpt-')
    )
  },
  discoverModels(opts) {
    return getCodexAvailableModels(opts as { codexHome?: string; forceRefresh?: boolean })
  },
  stampWorkspaceTrust: stampCodexWorkspaceTrust,
  findTranscript(workingDir: string, homeDir: string): { file: string; mtimeMs: number } | null {
    const candidates = new Set<string>([workingDir])
    try { candidates.add(realpathSync(workingDir)) } catch { /* ignore */ }
    let best: { file: string; mtimeMs: number } | null = null
    try {
      const sessionsRoot = join(homeDir, '.codex', 'sessions')
      if (!existsSync(sessionsRoot)) return null
      const years = readdirSync(sessionsRoot).filter(d => /^\d{4}$/.test(d)).sort().reverse()
      outer: for (const y of years.slice(0, 2)) {
        const yDir = join(sessionsRoot, y)
        const months = readdirSync(yDir).filter(d => /^\d{2}$/.test(d)).sort().reverse()
        for (const m of months.slice(0, 2)) {
          const mDir = join(yDir, m)
          const days = readdirSync(mDir).filter(d => /^\d{2}$/.test(d)).sort().reverse()
          for (const d of days.slice(0, 3)) {
            const dDir = join(mDir, d)
            const files = readdirSync(dDir)
              .filter(f => SAFE_JSONL_FILE_RX.test(f))
              .map(f => {
                const full = join(dDir, f)
                const st = lstatSync(full)
                return { file: full, mtimeMs: st.mtimeMs, safe: st.isFile() && !st.isSymbolicLink() }
              })
              .filter(item => item.safe)
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
            for (const item of files.slice(0, 15)) {
              if (best && item.mtimeMs <= best.mtimeMs) continue
              const fd = openSync(item.file, 'r')
              let head = ''
              try {
                const buf = Buffer.alloc(4096)
                const n = readSync(fd, buf, 0, 4096, 0)
                head = buf.toString('utf-8', 0, n)
              } finally { closeSync(fd) }
              const firstLine = head.split('\n')[0]?.trim()
              if (!firstLine) continue
              try {
                const meta = JSON.parse(firstLine)
                const cwd = meta?.payload?.cwd
                if (typeof cwd === 'string' && candidates.has(cwd)) {
                  best = { file: item.file, mtimeMs: item.mtimeMs }
                  break outer
                }
              } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* ignore */ }
    return best
  },
  parseTranscriptLine(entry: Record<string, unknown>, clipText = (s: string) => s): ParsedAltTranscriptLine {
    const { tsIso, tsMs } = parseIsoMs(entry.timestamp)
    const type = entry.type
    const payload = entry.payload as Record<string, unknown> | undefined
    const timelineItems: TimelineEntryItem[] = []
    const transcriptEvents: RawTranscriptEventItem[] = []
    let model: string | undefined
    let contextTokens: number | undefined
    let isTurnActivity = false

    if (type === 'turn_context' && payload) {
      if (typeof payload.model === 'string' && payload.model.trim()) {
        model = payload.model.trim()
      }
    } else if (type === 'event_msg' && payload) {
      if (payload.type === 'token_count') {
        const info = payload.info as Record<string, unknown> | undefined
        const lastUsage = info?.last_token_usage as Record<string, unknown> | undefined
        const inp = Number(lastUsage?.input_tokens) || 0
        const cached = Number(lastUsage?.cached_input_tokens) || 0
        const total = Number(lastUsage?.total_tokens) || (inp + cached)
        if (total > 0) contextTokens = total
      } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
        isTurnActivity = true
      }
    } else if (type === 'response_item' && payload) {
      const pType = payload.type
      const role = payload.role
      if (pType === 'message' && (role === 'user' || role === 'assistant')) {
        const blocks = payload.content
        if (Array.isArray(blocks)) {
          for (const b of blocks as Array<Record<string, unknown>>) {
            const txt = typeof b?.text === 'string' ? b.text.trim() : ''
            if (!txt) continue
            if (role === 'user' && /^<(?:permissions instructions|collaboration_mode|tools|recommended_plugins|skills_instructions|environment_context)\b/.test(txt)) {
              continue
            }
            isTurnActivity = true
            timelineItems.push({ ts: tsIso, kind: role === 'user' ? 'in' : 'note', text: clipText(txt) })
            transcriptEvents.push({
              ts: tsIso,
              tipus: role === 'user' ? 'user' : 'text',
              nev: null,
              szoveg: txt,
            })
          }
        }
      } else if (pType === 'function_call' || pType === 'local_shell_call' || pType === 'custom_tool_call') {
        isTurnActivity = true
        const name = typeof payload.name === 'string' ? payload.name : String(pType)
        const argsText = typeof payload.arguments === 'string' ? payload.arguments : name
        timelineItems.push({ ts: tsIso, kind: 'action', text: name })
        transcriptEvents.push({
          ts: tsIso,
          tipus: 'tool_use',
          nev: name,
          szoveg: argsText,
        })
      } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        isTurnActivity = true
        const outText = typeof payload.output === 'string' ? payload.output.trim() : ''
        if (outText) {
          transcriptEvents.push({
            ts: tsIso,
            tipus: 'tool_result',
            nev: null,
            szoveg: outText,
          })
        }
      }
    }

    return {
      tsIso,
      tsMs,
      ...(model !== undefined ? { model } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(isTurnActivity ? { isTurnActivity: true } : {}),
      timelineItems,
      transcriptEvents,
    }
  },
}

// ============================================================================
// 3. Google Antigravity (`agy`) Provider Adapter
// ============================================================================

let cachedAgyModels: { at: number; value: CliModelEntry[] } | null = null
const AGY_MODELS_CACHE_TTL_MS = 60_000

export function parseAgyModelsOutput(stdout: string): CliModelEntry[] {
  const parsed: CliModelEntry[] = []
  const seen = new Set<string>()
  const add = (rawId: string, rawName: string) => {
    const cleanId = rawId.trim().replace(/^(?:agy|antigravity):/i, '')
    const name = rawName.trim()
    if (!cleanId || !name || !SAFE_MODEL_ID_RX.test(cleanId) || seen.has(cleanId)) return
    seen.add(cleanId)
    recordKnownModelForCli('agy', cleanId)
    const prefixedId = `agy:${cleanId}`
    parsed.push({
      id: prefixedId,
      rawId: cleanId,
      cli: 'agy',
      label: `${name} (Antigravity)`,
    })
  }
  for (const rawLine of stdout.split('\n')) {
    // Strip carriage-return spinner frames and ANSI sequences if stdout came from a PTY
    const noAnsi = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    const line = noAnsi.includes('\r') ? noAnsi.split('\r').filter(Boolean).pop() ?? '' : noAnsi
    const tabMatch = /^\s*([a-zA-Z0-9][a-zA-Z0-9._:-]*)(?:\t+|\s{2,})(.+?)\s*$/.exec(line)
    if (tabMatch && !/^fetching\b/i.test(tabMatch[1]!)) {
      add(tabMatch[1]!, tabMatch[2]!)
      continue
    }
    const bulletMatch = /^\s*[•*-]\s+(.+?)\s+\(([a-zA-Z0-9._:-]+)\)\s*$/.exec(line)
    if (bulletMatch) {
      add(bulletMatch[2]!, bulletMatch[1]!)
    }
  }
  return parsed
}

export function stampAgyWorkspaceTrust(dir: string, customSettingsPath?: string): boolean {
  if (process.env.VITEST && !customSettingsPath) return false
  try {
    const settingsPath = customSettingsPath || join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
    if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) return false
    let data: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      try {
        data = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      } catch {
        data = {}
      }
    }
    const existing = Array.isArray(data.trustedWorkspaces)
      ? (data.trustedWorkspaces as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const trusted = new Set<string>(existing)
    const before = trusted.size
    for (const p of workspaceAndGitRootPaths(dir)) trusted.add(p)
    if (trusted.size === before) return false
    data.trustedWorkspaces = [...trusted]
    writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(settingsPath, 0o600) } catch { /* ignore */ }
    return true
  } catch {
    return false
  }
}

export function resolveCliBinary(cli: CliType): string | null {
  const provider = providerRegistry.get(cli)
  const binName = provider?.binaryName ?? cli
  const fromPath = tryResolveFromPath(binName)
  if (fromPath) return fromPath
  for (const candidate of provider?.fallbackBinaryPaths ?? []) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function getAgyAvailableModels(
  opts: { runner?: () => string; settingsPath?: string; forceRefresh?: boolean } = {},
): CliModelEntry[] {
  const now = Date.now()
  const isDefault = !opts.runner && !opts.settingsPath
  if (isDefault && !opts.forceRefresh && cachedAgyModels && now - cachedAgyModels.at < AGY_MODELS_CACHE_TTL_MS) {
    return cachedAgyModels.value
  }

  let parsed: CliModelEntry[] = []
  try {
    const out = opts.runner
      ? opts.runner()
      : (() => {
          const agyBin = resolveCliBinary('agy')
          if (!agyBin) return ''
          return execFileSync(agyBin, ['models'], {
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        })()
    if (out) {
      parsed = parseAgyModelsOutput(out)
    }
  } catch { /* ignore CLI error */ }

  try {
    const settingsFile = opts.settingsPath || join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
    if (existsSync(settingsFile)) {
      const s = JSON.parse(readFileSync(settingsFile, 'utf-8')) as { model?: unknown }
      if (typeof s.model === 'string' && s.model.trim()) {
        const cleanId = s.model.trim().replace(/^(?:agy|antigravity):/i, '')
        if (SAFE_MODEL_ID_RX.test(cleanId)) {
          recordKnownModelForCli('agy', cleanId)
          const prefixedId = `agy:${cleanId}`
          if (!parsed.some(m => m.id === prefixedId || m.rawId === cleanId)) {
            parsed.unshift({ id: prefixedId, rawId: cleanId, cli: 'agy', label: `${cleanId} (Antigravity)` })
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (isDefault && parsed.length > 0) {
    cachedAgyModels = { at: now, value: parsed }
  }
  return parsed
}

const agyAdapter: CliProviderAdapter = {
  id: 'agy',
  displayName: 'Antigravity (Google)',
  binaryName: 'agy',
  fallbackBinaryPaths: [
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    join(homedir(), '.local', 'bin', 'agy'),
    join(homedir(), '.antigravity', 'antigravity', 'bin', 'agy'),
  ],
  modelPrefixes: ['agy:', 'antigravity:'],
  instructionFiles: ['GEMINI.md', 'AGENTS.md'],
  headroomWrapTarget: null,
  supportsClaudeChannelsFlag: false,
  supportsSlashRename: false,
  supportsSlashClear: false,
  matchesModelFamily(m: string): boolean {
    return (
      m.startsWith('gemini-') ||
      m.startsWith('gpt-oss-') ||
      m.startsWith('antigravity-') ||
      /^claude-(?:opus|sonnet|haiku)-[\w.-]+-(?:low|medium|high|xhigh)$/.test(m)
    )
  },
  discoverModels(opts) {
    return getAgyAvailableModels(opts as { runner?: () => string; settingsPath?: string; forceRefresh?: boolean })
  },
  stampWorkspaceTrust: stampAgyWorkspaceTrust,
  findTranscript(workingDir: string, homeDir: string): { file: string; mtimeMs: number } | null {
    const candidates = new Set<string>([workingDir])
    try { candidates.add(realpathSync(workingDir)) } catch { /* ignore */ }
    let best: { file: string; mtimeMs: number } | null = null
    try {
      const lastConvPath = join(homeDir, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json')
      const brainBase = join(homeDir, '.gemini', 'antigravity-cli', 'brain')
      if (existsSync(lastConvPath) && !lstatSync(lastConvPath).isSymbolicLink()) {
        const map = JSON.parse(readFileSync(lastConvPath, 'utf-8')) as Record<string, unknown>
        for (const dir of candidates) {
          const convId = map[dir]
          const cleanConvId = typeof convId === 'string' ? convId.trim() : ''
          if (cleanConvId && SAFE_CONV_ID_RX.test(cleanConvId)) {
            const transcript = join(brainBase, cleanConvId, '.system_generated', 'logs', 'transcript.jsonl')
            if (existsSync(transcript)) {
              const st = lstatSync(transcript)
              if (st.isFile() && !st.isSymbolicLink()) {
                if (!best || st.mtimeMs > best.mtimeMs) best = { file: transcript, mtimeMs: st.mtimeMs }
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
    return best
  },
  parseTranscriptLine(entry: Record<string, unknown>, clipText = (s: string) => s): ParsedAltTranscriptLine {
    const { tsIso, tsMs } = parseIsoMs(entry.created_at ?? entry.timestamp)
    const type = entry.type
    const timelineItems: TimelineEntryItem[] = []
    const transcriptEvents: RawTranscriptEventItem[] = []
    const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined
    let isTurnActivity = false

    if (type === 'USER_INPUT') {
      const rawContent = typeof entry.content === 'string' ? entry.content : ''
      const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(rawContent)
      const txt = (reqMatch ? reqMatch[1]! : rawContent).trim()
      if (txt) {
        isTurnActivity = true
        timelineItems.push({ ts: tsIso, kind: 'in', text: clipText(txt) })
        transcriptEvents.push({ ts: tsIso, tipus: 'user', nev: null, szoveg: txt })
      }
    } else if (type === 'PLANNER_RESPONSE') {
      isTurnActivity = true
      if (typeof entry.thinking === 'string' && entry.thinking.trim()) {
        transcriptEvents.push({
          ts: tsIso,
          tipus: 'thinking',
          nev: null,
          szoveg: entry.thinking.trim(),
        })
      }
      const toolCalls = entry.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls as Array<Record<string, unknown>>) {
          const tName = typeof tc?.name === 'string' ? tc.name : 'tool'
          timelineItems.push({ ts: tsIso, kind: 'action', text: tName })
          transcriptEvents.push({
            ts: tsIso,
            tipus: 'tool_use',
            nev: tName,
            szoveg: tc?.arguments ? JSON.stringify(tc.arguments) : tName,
          })
        }
      }
      const txt = typeof entry.content === 'string' ? entry.content.trim() : ''
      if (txt) {
        timelineItems.push({ ts: tsIso, kind: 'note', text: clipText(txt) })
        transcriptEvents.push({ ts: tsIso, tipus: 'text', nev: null, szoveg: txt })
      }
    }

    return {
      tsIso,
      tsMs,
      ...(model !== undefined ? { model } : {}),
      ...(isTurnActivity ? { isTurnActivity: true } : {}),
      timelineItems,
      transcriptEvents,
    }
  },
}

// Register default built-in CLI providers
registerCliProvider(claudeAdapter)
registerCliProvider(codexAdapter)
registerCliProvider(agyAdapter)
