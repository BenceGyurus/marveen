import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ROOT = mkdtempSync(join(tmpdir(), 'chan-ui-inst-'))
const REPO_ROOT = resolve(__dirname, '..', '..')
const AGENTS = join(ROOT, 'agents')
const STORE = join(ROOT, 'store')
process.env.CLAUDECLAW_ENV_DIR = ROOT

vi.mock('../db.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db.js')>()
  return {
    ...orig,
    countDashboardUsers: () => 1,
  }
})

vi.mock('../config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../config.js')>()
  return {
    ...orig,
    PROJECT_ROOT: ROOT,
    STORE_DIR: STORE,
    MAIN_AGENT_ID: 'marveen-test',
    CHANNEL_PROVIDER: 'telegram',
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...orig,
    agentDir: (name: string) => join(AGENTS, name),
    readAgentChannelProvider: () => 'telegram',
    writeAgentChannelProvider: vi.fn(),
    setAgentEnabledPlugins: vi.fn(),
  }
})

vi.mock('../web/channel-monitor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/channel-monitor.js')>()
  return {
    ...orig,
    hardRestartMarveenChannels: () => ({ ok: true }),
  }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...orig,
    channelStateDir: (provider: string, baseDir?: string) =>
      baseDir ? join(baseDir, '.claude', 'channels', provider) : join(ROOT, '.claude', 'channels', provider),
    getProvider: (provider: Parameters<typeof orig.getProvider>[0]) => {
      const real = orig.getProvider(provider)
      return {
        ...real,
        validateToken: async (token: string) => ({ ok: Boolean(token && token.includes(':')), botName: '@demo_marveen_bot' }),
      }
    },
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')
type RouteContext = import('../web/routes/types.js').RouteContext

function makeCtx(method: string, path: string, body?: unknown, authKind: 'session' | 'token' = 'session') {
  const out: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) {
      if (chunk) {
        try { out.body = JSON.parse(chunk) as Record<string, unknown> } catch { out.body = null }
      }
    },
  }
  const raw = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    headers: {},
    on(ev: string, cb: (x?: Buffer) => void) {
      if (ev === 'data') cb(raw)
      if (ev === 'end') cb()
      return req
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: authKind } } as unknown as RouteContext
  return { ctx, out }
}

async function hit(method: string, path: string, body?: unknown, authKind: 'session' | 'token' = 'session') {
  const { ctx, out } = makeCtx(method, path, body, authKind)
  const handled = await tryHandleAgents(ctx, join(REPO_ROOT, 'web'))
  expect(handled).toBe(true)
  return out
}

