import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getCliTypeForModel,
  stripCliModelPrefix,
  getCodexAvailableModels,
  getAgyAvailableModels,
  prepareWorkspaceForCli,
  stampCodexWorkspaceTrust,
  stampAgyWorkspaceTrust,
} from '../cli-detector.js'
import {
  detectPaneState,
  shouldRetrySubmit,
  parkedInputText,
  detectsFirstRunGate,
  firstRunAcceptKeys,
} from '../pane-state.js'
import { buildRemoteLaunchCommand } from '../web/ssh-tmux.js'
import { findAltCliTranscriptForWorkingDir, readAltCliActiveModel } from '../web/active-model.js'

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
      expect(codex.map(m => m.id)).toEqual(['custom-codex-alpha', 'configured-codex-beta'])
      expect(codex[0]?.label).toBe('Custom Codex Alpha (Codex)')
      expect(getCliTypeForModel('custom-codex-alpha')).toBe('codex')
      expect(getCliTypeForModel('configured-codex-beta')).toBe('codex')

      const agy = getAgyAvailableModels({
        runner: () => [
          'Fetching available models...',
          'dynamic-agy-model-v1\tDynamic Agy Model',
          '  • Secondary Agy Model (secondary-agy-v2)',
        ].join('\n'),
        settingsPath: join(fakeCodexHome, 'nonexistent-settings.json'),
      })
      expect(agy.map(m => m.id)).toEqual(['dynamic-agy-model-v1', 'secondary-agy-v2'])
      expect(agy[0]?.label).toBe('Dynamic Agy Model (Antigravity)')
      expect(getCliTypeForModel('dynamic-agy-model-v1')).toBe('agy')
      expect(getCliTypeForModel('secondary-agy-v2')).toBe('agy')
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
      expect(readAltCliActiveModel(agyWorkdir, undefined, fakeHome)).toBe('gemini-2.5-flash')

      // 2. Codex fixture
      const codexDayDir = join(fakeHome, '.codex', 'sessions', '2026', '11', '15')
      mkdirSync(codexDayDir, { recursive: true })
      writeFileSync(
        join(codexDayDir, 'rollout-test.jsonl'),
        [
          JSON.stringify({ timestamp: '2026-11-15T18:01:00Z', type: 'session_meta', payload: { cwd: codexWorkdir } }),
          JSON.stringify({ timestamp: '2026-11-15T18:01:01Z', type: 'turn_context', payload: { cwd: codexWorkdir, model: 'gpt-5.4' } }),
        ].join('\n') + '\n',
      )

      const foundCodex = findAltCliTranscriptForWorkingDir(codexWorkdir, fakeHome)
      expect(foundCodex?.cli).toBe('codex')
      expect(readAltCliActiveModel(codexWorkdir, undefined, fakeHome)).toBe('gpt-5.4')
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
