// Thin Telegram Bot-API client for the standalone channel-coordinator.
//
// This is deliberately NOT grammy: the coordinator only needs getUpdates
// long-polling, and pulling grammy in would re-introduce the same in-memory
// offset handling and bot.start() lifecycle that the plugin uses. We poll with
// a raw fetch + AbortController read-timeout and persist the offset ourselves
// (see ingest.ts), so a crash/restart resumes exactly where we left off.
//
// This client never sends (outbound stays with the native plugin); it only
// ingests, and only while the native plugin is down (the coordinator backfills,
// see channel-coordinator.ts). In steady state the native plugin is the sole
// poller, so there is no 409 Conflict; a 409 here means the native came back
// and the coordinator yields.

const API_BASE = 'https://api.telegram.org'

// allowed_updates whitelist sent on every poll. callback_query is included so
// the coordinator at least records inline-button presses, even though the
// permission-relay path (notifications/claude/channel/permission) is a known
// gap in outbound-only mode -- see the design risk register.
export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'callback_query'] as const

export type UpdateKind = 'message' | 'edited_message' | 'channel_post' | 'callback_query'

export interface NormalizedEvent {
  update_id: number
  kind: UpdateKind
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  content: string
  meta: Record<string, unknown>
  tg_date: number | null
}

// One error type, classified by `kind` so the poll loop can pick a backoff
// strategy without re-parsing HTTP status / Bot-API error_code everywhere.
//   fatal     -> 401 invalid token: exit + alert, retrying is pointless
//   rate_limit-> 429: wait exactly parameters.retry_after seconds
//   conflict  -> 409: another poller holds the token; fixed backoff + window
//   transient -> 5xx / network / abort: exponential backoff with jitter
export type TelegramErrorKind = 'fatal' | 'rate_limit' | 'conflict' | 'transient'

