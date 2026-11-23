export interface TelegramImage {
  fileId: string
  albumId?: string
}

export interface CachedTelegramImage {
  id?: string
  path?: string
  albumId?: string
}

export function saveTelegramImage(root: string, token: string, chatId: string, messageId: number, image: TelegramImage): Promise<CachedTelegramImage>
export function listTelegramImages(root: string, token: string, chatId: string, options?: { albumId?: string; after?: string; limit?: number }): Promise<{
  images: { id: string; messageId: number; albumId: string | null; path: string }[]
  nextCursor: string | null
}>
export function readTelegramImage(root: string, token: string, chatId: string, id: string): Promise<{ type: 'image'; mimeType: string; data: string }>
export function pruneTelegramImages(root: string, now?: number): Promise<void>
