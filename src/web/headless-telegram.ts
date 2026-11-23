import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHandoffContent, resolveCoordinatorTelegramToken } from '../channel-coordinator.js'
import { closeIngestDb, commitIncomingBatch, getOffset, initIngestDb } from '../channel-coordinator/ingest.js'
import { getUpdates, mapUpdate, TelegramApiError, type NormalizedEvent } from '../channel-coordinator/telegram-client.js'
import { channelStateDir, getProvider, readChannelToken } from '../channel-provider.js'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { getHeadlessAgentState, listHeadlessTelegramAgents } from './headless-runner.js'

const POLL_MS = 5_000
const PAIRING_TTL_MS = 60 * 60_000
const getBotId = (token: string | null) => /^(\d+):[A-Za-z0-9_-]+$/.exec(token ?? '')?.[1]
const readToken = (dir: string) => readChannelToken('telegram', join(dir, '.env'))

interface PairingRequest {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
}

interface Access {
  dmPolicy?: string
  allowFrom: (number | string)[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: (number | string)[] }>
  pending?: Record<string, PairingRequest>
}

function readAccess(path: string): Access | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    if (!data || !Array.isArray(data.allowFrom)) return null
    return data
  } catch {
    return null
  }
}

function isAllowed(event: NormalizedEvent, access: Access): boolean {
  if (event.chat_id == null || event.user_id == null) return false
  if (event.chat_id === event.user_id) {
    return access.dmPolicy !== 'disabled' && access.allowFrom.some(id => String(id) === String(event.user_id))
  }
  const group = access.groups?.[String(event.chat_id)]
  if (group?.requireMention !== false) return false
  return group.allowFrom == null || (Array.isArray(group.allowFrom) &&
    (group.allowFrom.length === 0 || group.allowFrom.some(id => String(id) === String(event.user_id))))
}

export async function pollHeadlessTelegram(
  name: string,
  stateDir: string,
  opts: {
    fetchUpdates?: typeof getUpdates
    sendPairingNotice?: (token: string, chatId: string, message: string) => Promise<unknown>
    isCurrent?: () => boolean
    mainBotId?: string
  } = {},
): Promise<void> {
  const token = readToken(stateDir)
  const botId = getBotId(token)
  const accessPath = join(stateDir, 'access.json')
  if (!token || !botId || botId === opts.mainBotId || !readAccess(accessPath)) return

  initIngestDb()
  const source = `telegram:${name}:${botId}`
  const offset = getOffset(source)
  const updates = await (opts.fetchUpdates ?? getUpdates)(token, offset ? offset + 1 : 0, 0, 100)
  if (updates.length === 0 || opts.isCurrent?.() === false || readToken(stateDir) !== token) return
  const access = readAccess(accessPath)
  if (!access) return

  const events: Parameters<typeof commitIncomingBatch>[3] = []
  const pairings: { code: string; chatId: string }[] = []
  const now = Date.now()
  const pending = Object.fromEntries(Object.entries(access.pending ?? {})
    .filter(([, entry]) => entry?.expiresAt > now))
  let highWater = offset
  for (const raw of updates) {
    if (!Number.isSafeInteger(raw.update_id) || raw.update_id <= offset) continue
    highWater = Math.max(highWater, raw.update_id)
    const event = mapUpdate(raw)
    if (!event || event.kind === 'callback_query') continue
    if (isAllowed(event, access)) {
      events.push({ event, content: buildHandoffContent(event) })
    } else if (access.dmPolicy === 'pairing' && event.kind === 'message' &&
      event.user_id != null && event.chat_id === event.user_id &&
      Object.keys(pending).length < 5 &&
      !Object.values(pending).some(entry => entry.senderId === String(event.user_id))) {
      const code = randomBytes(4).toString('hex').toUpperCase()
      const chatId = String(event.chat_id)
      pending[code] = { senderId: chatId, chatId, createdAt: now, expiresAt: now + PAIRING_TTL_MS }
      pairings.push({ code, chatId })
    }
  }
  if (pairings.length > 0) {
    atomicWriteFileSync(accessPath, JSON.stringify({ ...access, pending }, null, 2), { mode: 0o600 })
  }
  if (highWater > offset) commitIncomingBatch(source, highWater, name, events)
  if (events.length > 0) logger.info({ name, updates: events.length }, 'Headless Telegram messages queued')

  const send = opts.sendPairingNotice ?? getProvider('telegram').sendMessage
  await Promise.all(pairings.map(async ({ code, chatId }) => {
    try {
      await send(token, chatId, `Pairing code: ${code}. Approve it in the Marveen dashboard, then resend your message.`)
    } catch {
      logger.warn({ name }, 'Headless Telegram pairing notice could not be sent')
    }
  }))
}

export function startHeadlessTelegramPolling(): () => void {
  let stopped = false
  const inFlight = new Set<string>()
  const retryAt = new Map<string, number>()
  const timer = setInterval(() => {
    const agents = listHeadlessTelegramAgents()
    if (agents.length === 0) return
    let mainBotId: string | undefined
    try { mainBotId = getBotId(resolveCoordinatorTelegramToken()) } catch { /* main has no Telegram token */ }
    const nativeMainToken = readToken(channelStateDir('telegram'))
    const nativeMainBotId = getBotId(nativeMainToken)
    const targets = agents.flatMap(agent => {
      const dir = agent.telegramStateDir
      if (!dir) return []
      const botId = getBotId(readToken(dir))
      return botId ? [{ agent, dir, botId }] : []
    })
    const counts = new Map<string, number>()
    for (const { botId } of targets) counts.set(botId, (counts.get(botId) ?? 0) + 1)
    for (const key of retryAt.keys()) {
      if (!counts.has(key)) retryAt.delete(key)
    }
    for (const { agent, dir, botId } of targets) {
      if (botId === mainBotId || botId === nativeMainBotId || counts.get(botId) !== 1 ||
        inFlight.has(botId) || (retryAt.get(botId) ?? 0) > Date.now()) continue
      inFlight.add(botId)
      void pollHeadlessTelegram(agent.name, dir, {
        mainBotId,
        isCurrent: () => !stopped && getHeadlessAgentState(agent.name) === agent,
      }).then(() => retryAt.delete(botId)).catch((error: unknown) => {
        const apiError = error instanceof TelegramApiError ? error : undefined
        const waitMs = apiError?.kind === 'rate_limit' ? (apiError.retryAfterSec ?? 30) * 1_000 : 60_000
        retryAt.set(botId, Date.now() + Math.max(POLL_MS, waitMs))
        logger.warn({ name: agent.name, kind: apiError?.kind ?? 'processing' }, 'Headless Telegram poll failed; will retry')
      }).finally(() => inFlight.delete(botId))
    }
  }, POLL_MS)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
    closeIngestDb()
  }
}