describe('Telegram Chat ID & Token Management Routes (Orchestrator & Sub-agents)', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    rmSync(AGENTS, { recursive: true, force: true })
    rmSync(join(ROOT, '.claude'), { recursive: true, force: true })
    rmSync(join(ROOT, '.env'), { force: true })
    mkdirSync(join(AGENTS, 'alpha'), { recursive: true })
    mkdirSync(STORE, { recursive: true })
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })) as unknown as typeof fetch
  })

  afterAll(() => {
    delete process.env.CLAUDECLAW_ENV_DIR
    globalThis.fetch = originalFetch
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('POST /channels/telegram syncs TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID to .env for main orchestrator', async () => {
    const res = await hit('POST', '/api/agents/marveen-test/channels/telegram', {
      botToken: '111222:TEST_MAIN_TOKEN',
      allowFrom: ['555666777'],
    })
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)

    const mainChannelEnv = readFileSync(join(ROOT, '.claude', 'channels', 'telegram', '.env'), 'utf-8')
    expect(mainChannelEnv).toContain('TELEGRAM_BOT_TOKEN=111222:TEST_MAIN_TOKEN')

    const access = JSON.parse(readFileSync(join(ROOT, '.claude', 'channels', 'telegram', 'access.json'), 'utf-8'))
    expect(access.dmPolicy).toBe('allowlist')
    expect(access.allowFrom).toEqual(['555666777'])

    const rootEnv = readFileSync(join(ROOT, '.env'), 'utf-8')
    expect(rootEnv).toContain('TELEGRAM_BOT_TOKEN=111222:TEST_MAIN_TOKEN')
    expect(rootEnv).toContain('ALLOWED_CHAT_ID=555666777')
  })

  it('POST /channels/telegram with preserveAccess keeps existing allowFrom & groups on token rotation', async () => {
    const first = await hit('POST', '/api/agents/alpha/channels/telegram', {
      botToken: '222333:OLD_TOKEN',
      allowFrom: ['10001'],
    })
    expect(first.status).toBe(200)

    const grp = await hit('POST', '/api/agents/alpha/channels/telegram/allowed', {
      id: '-10099887766',
      kind: 'group',
    })
    expect(grp.status).toBe(200)

    const rotated = await hit('POST', '/api/agents/alpha/channels/telegram', {
      botToken: '222333:NEW_TOKEN',
      preserveAccess: true,
    })
    expect(rotated.status).toBe(200)

    const subEnv = readFileSync(join(AGENTS, 'alpha', '.claude', 'channels', 'telegram', '.env'), 'utf-8')
    expect(subEnv).toContain('TELEGRAM_BOT_TOKEN=222333:NEW_TOKEN')

    const access = JSON.parse(readFileSync(join(AGENTS, 'alpha', '.claude', 'channels', 'telegram', 'access.json'), 'utf-8'))
    expect(access.allowFrom).toEqual(['10001'])
    expect(access.groups['-10099887766']).toBeDefined()
    expect(access.dmPolicy).toBe('allowlist')
  })

  it('POST /channels/telegram/allowed validates IDs, checks owner gate, adds DM/groups, and syncs main ALLOWED_CHAT_ID', async () => {
    const refused = await hit('POST', '/api/agents/alpha/channels/telegram/allowed', { id: '42', kind: 'user' }, 'token')
    expect(refused.status).toBe(403)

    const bad = await hit('POST', '/api/agents/alpha/channels/telegram/allowed', { id: '../bad', kind: 'user' })
    expect(bad.status).toBe(400)

    const addSub = await hit('POST', '/api/agents/alpha/channels/telegram/allowed', { id: '900100', kind: 'user' })
    expect(addSub.status).toBe(200)
    const subAccess = JSON.parse(readFileSync(join(AGENTS, 'alpha', '.claude', 'channels', 'telegram', 'access.json'), 'utf-8'))
    expect(subAccess.allowFrom).toContain('900100')
    expect(subAccess.dmPolicy).toBe('allowlist')

    const addMain = await hit('POST', '/api/agents/marveen-test/channels/telegram/allowed', { id: '777888999', kind: 'user' })
    expect(addMain.status).toBe(200)
    const rootEnv = readFileSync(join(ROOT, '.env'), 'utf-8')
    expect(rootEnv).toContain('ALLOWED_CHAT_ID=777888999')
  })
})

