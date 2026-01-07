import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { config } from './config'

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const dbPath = path.join(dataDir, 'queue.db')

// Lazy initialization to handle HMR in development
let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(dbPath)
    _db.pragma('journal_mode = WAL')

    // Initialize schema
    _db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        status TEXT DEFAULT 'waiting',
        result TEXT,
        error TEXT,
        retried INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_started ON jobs(started_at) WHERE status = 'active';
    `)
  }
  return _db
}

// Cleanup on process exit
if (typeof process !== 'undefined') {
  const cleanup = () => {
    if (_db) {
      _db.close()
      _db = null
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
}

// ============ Operations ============

export function addJob(type: string, data: unknown): string {
  const db = getDb()
  const id = crypto.randomUUID()

  db.prepare(
    'INSERT INTO jobs (id, type, data) VALUES (?, ?, ?)'
  ).run(id, type, JSON.stringify(data))

  return id
}

export function claimNextJob(): { id: string; type: string; data: unknown } | null {
  const db = getDb()
  const timeoutMinutes = config.jobTimeoutMinutes

  // Use transaction for atomic claim
  const claim = db.transaction(() => {
    // First, recover timed-out jobs (only if not already retried)
    db.prepare(`
      UPDATE jobs
      SET status = 'waiting', started_at = NULL
      WHERE status = 'active'
        AND retried = 0
        AND started_at < datetime('now', '-' || ? || ' minutes')
    `).run(timeoutMinutes)

    // Mark timed-out retried jobs as failed
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = 'Timed out after retry', completed_at = datetime('now')
      WHERE status = 'active'
        AND retried = 1
        AND started_at < datetime('now', '-' || ? || ' minutes')
    `).run(timeoutMinutes)

    // Claim next waiting job
    const job = db.prepare(`
      SELECT id, type, data FROM jobs
      WHERE status = 'waiting'
      ORDER BY created_at
      LIMIT 1
    `).get() as { id: string; type: string; data: string } | undefined

    if (!job) return null

    // Mark as active
    db.prepare(`
      UPDATE jobs
      SET status = 'active', started_at = datetime('now'), retried = retried + 1
      WHERE id = ?
    `).run(job.id)

    return {
      id: job.id,
      type: job.type,
      data: JSON.parse(job.data)
    }
  })

  return claim()
}

export function completeJob(id: string, result: unknown): boolean {
  const db = getDb()
  const info = db.prepare(`
    UPDATE jobs
    SET status = 'completed', result = ?, completed_at = datetime('now')
    WHERE id = ? AND status = 'active'
  `).run(JSON.stringify(result), id)

  return info.changes > 0
}

export function failJob(id: string, error: string): boolean {
  const db = getDb()
  const info = db.prepare(`
    UPDATE jobs
    SET status = 'failed', error = ?, completed_at = datetime('now')
    WHERE id = ? AND status = 'active'
  `).run(error, id)

  return info.changes > 0
}

export function getJobCounts(): Record<string, number> {
  const db = getDb()
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM jobs
    GROUP BY status
  `).all() as { status: string; count: number }[]

  return {
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    ...Object.fromEntries(rows.map(r => [r.status, r.count]))
  }
}

export function getRecentJobs(limit = 100): Array<{
  id: string
  type: string
  status: string
  created_at: string
}> {
  const db = getDb()
  return db.prepare(`
    SELECT id, type, status, created_at
    FROM jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as Array<{ id: string; type: string; status: string; created_at: string }>
}

export function cleanupOldJobs(): number {
  const db = getDb()
  const days = config.cleanupAfterDays

  const info = db.prepare(`
    DELETE FROM jobs
    WHERE status IN ('completed', 'failed')
      AND completed_at < datetime('now', '-' || ? || ' days')
  `).run(days)

  return info.changes
}
