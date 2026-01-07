# feat: JSON Queue Messaging System (SQLite + HTTP)

**Created:** 2025-12-14
**Type:** Enhancement
**Complexity:** Low

## Overview

Dead-simple JSON queue:
- SQLite database (persistent, no Docker needed)
- 3 HTTP endpoints (no auth - IP whitelisted at network level)
- Basic dashboard page
- Auto-retry on timeout, auto-cleanup old jobs

## Architecture

```
┌─────────────────┐  POST /api/queue     ┌──────────────────┐
│  External       │ ───────────────────▶ │  Next.js         │
│  Clients        │  (IP whitelisted)    │                  │
└─────────────────┘                      │  ┌────────────┐  │
                                         │  │  SQLite    │  │
┌─────────────────┐  GET /api/queue      │  │  (file)    │  │
│  macOS Worker   │ ───────────────────▶ │  └────────────┘  │
│                 │ ◀─────────────────── │                  │
│                 │  PUT /api/queue/:id  │                  │
└─────────────────┘                      └──────────────────┘
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Framework | Next.js 16 |
| Database | SQLite (better-sqlite3) |
| Auth | None (IP whitelist at network level) |

## Configuration

```bash
# .env
JOB_TIMEOUT_MINUTES=30      # Jobs auto-retry after this
MAX_PAYLOAD_BYTES=1048576   # 1MB max payload
CLEANUP_AFTER_DAYS=30       # Auto-delete old jobs
```

## Database Schema

```sql
CREATE TABLE jobs (
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

CREATE INDEX idx_jobs_status ON jobs(status, created_at);
CREATE INDEX idx_jobs_started ON jobs(started_at) WHERE status = 'active';
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/queue` | Add job |
| GET | `/api/queue` | Get & claim next job (+ recover timed out jobs) |
| PUT | `/api/queue/:id` | Complete/fail job |

## File Structure

```
app/
├── api/
│   └── queue/
│       ├── route.ts          # POST + GET
│       └── [id]/
│           └── route.ts      # PUT
├── dashboard/
│   └── page.tsx
lib/
├── db.ts                     # SQLite setup + operations
├── config.ts                 # Environment config
└── validation.ts             # Input validation
data/
└── queue.db                  # SQLite file (gitignored)
.env.example
```

## Implementation

### lib/config.ts

```typescript
export const config = {
  jobTimeoutMinutes: parseInt(process.env.JOB_TIMEOUT_MINUTES || '30'),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '1048576'),
  cleanupAfterDays: parseInt(process.env.CLEANUP_AFTER_DAYS || '30'),
}
```

### lib/validation.ts

```typescript
import { config } from './config'

export type ValidationResult =
  | { ok: true; type: string; data: unknown }
  | { ok: false; error: string }

export function validateJobInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object' }
  }

  const { type, data } = body as Record<string, unknown>

  if (!type || typeof type !== 'string') {
    return { ok: false, error: 'type must be a non-empty string' }
  }

  if (type.length > 100) {
    return { ok: false, error: 'type must be 100 characters or less' }
  }

  if (data === undefined) {
    return { ok: false, error: 'data is required' }
  }

  // Check payload size
  const dataStr = JSON.stringify(data)
  if (dataStr.length > config.maxPayloadBytes) {
    return { ok: false, error: `data exceeds ${config.maxPayloadBytes} bytes` }
  }

  return { ok: true, type, data }
}

export function validateCompleteInput(body: unknown):
  | { ok: true; status: 'completed' | 'failed'; result?: unknown; error?: string }
  | { ok: false; error: string } {

  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object' }
  }

  const { status, result, error } = body as Record<string, unknown>

  if (status !== 'completed' && status !== 'failed') {
    return { ok: false, error: 'status must be "completed" or "failed"' }
  }

  return { ok: true, status, result, error: typeof error === 'string' ? error : undefined }
}
```

### lib/db.ts

```typescript
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
        AND started_at < datetime('now', '-${timeoutMinutes} minutes')
    `).run()

    // Mark timed-out retried jobs as failed
    db.prepare(`
      UPDATE jobs
      SET status = 'failed', error = 'Timed out after retry', completed_at = datetime('now')
      WHERE status = 'active'
        AND retried = 1
        AND started_at < datetime('now', '-${timeoutMinutes} minutes')
    `).run()

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
      AND completed_at < datetime('now', '-${days} days')
  `).run()

  return info.changes
}
```

### app/api/queue/route.ts

```typescript
import { NextResponse } from 'next/server'
import { addJob, claimNextJob, cleanupOldJobs } from '@/lib/db'
import { validateJobInput } from '@/lib/validation'

