import { createLogger } from '../logger.js';
import { createSessionSendLocks } from '@cindy/app-runtime/sessionSendLocks';

export const {
  sendToSessionLocks,
  assertSessionNotRestarting,
  waitForSendToSessionLock,
  withSessionRestartLock,
  hasSendToSessionLock,
  acquireSendToSessionLock,
  withSendToSessionLock,
  trackSendToSessionLockRun,
  getSessionRewindGeneration,
  advanceSessionRewindGeneration,
} = createSessionSendLocks(createLogger('maker-ipc:send-to-session-lock'));
