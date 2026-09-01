import {
  isBrowserOpenForLoginErrorCode,
  type BrowserOpenForLoginErrorCode,
} from '../../../shared/browserBackend';
import { extractIpcError } from '../../utils/ipcError';

const TOAST_KEYS: Partial<Record<BrowserOpenForLoginErrorCode, string>> = {
  PROFILE_LOCKED: 'settings.computerUse.browser.toast.profileLocked',
  NO_CHROMIUM: 'settings.computerUse.browser.toast.noChromium',
  NO_AUTH_DB: 'settings.computerUse.browser.toast.noAuthDb',
  COPY_FAILED: 'settings.computerUse.browser.toast.copyFailed',
  HEADLESS_FORBIDDEN: 'settings.computerUse.browser.toast.headlessForbidden',
  STOP_FAILED: 'settings.computerUse.browser.toast.stopFailed',
  FOREIGN_AGENT_BROWSER: 'settings.computerUse.browser.toast.foreignInstance',
  APP_BOUND_ENCRYPTION_UNSUPPORTED:
    'settings.computerUse.browser.toast.appBoundEncryptionUnsupported',
};

export function browserOpenForLoginErrorCode(
  err: unknown,
): BrowserOpenForLoginErrorCode | null {
  const code = extractIpcError(err)?.code;
  return isBrowserOpenForLoginErrorCode(code) ? code : null;
}

export function browserOpenForLoginToastKey(code: BrowserOpenForLoginErrorCode): string {
  return TOAST_KEYS[code] ?? 'settings.computerUse.browser.toast.openForLoginFailed';
}
