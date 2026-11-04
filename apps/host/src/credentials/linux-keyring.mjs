/**
 * Linux credential backend for the existing Electron safeStorage ciphertext.
 *
 * Measured against real Desktop files on this machine (2026-11-04): the
 * keyring entry is `application=Cindy` with schema
 * `chrome_libsecret_os_crypt_password_v2`; key = PBKDF2-HMAC-SHA1(secret,
 * "saltysalt", 1 iteration, 16 bytes); AES-128-CBC with a 16-space IV; the
 * stored file is base64 text of "v11" + ciphertext.
 *
 * No plaintext fallback: when Secret Service is unavailable this throws, so a
 * caller can show a real error instead of silently losing the login.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class CredentialBackendUnavailableError extends Error {
  code = 'CREDENTIAL_STORE_UNAVAILABLE';

  constructor(message) {
    super(message);
    this.name = 'CredentialBackendUnavailableError';
  }
}

/** Chromium's keyring application name; `--isolated` dev builds use CindyDev. */
export const DEFAULT_LINUX_KEYRING_APPLICATION = 'Cindy';

export async function readLinuxKeyringSecret(application = DEFAULT_LINUX_KEYRING_APPLICATION) {
  try {
    const { stdout } = await run('secret-tool', [
      'lookup',
      'application',
      application,
      'xdg:schema',
      'chrome_libsecret_os_crypt_password_v2',
    ]);
    const keyringValue = stdout.trim();
    if (!keyringValue) throw new Error('empty keyring value');
    return keyringValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CredentialBackendUnavailableError(
      `Secret Service is not available for application "${application}" (${detail}); ` +
        'unlock the login keyring and retry',
    );
  }
}
