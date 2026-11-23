import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const API_BASE = 'https://api.telegram.org'
const MAX_BYTES = 20 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ID = /^(\d{16})\.([A-Za-z0-9_-]{1,64})\.([a-f0-9]{20})\.(jpg|png|gif|webp)$/
const CHAT_ID = /^-?\d{1,20}$/
const BOT_TOKEN = /^(\d+):[A-Za-z0-9_-]+$/
const ALBUM_ID = /^[A-Za-z0-9_-]{1,64}$/
const MIME_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

async function chatDirectory(root, token, chatId, create = false) {
  const botId = BOT_TOKEN.exec(token)?.[1]
  if (!botId || !CHAT_ID.test(chatId)) throw new Error('Invalid Telegram bot or chat')
  let dir = root
  for (const segment of ['store', 'telegram-images', botId, chatId]) {
    dir = join(dir, segment)
    if (create) {
      await mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    }
    const stat = await lstat(dir).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return null
    if (!stat.isDirectory()) throw new Error('Invalid Telegram image directory')
  }
  return dir
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  throw new Error('Unsupported Telegram image format')
}

async function fetchImage(token, fileId) {
  const signal = AbortSignal.timeout(15_000)
  const info = await fetch(`${API_BASE}/bot${token}/getFile`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }), signal,
  })
  if (!info.ok) throw new Error('Telegram getFile failed')
  const metadata = await info.json()
  const { file_path: path, file_size: size } = metadata.result ?? {}
  if (!metadata.ok || typeof path !== 'string' || !/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(path) ||
    size > MAX_BYTES) throw new Error('Telegram file unavailable or too large')
  const response = await fetch(`${API_BASE}/file/bot${token}/${path}`, { signal })
  if (!response.ok || !response.body) throw new Error('Telegram image download failed')
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body.cancel()
    throw new Error('Telegram image too large')
  }
  const chunks = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new Error('Telegram image too large')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, total)
}

function isFresh(stat, now = Date.now()) {
  return stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES && now - stat.mtimeMs <= MAX_AGE_MS
}

export async function saveTelegramImage(root, token, chatId, messageId, image) {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Invalid Telegram message ID')
  const albumId = typeof image.albumId === 'string' && ALBUM_ID.test(image.albumId) ? image.albumId : undefined
  const hash = createHash('sha256').update(image.fileId).digest('hex').slice(0, 20)
  const stem = `${String(messageId).padStart(16, '0')}.${albumId ?? '0'}.${hash}`
  const dir = await chatDirectory(root, token, chatId, true)

  for (const ext of Object.keys(MIME_TYPES)) {
    const id = `${stem}.${ext}`
    const path = join(dir, id)
    const stat = await lstat(path).catch(() => null)
    if (stat && isFresh(stat)) return { id, path, albumId }
  }
  const data = await fetchImage(token, image.fileId)
  const id = `${stem}.${imageExtension(data)}`
  const path = join(dir, id)
  const temp = join(dir, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
  return { id, path, albumId }
}

export async function listTelegramImages(root, token, chatId, { albumId, after, limit } = {}) {
  if (albumId != null && (typeof albumId !== 'string' || !ALBUM_ID.test(albumId))) throw new Error('Invalid album ID')
  if (after != null && (typeof after !== 'string' || !ID.test(after))) throw new Error('Invalid image cursor')
  const pageSize = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 30
  const images = []
  const dir = await chatDirectory(root, token, chatId)
  if (!dir) return { images, nextCursor: null }
  const files = (await readdir(dir)).sort()
  for (const id of files) {
    const info = ID.exec(id)
    if (!info || (after && id <= after) || (albumId && info[2] !== albumId)) continue
    const path = join(dir, id)
    const stat = await lstat(path).catch(() => null)
    if (!stat || !isFresh(stat)) continue
    if (images.length === pageSize) return { images, nextCursor: images.at(-1).id }
    images.push({ id, messageId: Number(info[1]), albumId: info[2] === '0' ? null : info[2], path })
  }
  return { images, nextCursor: null }
}

export async function readTelegramImage(root, token, chatId, id) {
  const info = typeof id === 'string' ? ID.exec(id) : null
  if (!info) throw new Error('Invalid image ID')
  const dir = await chatDirectory(root, token, chatId)
  if (!dir) throw new Error('Image unavailable for this chat')
  const file = await open(join(dir, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error('Image unavailable for this chat') })
  try {
    const stat = await file.stat()
    if (!isFresh(stat)) throw new Error('Image unavailable or expired')
    const bytes = await file.readFile()
    return { type: 'image', mimeType: MIME_TYPES[imageExtension(bytes)], data: bytes.toString('base64') }
  } finally {
    await file.close()
  }
}

async function subdirectories(dir) {
  return (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && CHAT_ID.test(entry.name))
}

export async function pruneTelegramImages(root, now = Date.now()) {
  const store = join(root, 'store')
  if (!(await lstat(store).catch(() => null))?.isDirectory()) return
  const base = join(store, 'telegram-images')
  if (!(await lstat(base).catch(() => null))?.isDirectory()) return
  for (const bot of await subdirectories(base)) {
    const botDir = join(base, bot.name)
    for (const chat of await subdirectories(botDir)) {
      const dir = join(botDir, chat.name)
      for (const name of await readdir(dir).catch(() => [])) {
        if (!ID.test(name) && !/^\.[a-f0-9-]{36}\.tmp$/.test(name)) continue
        const path = join(dir, name)
        const stat = await lstat(path).catch(() => null)
        if (stat?.isFile() && now - stat.mtimeMs > MAX_AGE_MS) await rm(path, { force: true })
      }
    }
  }
}
