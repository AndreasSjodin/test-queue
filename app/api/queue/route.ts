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
