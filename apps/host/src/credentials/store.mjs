/**
 * Read/write the Desktop's existing safeStorage records without forking them.
 *
 * Files live in `<userData>/safe-storage/<key>.enc`, base64 text, mode 0600 for
 * newly written records. Replacement is atomic (write a sibling, then rename) so
 * a crash cannot truncate a live session.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeCredentialCodec } from './native-codec.mjs';

import { deriveLinuxOsCryptKey, decryptOsCryptPayload, encryptOsCryptPayload } from './oscrypt.mjs';
import { readLinuxKeyringSecret } from './linux-keyring.mjs';

export class SafeStorageUnavailableError extends Error {
  code = 'CREDENTIAL_STORE_UNAVAILABLE';

  constructor(message) {
    super(message);
    this.name = 'SafeStorageUnavailableError';
  }
}

/**
 * @typedef {object} CredentialStore
 * @property {(key: string) => string | null} read
 * @property {(key: string, value: string) => void} write
 * @property {(key: string) => void} remove
 */

/**
 * Resolve the OS key once, then expose the same synchronous semantics the
 * Desktop credential helpers use.
 *
 * @param {{userDataDir: string, keyringApplication?: string, keyPromise?: Promise<Buffer>}} options
 * @returns {Promise<CredentialStore>}
 */
export async function createCredentialStore(options) {
  const platform = options.platform ?? process.platform;
  let codec = options.codec;
  if (!codec) {
    if (platform === 'linux') {
      const key = await (options.keyPromise
        ?? readLinuxKeyringSecret(options.keyringApplication).then(deriveLinuxOsCryptKey)
      ).catch(() => { throw new SafeStorageUnavailableError('Unlock the system keyring before connecting Cindy Host.'); });
      codec = { encrypt: value => encryptOsCryptPayload(value, key), decrypt: value => decryptOsCryptPayload(value, key) };
    } else if (platform === 'darwin' || platform === 'win32') {
      codec = createNativeCredentialCodec(options);
    } else {
      throw new SafeStorageUnavailableError('Unsupported host operating system');
    }
  }
  const dir = path.join(options.userDataDir, 'safe-storage');
  function recordPath(key) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('invalid credential key');
    return path.join(dir, `${key}.enc`);
  }

  return {
    encrypt: value => codec.encrypt(value),
    decrypt: value => codec.decrypt(value),
    read(recordKey) {
      const file = recordPath(recordKey);
      try {
        return codec.decrypt(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(recordKey, value) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = recordPath(recordKey);
      const temporary = `${file}.tmp-${randomUUID()}`;
      try {
        fs.writeFileSync(temporary, codec.encrypt(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
    remove(recordKey) {
      try {
        fs.unlinkSync(recordPath(recordKey));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

// Compatibility for the Linux codec tests and existing callers.
export const createPreparedLinuxCredentialStore = options => createCredentialStore({ ...options, platform: 'linux' });
