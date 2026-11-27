#!/usr/bin/env node
/**
 * Minimal stdio MCP server (`marveen_telegram`) enabling Codex and Antigravity
 * orchestrators to reply to Telegram chats without exposing TELEGRAM_BOT_TOKEN
 * in MCP config files, CLI arguments, or agent environments.
 */

import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { listTelegramImages, readTelegramImage } from './telegram-image-cache.mjs'

const SERVER_NAME = 'marveen_telegram'
const SERVER_VERSION = '1.0.0'
const SAFE_CHAT_ID_RE = /^(?:-?\d{1,20}|@[A-Za-z0-9_]{3,64})$/
const TELEGRAM_MAX_CHUNK = 4000

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT_ROOT = resolve(HERE, '..')

function isRegularFile(p) {
  try {
    return existsSync(p) && !lstatSync(p).isSymbolicLink() && lstatSync(p).isFile()
  } catch {
    return false
  }
}

function candidateStateDirs(projectRoot) {
  const explicit = (process.env.TELEGRAM_STATE_DIR || '').trim()
  if (process.env.MARVEEN_HEADLESS_TELEGRAM === '1') return explicit ? [explicit] : []
  const home = homedir()
  const out = []
  if (explicit) out.push(explicit)
  out.push(join(projectRoot, 'store', '.claude-channels', 'telegram'))
  out.push(join(projectRoot, 'store', '.channels', 'telegram'))
  out.push(join(projectRoot, '.claude', 'channels', 'telegram'))
  out.push(join(home, '.claude', 'channels', 'telegram'))
  return out
}

function readEnvKeyFromFile(filePath, key) {
  if (!isRegularFile(filePath)) return null
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    for (const raw of lines) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      if (k !== key) continue
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (val) return val
    }
  } catch { /* ignore */ }
  return null
}

function resolveTelegramCredentials(projectRoot = DEFAULT_PROJECT_ROOT) {
  const scoped = process.env.MARVEEN_HEADLESS_TELEGRAM === '1'
  const dirs = candidateStateDirs(projectRoot)
  let token = null
  let allowFrom = new Set()
  const groupChats = new Set()

  for (const dir of dirs) {
    if (!token) {
      token = readEnvKeyFromFile(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN')
    }
    const accessPath = join(dir, 'access.json')
    if (allowFrom.size === 0 && isRegularFile(accessPath)) {
      try {
        const parsed = JSON.parse(readFileSync(accessPath, 'utf-8'))
        const list = Array.isArray(parsed?.allowFrom) ? parsed.allowFrom : []
        for (const item of list) {
          const s = String(item).trim()
          if (s) allowFrom.add(s)
        }
        if (parsed?.groups && typeof parsed.groups === 'object') {
          for (const chatId of Object.keys(parsed.groups)) {
            groupChats.add(chatId)
            if (scoped) allowFrom.add(chatId)
          }
        }
      } catch { /* ignore */ }
    }
  }

  if (!token && !scoped) {
    token = readEnvKeyFromFile(join(projectRoot, '.env'), 'TELEGRAM_BOT_TOKEN')
  }
  if (allowFrom.size === 0 && !scoped) {
    const allowedChat = readEnvKeyFromFile(join(projectRoot, '.env'), 'ALLOWED_CHAT_ID')
    if (allowedChat && allowedChat !== '0') allowFrom.add(allowedChat)
  }

  return { token, allowFrom, scoped, groupChats }
}

function splitChunks(text, limit = TELEGRAM_MAX_CHUNK) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit)
    if (splitAt < Math.floor(limit * 0.4)) splitAt = limit
    chunks.push(rest.slice(0, splitAt))
    rest = rest.slice(splitAt).replace(/^\n/, '')
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

async function sendTelegramReply(args) {
  const rawChatId = String(args?.chat_id ?? '').trim()
  const text = String(args?.text ?? '')
  const replyToRaw = args?.reply_to_message_id ?? args?.reply_to
  const replyTo = replyToRaw !== undefined && replyToRaw !== null && String(replyToRaw).trim() !== ''
    ? Number(replyToRaw)
    : undefined

  const { token, allowFrom, scoped } = resolveTelegramCredentials()
  const chatId = rawChatId || (allowFrom.size === 1 ? Array.from(allowFrom)[0] : '')
  if (!chatId || !SAFE_CHAT_ID_RE.test(chatId)) {
    throw new Error('Invalid or missing chat_id')
  }
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured on host')
  }
  if ((scoped || allowFrom.size > 0) && !allowFrom.has(chatId)) {
    throw new Error(`chat_id ${chatId} is not in allowFrom`)
  }
  if (!text.trim()) {
    throw new Error('Empty message text')
  }

  const chunks = splitChunks(text)
  const sentIds = []
  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      chat_id: chatId,
      text: chunks[i],
    }
    if (i === 0 && Number.isInteger(replyTo) && replyTo > 0) {
      payload.reply_to_message_id = replyTo
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) {
      throw new Error(`Telegram API error (${res.status}): ${data?.description || 'unknown'}`)
    }
    if (data?.result?.message_id) sentIds.push(data.result.message_id)
  }

  return `sent (message_id: ${sentIds.join(', ') || 'ok'})`
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

