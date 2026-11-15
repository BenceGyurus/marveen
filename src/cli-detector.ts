import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs'
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
 * Ensure an agent/worker directory has instruction symlinks (`AGENTS.md`, `GEMINI.md`, etc. -> `CLAUDE.md`),
 * pre-trust the workspace in the target CLI provider's local config, and synchronize MCP servers
 * (including Headroom `headroom mcp serve` when available).
 */
export function prepareWorkspaceForCli(dir: string, cliType: CliType): void {
  const provider = getCliProvider(cliType)
  try {
    const claudeMd = join(dir, 'CLAUDE.md')
    if (existsSync(claudeMd) && !lstatSync(claudeMd).isSymbolicLink()) {
      const instructionTargets = new Set<string>(['AGENTS.md', 'GEMINI.md', ...provider.instructionFiles])
      instructionTargets.delete('CLAUDE.md')
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
          try { symlinkSync('CLAUDE.md', altPath) } catch { /* ignore */ }
        }
      }
    }
  } catch { /* best-effort instruction symlink */ }

  provider.stampWorkspaceTrust(dir)
  syncCliMcpConfig(cliType, join(dir, '.mcp.json'))
}

/**
 * Resolve the configured CLI runtime for the main orchestrator session
 * (`claude`, `codex`, `agy`, etc.) from `<projectRoot>/.env` (`MAIN_AGENT_MODEL`),
 * `process.env.MAIN_AGENT_MODEL`, or `<projectRoot>/.claude/settings.json`.
 * Defaults to `'claude'` when no non-Claude model is configured.
 */
export function resolveConfiguredMainCliType(projectRoot: string): CliType {
  try {
    const envPath = join(projectRoot, '.env')
    if (existsSync(envPath)) {
      const parsed = parseEnvContent(readFileSync(envPath, 'utf-8'), ['MAIN_AGENT_MODEL'])
      const fromEnv = parsed.MAIN_AGENT_MODEL?.trim()
      if (fromEnv) return getCliTypeForModel(fromEnv)
    }
  } catch { /* ignore */ }

  const procModel = process.env.MAIN_AGENT_MODEL?.trim()
  if (procModel) return getCliTypeForModel(procModel)

  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { model?: unknown }
      if (typeof parsed?.model === 'string' && parsed.model.trim()) {
        return getCliTypeForModel(parsed.model.trim())
      }
    }
  } catch { /* ignore */ }

  return 'claude'
}
