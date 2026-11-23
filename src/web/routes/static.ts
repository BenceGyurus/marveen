import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { compressBuffer, etagMatches, pickEncoding, serveFile, MIME } from '../http-helpers.js'
import { PROJECT_ROOT, BRAND_NAME } from '../../config.js'
import type { RouteContext } from './types.js'

const PROD_WEB_DIR = join(PROJECT_ROOT, 'web')
const PROD_DIST_WEB_DIR = join(PROJECT_ROOT, 'dist', 'web-assets')

/**
 * Resolve a static web asset, preferring its pre-minified `dist/web-assets/` artifact
 * when serving the project's own `web/` dir and the built file is up to date.
 */
export function resolveWebAssetPath(webDir: string, relPath: string): string {
  const srcPath = join(webDir, relPath)
  if (webDir !== PROD_WEB_DIR) return srcPath
  const builtPath = join(PROD_DIST_WEB_DIR, relPath)
  try {
    const builtStat = statSync(builtPath)
    const srcStat = statSync(srcPath)
    if (builtStat.mtimeMs >= srcStat.mtimeMs) return builtPath
  } catch {
    /* fall back to source asset when dist/web-assets/ is absent or older */
  }
  return srcPath
}

// Substitute the configured brand into the PWA manifest's user-visible fields
// (name/short_name) so an install that sets BRAND_NAME shows its own name on
// the installed home-screen icon. Replaces only those two quoted string values
// in place, preserving the file's exact formatting (whitespace + trailing
// newline), so a stock install (brandName == the shipped default) serves the
// file BYTE-FOR-BYTE unchanged. Keyed on the exact `"name"` / `"short_name"`
// keys (the `"name"` rule cannot match `"short_name"`). Pure + side-effect-free
// so it is provable independent of the request pipeline; a manifest missing the
// keys is returned untouched rather than throwing.
export function buildManifest(raw: string, brandName: string): string {
  return raw
    .replace(/^(\s*"name"\s*:\s*)"[^"]*"/m, (_m, p: string) => `${p}${JSON.stringify(`${brandName} Dashboard`)}`)
    .replace(/^(\s*"short_name"\s*:\s*)"[^"]*"/m, (_m, p: string) => `${p}${JSON.stringify(brandName)}`)
}

// Returns a short version token derived from an asset's mtime+size so the
// asset URL changes whenever the file changes, busting browser cache.
function assetVersionFromPath(filePath: string): string {
  try {
    const s = statSync(filePath)
    return `${s.mtimeMs.toString(36)}-${s.size.toString(36)}`
  } catch {
    return '0'
  }
}

const indexHtmlMemo = new Map<string, Buffer>()
const INDEX_MEMO_MAX = 12

function indexMemoGet(key: string): Buffer | undefined {
  const hit = indexHtmlMemo.get(key)
  if (hit) {
    indexHtmlMemo.delete(key)
    indexHtmlMemo.set(key, hit)
  }
  return hit
}

function indexMemoSet(key: string, buf: Buffer): void {
  if (indexHtmlMemo.has(key)) indexHtmlMemo.delete(key)
  else if (indexHtmlMemo.size >= INDEX_MEMO_MAX) {
    const oldest = indexHtmlMemo.keys().next().value
    if (oldest !== undefined) indexHtmlMemo.delete(oldest)
  }
  indexHtmlMemo.set(key, buf)
}

function serveIndexHtml(ctx: RouteContext, webDir: string): void {
  const { req, res } = ctx
  try {
    const filePath = join(webDir, 'index.html')
    const s = statSync(filePath)
    const appVer = assetVersionFromPath(resolveWebAssetPath(webDir, 'app.js'))
    const cssVer = assetVersionFromPath(resolveWebAssetPath(webDir, 'style.css'))
    const huVer = assetVersionFromPath(resolveWebAssetPath(webDir, 'lang/hu.js'))
    const enVer = assetVersionFromPath(resolveWebAssetPath(webDir, 'lang/en.js'))
    const encoding = pickEncoding(req, true)
    // All versioned asset tokens + compression variant form the index ETag:
    // cached index.html is invalidated whenever any ?v= URL or encoding changes.
    const baseEtag = `${s.mtimeMs}-${s.size}-${appVer}-${cssVer}-${huVer}-${enVer}`
    const etag = encoding ? `"${baseEtag}-${encoding}"` : `"${baseEtag}"`
    const lastModified = s.mtime.toUTCString()
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': 'no-cache',
        Vary: 'Accept-Encoding',
      })
      res.end()
      return
    }
    const memoKey = `${filePath}:${BRAND_NAME}:${etag}`
    let body = indexMemoGet(memoKey)
    if (!body) {
      const html = readFileSync(filePath, 'utf-8')
        .replace(
          /(<script\s+(?:defer\s+)?src=")\/app\.js(")/,
          `$1/app.js?v=${appVer}$2`,
        )
        // style.css and lang/*.js get the same ?v= cache-busting as app.js so
        // they can be served with a long max-age (see tryHandleStatic below).
        .replace(
          /(<link\s+rel="stylesheet"\s+href=")\/style\.css(")/,
          `$1/style.css?v=${cssVer}$2`,
        )
        .replace(
          /(<script\s+(?:defer\s+)?src=")\/lang\/hu\.js(")/,
          `$1/lang/hu.js?v=${huVer}$2`,
        )
        .replace(
          /(<script\s+(?:defer\s+)?src=")\/lang\/en\.js(")/,
          `$1/lang/en.js?v=${enVer}$2`,
        )
        // Bake the iOS home-screen label into apple-mobile-web-app-title so an
        // installed PWA shows the configured main-agent name (BRAND_NAME), not the
        // bundled "Marveen" default. Done server-side (not JS) so it is reliable
        // at "Add to Home Screen" time regardless of script timing.
        .replace(
          /(<meta name="apple-mobile-web-app-title" content=")[^"]*(">)/,
          `$1${escapeAttr(BRAND_NAME)}$2`,
        )
      const raw = Buffer.from(html, 'utf-8')
      body = encoding ? compressBuffer(raw, encoding) : raw
      indexMemoSet(memoKey, body)
    }
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': String(body.length),
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(404); res.end('Not found')
  }
}

