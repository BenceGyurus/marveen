import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  resolveHeadroomBinary,
  resolveHeadroomLauncher,
} from '../cli-detector.js'
import { detectPaneState, shouldRetrySubmit } from '../pane-state.js'
import { contextLimitForModel } from '../context-guard.js'
import { refreshMcpListCache } from '../web/mcp-list.js'
import {
  readLastAssistantModel,
  readLastTurnActivityMs,
  readContextTokensFromProjectDir,
  readTranscriptMtimeFromProjectDir,
  readTranscriptTailFromProjectDir,
  readLastConversationTsFromProjectDir,
} from '../web/active-model.js'

const REPO = join(__dirname, '..', '..')
const BASH_PATH = `/bin:/usr/bin:/usr/local/bin:${dirname(process.execPath)}`

describe('Headroom resilience and custom base URL bypass', () => {
  it('rejects broken/unexecutable headroom venv binary and falls back to raw CLI', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-hr-broken-'))
    try {
      const brokenHr = join(tmp, 'headroom')
      writeFileSync(brokenHr, '#!/bin/sh\nexit 127\n', { mode: 0o755 })
      chmodSync(brokenHr, 0o755)
      expect(resolveHeadroomBinary({ env: { ...process.env, MARVEEN_HEADROOM_BIN: brokenHr } })).toBeNull()
      expect(resolveHeadroomLauncher('claude', '/usr/bin/claude', {
        env: { ...process.env, MARVEEN_HEADROOM_BIN: brokenHr },
      })).toBe('/usr/bin/claude')
      expect(resolveHeadroomLauncher('codex', '/usr/bin/codex', {
        env: { ...process.env, MARVEEN_HEADROOM_BIN: brokenHr },
      })).toBe('/usr/bin/codex')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('skips headroom when hasCustomBaseUrl is true across claude, codex, and agy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-hr-custom-'))
    try {
      const fakeHr = join(tmp, 'headroom')
      writeFileSync(
        fakeHr,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "headroom 0.9"; exit 0; fi\nif [ "$1" = "wrap" ]; then echo "wrap codex claude"; exit 0; fi\n',
        { mode: 0o755 },
      )
      chmodSync(fakeHr, 0o755)
      const env = { ...process.env, MARVEEN_HEADROOM_BIN: fakeHr, MARVEEN_HEADROOM_WRAP_AGY: '1' }
      expect(resolveHeadroomLauncher('claude', '/bin/claude', { hasCustomBaseUrl: true, env })).toBe('/bin/claude')
      expect(resolveHeadroomLauncher('codex', '/bin/codex', { hasCustomBaseUrl: true, env })).toBe('/bin/codex')
      expect(resolveHeadroomLauncher('agy', '/bin/agy', { hasCustomBaseUrl: true, env })).toBe('/bin/agy')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('Non-Claude CLI boot safety without claude on PATH', () => {
  it('refreshMcpListCache returns cleanly instead of throwing when claude binary is absent', async () => {
    const res = await refreshMcpListCache()
    expect(Array.isArray(res.entries)).toBe(true)
  })

  it('mcp-list.ts, background-tasks.ts, and system-status.ts import cleanly without claude on PATH', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'marveen-nopath-'))
    try {
      const out = execFileSync(
        process.execPath,
        [
          '-e',
          `import('./dist/web/mcp-list.js').then(() => import('./dist/web/routes/background-tasks.js')).then(() => console.log('OK'))`,
        ],
        { cwd: REPO, env: { ...process.env, PATH: emptyDir }, encoding: 'utf-8' },
      )
      expect(out.trim()).toBe('OK')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('pane-state: Antigravity footer detection and busy guard', () => {
  it('detects Antigravity CLI idle variants while preserving bare Claude shortcut fixture', () => {
    const agyIdle = [
      '────────────────────────────────────────────────────────────────────────',
      '>   Ask anything or @ to mention files',
      '────────────────────────────────────────────────────────────────────────',
      '  ~/marveen  ·  Gemini 4 Hydrogen Medium  ·  ? for shortcuts',
    ].join('\n')
    expect(detectPaneState(agyIdle)).toBe('idle')

    const agyMinimalFooter = [
      '────────────────────────────────────────────────────────────────────────',
      '>   Type your message or @path/to/file',
      '────────────────────────────────────────────────────────────────────────',
      '  gemini-2.5-pro · ? for shortcuts',
    ].join('\n')
    expect(detectPaneState(agyMinimalFooter)).toBe('idle')

    const bareClaudeShortcut = [
      '────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n')
    expect(detectPaneState(bareClaudeShortcut)).toBe('idle')
  })

  it('shouldRetrySubmit skips alt-CLI Enter retry when pane is busy or booting', () => {
    const busyPane = '⠋ Thinking...\n────────────────────────────────────────\n> some prompt\n────────────────────────────────────────\nGemini 2.5 Pro · ? for shortcuts'
    expect(shouldRetrySubmit(busyPane, 'some prompt')).toBe(false)
  })
})

describe('active-model: resolves alt-CLI transcripts even when configDir is supplied', () => {
  it('finds agy transcript across all helpers with an isolated configDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-alt-transcript-'))
    try {
      const workDir = join(tmp, 'proj')
      const configDir = join(tmp, '.isolated-claude')
      mkdirSync(workDir, { recursive: true })
      mkdirSync(configDir, { recursive: true })

      const convId = 'conv-1234'
      const cacheDir = join(tmp, '.gemini', 'antigravity-cli', 'cache')
      const logDir = join(tmp, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs')
      mkdirSync(cacheDir, { recursive: true })
      mkdirSync(logDir, { recursive: true })

      writeFileSync(join(cacheDir, 'last_conversations.json'), JSON.stringify({
        [workDir]: convId,
      }))
      const ts = new Date().toISOString()
      writeFileSync(join(logDir, 'transcript.jsonl'), [
        JSON.stringify({ type: 'USER_INPUT', created_at: ts, content: 'hello' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: ts, model: 'gemini-4-hydrogen-medium', content: 'hi' }),
      ].join('\n') + '\n')

      expect(readLastAssistantModel(workDir, configDir, tmp)?.model).toBe('agy:gemini-4-hydrogen-medium')
      expect(readLastTurnActivityMs(workDir, configDir, tmp)).toBeGreaterThan(0)
      expect(readTranscriptMtimeFromProjectDir(workDir, configDir, tmp)).toBeGreaterThan(0)
      expect(readTranscriptTailFromProjectDir(workDir, configDir, 65536, tmp)).toContain('gemini-4-hydrogen-medium')
      expect(readLastConversationTsFromProjectDir(workDir, configDir, 65536, tmp)).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reads codex context tokens with an isolated configDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-codex-tokens-'))
    try {
      const workDir = join(tmp, 'proj')
      const configDir = join(tmp, '.isolated-claude')
      const sessDir = join(tmp, '.codex', 'sessions', '2026', '11', '15')
      mkdirSync(workDir, { recursive: true })
      mkdirSync(configDir, { recursive: true })
      mkdirSync(sessDir, { recursive: true })
      const ts = new Date().toISOString()
      writeFileSync(join(sessDir, 'rollout-1.jsonl'), [
        JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { cwd: workDir } }),
        JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { cwd: workDir, model: 'gpt-5.4' } }),
        JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 4321, input_tokens: 3000 } } } }),
      ].join('\n') + '\n')

      expect(readLastAssistantModel(workDir, configDir, tmp)?.model).toBe('codex:gpt-5.4')
      expect(readContextTokensFromProjectDir(workDir, configDir, tmp)).toBe(4321)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('context-guard: Gemini and OpenAI/Codex model limits', () => {
  it('maps Gemini and GPT-4.1 to 1M and GPT-5 to 400k', () => {
    expect(contextLimitForModel('gemini-4-hydrogen-medium')).toBe(1_000_000)
    expect(contextLimitForModel('agy:gemini-2.5-pro')).toBe(1_000_000)
    expect(contextLimitForModel('google/gemini-2.5-flash')).toBe(1_000_000)
    expect(contextLimitForModel('gpt-4.1')).toBe(1_000_000)
    expect(contextLimitForModel('codex:gpt-5.4')).toBe(400_000)
    expect(contextLimitForModel('gpt-5.4')).toBe(400_000)
  })
})

describe('Shell helpers & watchdogs: global multi-CLI compatibility', () => {
  it('main-cli-type.sh unquotes .env models and falls back to settings.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-sh-cli-'))
    try {
      const envFile = join(tmp, '.env')
      writeFileSync(envFile, 'MAIN_AGENT_MODEL="gemini-4-hydrogen-medium"\n')
      const agyOut = execFileSync('bash', [
        '-c',
        `source "${join(REPO, 'scripts', 'lib', 'main-cli-type.sh')}" && marveen_main_cli_type "${tmp}"`,
      ], { env: { PATH: BASH_PATH }, encoding: 'utf-8' }).trim()
      expect(agyOut).toBe('agy')

      writeFileSync(envFile, "MAIN_AGENT_MODEL='gpt-5.4'\n")
      const codexOut = execFileSync('bash', [
        '-c',
        `source "${join(REPO, 'scripts', 'lib', 'main-cli-type.sh')}" && marveen_main_cli_type "${tmp}"`,
      ], { env: { PATH: BASH_PATH }, encoding: 'utf-8' }).trim()
      expect(codexOut).toBe('codex')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('stuck-modal-guard.sh and channel-watchdog.sh exit 0 cleanly on non-Claude orchestrator without claude binary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'marveen-guard-'))
    try {
      mkdirSync(join(tmp, 'scripts', 'lib'), { recursive: true })
      mkdirSync(join(tmp, 'store'), { recursive: true })
      writeFileSync(join(tmp, '.env'), 'MAIN_AGENT_MODEL="gemini-4-hydrogen-medium"\n')
      writeFileSync(join(tmp, 'scripts', 'lib', 'main-cli-type.sh'), readFileSync(join(REPO, 'scripts', 'lib', 'main-cli-type.sh')))
      writeFileSync(join(tmp, 'scripts', 'stuck-modal-guard.sh'), readFileSync(join(REPO, 'scripts', 'stuck-modal-guard.sh')), { mode: 0o755 })
      writeFileSync(join(tmp, 'scripts', 'channel-watchdog.sh'), readFileSync(join(REPO, 'scripts', 'channel-watchdog.sh')), { mode: 0o755 })

      const guardRes = spawnSync('bash', [join(tmp, 'scripts', 'stuck-modal-guard.sh')], {
        env: { PATH: BASH_PATH, HOME: tmp, CLAUDE_CLAW_ROOT: tmp },
        encoding: 'utf-8',
      })
      expect(guardRes.status).toBe(0)

      const wdRes = spawnSync('bash', [join(tmp, 'scripts', 'channel-watchdog.sh')], {
        env: { PATH: BASH_PATH, HOME: tmp, PROJECT_DIR: tmp, STORE_DIR: join(tmp, 'store') },
        encoding: 'utf-8',
      })
      expect(wdRes.status).toBe(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
