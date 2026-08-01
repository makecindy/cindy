import type { SlackHookView } from '../../shared/hookControlIpc.js';
import { throwIpcError } from '../utils/ipcValidate.js';

interface LifecycleAnnouncementManager {
  setLifecycleAnnouncement(enabled: boolean): void;
  snapshot(): SlackHookView;
}

interface LifecycleAnnouncementLogger {
  warn(message: string, error?: unknown): void;
}

/**
 * Persist a lifecycle-notification preference without leaking filesystem details
 * across the Electron IPC boundary.
 */
export function setLifecycleAnnouncementFromIpc(
  manager: LifecycleAnnouncementManager,
  enabled: boolean,
  log: LifecycleAnnouncementLogger,
): { hook: SlackHookView } {
  try {
    manager.setLifecycleAnnouncement(enabled);
  } catch (err) {
    log.warn('failed to persist Slack lifecycle notification preference', err);
    throwIpcError('INTERNAL', 'failed to persist Slack lifecycle notification preference');
  }
  return { hook: manager.snapshot() };
}
