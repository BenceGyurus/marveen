import { transform } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC_WEB = join(ROOT, 'web')
const DIST_WEB = join(ROOT, 'dist', 'web-assets')

const ASSETS = [
  { rel: 'app.js', loader: 'js' },
  { rel: 'style.css', loader: 'css' },
  { rel: 'lang/hu.js', loader: 'js' },
  { rel: 'lang/en.js', loader: 'js' },
  { rel: 'operator.js', loader: 'js' },
  { rel: 'video-review.js', loader: 'js' },
]

export async function buildWebAssets() {
  for (const { rel, loader } of ASSETS) {
    const srcPath = join(SRC_WEB, rel)
    const outPath = join(DIST_WEB, rel)
    const source = readFileSync(srcPath, 'utf8')
    const result = await transform(source, {
      loader,
      minify: true,
      charset: 'utf8',
      target: 'es2022',
      legalComments: 'none',
    })
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, result.code, 'utf8')
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWebAssets()
}