async function sendTelegramPhoto(args) {
  const rawChatId = String(args?.chat_id ?? '').trim()
  const photoPath = String(args?.photo_path ?? '').trim()
  const caption = String(args?.caption ?? '').trim()
  const replyToRaw = args?.reply_to_message_id ?? args?.reply_to
  const replyTo = replyToRaw !== undefined && replyToRaw !== null && String(replyToRaw).trim() !== ''
    ? Number(replyToRaw)
    : undefined

  const { token, allowFrom, scoped } = resolveTelegramCredentials()
  const chatId = rawChatId || (allowFrom.size === 1 ? Array.from(allowFrom)[0] : '')
  if (!chatId || !SAFE_CHAT_ID_RE.test(chatId)) {
    throw new Error('Invalid or missing chat_id')
  }
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured on host')
  }
  if ((scoped || allowFrom.size > 0) && !allowFrom.has(chatId)) {
    throw new Error(`chat_id ${chatId} is not in allowFrom`)
  }
  if (!photoPath) {
    throw new Error('Missing photo_path')
  }
  const absPath = resolve(photoPath)
  if (!isRegularFile(absPath)) {
    throw new Error(`Photo file not found: ${absPath}`)
  }
  const size = statSync(absPath).size
  if (size <= 0 || size > 10 * 1024 * 1024) {
    throw new Error(`Photo size out of Telegram limits (1B..10MB): ${size} bytes`)
  }

  const ext = extname(absPath).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'image/png'
  const buf = readFileSync(absPath)
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('photo', new Blob([buf], { type: mime }), basename(absPath))
  if (caption) form.append('caption', caption.slice(0, 1024))
  if (Number.isInteger(replyTo) && replyTo > 0) {
    form.append('reply_to_message_id', String(replyTo))
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    body: form,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram API error (${res.status}): ${data?.description || 'unknown'}`)
  }
  return `photo sent (message_id: ${data?.result?.message_id ?? 'ok'})`
}

const TOOLS = [
  {
    name: 'telegram_reply',
    description: 'Send a text reply to a Telegram chat configured on this Marveen host.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Telegram chat ID (e.g. "123456789"). Omit only if a single default owner chat is configured.',
        },
        text: {
          type: 'string',
          description: 'Reply message text.',
        },
        reply_to_message_id: {
          type: 'string',
          description: 'Optional Telegram message_id to thread as a reply.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'telegram_send_photo',
    description: 'Send a local image file (PNG/JPG/WEBP/GIF, max 10MB) to a Telegram chat configured on this Marveen host.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Telegram chat ID (e.g. "123456789"). Omit only if a single default owner chat is configured.',
        },
        photo_path: {
          type: 'string',
          description: 'Absolute or workspace-relative path to the local image file.',
        },
        caption: {
          type: 'string',
          description: 'Optional photo caption (max 1024 chars).',
        },
        reply_to_message_id: {
          type: 'string',
          description: 'Optional Telegram message_id to thread as a reply.',
        },
      },
      required: ['photo_path'],
    },
  },
  {
    name: 'telegram_list_images',
    description: 'List recent Telegram images for the current chat, optionally filtered to an album. Pass nextCursor as after to continue, and open each relevant image using telegram_read_image.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID from the channel message.' },
        album_id: { type: 'string', description: 'Optional image_album_id from the channel message.' },
        after: { type: 'string', description: 'Optional nextCursor from the previous page.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'telegram_read_image',
    description: 'Open one cached Telegram image as visual input. Use the image_id from the channel message or an id returned by telegram_list_images.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID from the channel message.' },
        image_id: { type: 'string', description: 'The cached image ID.' },
      },
      required: ['chat_id', 'image_id'],
    },
  },
]

async function callTool({ params }) {
  try {
    const name = params?.name
    if (name === 'telegram_list_images' || name === 'telegram_read_image') {
      const args = params?.arguments ?? {}
      const chatId = String(args.chat_id ?? '').trim()
      const { token, allowFrom, groupChats } = resolveTelegramCredentials()
      if (!token || (!allowFrom.has(chatId) && !groupChats.has(chatId))) {
        throw new Error('Telegram image chat is not authorized')
      }
      const content = name === 'telegram_read_image'
        ? await readTelegramImage(DEFAULT_PROJECT_ROOT, token, chatId, args.image_id)
        : {
          type: 'text',
          text: JSON.stringify(await listTelegramImages(DEFAULT_PROJECT_ROOT, token, chatId, {
            albumId: args.album_id, after: args.after, limit: args.limit,
          })),
        }
      return { content: [content] }
    }
    if (name === 'telegram_reply') {
      const resultText = await sendTelegramReply(params?.arguments || {})
      return { content: [{ type: 'text', text: resultText }] }
    }
    if (name === 'telegram_send_photo') {
      const resultText = await sendTelegramPhoto(params?.arguments || {})
      return { content: [{ type: 'text', text: resultText }] }
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }
  }
  throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${params.name}`)
}

serveStdio(() => {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }))
  server.setRequestHandler('tools/call', callTool)
  return server
})
