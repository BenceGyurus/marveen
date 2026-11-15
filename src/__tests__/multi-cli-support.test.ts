import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  getCliTypeForModel,
  getCliProvider,
  listCliProviders,
  listNonClaudeCliProviders,
  stripCliModelPrefix,
  formatCliModelId,
  getCodexAvailableModels,
  getAgyAvailableModels,
  prepareWorkspaceForCli,
  stampCodexWorkspaceTrust,
  stampAgyWorkspaceTrust,
  resolveHeadroomBinary,
  resolveHeadroomLauncher,
  detectHeadroomInfo,
  syncCliMcpConfig,
} from '../cli-detector.js'
import {
  detectPaneState,
  shouldRetrySubmit,
  parkedInputText,
  detectsFirstRunGate,
  firstRunAcceptKeys,
} from '../pane-state.js'
import { buildRemoteLaunchCommand } from '../web/ssh-tmux.js'
import {
  findAltCliTranscriptForWorkingDir,
  readAltCliActiveModel,
  readLastAssistantModel,
  readLastTurnActivityMs,
  readContextTokensFromProjectDir,
  readTranscriptMtimeFromProjectDir,
  readTranscriptTailFromProjectDir,
  readLastConversationTsFromProjectDir,
} from '../web/active-model.js'

describe('cli-detector: model to CLI routing and dynamic model extraction', () => {
  it('routes Claude, DeepSeek, MiniMax, OpenRouter, Ollama and custom providers to claude', () => {
    for (const m of [
      '',
      'inherit',
      'claude-opus-5',
      'claude-fable-5-2',
      'claude-opus-5-5[1m]',
      'deepseek-v4-pro',
      'minimax-m3',
      'openrouter-auto:coding',
      'ollama:qwen3:32b',
      'custom:my-litellm',
    ]) {
      expect(getCliTypeForModel(m), m).toBe('claude')
    }
  })

  it('routes GPT, o-series, codex-* and codex: prefixed models to codex', () => {
    for (const m of [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'o3',
      'o4-mini',
      'codex:gpt-5.4',
      'openai:gpt-5.4',
    ]) {
      expect(getCliTypeForModel(m), m).toBe('codex')
    }
  })

  it('routes Gemini and agy:/antigravity: prefixed models to agy', () => {
    for (const m of [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'agy:claude-sonnet-4-6',
      'antigravity:gemini-2.5-pro',
    ]) {
      expect(getCliTypeForModel(m), m).toBe('agy')
    }
  })

  it('strips explicit CLI prefixes and normalizes default/auto', () => {
    expect(stripCliModelPrefix('codex:gpt-5.4')).toBe('gpt-5.4')
    expect(stripCliModelPrefix('agy:claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(stripCliModelPrefix('codex:default')).toBe('')
    expect(stripCliModelPrefix('agy:auto')).toBe('')
    expect(stripCliModelPrefix('gpt-5.4')).toBe('gpt-5.4')
    expect(stripCliModelPrefix('gemini-2.5-flash')).toBe('gemini-2.5-flash')
  })

  it('dynamically extracts Codex and Antigravity models and registers them for CLI routing', () => {
    const fakeCodexHome = mkdtempSync(join(tmpdir(), 'marveen-codex-models-'))
    try {
      writeFileSync(
        join(fakeCodexHome, 'models_cache.json'),
        JSON.stringify({
          models: [
            { slug: 'custom-codex-alpha', display_name: 'Custom Codex Alpha', visibility: 'list', description: 'Fast model' },
            { slug: 'hidden-internal', display_name: 'Hidden', visibility: 'none' },
          ],
        }),
      )
      writeFileSync(join(fakeCodexHome, 'config.toml'), 'model = "configured-codex-beta"\n')

      const codex = getCodexAvailableModels({ codexHome: fakeCodexHome })
      expect(codex.map(m => m.id)).toEqual(['codex:custom-codex-alpha', 'codex:configured-codex-beta'])
      expect(codex.map(m => m.rawId)).toEqual(['custom-codex-alpha', 'configured-codex-beta'])
      expect(codex[0]?.cli).toBe('codex')
      expect(codex[0]?.label).toBe('Custom Codex Alpha (Codex)')
      expect(getCliTypeForModel('codex:custom-codex-alpha')).toBe('codex')
      expect(getCliTypeForModel('custom-codex-alpha')).toBe('codex')
      expect(getCliTypeForModel('configured-codex-beta')).toBe('codex')

      const agy = getAgyAvailableModels({
        runner: () => [
          'Fetching available models...',
          '\r- Fetching available models...\r  dynamic-agy-model-v1   Dynamic Agy Model',
          '  • Secondary Agy Model (secondary-agy-v2)',
          '  claude-opus-5-5-high   Claude Opus 4.6 (Thinking)',
          '  gpt-oss-120b-medium    GPT-OSS 120B (Medium)',
        ].join('\n'),
        settingsPath: join(fakeCodexHome, 'nonexistent-settings.json'),
      })
      expect(agy.map(m => m.id)).toEqual([
        'agy:dynamic-agy-model-v1',
        'agy:secondary-agy-v2',
        'agy:claude-opus-5-5-high',
        'agy:gpt-oss-120b-medium',
      ])
      expect(agy[0]?.label).toBe('Dynamic Agy Model (Antigravity)')
      expect(agy[2]?.cli).toBe('agy')
      expect(agy[2]?.rawId).toBe('claude-opus-5-5-high')
      expect(getCliTypeForModel('agy:dynamic-agy-model-v1')).toBe('agy')
      expect(getCliTypeForModel('dynamic-agy-model-v1')).toBe('agy')
      expect(getCliTypeForModel('secondary-agy-v2')).toBe('agy')
      // Shared Claude/GPT names stay unambiguous across agents
      expect(getCliTypeForModel('agy:claude-opus-5-5-high')).toBe('agy')
      expect(getCliTypeForModel('claude-opus-5-5-high')).toBe('agy')
      expect(getCliTypeForModel('claude-opus-4-6')).toBe('claude')
      expect(getCliTypeForModel('agy:gpt-oss-120b-medium')).toBe('agy')
      expect(getCliTypeForModel('codex:gpt-5.4')).toBe('codex')
    } finally {
      rmSync(fakeCodexHome, { recursive: true, force: true })
    }
  })
})

describe('cli-detector: workspace instruction mirroring', () => {
  it('creates AGENTS.md and GEMINI.md instruction symlinks to CLAUDE.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-multi-cli-ws-'))
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), '# Agent Instructions\nAlways answer in Hungarian.\n')

      prepareWorkspaceForCli(dir, 'codex')
      const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf-8')
      const geminiMd = readFileSync(join(dir, 'GEMINI.md'), 'utf-8')
      expect(agentsMd).toContain('# Agent Instructions')
      expect(geminiMd).toContain('Always answer in Hungarian.')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pane-state: Codex and Antigravity TUI recognition', () => {
  const CODEX_IDLE_PANE = [
    '╭───────────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.169.0)                    │',
    '│                                               │',
    '│ model:     gpt-5.4       /model to change     │',
    '│ directory: /private/tmp/agent-codex           │',
    '╰───────────────────────────────────────────────╯',
    '',
    '› Ask Codex to do anything',
    '',
    '  gpt-5.4 · 100% left · /private/tmp/agent-codex',
  ].join('\n')

  const CODEX_TYPING_PANE = [
    '╭───────────────────────────────────────────────╮',
    '│ >_ OpenAI Codex (v0.169.0)                    │',
    '╰───────────────────────────────────────────────╯',
    '',
    '› Szia Codex, elemezd a projektet',
    '',
    '  gpt-5.4 · 100% left · /private/tmp/agent-codex',
  ].join('\n')

  const AGY_IDLE_PANE = [
    '  Welcome back!',
    '',
    '────────────────────────────────────────────────────────────────────────────────',
    '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
    '────────────────────────────────────────────────────────────────────────────────',
    '  auto · Gemini 2.5 Flash · high                                        marveen',
  ].join('\n')

  const AGY_TYPING_PANE = [
    '────────────────────────────────────────────────────────────────────────────────',
    '> Helló Antigravity, írj egy tesztet',
    '────────────────────────────────────────────────────────────────────────────────',
    '  auto · Gemini 2.5 Flash · high                                        marveen',
  ].join('\n')

  const AGY_BUSY_PANE = [
    '✦ Thinking... (esc to cancel, 4s)',
    '────────────────────────────────────────────────────────────────────────────────',
    '> ',
    '────────────────────────────────────────────────────────────────────────────────',
    '  auto · Gemini 2.5 Flash · high · esc to interrupt                     marveen',
  ].join('\n')

  const AGY_TRUST_MODAL = [
    '╭──────────────────────────────────────────────────────────────────────────────╮',
    '│ Do you trust the contents of this project?                                   │',
    '│                                                                              │',
    '│ > 1. Trust folder (/private/tmp/agent-agy)                                   │',
    '│   2. Trust parent folder (/private/tmp)                                      │',
    '│   3. Don\'t trust                                                             │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ].join('\n')

  it('recognizes Codex idle and typing states accurately', () => {
    expect(detectPaneState(CODEX_IDLE_PANE)).toBe('idle')
    expect(shouldRetrySubmit(CODEX_IDLE_PANE, 'Szia Codex, elemezd a projektet')).toBe(false)
    expect(parkedInputText(CODEX_IDLE_PANE)).toBeNull()

    expect(detectPaneState(CODEX_TYPING_PANE)).toBe('typing')
    expect(shouldRetrySubmit(CODEX_TYPING_PANE, 'Szia Codex, elemezd a projektet')).toBe(true)
    expect(parkedInputText(CODEX_TYPING_PANE)).toBe('Szia Codex, elemezd a projektet')
  })

  it('recognizes Antigravity idle, typing, busy, and workspace trust gate states', () => {
    expect(detectPaneState(AGY_IDLE_PANE)).toBe('idle')
    expect(shouldRetrySubmit(AGY_IDLE_PANE, 'Helló Antigravity, írj egy tesztet')).toBe(false)
    expect(parkedInputText(AGY_IDLE_PANE)).toBeNull()

    expect(detectPaneState(AGY_TYPING_PANE)).toBe('typing')
    expect(shouldRetrySubmit(AGY_TYPING_PANE, 'Helló Antigravity, írj egy tesztet')).toBe(true)
    expect(parkedInputText(AGY_TYPING_PANE)).toBe('Helló Antigravity, írj egy tesztet')

    expect(detectPaneState(AGY_BUSY_PANE)).toBe('busy')

    expect(detectsFirstRunGate(AGY_TRUST_MODAL)).toBe('trust')
    expect(firstRunAcceptKeys(AGY_TRUST_MODAL)).toEqual(['Enter'])
  })
})

