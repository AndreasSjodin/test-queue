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
