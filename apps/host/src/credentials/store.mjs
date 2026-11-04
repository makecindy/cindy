/**
 * Read/write the Desktop's existing safeStorage records without forking them.
 *
 * Files live in `<userData>/safe-storage/<key>.enc`, base64 text, mode 0600 for
 * newly written records. Replacement is atomic (write a sibling, then rename) so
 * a crash cannot truncate a live session.
 */

import fs from 'node:fs';
import path from 'node:path';

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
export async function createPreparedLinuxCredentialStore(options) {
  const dir = path.join(options.userDataDir, 'safe-storage');
  const resolved = await (options.keyPromise
    ?? readLinuxKeyringSecret(options.keyringApplication).then(deriveLinuxOsCryptKey)
  ).catch((error) => {
    throw new SafeStorageUnavailableError(error instanceof Error ? error.message : String(error));
  });

  return {
    read(recordKey) {
      const file = path.join(dir, `${recordKey}.enc`);
      try {
        return decryptOsCryptPayload(fs.readFileSync(file, 'utf8'), resolved);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(recordKey, value) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${recordKey}.enc`);
      const temporary = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, encryptOsCryptPayload(value, resolved), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, file);
    },
    remove(recordKey) {
      try {
        fs.unlinkSync(path.join(dir, `${recordKey}.enc`));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}
