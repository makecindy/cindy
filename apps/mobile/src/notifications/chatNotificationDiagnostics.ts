import { mobileDebugLog } from '@/debug/mobileDebugLog';

type Stage = 'unavailable' | 'disabled' | 'permission-denied' | 'identity' | 'paused' | 'credentials' | 'no-token' | 'configured' | 'failed' | 'signed-out';
let stage: Stage = 'unavailable';
let failedAt: Stage | undefined;
let foreground: 'invalid-route' | 'other-route' | 'reading' | 'allowed' | undefined;
export function recordChatForegroundDecision(value: NonNullable<typeof foreground>) {
  foreground = value;
  mobileDebugLog('info', 'notifications', 'foreground-decision', { decision: value });
}
export function recordChatBackgroundStage(value: Stage) {
  failedAt = value === 'failed' ? stage : undefined;
  stage = value;
  if (value === 'signed-out' || value === 'unavailable') foreground = undefined;
  mobileDebugLog('info', 'notifications', 'background-stage', { stage });
}

const connections = new Set(['stopped', 'connecting', 'authenticating', 'ready', 'auth-timeout', 'actor-mismatch',
  'server-error', 'protocol-error', 'closed', 'disconnected', 'auth-or-connect-failed']);
const numbers = ['inboxAt', 'inboxRows', 'httpStatus', 'messageChannelImportance', 'invalid', 'wrongRecipient',
  'duplicates', 'dispatched', 'constructed', 'changeFrames', 'sessionDispatched', 'sessionDuplicates', 'sessionInvalid'] as const;

/** Explicit local export only. Old native runtimes remain supported; no arbitrary native fields escape. */
export async function readChatNotificationDiagnostics(): Promise<Record<string, string | number | boolean>> {
  const result: Record<string, string | number | boolean> = { stage };
  if (failedAt) result.failedAt = failedAt;
  if (foreground) result.foreground = foreground;
  try {
    const { default: Native } = await import('../../modules/cindy-chat-notifications/src');
    const snapshot = await Native?.getDiagnostics?.();
    if (!snapshot || typeof snapshot !== 'object') return result;
    if (typeof snapshot.sessionRelay === 'string' && ['stopped', 'connecting', 'ready', 'subscribed', 'unsupported', 'denied', 'reconnecting', 'peer-timeout'].includes(snapshot.sessionRelay)) result.sessionRelay = snapshot.sessionRelay;
    for (const key of ['connection', 'connectionError']) {
      const value = snapshot[key];
      if (typeof value === 'string' && (connections.has(value) || value === 'none')) result[key] = value;
    }
    if (typeof snapshot.inbox === 'string' && ['unchecked', 'failed', 'http-error', 'ok'].includes(snapshot.inbox)) result.inbox = snapshot.inbox;
    for (const key of numbers) {
      const value = snapshot[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= -2) result[key] = value;
    }
    for (const key of ['serviceRunning', 'notificationsEnabled']) {
      if (typeof snapshot[key] === 'boolean') result[key] = snapshot[key] as boolean;
    }
  } catch { result.nativeReadFailed = true; }
  return result;
}
