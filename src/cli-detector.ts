import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

export interface CliToolInfo {
  name: CliType
  available: boolean
  binPath: string | null
  version: string | null
}

export interface CliModelEntry {
  id: string
  label: string
  description?: string
}

const CHATGPT_APP_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

const knownCodexModelIds = new Set<string>()
const knownAgyModelIds = new Set<string>()

/**
 * Determine which CLI binary (`claude`, `codex`, or `agy`) should execute a given model ID.
 * Uses explicit prefixes first, then dynamically discovered model catalogs, then generic family prefixes.
 */
export function getCliTypeForModel(model: string | null | undefined): CliType {
  if (!model || typeof model !== 'string') return 'claude'
  const m = model.trim().toLowerCase()
  if (!m) return 'claude'

  if (m.startsWith('agy:') || m.startsWith('antigravity:')) return 'agy'
  if (m.startsWith('codex:') || m.startsWith('openai:')) return 'codex'
  if (m.startsWith('claude:')) return 'claude'

  // OpenRouter models (`provider/model`) are served via Claude Code's Anthropic-compatible endpoint
  if (m.includes('/')) return 'claude'

  // Consult dynamically discovered model catalogs
  if (knownCodexModelIds.has(m)) return 'codex'
  if (knownAgyModelIds.has(m)) return 'agy'

  // Antigravity (agy) model family patterns
  if (
    m.startsWith('gemini-') ||
    m.startsWith('gpt-oss-') ||
    m.startsWith('antigravity-') ||
    /^claude-(?:opus|sonnet|haiku)-[\w.-]+-(?:low|medium|high|xhigh)$/.test(m)
  ) {
    return 'agy'
  }

  // OpenAI Codex (codex) model family patterns
  if (
    m.startsWith('gpt-') ||
    /^o[134](?:$|[-_])/.test(m) ||
    m.startsWith('codex') ||
    m.startsWith('chatgpt-')
  ) {
    return 'codex'
  }

  return 'claude'
}

/**
 * Strip an optional explicit CLI prefix (`claude:`, `codex:`, `agy:`, `antigravity:`) from a model ID
 * and validate against `SAFE_MODEL_ID_RX` to prevent CLI option/flag injection.
 */
export function stripCliModelPrefix(model: string): string {
  const stripped = (model ?? '').replace(/^(?:claude|codex|openai|agy|antigravity):/i, '').trim()
  if (!stripped || /^(?:default|auto|inherit)$/i.test(stripped)) return ''
  if (!SAFE_MODEL_ID_RX.test(stripped)) return ''
  return stripped
}

/**
 * Resolve the binary path for `claude`, `codex`, or `agy`.
 */
export function resolveCliBinary(cli: CliType): string | null {
  const fromPath = tryResolveFromPath(cli)
  if (fromPath) return fromPath
  if (cli === 'codex' && existsSync(CHATGPT_APP_CODEX_BIN)) {
    return CHATGPT_APP_CODEX_BIN
  }
  return null
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
  const value: Record<CliType, CliToolInfo> = {
    claude: probeOneCli('claude'),
    codex: probeOneCli('codex'),
    agy: probeOneCli('agy'),
  }
  cachedClis = { at: now, value }
  return value
}

let cachedCodexModels: { at: number; value: CliModelEntry[] } | null = null
const CODEX_MODELS_CACHE_TTL_MS = 30_000

/**
 * Dynamically extract available Codex models from the local Codex installation
 * (`$CODEX_HOME/models_cache*.json` or `~/.codex/models_cache*.json` and `config.toml`).
 */
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
    const cleanId = id.trim()
    if (!cleanId || !SAFE_MODEL_ID_RX.test(cleanId) || seen.has(cleanId)) return
    seen.add(cleanId)
    knownCodexModelIds.add(cleanId.toLowerCase())
    result.push({
      id: cleanId,
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

let cachedAgyModels: { at: number; value: CliModelEntry[] } | null = null
const AGY_MODELS_CACHE_TTL_MS = 60_000

/**
 * Parse the stdout of `agy models` into `CliModelEntry[]`.
 */
export function parseAgyModelsOutput(stdout: string): CliModelEntry[] {
  const parsed: CliModelEntry[] = []
  const seen = new Set<string>()
  const add = (rawId: string, rawName: string) => {
    const id = rawId.trim()
    const name = rawName.trim()
    if (!id || !name || !SAFE_MODEL_ID_RX.test(id) || seen.has(id)) return
    seen.add(id)
    knownAgyModelIds.add(id.toLowerCase())
    parsed.push({
      id,
      label: `${name} (Antigravity)`,
    })
  }
  for (const line of stdout.split('\n')) {
    // Format 1 (non-TTY pipe output): `<model-id>\t<Display Name>`
    const tabMatch = /^\s*([a-zA-Z0-9][a-zA-Z0-9._:-]*)\t+(.+?)\s*$/.exec(line)
    if (tabMatch) {
      add(tabMatch[1]!, tabMatch[2]!)
      continue
    }
    // Format 2 (TTY bullet output): `• <Display Name> (<model-id>)`
    const bulletMatch = /^\s*[•*-]\s+(.+?)\s+\(([a-zA-Z0-9._:-]+)\)\s*$/.exec(line)
    if (bulletMatch) {
      add(bulletMatch[2]!, bulletMatch[1]!)
    }
  }
  return parsed
}

/**
 * Dynamically extract available Antigravity models by invoking `agy models`
 * (and reading `~/.gemini/antigravity-cli/settings.json` as an additional source).
 */
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
            timeout: 5000,
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
        const id = s.model.trim()
        if (SAFE_MODEL_ID_RX.test(id)) {
          knownAgyModelIds.add(id.toLowerCase())
          if (!parsed.some(m => m.id === id)) {
            parsed.unshift({ id, label: `${id} (Antigravity)` })
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (isDefault) {
    cachedAgyModels = { at: now, value: parsed }
  }
  return parsed
}

/**
 * Ensure an agent/worker directory has instruction symlinks (`AGENTS.md` and `GEMINI.md` -> `CLAUDE.md`)
 * and pre-trust the workspace in the target CLI's local config so interactive prompts do not block startup.
 */
export function prepareWorkspaceForCli(dir: string, cliType: CliType): void {
  try {
    const claudeMd = join(dir, 'CLAUDE.md')
    if (existsSync(claudeMd) && !lstatSync(claudeMd).isSymbolicLink()) {
      for (const altName of ['AGENTS.md', 'GEMINI.md']) {
        const altPath = join(dir, altName)
        let exists = false
        try {
          lstatSync(altPath)
          exists = true
        } catch {
          exists = false
        }
        if (!exists) {
          try { symlinkSync('CLAUDE.md', altPath) } catch { /* ignore */ }
        }
      }
    }
  } catch { /* best-effort instruction symlink */ }

  if (cliType === 'agy') {
    stampAgyWorkspaceTrust(dir)
  } else if (cliType === 'codex') {
    stampCodexWorkspaceTrust(dir)
  }
}

function workspaceAndGitRootPaths(dir: string): string[] {
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

export function stampAgyWorkspaceTrust(dir: string, customSettingsPath?: string): boolean {
  if (process.env.VITEST && !customSettingsPath) return false
  try {
    const settingsPath = customSettingsPath || join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 })
    if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) return false
    let data: Record<string, unknown> = {}
    if (existsSync(settingsPath)) {
      try {
        data = JSON.parse(readFileSync(settingsFileOrPath(settingsPath), 'utf-8')) as Record<string, unknown>
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

function settingsFileOrPath(p: string): string {
  return p
}
