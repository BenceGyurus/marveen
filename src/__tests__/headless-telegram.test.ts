import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeIngestDb, getOffset, initIngestDb } from '../channel-coordinator/ingest.js'
import { pollHeadlessTelegram, startHeadlessTelegramPolling } from '../web/headless-telegram.js'
import { buildHeadlessChildEnv, buildHeadlessTurnSpec, registerHeadlessAgent, unregisterHeadlessAgent } from '../web/headless-runner.js'

let root: string
let stateDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'marveen-headless-telegram-'))
  stateDir = join(root, 'telegram')
  mkdirSync(stateDir)
  initIngestDb(join(root, 'store.db'))
})

afterEach(() => {
  closeIngestDb()
  rmSync(root, { recursive: true, force: true })
})

const update = (updateId: number, userId: number) => ({
  update_id: updateId,
  message: { message_id: 12, date: 1, chat: { id: userId }, from: { id: userId }, text: 'Szia!' },
})

function configure(dir: string, token: string, allowFrom: string[]) {
  writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=' + token + '\n')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom, groups: {} }))
}

describe('headless Telegram intake', () => {
  it('starts polling a registered AGY agent and stops polling when it is unregistered', async () => {
    configure(stateDir, '100:test-one', ['42'])
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, result: [update(8, 42)] }))
    vi.stubGlobal('fetch', fetch)
    vi.useFakeTimers()
    const stop = startHeadlessTelegramPolling()
    try {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetch).not.toHaveBeenCalled()
      registerHeadlessAgent({
        name: 'marketing', session: 'agent-marketing', cliType: 'agy', model: 'agy:gemini-4-hydrogen-high',
        dir: root, skipPermissions: false, telegramStateDir: stateDir,
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetch).toHaveBeenCalledOnce()
      expect(initIngestDb().prepare('SELECT to_agent FROM agent_messages').get()).toEqual({ to_agent: 'marketing' })
      unregisterHeadlessAgent('marketing')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetch).toHaveBeenCalledOnce()
    } finally {
      unregisterHeadlessAgent('marketing')
      stop()
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })

  it('routes an approved update to the owning agent and deduplicates updates per bot', async () => {
    configure(stateDir, '100:test-one', ['42'])
    const otherDir = join(root, 'other')
    mkdirSync(otherDir)
    configure(otherDir, '200:test-two', ['42'])
    const fetchUpdates = vi.fn().mockResolvedValue([update(8, 42), update(9, 99)])

    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates })
    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates })
    await pollHeadlessTelegram('sales', otherDir, { fetchUpdates })

    expect(fetchUpdates.mock.calls.map(([token, offset]) => [token, offset])).toEqual([
      ['100:test-one', 0], ['100:test-one', 10], ['200:test-two', 0],
    ])
    const rows = initIngestDb().prepare('SELECT from_agent, to_agent, content FROM agent_messages ORDER BY id').all()
    expect(rows).toEqual(['marketing', 'sales'].map(to_agent => ({
      from_agent: 'telegram-coordinator',
      to_agent,
      content: expect.stringContaining('chat_id="42" message_id="12"'),
    })))
  })

  it('does not advance the offset when durable enqueue fails', async () => {
    configure(stateDir, '100:test-one', ['42'])
    const fetchUpdates = vi.fn().mockResolvedValue([update(8, 42)])
    const db = initIngestDb()
    db.exec("CREATE TRIGGER reject_handoff BEFORE INSERT ON agent_messages BEGIN SELECT RAISE(ABORT, 'write failed'); END")
    await expect(pollHeadlessTelegram('marketing', stateDir, { fetchUpdates })).rejects.toThrow('write failed')
    expect(getOffset('telegram:marketing:100')).toBe(0)
    expect(db.prepare('SELECT count(*) AS count FROM incoming_events').get()).toEqual({ count: 0 })

    db.exec('DROP TRIGGER reject_handoff')
    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates })
    expect(getOffset('telegram:marketing:100')).toBe(8)
  })

  it('holds updates when the access file cannot be read safely', async () => {
    configure(stateDir, '100:test-one', ['42'])
    writeFileSync(join(stateDir, 'access.json'), '{broken')
    const fetchUpdates = vi.fn()
    await expect(pollHeadlessTelegram('marketing', stateDir, { fetchUpdates })).rejects.toThrow('invalid-access')
    expect(fetchUpdates).not.toHaveBeenCalled()
  })

  it('polls a quoted bot token and creates a pairing request when access.json is missing', async () => {
    writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN="100:test-one"\n')
    const fetchUpdates = vi.fn().mockResolvedValue([update(8, 42)])
    const sendPairingNotice = vi.fn().mockResolvedValue(undefined)

    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates, sendPairingNotice })

    expect(fetchUpdates).toHaveBeenCalledExactlyOnceWith('100:test-one', 0, 0, 100)
    expect(initIngestDb().prepare('SELECT count(*) AS count FROM agent_messages').get()).toEqual({ count: 0 })
    const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf8'))
    expect(access).toMatchObject({ dmPolicy: 'pairing', allowFrom: [] })
    expect(Object.values(access.pending)).toMatchObject([{ senderId: '42' }])
    expect(sendPairingNotice).toHaveBeenCalledOnce()
  })

  it('creates dashboard pairing requests without forwarding unapproved messages', async () => {
    configure(stateDir, '100:test-one', [])
    const accessFile = join(stateDir, 'access.json')
    writeFileSync(accessFile, JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }))
    const fetchUpdates = vi.fn().mockResolvedValue([update(8, 42), update(9, 42)])
    const sendPairingNotice = vi.fn().mockResolvedValue(undefined)
    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates, sendPairingNotice })

    expect(initIngestDb().prepare('SELECT count(*) AS count FROM agent_messages').get()).toEqual({ count: 0 })
    const [[code, request]] = Object.entries(JSON.parse(readFileSync(accessFile, 'utf8')).pending)
    expect(request).toMatchObject({ senderId: '42', chatId: '42' })
    expect(sendPairingNotice).toHaveBeenCalledExactlyOnceWith('100:test-one', '42', expect.stringContaining(code))
  })

  it('does not fetch the main bot or enqueue a result after the agent has stopped', async () => {
    configure(stateDir, '100:test-one', ['42'])
    const fetchUpdates = vi.fn().mockResolvedValue([update(8, 42)])
    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates, mainBotId: '100' })
    expect(fetchUpdates).not.toHaveBeenCalled()

    await pollHeadlessTelegram('marketing', stateDir, { fetchUpdates, isCurrent: () => false })
    expect(getOffset('telegram:marketing:100')).toBe(0)
    expect(initIngestDb().prepare('SELECT count(*) AS count FROM agent_messages').get()).toEqual({ count: 0 })
  })
})

