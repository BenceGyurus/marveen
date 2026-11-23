import { saveTelegramImage, type CachedTelegramImage, type TelegramImage } from '../../scripts/telegram-image-cache.mjs'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import type { NormalizedEvent } from './telegram-client.js'

export async function cacheTelegramImages(
  events: NormalizedEvent[],
  token: string,
  root = PROJECT_ROOT,
): Promise<Map<number, CachedTelegramImage>> {
  const pending = events.flatMap(event => {
    const image = event.meta.image as TelegramImage | undefined
    return image && event.chat_id != null && event.message_id != null
      ? [{ event, image, chatId: String(event.chat_id), messageId: event.message_id }]
      : []
  })
  const cached = new Map<number, CachedTelegramImage>()
  for (let i = 0; i < pending.length; i += 3) {
    await Promise.all(pending.slice(i, i + 3).map(async ({ event, image, chatId, messageId }) => {
      try {
        cached.set(event.update_id, await saveTelegramImage(root, token, chatId, messageId, image))
      } catch {
        // A failed attachment must not block the caption or the next update.
        cached.set(event.update_id, { albumId: image.albumId })
        logger.warn({ updateId: event.update_id }, 'Telegram image download failed')
      }
    }))
  }
  return cached
}
