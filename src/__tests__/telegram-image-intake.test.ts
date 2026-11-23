import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandoffContent } from '../channel-coordinator.js'
import { mapUpdate } from '../channel-coordinator/telegram-client.js'
import { cacheTelegramImages } from '../channel-coordinator/images.js'
import { listTelegramImages, pruneTelegramImages, readTelegramImage } from '../../scripts/telegram-image-cache.mjs'

const token = '100:fixture'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const photo = (id: number, chat = 42) => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: chat },
    from: { id: chat },
    media_group_id: '555',
    caption: id === 1 ? 'Nézd át az albumot' : undefined,
    photo: [
      { file_id: 'small-' + id, width: 80, height: 80 },
      { file_id: 'original-' + id, width: 500, height: 500 },
    ],
  },
})

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'marveen-telegram-media-')) })
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe('Telegram image intake', () => {
  it('caches the best copy of every image and lists large sets by album without leaking other chats', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'photos/file.png' } })
      : new Response(png))
    vi.stubGlobal('fetch', fetch)
    const events = Array.from({ length: 25 }, (_, i) => mapUpdate(photo(i + 1))!)
    const cached = await cacheTelegramImages(events, token, root)
    expect(cached.size).toBe(25)
    expect(fetch).toHaveBeenCalledTimes(50)
    const first = cached.get(1)!
    expect(readFileSync(first.path!)).toEqual(png)
    const prompt = buildHandoffContent({ ...events[0], meta: { ...events[0].meta, cached_image: first } }, false)
    expect(prompt).toContain('image_path="')
    expect(prompt).toContain('image_album_id="555"')
    expect(prompt).toContain('Nézd át az albumot')
    const firstPage = await listTelegramImages(root, token, '42', { albumId: '555', limit: 10 })
    const secondPage = await listTelegramImages(root, token, '42', { albumId: '555', limit: 10, after: firstPage.nextCursor! })
    const thirdPage = await listTelegramImages(root, token, '42', { albumId: '555', limit: 10, after: secondPage.nextCursor! })
    expect([...firstPage.images, ...secondPage.images, ...thirdPage.images].map(img => img.messageId)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    )
    expect(thirdPage.nextCursor).toBeNull()
    expect(await readTelegramImage(root, token, '42', first.id!)).toMatchObject({ mimeType: 'image/png', data: png.toString('base64') })
    await expect(readTelegramImage(root, token, '96', first.id!)).rejects.toThrow()
    await expect(readTelegramImage(root, token, '42', '../../secret')).rejects.toThrow()
    expect(events[0].meta).toMatchObject({ image: { fileId: 'original-1', albumId: '555' } })
  })

  it('supports raster images sent as files and reports invalid downloads in the handoff', async () => {
    const event = mapUpdate({
      update_id: 10, message: {
        message_id: 10, chat: { id: 42 }, from: { id: 42 },
        document: { file_id: 'doc-image', mime_type: 'image/png', file_name: 'diagram.png' },
      },
    })!
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'documents/file.png' } })
      : new Response('not a raster image')))
    const cached = await cacheTelegramImages([event], token, root)
    expect(event.meta).toMatchObject({ image: { fileId: 'doc-image' } })
    expect(buildHandoffContent({ ...event, meta: { ...event.meta, cached_image: cached.get(10) } }, false))
      .toContain('image_status="unavailable"')
  })

  it('gives the agent visual MCP content only for authorized, unexpired images', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/getFile')
      ? Response.json({ ok: true, result: { file_path: 'photos/file.png' } })
      : new Response(png)))
    const cached = await cacheTelegramImages([mapUpdate(photo(1))!, mapUpdate(photo(2))!], token, root)
    const expired = cached.get(2)!
    const old = new Date(Date.now() - 8 * 86_400_000)
    utimesSync(expired.path!, old, old)
    await pruneTelegramImages(root)
    expect(() => readFileSync(expired.path!)).toThrow()

    const scriptDir = join(root, 'scripts')
    const stateDir = join(root, 'state')
    mkdirSync(scriptDir)
    mkdirSync(stateDir)
    for (const script of ['channel-reply-mcp.mjs', 'telegram-image-cache.mjs']) {
      copyFileSync(resolve('scripts', script), join(scriptDir, script))
    }
    writeFileSync(join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=' + token + '\n')
    writeFileSync(join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['42'] }))
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    const result = spawnSync(process.execPath, [join(scriptDir, 'channel-reply-mcp.mjs')], {
      input: [
        call(1, 'telegram_list_images', { chat_id: '42', album_id: '555' }),
        call(2, 'telegram_read_image', { chat_id: '42', image_id: cached.get(1)!.id }),
        call(3, 'telegram_read_image', { chat_id: '43', image_id: cached.get(1)!.id }),
      ].join('\n') + '\n',
      encoding: 'utf8',
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, MARVEEN_HEADLESS_TELEGRAM: '1' },
    })
    expect(result.status).toBe(0)
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    const lookup = (id: number) => replies.find(reply => reply.id === id).result
    expect(JSON.parse(lookup(1).content[0].text).images.map((image: { messageId: number }) => image.messageId)).toEqual([1])
    expect(lookup(2).content).toEqual([{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }])
    expect(lookup(3).isError).toBe(true)
  })
})
