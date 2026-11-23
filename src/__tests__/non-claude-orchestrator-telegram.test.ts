import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  SANDBOX_ROOT,
  SANDBOX_HOME,
  SANDBOX_PROJECT,
  mockGetPendingMessages,
  mockSendPromptToSession,
  mockIsSessionReady,
  mockSessionExists,
  mockMarkMessageDelivered,
} = vi.hoisted(() => {
  const { mkdtempSync: mkd, mkdirSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  const root = mkd(j(td(), 'marveen-nonclaude-tg-'))
  const home = j(root, 'home')
  const proj = j(root, 'project')
  mk(home, { recursive: true })
  mk(proj, { recursive: true })
  return {
    SANDBOX_ROOT: root,
    SANDBOX_HOME: home,
    SANDBOX_PROJECT: proj,
    mockGetPendingMessages: vi.fn<() => Array<Record<string, unknown>>>(() => []),
    mockSendPromptToSession: vi.fn(async (..._a: unknown[]) => 'sent' as const),
    mockIsSessionReady: vi.fn(async (..._a: unknown[]) => true),
    mockSessionExists: vi.fn((..._a: unknown[]) => true),
    mockMarkMessageDelivered: vi.fn((..._a: unknown[]) => true),
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: SANDBOX_PROJECT,
  STORE_DIR: join(SANDBOX_PROJECT, 'store'),
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => (toAgent ? [] : mockGetPendingMessages()),
  getMessageStatus: () => 'pending',
  markMessageDelivered: (...a: unknown[]) => mockMarkMessageDelivered(...a),
  markMessageDone: () => true,
  markMessageFailed: () => true,
  ABANDONED_SESSION_ABSENT: 'abandoned',
  markPendingFederatedFailed: () => true,
  markPendingMessageFailed: () => true,
  setMessageResult: () => true,
  createAgentMessage: () => ({ id: 999 }),
  lastMessageFromAgentAt: () => null,
  countNewerMessagesFromSameSender: () => 0,
  stampMessageTrace: () => false,
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => join(SANDBOX_PROJECT, 'store', '.claude-channels', 'telegram'),
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(SANDBOX_PROJECT, 'agents', name),
  isKnownAgent: () => false,
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
  readAgentPullDelivery: () => false,
  readAgentChannelProvider: () => null,
}))

vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsSessionReady(...a),
  clearStaleParkedInput: vi.fn(() => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExists(...a),
  capturePane: vi.fn(async () => ''),
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

import { resolveConfiguredMainCliType } from '../cli-detector.js'
import { decideNativeChannelDown } from '../channel-coordinator/liveness.js'
import {
  resolveCoordinatorTelegramToken,
  loadTelegramAccessPolicy,
  isTelegramEventAuthorized,
} from '../channel-coordinator.js'
import { runMessageRouterTick } from '../web/message-router.js'

describe('Non-Claude main orchestrator Telegram pipeline', () => {
  beforeEach(() => {
    rmSync(SANDBOX_PROJECT, { recursive: true, force: true })
    rmSync(SANDBOX_HOME, { recursive: true, force: true })
    mkdirSync(SANDBOX_PROJECT, { recursive: true })
    mkdirSync(SANDBOX_HOME, { recursive: true })
    mockGetPendingMessages.mockReset().mockReturnValue([])
    mockSendPromptToSession.mockReset().mockResolvedValue('sent')
    mockIsSessionReady.mockReset().mockResolvedValue(true)
    mockSessionExists.mockReset().mockReturnValue(true)
    mockMarkMessageDelivered.mockReset().mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env.MAIN_AGENT_MODEL
  })

  it('resolveConfiguredMainCliType detects agy, codex, and defaults to claude', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cli-type-'))
    try {
      expect(resolveConfiguredMainCliType(tmp)).toBe('claude')
      writeFileSync(join(tmp, '.env'), 'MAIN_AGENT_MODEL=gemini-4-hydrogen-medium\n')
      expect(resolveConfiguredMainCliType(tmp)).toBe('agy')
      writeFileSync(join(tmp, '.env'), 'MAIN_AGENT_MODEL=codex:gpt-5.4\n')
      expect(resolveConfiguredMainCliType(tmp)).toBe('codex')
      writeFileSync(join(tmp, '.env'), 'MAIN_AGENT_MODEL=claude-opus-4-6\n')
      expect(resolveConfiguredMainCliType(tmp)).toBe('claude')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('decideNativeChannelDown bypasses STARTUP_GRACE_MS when nativePluginSupported is false', () => {
    expect(
      decideNativeChannelDown({
        claudePid: 1234,
        pluginAlive: false,
        keepaliveAgeMs: 0,
        msSinceLastRespawn: 1000,
        nativePluginSupported: false,
      }),
    ).toBe(true)

    expect(
      decideNativeChannelDown({
        claudePid: 1234,
        pluginAlive: false,
        keepaliveAgeMs: 0,
        msSinceLastRespawn: 1000,
      }),
    ).toBe(false)
  })

  it('resolveCoordinatorTelegramToken discovers tokens across state dirs and project .env', () => {
    const base = mkdtempSync(join(tmpdir(), 'coord-tok-'))
    try {
      const stateDir = join(base, 'coord-state')
      const projectRoot = join(base, 'project')
      const homeDir = join(base, 'home')
      mkdirSync(join(homeDir, '.claude', 'channels', 'telegram'), { recursive: true })
      mkdirSync(projectRoot, { recursive: true })

      writeFileSync(join(homeDir, '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=111:home-token\n')
      expect(resolveCoordinatorTelegramToken({ stateDir, projectRoot, homeDir, env: {} })).toBe('111:home-token')

      mkdirSync(join(projectRoot, 'store', '.claude-channels', 'telegram'), { recursive: true })
      writeFileSync(
        join(projectRoot, 'store', '.claude-channels', 'telegram', '.env'),
        'TELEGRAM_BOT_TOKEN="222:store-token"\n',
      )
      expect(resolveCoordinatorTelegramToken({ stateDir, projectRoot, homeDir, env: {} })).toBe('222:store-token')

      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, '.env'), "TELEGRAM_BOT_TOKEN='333:coord-token'\n")
      expect(resolveCoordinatorTelegramToken({ stateDir, projectRoot, homeDir, env: {} })).toBe('222:store-token')
      rmSync(join(projectRoot, 'store', '.claude-channels', 'telegram', '.env'))
      expect(resolveCoordinatorTelegramToken({ stateDir, projectRoot, homeDir, env: {} })).toBe('333:coord-token')

      expect(
        resolveCoordinatorTelegramToken({
          stateDir,
          projectRoot,
          homeDir,
          env: { TELEGRAM_BOT_TOKEN: '444:env-token' },
        }),
      ).toBe('444:env-token')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('uses this installation’s Telegram token ahead of saved global copies', () => {
    const base = mkdtempSync(join(tmpdir(), 'coord-install-token-'))
    try {
      const projectRoot = join(base, 'install')
      const homeDir = join(base, 'home')
      const stateDir = join(homeDir, '.claude', 'channels', 'telegram-coordinator')
      const nativeDir = join(projectRoot, '.claude', 'channels', 'telegram')
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(nativeDir, { recursive: true })
      const options = { projectRoot, homeDir, stateDir, env: {} }
      writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=111:stale-copy\n')
      writeFileSync(join(projectRoot, '.env'), 'TELEGRAM_BOT_TOKEN=222:install-token\n')
      expect(resolveCoordinatorTelegramToken(options)).toBe('222:install-token')

      writeFileSync(join(nativeDir, '.env'), 'TELEGRAM_BOT_TOKEN=333:native-token\n')
      expect(resolveCoordinatorTelegramToken(options)).toBe('333:native-token')

      const legacyDir = join(homeDir, '.claude', 'channels', 'telegram')
      mkdirSync(legacyDir, { recursive: true })
      writeFileSync(join(legacyDir, '.env'), 'TELEGRAM_BOT_TOKEN=444:explicit-state\n')
      expect(resolveCoordinatorTelegramToken({ ...options, env: { TELEGRAM_STATE_DIR: legacyDir } })).toBe('444:explicit-state')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('loadTelegramAccessPolicy & isTelegramEventAuthorized enforce allowFrom, groups, and ALLOWED_CHAT_ID', () => {
    const base = mkdtempSync(join(tmpdir(), 'coord-acl-'))
    try {
      const projectRoot = join(base, 'project')
      const homeDir = join(base, 'home')
      mkdirSync(join(homeDir, '.claude', 'channels', 'telegram'), { recursive: true })
      mkdirSync(projectRoot, { recursive: true })

      const unconfigured = loadTelegramAccessPolicy({ projectRoot, homeDir, env: {} })
      expect(unconfigured.enforced).toBe(false)
      expect(isTelegramEventAuthorized({ chat_id: 999, user_id: 999 }, unconfigured)).toBe(true)

      writeFileSync(
        join(homeDir, '.claude', 'channels', 'telegram', 'access.json'),
        JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['12345'], groups: { '-100777': {} } }),
      )
      writeFileSync(join(projectRoot, '.env'), 'ALLOWED_CHAT_ID=55555\n')

      const policy = loadTelegramAccessPolicy({ projectRoot, homeDir, env: {} })
      expect(policy.enforced).toBe(true)
      expect(isTelegramEventAuthorized({ chat_id: 12345, user_id: 12345 }, policy)).toBe(true)
      expect(isTelegramEventAuthorized({ chat_id: -100777, user_id: 99999 }, policy)).toBe(true)
      expect(isTelegramEventAuthorized({ chat_id: 55555, user_id: 55555 }, policy)).toBe(true)
      expect(isTelegramEventAuthorized({ chat_id: 88888, user_id: 88888 }, policy)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('runMessageRouterTick pushes Telegram inbound directly to MAIN_CHANNELS_SESSION when main CLI is agy/codex', async () => {
    writeFileSync(join(SANDBOX_PROJECT, '.env'), 'MAIN_AGENT_MODEL=gemini-4-hydrogen-medium\n')
    mockGetPendingMessages.mockReturnValue([
      {
        id: 101,
        from_agent: 'telegram-coordinator',
        to_agent: 'marveen',
        content: '<channel source="telegram" chat_id="1268077055" message_id="10">szia marveen</channel>',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
      },
    ])

    await runMessageRouterTick()

    expect(mockSessionExists).toHaveBeenCalledWith(null, 'marveen-channels')
    expect(mockIsSessionReady).toHaveBeenCalledWith('marveen-channels', null, { onBlocked: expect.any(Function) })
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession.mock.calls[0]?.[0]).toBe('marveen-channels')
    expect(String(mockSendPromptToSession.mock.calls[0]?.[1])).toContain('szia marveen')
    expect(mockMarkMessageDelivered).toHaveBeenCalledWith(101)
  })

  it('runMessageRouterTick keeps PULL model (skips tmux inject) when main CLI is claude', async () => {
    writeFileSync(join(SANDBOX_PROJECT, '.env'), 'MAIN_AGENT_MODEL=claude-opus-4-6\n')
    mockGetPendingMessages.mockReturnValue([
      {
        id: 102,
        from_agent: 'telegram-coordinator',
        to_agent: 'marveen',
        content: '<channel source="telegram" chat_id="1268077055" message_id="11">szia</channel>',
        status: 'pending',
        created_at: Math.floor(Date.now() / 1000),
      },
    ])

    await runMessageRouterTick()

    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockMarkMessageDelivered).not.toHaveBeenCalled()
  })

  it('lifecycle scripts wire channel-coordinator across Linux systemd, macOS LaunchAgents, start/stop, and update', () => {
    const repoRoot = join(import.meta.dirname, '..', '..')
    const linuxInstall = readFileSync(join(repoRoot, 'install-linux.sh'), 'utf-8')
    const macosInstall = readFileSync(join(repoRoot, 'install-macos.sh'), 'utf-8')
    const startSh = readFileSync(join(repoRoot, 'scripts', 'start.sh'), 'utf-8')
    const stopSh = readFileSync(join(repoRoot, 'scripts', 'stop.sh'), 'utf-8')
    const updateSh = readFileSync(join(repoRoot, 'update.sh'), 'utf-8')

    expect(linuxInstall).toContain('COORD_UNIT="${SERVICE_ID}-channel-coordinator"')
    expect(linuxInstall).toContain('dist/channel-coordinator.js')
    expect(macosInstall).toContain('install-channel-coordinator.sh')
    expect(startSh).toContain('channel-coordinator')
    expect(stopSh).toContain('channel-coordinator')
    expect(updateSh).toContain('install_channel_coordinator_unit')
  })
})
