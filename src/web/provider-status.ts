import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { resolveCliBinary } from '../cli-detector.js'
import { compareVersions } from '../claude-cli-support.js'

const exec = promisify(execFile)

async function output(bin: string, args: string[], timeout = 6000) {
  const run = exec(bin, args, { timeout, maxBuffer: 2 * 1024 * 1024 })
  run.child.stdin?.end()
  return (await run).stdout
}

async function provider(id: 'codex' | 'agy') {
  const bin = resolveCliBinary(id)
  const installed = bin ? await output(bin, ['--version']).then(s => s.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null).catch(() => null) : null
  let latest: string | null = null
  try {
    if (id === 'agy' && bin) {
      latest = (await output(bin, ['changelog'])).match(/^(\d+\.\d+\.\d+):/m)?.[1] ?? null
    } else if (id === 'codex' && bin) {
      const response = await fetch('https://registry.npmjs.org/@openai/codex/latest', { signal: AbortSignal.timeout(6000) })
      if (response.ok) {
        const { version } = await response.json() as { version?: string }
        if (version && /^\d+\.\d+\.\d+$/.test(version)) latest = version
      }
    }
  } catch { /* Each source can be unavailable independently. */ }
  return { id, present: Boolean(bin), installed, latest, update: installed && latest ? compareVersions(latest, installed) > 0 : null }
}

async function collect() {
  const [codex, agy, usage] = await Promise.all([
    provider('codex'), provider('agy'),
    output('python3', [join(PROJECT_ROOT, 'scripts/provider-usage.py')], 12000)
      .then(s => JSON.parse(s)).catch(() => ({})),
  ])
  return [codex, agy].map(p => ({ ...p, usage: usage[p.id] ?? null }))
}

let cached: { until: number; result: ReturnType<typeof collect> } | undefined
export function providerStatus() {
  if (!cached || cached.until < Date.now()) cached = { until: Date.now() + 60_000, result: collect() }
  return cached.result
}
