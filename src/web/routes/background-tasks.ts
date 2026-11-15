import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath, tryResolveFromPath } from '../../platform.js'
import { getCliTypeForModel, resolveCliBinary } from '../../cli-detector.js'
import { APP_TZ, MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { fleetVenvPathPrefix } from '../agent-process.js'
import { ROOT_SANDBOX_ENV } from '../root-sandbox-env.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import { exactTmuxTarget } from '../../tmux-target.js'

const execFileAsync = promisify(execFile)

function tmuxBin(): string {
  return resolveFromPath('tmux')
}

function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function resolveBgAgentModel(agentId: string): string | null {
  try {
    const cfgPath = join(PROJECT_ROOT, 'agents', agentId, 'agent-config.json')
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { model?: unknown }
      if (typeof cfg.model === 'string' && cfg.model.trim()) return cfg.model.trim()
    }
    if (agentId === MAIN_AGENT_ID || agentId === 'marveen') {
      const envPath = join(STORE_DIR, '..', '.env')
      if (existsSync(envPath)) {
        for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
          const m = /^(?:export\s+)?(MAIN_AGENT_MODEL|MAIN_MODEL)\s*=\s*(.+)$/.exec(line.trim())
          if (m) {
            const val = m[2].trim().replace(/^["']|["']$/g, '')
            if (val) return val
          }
        }
      }
    }
  } catch { /* fall through */ }
  return null
}

function buildBackgroundTaskExec(agentId: string): string {
  const model = resolveBgAgentModel(agentId)
  const cliType = getCliTypeForModel(model)
  const cleanModel = model ? model.replace(/^(?:claude|codex|openai|agy|antigravity):/i, '') : ''

  if (cliType === 'codex') {
    const codexBin = resolveCliBinary('codex') ?? 'codex'
    const modelFlag = cleanModel ? ` -m ${shSingleQuote(cleanModel)}` : ''
    return `${ROOT_SANDBOX_ENV} && unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ${shSingleQuote(codexBin)} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${modelFlag} "$BG_PROMPT" 2>&1`
  }
  if (cliType === 'agy') {
    const agyBin = resolveCliBinary('agy') ?? 'agy'
    const modelFlag = cleanModel ? ` --model ${shSingleQuote(cleanModel)}` : ''
    return `${ROOT_SANDBOX_ENV} && unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ${shSingleQuote(agyBin)} --dangerously-skip-permissions -p "$BG_PROMPT"${modelFlag} 2>&1`
  }

  const claudeBin = tryResolveFromPath('claude')
  if (claudeBin) {
    return `${ROOT_SANDBOX_ENV} && ${shSingleQuote(claudeBin)} -p "$BG_PROMPT" --output-format text 2>&1`
  }
  const fallbackAgy = resolveCliBinary('agy')
  if (fallbackAgy) {
    return `${ROOT_SANDBOX_ENV} && unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ${shSingleQuote(fallbackAgy)} --dangerously-skip-permissions -p "$BG_PROMPT" 2>&1`
  }
  const fallbackCodex = resolveCliBinary('codex')
  if (fallbackCodex) {
    return `${ROOT_SANDBOX_ENV} && unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY && ${shSingleQuote(fallbackCodex)} exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$BG_PROMPT" 2>&1`
  }
  return `${ROOT_SANDBOX_ENV} && claude -p "$BG_PROMPT" --output-format text 2>&1`
}
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function bgSessionName(id: string): string {
  return `bg-${id}`
}

// A tmux that does not answer within the timeout used to read as a dead session, so the
// task was closed while its session (and the claude -p in it) ran on with no owner. Only
// a non-zero tmux exit (e.g. 1, "no server running") means the session is really gone.
async function bgSessionState(session: string): Promise<'alive' | 'dead' | 'unknown'> {
  try {
    const { stdout } = await execFileAsync(tmuxBin(), ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return stdout.split('\n').some(l => l.trim() === session) ? 'alive' : 'dead'
  } catch (err) {
    if (typeof (err as { code?: unknown }).code === 'number') return 'dead'
    logger.warn({ err, session }, 'tmux list-sessions did not answer; background task liveness unknown')
    return 'unknown'
  }
}

async function captureSession(session: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(tmuxBin(), ['capture-pane', '-t', exactTmuxTarget(session), '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
    return stdout
  } catch {
    return null
  }
}

async function killSession(session: string): Promise<void> {
  try {
    await execFileAsync(tmuxBin(), ['kill-session', '-t', exactTmuxTarget(session)], { timeout: 3000 })
  } catch { /* already dead */ }
}

export async function spawnBackgroundTask(agentId: string, prompt: string): Promise<BackgroundTask | { error: string }> {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  const shellCmd = [
    // FLEETVENV923: the fleet venv's bin/ first, as in every agent launch.
    `export PATH="${fleetVenvPathPrefix()}$HOME/.local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    'export CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
    buildBackgroundTaskExec(agentId),
  ].join(' && ')

  try {
    await execFileAsync(tmuxBin(), [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}; echo '___BG_DONE___'; sleep 5`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    if (getBackgroundTask(id)?.status === 'running') finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  const current = getBackgroundTask(id)
  if (!current || current.status !== 'running') {
    await killSession(session)
    logger.info({ id, session }, 'Background task cancelled during spawn; session killed')
    return current ?? task
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  setTimeout(() => { void checkAndFinalize(id) }, TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  let busy = false

  async function tick(): Promise<void> {
    try {
      const task = getBackgroundTask(id)
      if (!task || task.status !== 'running') { clearInterval(interval); return }

      const session = task.tmux_session
      if (!session) { clearInterval(interval); return }

      const state = await bgSessionState(session)
      if (getBackgroundTask(id)?.status !== 'running') { clearInterval(interval); return }
      if (state === 'unknown') return // tmux did not answer; ask again on the next tick
      if (state === 'dead') {
        finishBackgroundTask(id, 'done', '(session ended)')
        logger.info({ id }, 'Background task session ended')
        clearInterval(interval)
        return
      }

      const pane = await captureSession(session)
      if (getBackgroundTask(id)?.status !== 'running') { clearInterval(interval); return }
      if (pane && pane.includes('___BG_DONE___')) {
        const output = pane.replace(/___BG_DONE___[\s\S]*$/, '').trim()
        finishBackgroundTask(id, 'done', output)
        clearInterval(interval)
        await killSession(session)
        logger.info({ id }, 'Background task completed')
      }
    } catch (err) {
      logger.warn({ err, id }, 'Background task poll tick failed')
    }
  }

  const interval = setInterval(() => {
    if (busy) return
    busy = true
    void tick().finally(() => { busy = false })
  }, 10_000)
}

async function checkAndFinalize(id: string): Promise<void> {
  try {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') return

    const session = task.tmux_session
    const output = session ? await captureSession(session) : null
    if (getBackgroundTask(id)?.status !== 'running') return
    finishBackgroundTask(id, 'timeout', output?.trim() || '(timeout)')
    if (session) await killSession(session)
    logger.warn({ id }, 'Background task timed out after 30 minutes')
  } catch (err) {
    logger.warn({ err, id }, 'Background task timeout check failed')
  }
}

export async function sweepOrphanedBackgroundTasks(): Promise<void> {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    const state = task.tmux_session ? await bgSessionState(task.tmux_session) : 'dead'
    if (state === 'dead') {
      const output = task.tmux_session ? await captureSession(task.tmux_session) : null
      // A DELETE may have closed the task while the sweep awaited tmux.
      if (getBackgroundTask(task.id)?.status !== 'running') continue
      finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
      orphaned++
    } else {
      if (getBackgroundTask(task.id)?.status !== 'running') continue
      setTimeout(() => { void checkAndFinalize(task.id) }, TIMEOUT_MS)
      pollUntilDone(task.id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = await spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error }, 429)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    let row = task
    if (task.status === 'running' && task.tmux_session) {
      liveOutput = await captureSession(task.tmux_session)
      // The poller or a DELETE can finish the task while the capture was in
      // flight; answer with the row as it is NOW, not the stale 'running' one.
      row = getBackgroundTask(taskMatch[1]) ?? task
    }

    json(res, {
      ...row,
      liveOutput: row.status === 'running' ? liveOutput : null,
      started_label: new Date(row.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: row.finished_at ? new Date(row.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    const output = task.tmux_session ? await captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      await killSession(task.tmux_session)
    }
    finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
    json(res, { ok: true })
    return true
  }

  return false
}
