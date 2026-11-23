#!/usr/bin/env node
/**
 * Minimal stdio MCP server (`marveen_telegram`) enabling Codex and Antigravity
 * orchestrators to reply to Telegram chats without exposing TELEGRAM_BOT_TOKEN
 * in MCP config files, CLI arguments, or agent environments.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

function writeRpc(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handleRequest(msg) {
  const { id, method, params } = msg
  if (method === 'notifications/initialized' || id === undefined) return

  try {
    if (method === 'initialize') {
      writeRpc({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      })
      return
    }
    if (method === 'ping') {
      writeRpc({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'tools/list') {
      writeRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
      return
    }
    if (method === 'tools/call') {
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
        writeRpc({ jsonrpc: '2.0', id, result: { content: [content] } })
        return
      }
      if (name === 'telegram_reply') {
        const resultText = await sendTelegramReply(params?.arguments || {})
        writeRpc({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: resultText }] },
        })
        return
      }
      writeRpc({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${String(name)}` },
      })
      return
    }
    writeRpc({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    })
  } catch (err) {
    writeRpc({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      },
    })
  }
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      void handleRequest(parsed)
    } catch { /* ignore malformed lines */ }
  }
})
