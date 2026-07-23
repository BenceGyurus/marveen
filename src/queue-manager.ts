import Database from 'better-sqlite3'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database | null = null

export interface WorkerJob {
  id: string
  queue_name: string
  payload: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  created_at: number
}

export function initQueueManager(): void {
  const dbPath = join(STORE_DIR, 'worker_queue.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_jobs (
      id TEXT PRIMARY KEY,
      queue_name TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      error_msg TEXT
    )
  `)
  
  db.exec(`CREATE INDEX IF NOT EXISTS idx_worker_jobs_queue_status ON worker_jobs(queue_name, status, created_at)`)
  logger.info('Queue manager (embedded MQ) initialized.')
}

export function enqueueJob(queueName: string, payload: Record<string, any>): string {
  if (!db) initQueueManager()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`
  const stmt = db!.prepare(`
    INSERT INTO worker_jobs (id, queue_name, payload, created_at)
    VALUES (?, ?, ?, ?)
  `)
  stmt.run(id, queueName, JSON.stringify(payload), Date.now())
  return id
}

// Transactional pop: guarantees exactly-once delivery across multiple workers
export function dequeueJob(queueName: string): WorkerJob | null {
  if (!db) initQueueManager()
  
  const popTransaction = db!.transaction(() => {
    // Find the oldest pending job
    const job = db!.prepare(`
      SELECT * FROM worker_jobs 
      WHERE queue_name = ? AND status = 'pending' 
      ORDER BY created_at ASC LIMIT 1
    `).get(queueName) as WorkerJob | undefined

    if (job) {
      // Mark as processing
      db!.prepare(`
        UPDATE worker_jobs 
        SET status = 'processing', started_at = ? 
        WHERE id = ?
      `).run(Date.now(), job.id)
      job.status = 'processing'
      return job
    }
    return null
  })

  return popTransaction()
}

export function completeJob(id: string, success: boolean, errorMsg?: string): void {
  if (!db) initQueueManager()
  const status = success ? 'completed' : 'failed'
  db!.prepare(`
    UPDATE worker_jobs 
    SET status = ?, finished_at = ?, error_msg = ? 
    WHERE id = ?
  `).run(status, Date.now(), errorMsg || null, id)
}
