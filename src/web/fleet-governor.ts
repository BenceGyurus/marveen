import { readFileSync } from 'node:fs'
import os from 'node:os'
import { logger } from '../logger.js'

export type TurnPriority = 'critical' | 'high' | 'normal' | 'low'

const PRIORITY_RANK: Record<TurnPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export interface GovernorTask<T = unknown> {
  id: string
  agentKey: string
  priority: TurnPriority
  enqueuedAt: number
  run: (signal: AbortSignal) => Promise<T>
  resolve: (val: T) => void
  reject: (err: unknown) => void
  controller: AbortController
}

export interface GovernorStats {
  maxConcurrent: number
  activeCount: number
  queuedCount: number
  availableMemMb: number
  totalMemMb: number
  cpus: number
  activeAgents: string[]
  queuedAgents: string[]
  minAvailMemMb: number
}

/**
 * Compute hardware-safe default concurrency for active headless agent turns.
 * Leaves 1 vCPU for OS/dashboard/DB and budgets ~2200 MB peak per active CLI turn
 * after reserving 2500 MB for host + dashboard + channel coordinator.
 *
 * Example (4 vCPU, 12 GB RAM): min(3, floor(9788 / 2200)) = 3 concurrent turns.
 */
export function computeDefaultConcurrency(cpus: number, totalMemMb: number): number {
  const safeCpus = Math.max(1, Math.floor(cpus))
  const safeMemMb = Math.max(1024, Math.floor(totalMemMb))
  const cpuCap = Math.max(1, safeCpus - 1)
  const memCap = Math.max(1, Math.floor(Math.max(2200, safeMemMb - 2500) / 2200))
  return Math.max(1, Math.min(cpuCap, memCap))
}

/**
 * Read available host memory in MB. On Linux, parses /proc/meminfo MemAvailable
 * (which accounts for reclaimable page cache); elsewhere falls back to os.freemem().
 */
export function getAvailableMemoryMb(): number {
  if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf-8')
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)
      if (m && m[1]) {
        return Math.max(0, Math.round(parseInt(m[1], 10) / 1024))
      }
    } catch { /* fall back to os.freemem */ }
  }
  return Math.max(0, Math.round(os.freemem() / (1024 * 1024)))
}

export function resolveMaxConcurrentTurns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MARVEEN_MAX_CONCURRENT_TURNS)
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  const cpus = os.cpus().length || 2
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024))
  return computeDefaultConcurrency(cpus, totalMemMb)
}

export function resolveMinAvailMemMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MARVEEN_MIN_AVAIL_MEM_MB)
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
  // On Linux, /proc/meminfo MemAvailable includes reclaimable page cache (900 MB is a true floor).
  // On macOS, os.freemem() excludes inactive/purgeable pages, so use a lower free-page floor.
  return process.platform === 'linux' ? 900 : 256
}

export class FleetGovernor {
  private readonly queue: GovernorTask<unknown>[] = []
  private readonly activeByAgent = new Map<string, GovernorTask<unknown>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private seq = 0

  enqueue<T>(opts: {
    agentKey: string
    priority?: TurnPriority
    run: (signal: AbortSignal) => Promise<T>
  }): Promise<T> {
    const priority = opts.priority ?? 'normal'
    const controller = new AbortController()
    return new Promise<T>((resolve, reject) => {
      const task: GovernorTask<T> = {
        id: `turn-${++this.seq}`,
        agentKey: opts.agentKey,
        priority,
        enqueuedAt: Date.now(),
        run: opts.run,
        resolve,
        reject,
        controller,
      }
      this.insertSorted(task as GovernorTask<unknown>)
      this.pump()
    })
  }

  private insertSorted(task: GovernorTask<unknown>): void {
    const rank = PRIORITY_RANK[task.priority]
    let idx = this.queue.length
    for (let i = 0; i < this.queue.length; i++) {
      if (PRIORITY_RANK[this.queue[i]!.priority] > rank) {
        idx = i
        break
      }
    }
    this.queue.splice(idx, 0, task)
  }

  /**
   * Cancel all queued and active turns for an agent (e.g. on stopAgentProcess).
   */
  cancelAgent(agentKey: string): number {
    let cancelled = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.agentKey === agentKey) {
        const [removed] = this.queue.splice(i, 1)
        removed!.controller.abort()
        removed!.reject(new Error(`Turn cancelled for stopped agent: ${agentKey}`))
        cancelled++
      }
    }
    const active = this.activeByAgent.get(agentKey)
    if (active) {
      active.controller.abort()
      cancelled++
    }
    return cancelled
  }

  isAgentActiveOrQueued(agentKey: string): boolean {
    if (this.activeByAgent.has(agentKey)) return true
    return this.queue.some(t => t.agentKey === agentKey)
  }

  getAgentQueuePosition(agentKey: string): number {
    const idx = this.queue.findIndex(t => t.agentKey === agentKey)
    return idx >= 0 ? idx + 1 : 0
  }

  getStats(): GovernorStats {
    const cpus = os.cpus().length || 1
    const totalMemMb = Math.round(os.totalmem() / (1024 * 1024))
    return {
      maxConcurrent: resolveMaxConcurrentTurns(),
      activeCount: this.activeByAgent.size,
      queuedCount: this.queue.length,
      availableMemMb: getAvailableMemoryMb(),
      totalMemMb,
      cpus,
      activeAgents: [...this.activeByAgent.keys()],
      queuedAgents: this.queue.map(t => t.agentKey),
      minAvailMemMb: resolveMinAvailMemMb(),
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.queue.length === 0) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.pump()
    }, 2000)
    if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref()
  }

  private pump(): void {
    if (this.queue.length === 0) return
    const maxConcurrent = resolveMaxConcurrentTurns()
    const minAvailMemMb = resolveMinAvailMemMb()

    while (this.activeByAgent.size < maxConcurrent && this.queue.length > 0) {
      // Memory admission control: when >=1 turn is already running, hold new
      // spawns if host MemAvailable is below the safety floor.
      if (this.activeByAgent.size >= 1) {
        const avail = getAvailableMemoryMb()
        if (avail < minAvailMemMb) {
          logger.warn(
            { availMemMb: avail, minAvailMemMb, activeCount: this.activeByAgent.size, queuedCount: this.queue.length },
            'fleet-governor: holding queued turn due to low available memory',
          )
          this.scheduleRetry()
          return
        }
      }

      // Find the highest-priority queued task whose agent does not already have an active turn.
      const nextIdx = this.queue.findIndex(t => !this.activeByAgent.has(t.agentKey))
      if (nextIdx === -1) {
        // All queued tasks belong to agents that are currently mid-turn.
        return
      }

      const [task] = this.queue.splice(nextIdx, 1)
      if (!task) return

      this.activeByAgent.set(task.agentKey, task)
      void this.executeTask(task)
    }
  }

  private async executeTask(task: GovernorTask<unknown>): Promise<void> {
    try {
      const result = await task.run(task.controller.signal)
      task.resolve(result)
    } catch (err) {
      task.reject(err)
    } finally {
      if (this.activeByAgent.get(task.agentKey)?.id === task.id) {
        this.activeByAgent.delete(task.agentKey)
      }
      this.pump()
    }
  }
}

export const fleetGovernor = new FleetGovernor()