export class TelegramApiError extends Error {
  constructor(
    public readonly kind: TelegramErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

interface RawUpdate {
  update_id: number
  message?: RawMessage
  edited_message?: RawMessage
  channel_post?: RawMessage
  callback_query?: {
    id: string
    data?: string
    from?: RawUser
    message?: RawMessage
  }
}

interface RawMessage {
  message_id: number
  date?: number
  text?: string
  caption?: string
  chat: { id: number; username?: string; title?: string }
  from?: RawUser
  photo?: { file_id: string; width: number; height: number }[]
  document?: { file_id: string; file_name?: string; mime_type?: string }
  media_group_id?: string
  voice?: { file_id: string }
  message_thread_id?: number
  is_topic_message?: boolean
}

interface RawUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

function displayName(u?: RawUser): string | null {
  if (!u) return null
  if (u.username) return u.username
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return full || String(u.id)
}

// Normalize a raw Telegram update into the flat shape the ingest layer stores.
// Returns null for update kinds we do not handle (so the caller still advances
// the offset past them rather than re-fetching forever).
export function mapUpdate(u: RawUpdate): NormalizedEvent | null {
  const msg = u.message ?? u.edited_message ?? u.channel_post
  if (msg) {
    const kind: UpdateKind = u.edited_message
      ? 'edited_message'
      : u.channel_post
        ? 'channel_post'
        : 'message'
    const meta: Record<string, unknown> = {}
    const photo = msg.photo?.reduce<NonNullable<RawMessage['photo']>[number] | undefined>((best, size) =>
      !best || size.width * size.height >= best.width * best.height ? size : best, undefined)
    const document = msg.document
    if (photo) meta['has_photo'] = true
    if (document) meta['document'] = { file_id: document.file_id, file_name: document.file_name }
    const imageFileId = photo?.file_id ?? (
      document && (/^image\/(?:jpeg|png|gif|webp)$/i.test(document.mime_type ?? '') ||
        /\.(?:jpe?g|png|gif|webp)$/i.test(document.file_name ?? '')) ? document.file_id : undefined
    )
    if (imageFileId) {
      meta['image'] = {
        fileId: imageFileId,
        ...(msg.media_group_id ? { albumId: msg.media_group_id } : {}),
      }
    }
    if (msg.voice) meta['voice'] = { file_id: msg.voice.file_id }
    // A topic of a private chat or forum; the handoff shows it only while
    // TELEGRAM_TOPICS_ENABLED is on (buildHandoffContent).
    if (msg.is_topic_message && msg.message_thread_id != null) meta['message_thread_id'] = msg.message_thread_id
    return {
      update_id: u.update_id,
      kind,
      chat_id: msg.chat.id,
      user_id: msg.from?.id ?? null,
      username: displayName(msg.from) ?? msg.chat.title ?? null,
      message_id: msg.message_id,
      content: msg.text ?? msg.caption ?? '',
      meta,
      tg_date: msg.date ?? null,
    }
  }
  if (u.callback_query) {
    const cq = u.callback_query
    return {
      update_id: u.update_id,
      kind: 'callback_query',
      chat_id: cq.message?.chat.id ?? null,
      user_id: cq.from?.id ?? null,
      username: displayName(cq.from),
      message_id: cq.message?.message_id ?? null,
      content: cq.data ?? '',
      meta: { callback_query_id: cq.id },
      tg_date: cq.message?.date ?? null,
    }
  }
  return null
}

interface UpdatesResponse {
  ok?: boolean
  result?: RawUpdate[]
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

async function requestUpdates(
  token: string,
  options: { offset: number; timeout: number; limit: number; allowed_updates?: typeof ALLOWED_UPDATES },
): Promise<{ response: Response; body: UpdatesResponse | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (options.timeout + 10) * 1000)
  try {
    const response = await fetch(`${API_BASE}/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options),
      signal: controller.signal,
    })
    let body: UpdatesResponse | null = null
    try {
      body = await response.json() as UpdatesResponse | null
    } catch (error) {
      // A proxy error can be plain text. Keep its HTTP status for classification,
      // but treat a stalled body exactly like a stalled connection.
      if (controller.signal.aborted || response.ok) throw error
    }
    return { response, body }
  } catch {
    throw new TelegramApiError('transient', controller.signal.aborted
      ? 'getUpdates request timed out'
      : 'getUpdates request or response failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function getUpdates(
  token: string,
  offset: number,
  timeout: number,
  limit: number,
): Promise<RawUpdate[]> {
  const { response, body } = await requestUpdates(token, { offset, timeout, limit, allowed_updates: ALLOWED_UPDATES })
  if (!response.ok) {
    const errorCode = typeof body?.error_code === 'number' ? body.error_code : response.status
    const description = body?.description ?? `HTTP ${response.status}`
    if (errorCode === 401) throw new TelegramApiError('fatal', `401 unauthorized: ${description}`)
    if (errorCode === 409) throw new TelegramApiError('conflict', `409 conflict: ${description}`)
    if (errorCode === 429) throw new TelegramApiError('rate_limit', `429 too many requests: ${description}`, body?.parameters?.retry_after)
    if (errorCode >= 500) throw new TelegramApiError('transient', `5xx: ${description}`)
    throw new TelegramApiError('fatal', `unexpected ${errorCode}: ${description}`)
  }
  if (!body?.ok || !Array.isArray(body.result)) {
    throw new TelegramApiError('transient', 'getUpdates returned no valid result')
  }
  return body.result
}

// Probe the current server-side high-water update_id WITHOUT confirming anything
// and WITHOUT sending allowed_updates. Telegram's negative offset returns the
// last |offset| updates from the end of the queue and does not advance the
// confirmed pointer, so this is a non-destructive read. We deliberately omit
// allowed_updates here: Telegram REMEMBERS the last allowed_updates passed, so
// sending our whitelist on a seed call could alter what a subsequent (or the
// native plugin's) poll receives. Returns the highest pending update_id, or
// null when the queue is empty. Used to seed poll_offset on entering a backfill
// window so we never re-deliver below the true high-water.
export async function probeHighWater(token: string): Promise<number | null> {
  const { response, body } = await requestUpdates(token, { offset: -1, limit: 1, timeout: 0 })
  if (!response.ok) {
    if (response.status === 401) throw new TelegramApiError('fatal', '401 unauthorized (high-water probe)')
    if (response.status === 409) throw new TelegramApiError('conflict', '409 conflict (high-water probe)')
    throw new TelegramApiError('transient', `high-water probe HTTP ${response.status}`)
  }
  if (!body?.ok || !Array.isArray(body.result)) {
    throw new TelegramApiError('transient', 'high-water probe returned no valid result')
  }
  return body.result.at(-1)?.update_id ?? null
}
