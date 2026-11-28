export function deferralReasonKey(reason?: string): 'busy' | 'usage' | 'permission' | 'other' {
  if (reason === 'session-running' || reason === 'user-active' || reason === 'already-queued' || reason === 'queue-wait-timeout') return 'busy';
  if (reason === 'usage-limit-wait') return 'usage';
  if (reason === 'routine-permission-unavailable') return 'permission';
  return 'other';
}
