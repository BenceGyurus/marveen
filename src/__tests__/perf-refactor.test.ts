import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const ENV_SANDBOX = mkdtempSync(join(tmpdir(), 'perf-env-'))
const AGENT_SANDBOX = mkdtempSync(join(tmpdir(), 'perf-agents-'))
const STATIC_SANDBOX = mkdtempSync(join(tmpdir(), 'perf-static-'))
const BIN_SANDBOX = mkdtempSync(join(tmpdir(), 'perf-tmux-'))
const FAKE_TMUX_LOG = join(BIN_SANDBOX, 'tmux.log')
const FAKE_PANE_FILE = join(BIN_SANDBOX, 'pane.txt')

const ORIG_ENV_DIR = process.env.CLAUDECLAW_ENV_DIR
const ORIG_PATH = process.env.PATH
const ORIG_FAKE_LOG = process.env.FAKE_TMUX_LOG
const ORIG_FAKE_PANE = process.env.FAKE_PANE_FILE

writeFileSync(FAKE_TMUX_LOG, '')
writeFileSync(FAKE_PANE_FILE, 'INITIAL PANE\n')
writeFileSync(
  join(BIN_SANDBOX, 'tmux'),
  `#!/bin/sh
case "$1" in
  has-session)
    exit 0 ;;
  capture-pane)
    printf 'capture-pane\\n' >> "$FAKE_TMUX_LOG"
    cat "$FAKE_PANE_FILE"
    exit 0 ;;
  *)
    exit 0 ;;
esac
`,
)
chmodSync(join(BIN_SANDBOX, 'tmux'), 0o755)

process.env.CLAUDECLAW_ENV_DIR = ENV_SANDBOX
process.env.PATH = `${BIN_SANDBOX}:${ORIG_PATH ?? ''}`
process.env.FAKE_TMUX_LOG = FAKE_TMUX_LOG
process.env.FAKE_PANE_FILE = FAKE_PANE_FILE

const {
  initDatabase,
  getDb,
  clearMemoryCache,
  searchMemories,
  recentMemories,
  getMemoriesForChat,
  getAgentMemories,
  searchAgentMemories,
  recallByDateRange,
  recallSearch,
} = await import('../db.js')
const {
  readEnvFile,
  updateEnvFile,
  writeEnvFileFresh,
} = await import('../env.js')
const { serveFile, etagMatches, jsonMaybeGzip } = await import('../web/http-helpers.js')
const { tryHandleStatic } = await import('../web/routes/static.js')
const { extractApiPrefix } = await import('../web/route-dispatch.js')
const {
  fetchAnthropicStatus,
  _resetAnthropicStatusCacheForTest,
} = await import('../web/routes/status.js')
const {
  getSystemStatus,
  _resetSystemStatusCacheForTest,
} = await import('../web/system-status.js')
const {
  tryHandleAgentTerminal,
  resetTerminalStreamHubsForTests,
} = await import('../web/routes/agent-terminal.js')
const { MAIN_AGENT_ID } = await import('../config.js')

function fakeReq(headers: Record<string, string> = {}, method = 'GET') {
  return Object.assign(new EventEmitter(), { headers, method, socket: {} }) as any
}

function captureRes() {
  const chunks: Buffer[] = []
  let statusCode = 0
  let headers: Record<string, string> = {}
  const res: any = {
    writeHead(status: number, hdrs: Record<string, string> = {}) {
      statusCode = status
      headers = Object.fromEntries(
        Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), String(v)]),
      )
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
    },
  }
  return {
    res,
    get status() { return statusCode },
    get headers() { return headers },
    get body() { return Buffer.concat(chunks) },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  _resetAnthropicStatusCacheForTest()
  _resetSystemStatusCacheForTest()
  resetTerminalStreamHubsForTests()
})