// Resolve the stored main-agent avatar's MIME type (null if none stored, so we
// keep the static fallback icons). Mirrors the /api/marveen/avatar route's
// extension probe order.
function detectAvatarType(): string | null {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (existsSync(join(PROJECT_ROOT, 'store', `marveen-avatar${ext}`))) return MIME[ext]
  }
  return null
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Allowlist for the /avatars/ and /icons/ single-segment filename (mirrors the
// NAME_RE + basename() guard in routes/docs.ts). Combined with the basename()
// check below this blocks path traversal (../, absolute paths, nested
// segments). Extensions cover every file shipped under web/avatars (png +
// gallery.html) and web/icons (png); defense-in-depth, the pathname is already
// WHATWG-normalized upstream.
const STATIC_NAME_RE = /^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|svg|ico|html)$/

export async function tryHandleStatic(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path } = ctx

  if (path === '/' || path === '/index.html') { serveIndexHtml(ctx, webDir); return true }
  // app.js/style.css URLs are versioned (?v=mtime-size, rewritten into
  // index.html above), so a long max-age is safe: any content change produces
  // a new URL. index.html itself stays no-cache.
  if (path === '/style.css') { serveFile(req, res, resolveWebAssetPath(webDir, 'style.css'), { cacheSeconds: 86400, allowBrotli: true }); return true }
  if (path === '/app.js') { serveFile(req, res, resolveWebAssetPath(webDir, 'app.js'), { cacheSeconds: 86400, allowBrotli: true }); return true }
  if (path === '/manifest.json') {
    // Brand the manifest (name/short_name -> BRAND_NAME, byte-preserving for the
    // shipped default via buildManifest) and, when a main-agent avatar is stored,
    // repoint the install icons at the live avatar so the home-screen / PWA icon
    // matches the browser favicon (<link rel="icon" href="/api/marveen/avatar">).
    // The declared icon MIME type is detected from the stored file -- Chrome drops
    // icons whose type lies. Falls back to the static manifest if anything fails.
    try {
      const branded = buildManifest(readFileSync(join(webDir, 'manifest.json'), 'utf-8'), BRAND_NAME)
      const avatarType = detectAvatarType()
      if (!avatarType) {
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json',
          'Content-Length': String(Buffer.byteLength(branded)),
          'Cache-Control': 'no-cache',
        })
        res.end(branded)
      } else {
        const manifest = JSON.parse(branded)
        manifest.icons = [
          { src: '/api/marveen/avatar', sizes: '192x192', type: avatarType, purpose: 'any' },
          { src: '/api/marveen/avatar', sizes: '512x512', type: avatarType, purpose: 'any' },
        ]
        const payload = JSON.stringify(manifest)
        res.writeHead(200, {
          'Content-Type': 'application/manifest+json',
          'Content-Length': String(Buffer.byteLength(payload)),
          'Cache-Control': 'no-cache',
        })
        res.end(payload)
      }
    } catch {
      serveFile(req, res, join(webDir, 'manifest.json'))
    }
    return true
  }
  if (path === '/sw.js') { serveFile(req, res, join(webDir, 'sw.js'), { allowBrotli: true }); return true }

  if (path.startsWith('/lang/')) {
    const langFile = path.replace('/lang/', '')
    // Allowlist: only the two known language files (no path traversal).
    if (langFile === 'hu.js' || langFile === 'en.js') {
      serveFile(req, res, resolveWebAssetPath(webDir, join('lang', langFile)), { cacheSeconds: 86400, allowBrotli: true })
      return true
    }
    res.writeHead(404); res.end()
    return true
  }

  if (path.startsWith('/avatars/')) {
    const avatarFile = path.replace('/avatars/', '')
    if (!STATIC_NAME_RE.test(avatarFile) || basename(avatarFile) !== avatarFile) {
      res.writeHead(404); res.end()
      return true
    }
    serveFile(req, res, join(webDir, 'avatars', avatarFile), { cacheSeconds: 3600 })
    return true
  }

  if (path.startsWith('/icons/')) {
    const iconFile = path.replace('/icons/', '')
    if (!STATIC_NAME_RE.test(iconFile) || basename(iconFile) !== iconFile) {
      res.writeHead(404); res.end()
      return true
    }
    serveFile(req, res, join(webDir, 'icons', iconFile), { cacheSeconds: 3600 })
    return true
  }

  return false
}
