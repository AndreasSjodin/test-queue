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
