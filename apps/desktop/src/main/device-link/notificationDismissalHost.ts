import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createNotificationDismissalLedger, type NotificationDismissalState, type TrackedNotification } from './notificationDismissal.js';

const log = createLogger('notification-dismissal');
const storage = createOverrideSettingsFile<NotificationDismissalState>({
  filePath: () => ownerScopedUserDataPath('notification-dismissals.json'),
  scopeKey: () => activeOwnerScopeKey(),
  defaults: () => ({ pending: [], retired: [] }),
  normalize(value) {
    const row = value as Partial<NotificationDismissalState> | null;
    return {
      pending: Array.isArray(row?.pending) ? row.pending.filter(item => item && typeof item.id === 'string'
        && typeof item.sessionId === 'string' && ['done', 'error', 'needs-reply'].includes(item.kind)
        && Array.isArray(item.requestIds) && item.requestIds.every(id => typeof id === 'string')) : [],
      retired: Array.isArray(row?.retired) ? row.retired.filter(id => typeof id === 'string') : [],
    };
  },
  preserveUnreadableFile: true, maxBytes: 2 * 1024 * 1024,
  logLoadedValue: false, logReadErrorDetails: false, log, label: 'notification dismissal state',
});
let cached: { owner: string; ledger: ReturnType<typeof createNotificationDismissalLedger> } | undefined;
let changed: (() => void) | undefined;
function ledger() {
  const owner = activeOwnerScopeKey();
  if (!cached || cached.owner !== owner) cached = { owner, ledger: createNotificationDismissalLedger(storage.read(), state => {
    if (activeOwnerScopeKey() !== owner) return;
    storage.writePatch(state);
    changed?.();
  }) };
  return cached.ledger;
}
function attempt(operation: () => void) { try { operation(); } catch { log.warn('notification retirement storage unavailable'); } }
export function trackMobileNotification(item: TrackedNotification): void { attempt(() => ledger().record(item)); }
export function retireReadMobileNotifications(sessionId: string): void { attempt(() => ledger().read(sessionId)); }
export function retireAnsweredMobileNotifications(sessionId: string, requestId: string): void { attempt(() => ledger().resolve(sessionId, requestId)); }
export function mobileNotificationDismissalBatch(): string[] { return ledger().batch(); }
export function acknowledgeMobileNotificationDismissals(ids: string[]): void { ledger().acknowledged(ids); }
export function onMobileNotificationDismissalsChanged(listener: () => void): () => void {
  changed = listener;
  return () => { if (changed === listener) changed = undefined; };
}