afterAll(() => {
  if (ORIG_ENV_DIR === undefined) delete process.env.CLAUDECLAW_ENV_DIR
  else process.env.CLAUDECLAW_ENV_DIR = ORIG_ENV_DIR
  if (ORIG_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIG_PATH
  if (ORIG_FAKE_LOG === undefined) delete process.env.FAKE_TMUX_LOG
  else process.env.FAKE_TMUX_LOG = ORIG_FAKE_LOG
  if (ORIG_FAKE_PANE === undefined) delete process.env.FAKE_PANE_FILE
  else process.env.FAKE_PANE_FILE = ORIG_FAKE_PANE

  rmSync(ENV_SANDBOX, { recursive: true, force: true })
  rmSync(AGENT_SANDBOX, { recursive: true, force: true })
  rmSync(STATIC_SANDBOX, { recursive: true, force: true })
  rmSync(BIN_SANDBOX, { recursive: true, force: true })
})

describe('db performance pragmas, indexes & embedding projection', () => {
  it('applies pragmas, creates composite indexes, and projects NULL AS embedding on read paths', () => {
    process.env.NODE_ENV = 'test'
    initDatabase(':memory:')
    clearMemoryCache()
    const db = getDb()

    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    expect(db.pragma('temp_store', { simple: true })).toBe(2)

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map(r => r.name)
    expect(indexes).toContain('idx_memories_created')
    expect(indexes).toContain('idx_daily_logs_only_date')
    expect(indexes).toContain('idx_agent_messages_created')

    const now = Math.floor(Date.now() / 1000)
    const fakeEmbedding = JSON.stringify([0.1, 0.2, 0.3, 0.4])
    db.prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, embedding, embedding_model)
       VALUES (?, ?, ?, 'semantic', 1.0, ?, ?, ?, 'hot', ?, 'test-model')`,
    ).run('perf-chat', 'topic-1', 'PerfRefactorUniqueToken alpha signal', now, now, 'perf-agent', fakeEmbedding)

    const rawRow = db.prepare('SELECT embedding FROM memories WHERE chat_id = ?').get('perf-chat') as { embedding: string | null }
    expect(rawRow.embedding).toBe(fakeEmbedding)

    for (const rows of [
      searchMemories('PerfRefactorUniqueToken', 'perf-chat', 5),
      recentMemories('perf-chat', 5),
      getMemoriesForChat('perf-chat', 10, 0),
      getAgentMemories('perf-agent', 10),
      searchAgentMemories('perf-agent', 'PerfRefactorUniqueToken', 10),
    ]) {
      expect(rows.length).toBeGreaterThanOrEqual(1)
      expect((rows[0] as unknown as { embedding: unknown }).embedding).toBeNull()
    }

    const today = new Date(now * 1000).toISOString().slice(0, 10)
    const rangeRes = recallByDateRange('2020-01-01', today, 'perf-agent', { query: 'PerfRefactorUniqueToken' })
    expect(rangeRes.memories.length).toBe(1)
    expect((rangeRes.memories[0] as unknown as { embedding: unknown }).embedding).toBeNull()

    const searchRes = recallSearch('PerfRefactorUniqueToken', 'perf-agent')
    expect(searchRes.memories.length).toBe(1)
    expect((searchRes.memories[0] as unknown as { embedding: unknown }).embedding).toBeNull()
  })
})

describe('HTTP static serving, Brotli, HEAD, Content-Length & route dispatch', () => {
  it('extracts API prefixes in O(1)', () => {
    expect(extractApiPrefix('/api/agents/demo/status')).toBe('agents')
    expect(extractApiPrefix('/api/overview')).toBe('overview')
    expect(extractApiPrefix('/api/')).toBe('')
    expect(extractApiPrefix('/api')).toBe('')
    expect(extractApiPrefix('/')).toBe('')
    expect(extractApiPrefix('/style.css')).toBe('')
  })

  it('serves Brotli with accurate Content-Length, HEAD empty body, weak ETag 304, and memo hit', () => {
    const jsPath = join(STATIC_SANDBOX, 'sample-bundle.js')
    const content = 'const marveenPerfCheck = "abcdef";\n'.repeat(80)
    writeFileSync(jsPath, content, 'utf8')

    const c1 = captureRes()
    serveFile(fakeReq({ 'accept-encoding': 'gzip, deflate, br' }), c1.res, jsPath, { cacheSeconds: 3600, allowBrotli: true })
    expect(c1.status).toBe(200)
    expect(c1.headers['content-encoding']).toBe('br')
    expect(c1.headers['etag']).toMatch(/-br"$/)
    expect(c1.headers['content-length']).toBe(String(c1.body.length))
    expect(brotliDecompressSync(c1.body).toString('utf8')).toBe(content)

    const cHead = captureRes()
    serveFile(fakeReq({ 'accept-encoding': 'br' }, 'HEAD'), cHead.res, jsPath, { allowBrotli: true })
    expect(cHead.status).toBe(200)
    expect(cHead.headers['content-length']).toBe(String(c1.body.length))
    expect(cHead.body.length).toBe(0)

    const c304 = captureRes()
    serveFile(fakeReq({ 'accept-encoding': 'br', 'if-none-match': `W/${c1.headers['etag']}` }), c304.res, jsPath, { allowBrotli: true })
    expect(c304.status).toBe(304)
    expect(c304.body.length).toBe(0)
    expect(etagMatches(`W/${c1.headers['etag']}`, c1.headers['etag'])).toBe(true)

    const c2 = captureRes()
    serveFile(fakeReq({ 'accept-encoding': 'br' }), c2.res, jsPath, { allowBrotli: true })
    expect(c2.status).toBe(200)
    expect(c2.body.equals(c1.body)).toBe(true)
  })

  it('tryHandleStatic serves Brotli index.html with ?v= tokens and 304 conditional GET', async () => {
    const webDir = join(STATIC_SANDBOX, 'web')
    mkdirSync(join(webDir, 'lang'), { recursive: true })
    writeFileSync(join(webDir, 'app.js'), 'console.log("app");\n'.repeat(100))
    writeFileSync(join(webDir, 'style.css'), 'body{color:#fff}\n'.repeat(100))
    writeFileSync(join(webDir, 'lang', 'hu.js'), 'window.HU={};\n'.repeat(100))
    writeFileSync(join(webDir, 'lang', 'en.js'), 'window.EN={};\n'.repeat(100))
    writeFileSync(
      join(webDir, 'index.html'),
      `<!doctype html><html><head><link rel="stylesheet" href="/style.css"><script defer src="/lang/hu.js"></script><script defer src="/lang/en.js"></script><meta name="apple-mobile-web-app-title" content="Marveen"></head><body>${'<!-- pad -->'.repeat(150)}<script defer src="/app.js"></script></body></html>`,
    )

    const c1 = captureRes()
    const handled = await tryHandleStatic(
      { req: fakeReq({ 'accept-encoding': 'br, gzip' }), res: c1.res, path: '/', method: 'GET', url: new URL('http://localhost/') } as any,
      webDir,
    )
    expect(handled).toBe(true)
    expect(c1.status).toBe(200)
    expect(c1.headers['content-encoding']).toBe('br')
    expect(c1.headers['content-length']).toBe(String(c1.body.length))
    const html = brotliDecompressSync(c1.body).toString('utf8')
    expect(html).toMatch(/\/app\.js\?v=[0-9a-z.-]+/)
    expect(html).toMatch(/\/style\.css\?v=[0-9a-z.-]+/)
    expect(html).toMatch(/\/lang\/hu\.js\?v=[0-9a-z.-]+/)
    expect(html).toMatch(/\/lang\/en\.js\?v=[0-9a-z.-]+/)

    const c304 = captureRes()
    await tryHandleStatic(
      { req: fakeReq({ 'accept-encoding': 'br', 'if-none-match': c1.headers['etag'] }), res: c304.res, path: '/', method: 'GET', url: new URL('http://localhost/') } as any,
      webDir,
    )
    expect(c304.status).toBe(304)
  })

  it('jsonMaybeGzip sets exact Content-Length on compressed and uncompressed JSON', () => {
    const payload = { ok: true, padding: 'x'.repeat(2048) }

    const gz = captureRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip' }), gz.res, payload)
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(gz.headers['content-length']).toBe(String(gz.body.length))
    expect(JSON.parse(gunzipSync(gz.body).toString('utf8'))).toEqual(payload)

    const plain = captureRes()
    jsonMaybeGzip(fakeReq({}), plain.res, payload)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.headers['content-length']).toBe(String(plain.body.length))
    expect(JSON.parse(plain.body.toString('utf8'))).toEqual(payload)
  })
})

describe('env.ts parse cache, defensive copy, and invalidation', () => {
  it('caches reads, returns defensive copies, and invalidates on updates or external writes', () => {
    const envPath = join(ENV_SANDBOX, '.env')
    writeFileSync(envPath, 'FOO=alpha\nBAR=one\n')

    const first = readEnvFile()
    expect(first.FOO).toBe('alpha')
    first.FOO = 'mutated'
    expect(readEnvFile().FOO).toBe('alpha')

    updateEnvFile({ FOO: 'beta_updated' })
    expect(readEnvFile().FOO).toBe('beta_updated')

    writeEnvFileFresh(envPath, 'FRESH_KEY=gamma_fresh\n')
    expect(readEnvFile()).toEqual({ FRESH_KEY: 'gamma_fresh' })

    writeFileSync(envPath, 'EXTERNAL=delta_external_payload\n')
    utimesSync(envPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))
    expect(readEnvFile().EXTERNAL).toBe('delta_external_payload')

    rmSync(envPath, { force: true })
    expect(readEnvFile()).toEqual({})
  })
})

describe('status.ts parallel fetch & single-flight cache + system-status coalescing', () => {
  it('fetches RSS and components concurrently, coalesces in-flight calls, caches for TTL, and does not cache failures', async () => {
    const requested: string[] = []
    let releaseRss!: (v: Response) => void
    let releaseComp!: (v: Response) => void

    const rssPromise = new Promise<Response>((r) => { releaseRss = r })
    const compPromise = new Promise<Response>((r) => { releaseComp = r })

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      requested.push(String(url))
      if (String(url).includes('history.rss')) return rssPromise
      return compPromise
    }))

    const p1 = fetchAnthropicStatus()
    const p2 = fetchAnthropicStatus()
    await vi.waitFor(() => expect(requested).toHaveLength(2))
    expect(requested.some(u => u.includes('history.rss'))).toBe(true)
    expect(requested.some(u => u.includes('components.json'))).toBe(true)

    releaseRss(new Response('<rss><channel></channel></rss>', { status: 200 }))
    releaseComp(new Response(JSON.stringify({ components: [{ name: 'Claude API', status: 'operational' }] }), { status: 200 }))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)
    expect(r1.components).toEqual([{ name: 'Claude API', status: 'operational' }])
    expect(requested).toHaveLength(2)

    const cached = await fetchAnthropicStatus()
    expect(cached).toBe(r1)
    expect(requested).toHaveLength(2)

    _resetAnthropicStatusCacheForTest()
    let failCount = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      failCount++
      if (String(url).includes('history.rss') && failCount <= 2) throw new Error('network down')
      if (String(url).includes('history.rss')) return new Response('<rss><channel></channel></rss>', { status: 200 })
      return new Response(JSON.stringify({ components: [] }), { status: 200 })
    }))

    const errRes = await fetchAnthropicStatus()
    expect(errRes.overall).toBe('unknown')
    expect(errRes.error).toBe('Failed to fetch status')

    const recovered = await fetchAnthropicStatus()
    expect(recovered.error).toBeUndefined()
    expect(recovered.overall).toBe('operational')
  })

  it('coalesces concurrent getSystemStatus() calls cleanly', async () => {
    _resetSystemStatusCacheForTest()
    const [a, b] = await Promise.all([getSystemStatus(), getSystemStatus()])
    expect(a).toBe(b)
    expect(Array.isArray(a.blocks)).toBe(true)
    const labels = a.blocks.flatMap(blk => blk.rows.map(r => r.label))
    expect(labels).toContain('CLI verziók')
    expect(labels).toContain('Tárhely')
  })
})

describe('agent-terminal.ts SSE hub fan-out & deduplication', () => {
  async function openSse(name: string) {
    const req = fakeReq()
    const events: string[] = []
    const res: any = new Writable({
      write(chunk, _enc, cb) { events.push(chunk.toString()); cb() },
    })
    res.writeHead = () => res
    const url = new URL(`http://localhost/api/agents/${encodeURIComponent(name)}/pane/stream`)
    await tryHandleAgentTerminal({ req, res, path: url.pathname, method: 'GET', url } as any)
    return { req, events }
  }

  it('shares one poll loop across subscribers, suppresses identical frames, broadcasts changes, and stops on close', async () => {
    writeFileSync(FAKE_TMUX_LOG, '')
    writeFileSync(FAKE_PANE_FILE, 'INITIAL PANE\n')

    const s1 = await openSse(MAIN_AGENT_ID)
    await vi.waitFor(() => expect(s1.events.filter(e => e.startsWith('data: '))).toHaveLength(1))
    expect(JSON.parse(s1.events[0].slice(6).trim())).toEqual({ pane: 'INITIAL PANE\n', running: true })

    const s2 = await openSse(MAIN_AGENT_ID)
    expect(s2.events.filter(e => e.startsWith('data: '))).toHaveLength(1)
    expect(JSON.parse(s2.events[0].slice(6).trim())).toEqual({ pane: 'INITIAL PANE\n', running: true })

    await sleep(900)
    expect(s1.events.filter(e => e.startsWith('data: '))).toHaveLength(1)
    expect(s2.events.filter(e => e.startsWith('data: '))).toHaveLength(1)

    writeFileSync(FAKE_PANE_FILE, 'UPDATED PANE\n')
    await vi.waitFor(() => {
      expect(s1.events.filter(e => e.startsWith('data: ')).length).toBeGreaterThanOrEqual(2)
      expect(s2.events.filter(e => e.startsWith('data: ')).length).toBeGreaterThanOrEqual(2)
    }, { timeout: 3000 })

    expect(JSON.parse(s1.events[1].slice(6).trim())).toEqual({ pane: 'UPDATED PANE\n', running: true })
    expect(JSON.parse(s2.events[1].slice(6).trim())).toEqual({ pane: 'UPDATED PANE\n', running: true })

    s1.req.emit('close')
    s2.req.emit('close')
    await sleep(150)
    const { readFileSync } = await import('node:fs')
    const callsAfterClose = readFileSync(FAKE_TMUX_LOG, 'utf8').split('\n').filter(Boolean).length
    await sleep(900)
    const callsLater = readFileSync(FAKE_TMUX_LOG, 'utf8').split('\n').filter(Boolean).length
    expect(callsLater).toBe(callsAfterClose)
  })
})

describe('agent-config.ts mtime cache & invalidation', () => {
  it('returns updated config after writes/external edits and isolates mutated return objects', async () => {
    const demoDir = join(AGENT_SANDBOX, 'agents', 'demo')
    mkdirSync(demoDir, { recursive: true })
    const cfgPath = join(demoDir, 'agent-config.json')
    writeFileSync(cfgPath, JSON.stringify({ model: 'sonnet', displayName: 'Demo Initial' }))

    vi.resetModules()
    vi.doMock('../config.js', async (orig) => {
      const actual = await orig<typeof import('../config.js')>()
      return { ...actual, PROJECT_ROOT: AGENT_SANDBOX }
    })

    const ac = await import('../web/agent-config.js')
    try {
      expect(ac.readAgentDisplayName('demo')).toBe('Demo Initial')
      const obj = ac.readAgentConfigObject('demo')
      obj.displayName = 'Mutated Caller Object'
      expect(ac.readAgentConfigObject('demo').displayName).toBe('Demo Initial')

      ac.writeAgentDisplayName('demo', 'Demo Renamed')
      ac.writeAgentTagline('demo', 'Fast Helper')
      const model = 'claude-opus-5'
      ac.writeAgentModel('demo', model)
      expect(ac.readAgentDisplayName('demo')).toBe('Demo Renamed')
      expect(ac.readAgentTagline('demo')).toBe('Fast Helper')
      expect(ac.readAgentModel('demo')).toBe(model)

      writeFileSync(cfgPath, JSON.stringify({ model: 'haiku', displayName: 'External Edit Long', tagline: 'Updated' }))
      utimesSync(cfgPath, new Date(Date.now() + 2000), new Date(Date.now() + 2000))
      expect(ac.readAgentDisplayName('demo')).toBe('External Edit Long')
    } finally {
      vi.doUnmock('../config.js')
      vi.resetModules()
    }
  })
})
