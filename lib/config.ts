export const config = {
  jobTimeoutMinutes: parseInt(process.env.JOB_TIMEOUT_MINUTES || '30'),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '1048576'),
  cleanupAfterDays: parseInt(process.env.CLEANUP_AFTER_DAYS || '30'),
}