describe('ssh-tmux: buildRemoteLaunchCommand multi-CLI support', () => {
  it('builds remote launch commands for claude, codex, and agy', () => {
    const claudeCmd = buildRemoteLaunchCommand({ workdir: '/srv/agent', model: 'claude-opus-5', continue: true })
    expect(claudeCmd).toContain('claude --continue --dangerously-skip-permissions --model')

    const codexCmd = buildRemoteLaunchCommand({ workdir: '/srv/agent', model: 'gpt-5.4', continue: false })
    expect(codexCmd).toContain('codex --dangerously-bypass-approvals-and-sandbox -m')
    expect(codexCmd).toContain('gpt-5.4')

    const agyCmd = buildRemoteLaunchCommand({ workdir: '/srv/agent', model: 'gemini-2.5-flash', continue: false })
    expect(agyCmd).toContain('agy --dangerously-skip-permissions --model')
    expect(agyCmd).toContain('gemini-2.5-flash')
  })
})

describe('active-model: Antigravity and Codex transcript readers', () => {
  it('reads active model from Antigravity brain transcript and Codex rollout transcript', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'marveen-alt-cli-home-'))
    const agyWorkdir = join(fakeHome, 'ws-agy')
    const codexWorkdir = join(fakeHome, 'ws-codex')
    try {
      mkdirSync(agyWorkdir, { recursive: true })
      mkdirSync(codexWorkdir, { recursive: true })

      // 1. Antigravity fixture
      const convId = '11111111-2222-3333-4444-555555555555'
      const agyCacheDir = join(fakeHome, '.gemini', 'antigravity-cli', 'cache')
      const agyLogsDir = join(fakeHome, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs')
      mkdirSync(agyCacheDir, { recursive: true })
      mkdirSync(agyLogsDir, { recursive: true })
      writeFileSync(join(agyCacheDir, 'last_conversations.json'), JSON.stringify({ [agyWorkdir]: convId }))
      writeFileSync(
        join(agyLogsDir, 'transcript.jsonl'),
        [
          JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-15T18:00:00Z', content: 'Hello' }),
          JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-15T18:00:02Z', model: 'gemini-2.5-flash', content: 'Szia!' }),
        ].join('\n') + '\n',
      )

      const foundAgy = findAltCliTranscriptForWorkingDir(agyWorkdir, fakeHome)
      expect(foundAgy?.cli).toBe('agy')
      expect(readAltCliActiveModel(agyWorkdir, undefined, fakeHome)).toBe('agy:gemini-2.5-flash')

      // 2. Codex fixture
      const codexDayDir = join(fakeHome, '.codex', 'sessions', '2026', '11', '15')
      mkdirSync(codexDayDir, { recursive: true })
      writeFileSync(
        join(codexDayDir, 'rollout-test.jsonl'),
        [
          JSON.stringify({ timestamp: '2026-11-15T18:01:00Z', type: 'session_meta', payload: { cwd: codexWorkdir } }),
          JSON.stringify({ timestamp: '2026-11-15T18:01:01Z', type: 'turn_context', payload: { cwd: codexWorkdir, model: 'gpt-5.4' } }),
          JSON.stringify({
            timestamp: '2026-11-15T18:01:02Z',
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rendben!' }] },
          }),
          JSON.stringify({
            timestamp: '2026-11-15T18:01:03Z',
            type: 'event_msg',
            payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12000, cached_input_tokens: 3000, total_tokens: 15400 } } },
          }),
        ].join('\n') + '\n',
      )

      const foundCodex = findAltCliTranscriptForWorkingDir(codexWorkdir, fakeHome)
      expect(foundCodex?.cli).toBe('codex')
      expect(readAltCliActiveModel(codexWorkdir, undefined, fakeHome)).toBe('codex:gpt-5.4')
      expect(readLastAssistantModel(codexWorkdir, undefined, fakeHome)?.model).toBe('codex:gpt-5.4')
      expect(readLastTurnActivityMs(codexWorkdir, undefined, fakeHome)).toBe(Date.parse('2026-11-15T18:01:02Z'))
      expect(readContextTokensFromProjectDir(codexWorkdir, undefined, fakeHome)).toBe(15400)
      expect(readTranscriptMtimeFromProjectDir(codexWorkdir, undefined, fakeHome)).toBeGreaterThan(0)
      expect(readTranscriptTailFromProjectDir(codexWorkdir, undefined, 4096, fakeHome)).toContain('Rendben!')
      expect(readLastConversationTsFromProjectDir(codexWorkdir, undefined, 4096, fakeHome)).toBe(Date.parse('2026-11-15T18:01:03Z'))

      expect(readLastAssistantModel(agyWorkdir, undefined, fakeHome)?.model).toBe('agy:gemini-2.5-flash')
      expect(readLastTurnActivityMs(agyWorkdir, undefined, fakeHome)).toBe(Date.parse('2026-11-15T18:00:02Z'))
      expect(readLastConversationTsFromProjectDir(agyWorkdir, undefined, 4096, fakeHome)).toBe(Date.parse('2026-11-15T18:00:02Z'))

      // 3. Provider registry contract
      expect(listCliProviders().map(p => p.id)).toEqual(['claude', 'codex', 'agy'])
      expect(listNonClaudeCliProviders().map(p => p.id)).toEqual(['codex', 'agy'])
      expect(getCliProvider('claude').supportsClaudeChannelsFlag).toBe(true)
      expect(getCliProvider('codex').supportsClaudeChannelsFlag).toBe(false)
      expect(getCliProvider('agy').supportsClaudeChannelsFlag).toBe(false)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('enforces security guards: blocks CLI flag injection, path traversal, symlinks, and credential leaks', () => {
    // 1. CLI option/flag & command injection rejected by stripCliModelPrefix
    expect(stripCliModelPrefix('--dangerously-bypass-approvals-and-sandbox')).toBe('')
    expect(stripCliModelPrefix('codex:-c shell_environment_policy.inherit=all')).toBe('')
    expect(stripCliModelPrefix('agy:--mode=agent')).toBe('')
    expect(stripCliModelPrefix('gpt-5.4; rm -rf /')).toBe('')
    expect(stripCliModelPrefix('gemini-2.5-flash\n--malicious')).toBe('')

    // 2. Credential isolation on remote launches for non-Claude CLIs
    const codexRemote = buildRemoteLaunchCommand({ workdir: '/srv/a', model: 'gpt-5.4', continue: false })
    expect(codexRemote).toContain('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY')
    const agyRemote = buildRemoteLaunchCommand({ workdir: '/srv/a', model: 'gemini-2.5-flash', continue: false })
    expect(agyRemote).toContain('unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY')

    // 3. Path traversal & symlink protection in findAltCliTranscriptForWorkingDir and workspace trust stamping
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-sec-test-'))
    try {
      const wsDir = join(tmp, 'ws')
      mkdirSync(wsDir, { recursive: true })
      const cacheDir = join(tmp, '.gemini', 'antigravity-cli', 'cache')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(
        join(cacheDir, 'last_conversations.json'),
        JSON.stringify({ [wsDir]: '../../../etc/passwd' }),
      )
      expect(findAltCliTranscriptForWorkingDir(wsDir, tmp)).toBeNull()

      // 4. 0o600 permissions & symlink refusal on config files
      const codexCfg = join(tmp, 'codex-config.toml')
      expect(stampCodexWorkspaceTrust(wsDir, codexCfg)).toBe(true)
      expect(statSync(codexCfg).mode & 0o777).toBe(0o600)

      const agyCfg = join(tmp, 'agy-settings.json')
      expect(stampAgyWorkspaceTrust(wsDir, agyCfg)).toBe(true)
      expect(statSync(agyCfg).mode & 0o777).toBe(0o600)

      const symlinkCfg = join(tmp, 'symlink-settings.json')
      symlinkSync(agyCfg, symlinkCfg)
      expect(stampAgyWorkspaceTrust(join(tmp, 'other-ws'), symlinkCfg)).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('headroom integration: launcher, MCP config sync, and sandboxed installer', () => {
  it('formats canonical model IDs cleanly per CLI agent', () => {
    expect(formatCliModelId('agy', 'claude-opus-5-5-high')).toBe('agy:claude-opus-5-5-high')
    expect(formatCliModelId('codex', 'gpt-5.4')).toBe('codex:gpt-5.4')
    expect(formatCliModelId('codex', 'codex:gpt-5.4')).toBe('codex:gpt-5.4')
    expect(formatCliModelId('claude', 'claude-opus-4-6')).toBe('claude-opus-4-6')
    expect(formatCliModelId('claude', 'claude:claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  it('resolves headroom launcher wrappers for claude, codex, and agy with safe fallbacks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-headroom-launcher-'))
    try {
      const fakeHr = join(tmp, 'headroom')
      writeFileSync(
        fakeHr,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "--version" ]; then echo "headroom 0.9.9"; exit 0; fi',
          'if [ "$1" = "wrap" ] && [ "$2" = "--help" ]; then',
          '  echo "Supported tools: claude, codex, agy"',
          '  exit 0',
          'fi',
          'exit 0',
        ].join('\n') + '\n',
      )
      chmodSync(fakeHr, 0o755)

      const env = { HEADROOM_BIN: fakeHr, PATH: '/usr/bin:/bin' }
      expect(resolveHeadroomBinary({ env, homeDir: tmp })).toBe(fakeHr)

      const info = detectHeadroomInfo({ env, homeDir: tmp })
      expect(info.available).toBe(true)
      expect(info.enabled).toBe(true)
      expect(info.binPath).toBe(fakeHr)
      expect(info.version).toBe('headroom 0.9.9')
      expect(info.wrapTargets).toEqual(expect.arrayContaining(['claude', 'codex', 'agy']))

      expect(resolveHeadroomLauncher('claude', "'/opt/bin/claude'", { env, homeDir: tmp })).toBe(`${fakeHr} wrap claude --`)
      expect(resolveHeadroomLauncher('codex', "'/opt/bin/codex'", { env, homeDir: tmp })).toBe(`${fakeHr} wrap codex --`)
      expect(resolveHeadroomLauncher('agy', "'/opt/bin/agy'", { env, homeDir: tmp })).toBe(`${fakeHr} wrap agy --`)

      // Custom OpenRouter/DeepSeek Anthropic Base URL skips Headroom proxy wrap on claude
      expect(resolveHeadroomLauncher('claude', "'/opt/bin/claude'", { hasCustomBaseUrl: true, env, homeDir: tmp })).toBe("'/opt/bin/claude'")

      // MARVEEN_HEADROOM=0 opt-out falls back cleanly to the raw CLI binary
      const disabledEnv = { ...env, MARVEEN_HEADROOM: '0' }
      expect(resolveHeadroomLauncher('claude', "'/opt/bin/claude'", { env: disabledEnv, homeDir: tmp })).toBe("'/opt/bin/claude'")
      expect(resolveHeadroomLauncher('codex', "'/opt/bin/codex'", { env: disabledEnv, homeDir: tmp })).toBe("'/opt/bin/codex'")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('syncs headroom MCP server configuration safely for claude, codex, and agy without leaking credentials', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-headroom-mcp-'))
    try {
      const fakeHr = join(tmp, 'headroom')
      writeFileSync(fakeHr, '#!/usr/bin/env bash\necho "0.9.9"\n')
      chmodSync(fakeHr, 0o755)

      const env = { HEADROOM_BIN: fakeHr, PATH: '/usr/bin:/bin' }

      // 1. Claude .mcp.json (written cleanly and preserves unrelated servers)
      const mcpJsonPath = join(tmp, '.mcp.json')
      writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { existing: { command: 'node', args: ['x.js'] } } }))
      expect(syncCliMcpConfig('claude', mcpJsonPath, { env, homeDir: tmp })).toBe(true)
      const parsedClaudeMcp = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
      expect(parsedClaudeMcp.mcpServers.existing).toEqual({ command: 'node', args: ['x.js'] })
      expect(parsedClaudeMcp.mcpServers.headroom).toEqual({ command: fakeHr, args: ['mcp', 'serve'] })
      expect(statSync(mcpJsonPath).mode & 0o777).toBe(0o600)

      // 2. Codex ~/.codex/config.toml (adds [mcp_servers.headroom] + forwards non-secret servers, strips API keys)
      const codexWs = join(tmp, 'ws-codex')
      mkdirSync(codexWs, { recursive: true })
      writeFileSync(
        join(codexWs, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            memoryTool: {
              command: 'npx',
              args: ['-y', 'memory-mcp'],
              env: { MEMORY_DIR: '/tmp/mem', ANTHROPIC_API_KEY: 'sk-ant-secret', CUSTOM_TOKEN: 'secret-tok' },
            },
          },
        }),
      )
      expect(syncCliMcpConfig('codex', join(codexWs, '.mcp.json'), { env, homeDir: tmp })).toBe(true)
      const codexToml = readFileSync(join(tmp, '.codex', 'config.toml'), 'utf-8')
      expect(codexToml).toContain('[mcp_servers.headroom]')
      expect(codexToml).toContain('args = ["mcp","serve"]')
      expect(codexToml).toContain('[mcp_servers.memoryTool]')
      expect(codexToml).toContain('MEMORY_DIR = "/tmp/mem"')
      expect(codexToml).not.toContain('sk-ant-secret')
      expect(codexToml).not.toContain('secret-tok')
      expect(statSync(join(tmp, '.codex', 'config.toml')).mode & 0o777).toBe(0o600)

      // 3. Antigravity ~/.gemini/antigravity/mcp_config.json
      expect(syncCliMcpConfig('agy', join(codexWs, '.mcp.json'), { env, homeDir: tmp })).toBe(true)
      const agyMcp = JSON.parse(readFileSync(join(tmp, '.gemini', 'antigravity', 'mcp_config.json'), 'utf-8'))
      expect(agyMcp.mcpServers.headroom).toEqual({ command: fakeHr, args: ['mcp', 'serve'] })
      expect(agyMcp.mcpServers.memoryTool.env).toEqual({ MEMORY_DIR: '/tmp/mem' })

      // 4. Refuses symlinks on MCP targets
      const evilTarget = join(tmp, 'evil.txt')
      writeFileSync(evilTarget, 'untouched')
      const symlinkMcp = join(tmp, 'symlink.mcp.json')
      symlinkSync(evilTarget, symlinkMcp)
      expect(syncCliMcpConfig('claude', symlinkMcp, { env, homeDir: tmp })).toBe(false)
      expect(readFileSync(evilTarget, 'utf-8')).toBe('untouched')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('installs headroom in an isolated temp HOME using mock uv without modifying host paths', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const repoRoot = resolve(here, '..', '..')
    const scriptPath = join(repoRoot, 'scripts', 'install-headroom.sh')
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-headroom-install-sandbox-'))
    try {
      const fakeHome = join(tmp, 'home')
      const mockBin = join(tmp, 'mock-bin')
      const logFile = join(tmp, 'uv-calls.log')
      mkdirSync(fakeHome, { recursive: true })
      mkdirSync(mockBin, { recursive: true })

      const mockUv = join(mockBin, 'uv')
      writeFileSync(
        mockUv,
        [
          '#!/usr/bin/env bash',
          `echo "$@" >> "${logFile}"`,
          `mkdir -p "${fakeHome}/.local/bin"`,
          `printf '#!/usr/bin/env bash\\necho "headroom 0.9.9-sandbox"\\n' > "${fakeHome}/.local/bin/headroom"`,
          `chmod +x "${fakeHome}/.local/bin/headroom"`,
          'exit 0',
        ].join('\n') + '\n',
      )
      chmodSync(mockUv, 0o755)

      // 1. Respects MARVEEN_HEADROOM=0 opt-out
      execFileSync('bash', [scriptPath], {
        env: { HOME: fakeHome, PATH: `${mockBin}:/usr/bin:/bin`, MARVEEN_HEADROOM: '0' },
        encoding: 'utf-8',
      })
      expect(existsSync(join(fakeHome, '.local', 'bin', 'headroom'))).toBe(false)

      // 2. Installs into fake HOME via mock uv without touching real user ~/.local
      const out = execFileSync('bash', [scriptPath], {
        env: { HOME: fakeHome, PATH: `${mockBin}:/usr/bin:/bin` },
        encoding: 'utf-8',
      })
      expect(out).toContain('Headroom telepitve (uv)')
      expect(readFileSync(logFile, 'utf-8')).toContain('tool install headroom-ai[all]')
      expect(existsSync(join(fakeHome, '.local', 'bin', 'headroom'))).toBe(true)

      // 3. Fallback to isolated Python venv when uv is unavailable
      const venvHome = join(tmp, 'venv-home')
      const venvDir = join(tmp, 'custom-venv')
      const pyMockBin = join(tmp, 'py-only-bin')
      const pipLog = join(tmp, 'pip-calls.log')
      mkdirSync(venvHome, { recursive: true })
      mkdirSync(pyMockBin, { recursive: true })
      const fakePy = join(pyMockBin, 'python3')
      writeFileSync(
        fakePy,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "-c" ]; then exit 0; fi',
          'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
          '  target="$3"',
          '  mkdir -p "$target/bin"',
          '  printf "#!/usr/bin/env bash\\nexit 0\\n" > "$target/bin/python"',
          '  cat > "$target/bin/pip" <<PIPEOF',
          '#!/usr/bin/env bash',
          `echo "\\$@" >> "${pipLog}"`,
          'printf "#!/usr/bin/env bash\\necho headroom-venv\\n" > "$target/bin/headroom"',
          'chmod +x "$target/bin/headroom"',
          'exit 0',
          'PIPEOF',
          '  chmod +x "$target/bin/python" "$target/bin/pip"',
          '  exit 0',
          'fi',
          'exit 1',
        ].join('\n') + '\n',
      )
      chmodSync(fakePy, 0o755)
      const venvOut = execFileSync('bash', [scriptPath], {
        env: {
          HOME: venvHome,
          PATH: `${pyMockBin}:/usr/bin:/bin`,
          PYTHON3_BIN: fakePy,
          MARVEEN_HEADROOM_VENV: venvDir,
        },
        encoding: 'utf-8',
      })
      expect(venvOut).toContain('Headroom telepitve')
      expect(readFileSync(pipLog, 'utf-8')).toContain('headroom-ai[all]')
      expect(existsSync(join(venvHome, '.local', 'bin', 'headroom'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