describe('Dashboard UI Channel Inputs & Installer CLI/Model Detection Contracts', () => {
  it('web/index.html & web/app.js expose Telegram Chat ID, manual add, inline token update, and main agent refresh', () => {
    const html = readFileSync(join(REPO_ROOT, 'web', 'index.html'), 'utf-8')
    const appJs = readFileSync(join(REPO_ROOT, 'web', 'app.js'), 'utf-8')
    const hu = readFileSync(join(REPO_ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
    const en = readFileSync(join(REPO_ROOT, 'web', 'lang', 'en.js'), 'utf-8')

    expect(html).toContain('id="chTelegramAllowFromInput"')
    expect(html).toContain('id="chEditTokenToggleBtn"')
    expect(html).toContain('id="chSaveTokenBtn"')
    expect(html).toContain('id="chAddAllowedBtn"')
    expect(html).toContain('id="chAddAllowedInput"')

    expect(appJs).toContain('chTelegramAllowFromInput')
    expect(appJs).toContain('payload.allowFrom = ids')
    expect(appJs).toContain('preserveAccess: true')
    expect(appJs).toContain('openMarveenDetail()')
    expect(hu).toContain('channel.telegram_chat_id_label')
    expect(en).toContain('channel.telegram_chat_id_label')
  })

  it('install-linux.sh & install-macos.sh include CLI detection, model discovery, and Telegram Chat ID config', () => {
    for (const file of ['install-linux.sh', 'install-macos.sh']) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8')
      expect(src).toContain('_detect_cli_status()')
      expect(src).toContain('_discover_models_for_cli()')
      expect(src).toContain('MARVEEN_ALLOWED_CHAT_ID')
      expect(src).toContain('MARVEEN_TELEGRAM_BOT_TOKEN')
      expect(src).toContain('"dmPolicy": "allowlist"')
    }
  })

  it('installer _discover_models_for_cli parses temp Codex & Antigravity fixtures cleanly without touching host dotfiles', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'inst-models-'))
    const fakeBin = join(fakeHome, 'bin')
    mkdirSync(join(fakeHome, '.codex'), { recursive: true })
    mkdirSync(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })

    writeFileSync(join(fakeHome, '.codex', 'config.toml'), 'model = "gpt-5.5-codex"\n')
    writeFileSync(join(fakeHome, '.codex', 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-5.4' }, { slug: 'o3-pro' }],
    }))
    writeFileSync(join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({
      model: 'gemini-3-ultra',
    }))

    const mockAgy = join(fakeBin, 'agy')
    writeFileSync(mockAgy, '#!/bin/sh\necho "claude-opus-4-6-thinking  Claude Opus 4.6"\necho "gemini-3-pro-high         Gemini 3 Pro High"\n')
    chmodSync(mockAgy, 0o755)

    try {
      // Extract only _discover_models_for_cli function block cleanly
      const script = readFileSync(join(REPO_ROOT, 'install-macos.sh'), 'utf-8')
      const match = script.match(/_discover_models_for_cli\(\) \{[\s\S]*?\n\}/)
      expect(match).not.toBeNull()
      const runner = `${match![0]}\n_discover_models_for_cli "$1"\n`

      const codexOut = execFileSync('bash', ['-c', runner, '--', 'codex'], {
        env: { ...process.env, HOME: fakeHome, CODEX_HOME: join(fakeHome, '.codex') },
        encoding: 'utf-8',
      })
      expect(codexOut.trim().split('\n')).toContain('codex:gpt-5.5-codex')
      expect(codexOut.trim().split('\n')).toContain('codex:gpt-5.4')
      expect(codexOut.trim().split('\n')).toContain('codex:o3-pro')

      const agyOut = execFileSync('bash', ['-c', runner, '--', 'agy'], {
        env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: 'utf-8',
      })
      const agyLines = agyOut.trim().split('\n')
      expect(agyLines).toContain('agy:gemini-3-ultra')
      expect(agyLines).toContain('agy:claude-opus-4-6-thinking')
      expect(agyLines).toContain('agy:gemini-3-pro-high')
      // When live agy models succeeds, stale fallbacks are not appended
      expect(agyLines).not.toContain('agy:gpt-oss-120b-medium')

      // Realistic agy models output with spinner/ANSI/tab columns (gemini-4)
      writeFileSync(mockAgy, '#!/bin/sh\nprintf "\\r\\033[2Kgemini-4-hydrogen-medium\\tGemini 4 Hydrogen (Medium)\\n"\nprintf "gemini-4-argon-high\\tGemini 4 Argon (High)\\n"\n')
      chmodSync(mockAgy, 0o755)
      rmSync(join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'))
      const liveOut = execFileSync('bash', ['-c', runner, '--', 'agy'], {
        env: { ...process.env, HOME: fakeHome, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: 'utf-8',
      }).trim().split('\n')
      expect(liveOut).toEqual(['agy:gemini-4-hydrogen-medium', 'agy:gemini-4-argon-high'])

      // Fallback when agy binary is unavailable uses current models (no stale gemini-3-pro-high)
      const fallbackOut = execFileSync('bash', ['-c', runner, '--', 'agy'], {
        env: { ...process.env, HOME: fakeHome, PATH: '/usr/bin:/bin' },
        encoding: 'utf-8',
      }).trim().split('\n')
      expect(fallbackOut).toContain('agy:gemini-4-hydrogen-medium')
      expect(fallbackOut).not.toContain('agy:gemini-3-pro-high')
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})