describe('headless Telegram replies', () => {
  it('removes inherited bot credentials and uses the agent state directory', () => {
    const base = { TELEGRAM_STATE_DIR: '/main/telegram', TELEGRAM_BOT_TOKEN: 'main-token' }
    expect(buildHeadlessChildEnv(base).TELEGRAM_STATE_DIR).toBeUndefined()
    const env = buildHeadlessChildEnv(base, { TELEGRAM_STATE_DIR: stateDir })
    expect(env.TELEGRAM_STATE_DIR).toBe(stateDir)
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
  })

  it('forwards the Telegram scope variables through Codex MCP', () => {
    const spec = buildHeadlessTurnSpec({
      cliType: 'codex', bin: 'codex', cleanModel: 'gpt-5.4', prompt: 'Test',
      skipPermissions: false, threadId: 'fixture-thread', hasPriorTurn: true, telegramStateDir: stateDir,
    })
    expect(spec.args).toContain('mcp_servers.marveen_telegram.env_vars=["MARVEEN_HEADLESS_TELEGRAM","TELEGRAM_STATE_DIR"]')
  })

  it('uses the scoped bot and refuses to fall back when that bot is missing', () => {
    const bridge = resolve('scripts/channel-reply-mcp.mjs')
    const loader = join(root, 'fetch-stub.mjs')
    writeFileSync(loader, `
      globalThis.fetch = async (url) => {
        if (!url.includes('/bot100:test-one/')) throw new Error('Wrong Telegram bot')
        return Response.json({ ok: true, result: { message_id: 87 } })
      }
    `)
    const input = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'telegram_reply', arguments: { chat_id: '42', text: 'Szia!' } },
    }) + '\n'
    const send = (dir: string) => {
      const result = spawnSync(process.execPath, ['--import', loader, bridge], {
        input, encoding: 'utf8',
        env: { ...process.env, TELEGRAM_STATE_DIR: dir, MARVEEN_HEADLESS_TELEGRAM: '1' },
      })
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout).result
    }
    configure(stateDir, '100:test-one', ['42'])
    expect(send(stateDir).content[0].text).toContain('message_id: 87')
    expect(send(join(root, 'missing'))).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('TELEGRAM_BOT_TOKEN not configured') }],
    })
  })

  it('sends local photos via telegram_send_photo with scoped bot isolation and allowlist checks', () => {
    const bridge = resolve('scripts/channel-reply-mcp.mjs')
    const loader = join(root, 'photo-fetch-stub.mjs')
    const samplePng = join(root, 'sample.png')
    writeFileSync(samplePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    writeFileSync(loader, `
      globalThis.fetch = async (url, init) => {
        if (!url.includes('/bot100:test-one/sendPhoto')) throw new Error('Wrong Telegram endpoint: ' + url)
        if (!(init?.body instanceof FormData)) throw new Error('Expected FormData body')
        return Response.json({ ok: true, result: { message_id: 99 } })
      }
    `)
    const call = (dir: string, args: Record<string, unknown>) => {
      const input = JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'telegram_send_photo', arguments: args },
      }) + '\n'
      const result = spawnSync(process.execPath, ['--import', loader, bridge], {
        input, encoding: 'utf8',
        env: { ...process.env, TELEGRAM_STATE_DIR: dir, MARVEEN_HEADLESS_TELEGRAM: '1' },
      })
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout).result
    }
    configure(stateDir, '100:test-one', ['42'])
    expect(call(stateDir, { chat_id: '42', photo_path: samplePng, caption: 'ok' }).content[0].text).toContain('message_id: 99')
    expect(call(stateDir, { chat_id: '999', photo_path: samplePng })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('not in allowFrom') }],
    })
    expect(call(stateDir, { chat_id: '42', photo_path: join(root, 'nope.png') })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('Photo file not found') }],
    })
    expect(call(join(root, 'missing'), { chat_id: '42', photo_path: samplePng })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('TELEGRAM_BOT_TOKEN not configured') }],
    })
  })
})
