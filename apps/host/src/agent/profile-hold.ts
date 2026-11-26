import { createIpcError } from '../../../desktop/src/shared/ipc-errors.js';
import { createMainI18n } from '../../../desktop/src/main/i18n.js';

export type ProfileReleaseFailure = { code: 'PRECONDITION_FAILED'; reason: 'HOST_PROFILE_RELEASE_FAILED'; message: string };
export type ProfileHold = string | ProfileReleaseFailure;

export function releaseFailure(): ProfileReleaseFailure {
  const i18n = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  return { code: 'PRECONDITION_FAILED', reason: 'HOST_PROFILE_RELEASE_FAILED', message: i18n.t('ipcError.PRECONDITION_FAILED') };
}

export function holdRefusal(hold: ProfileHold) {
  return typeof hold === 'string' ? { code: 'PRECONDITION_FAILED' as const, message: hold } : releaseFailure();
}

export function holdError(hold: ProfileHold) {
  const { code, message, ...details } = holdRefusal(hold);
  return Object.assign(createIpcError(code, message), details);
}