// POST - Add job
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const validation = validateJobInput(body)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  const id = addJob(validation.type, validation.data)
  return NextResponse.json({ id, status: 'waiting' }, { status: 201 })
}

// GET - Claim next job
export async function GET() {
  // Opportunistically cleanup old jobs (cheap operation)
  cleanupOldJobs()

  const job = claimNextJob()

  if (!job) {
    return new NextResponse(null, { status: 204 })
  }

  return NextResponse.json(job)
}
```

### app/api/queue/[id]/route.ts

```typescript
import { NextResponse } from 'next/server'
import { completeJob, failJob } from '@/lib/db'
import { validateCompleteInput } from '@/lib/validation'

// PUT - Complete or fail job
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const validation = validateCompleteInput(body)
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }

  let success: boolean
  if (validation.status === 'completed') {
    success = completeJob(id, validation.result)
  } else {
    success = failJob(id, validation.error || 'Unknown error')
  }

  if (!success) {
    return NextResponse.json({ error: 'Job not found or not active' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
```

### app/dashboard/page.tsx

```typescript
import { getJobCounts, getRecentJobs } from '@/lib/db'

export const dynamic = 'force-dynamic'

export default function Dashboard() {
  const counts = getJobCounts()
  const jobs = getRecentJobs(100)

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Queue Dashboard</h1>

      <div className="flex gap-4 mb-6">
        <div className="bg-yellow-100 p-3 rounded">Waiting: {counts.waiting}</div>
        <div className="bg-blue-100 p-3 rounded">Active: {counts.active}</div>
        <div className="bg-green-100 p-3 rounded">Completed: {counts.completed}</div>
        <div className="bg-red-100 p-3 rounded">Failed: {counts.failed}</div>
      </div>

      <table className="w-full">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">ID</th>
            <th className="p-2">Type</th>
            <th className="p-2">Status</th>
            <th className="p-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id} className="border-b">
              <td className="p-2 font-mono text-sm">{job.id.slice(0, 8)}</td>
              <td className="p-2">{job.type}</td>
              <td className="p-2">
                <span className={
                  job.status === 'completed' ? 'text-green-600' :
                  job.status === 'failed' ? 'text-red-600' :
                  job.status === 'active' ? 'text-blue-600' :
                  'text-yellow-600'
                }>
                  {job.status}
                </span>
              </td>
              <td className="p-2">{job.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

### .env.example

```bash
JOB_TIMEOUT_MINUTES=30
MAX_PAYLOAD_BYTES=1048576
CLEANUP_AFTER_DAYS=30
```

### .gitignore addition

```
data/
```

## Tasks

- [ ] Install better-sqlite3
- [ ] Create lib/config.ts
- [ ] Create lib/validation.ts
- [ ] Create lib/db.ts with all operations
- [ ] Create POST/GET /api/queue
- [ ] Create PUT /api/queue/:id
- [ ] Create dashboard page
- [ ] Add .env.example
- [ ] Test full flow

## Behavior Summary

**Job Lifecycle:**
1. Client POSTs job → status: `waiting`
2. Worker GETs job → status: `active`, starts timeout clock
3. Worker PUTs completion → status: `completed` or `failed`

**Timeout Handling:**
- Jobs `active` longer than `JOB_TIMEOUT_MINUTES` auto-retry once
- If retry also times out → marked `failed`

**Cleanup:**
- Old `completed`/`failed` jobs auto-deleted after `CLEANUP_AFTER_DAYS`
- Cleanup runs opportunistically on each GET request

## macOS Worker Example

```typescript
// worker.ts
const API_URL = 'https://your-server.com'

async function poll() {
  while (true) {
    try {
      const res = await fetch(`${API_URL}/api/queue`)

      if (res.status === 204) {
        await sleep(3000)
        continue
      }

      const job = await res.json()
      console.log('Processing:', job.id, job.type)

      try {
        const result = await process(job)
        await fetch(`${API_URL}/api/queue/${job.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed', result })
        })
      } catch (err: any) {
        await fetch(`${API_URL}/api/queue/${job.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'failed', error: err.message })
        })
      }
    } catch (err) {
      console.error('Poll error:', err)
      await sleep(5000)
    }
  }
}

async function process(job: any) {
  // Your logic here
  return { done: true }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

poll()
```

## API Usage

```bash
# Add job
curl -X POST http://localhost:3000/api/queue \
  -H "Content-Type: application/json" \
  -d '{"type": "process_image", "data": {"url": "https://example.com/img.jpg"}}'

# Get next job (worker)
curl http://localhost:3000/api/queue

# Complete job
curl -X PUT http://localhost:3000/api/queue/JOB_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "result": {"processed": true}}'

# Fail job
curl -X PUT http://localhost:3000/api/queue/JOB_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "failed", "error": "Something went wrong"}'
```
