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
 * @property {(value: string) => string} encrypt
 * @property {(value: string) => string} decrypt
 * @property {(key: string) => string | null} read
 * @property {(key: string, value: string) => void} write
 * @property {(key: string) => void} remove
 */

/**
 * Resolve the OS key once, then expose the same synchronous semantics the
 * Desktop credential helpers use.
 *
 * On Linux without a Secret Service (servers, containers, NAS apps), the keyring
 * secret can instead come from an owner-only file: `options.credentialKeyFile`,
 * defaulting to `CINDY_HOST_CREDENTIAL_KEY_FILE`. The key derivation is the same,
 * so records stay v11 and a secret exported from a keyring decrypts them.
 *
 * @param {{userDataDir: string, keyringApplication?: string, keyPromise?: Promise<Buffer>, credentialKeyFile?: string}} options
 * @returns {Promise<CredentialStore>}
 */
/**
 * Read the keyring secret from a credential key file. Any problem is fatal and
 * named precisely: the store never falls back to the keyring or to plaintext.
 */
function readCredentialKeyFile(file) {
  let secret;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.mode & 0o077) throw new Error('readable or writable by group or others; run chmod 600 on it');
    secret = fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new SafeStorageUnavailableError(`Cannot use credential key file ${file}: ${error.message}`);
  }
  if (!secret) throw new SafeStorageUnavailableError(`Credential key file ${file} is empty`);
  return secret;
}

export async function createCredentialStore(options) {
  const platform = options.platform ?? process.platform;
  let codec = options.codec;
  if (!codec) {
    if (platform === 'linux') {
      const keyFile = options.credentialKeyFile ?? process.env.CINDY_HOST_CREDENTIAL_KEY_FILE?.trim();
      // Kept outside the keyring catch below so a bad key file reports its own cause.
      const key = keyFile && !options.keyPromise
        ? deriveLinuxOsCryptKey(readCredentialKeyFile(keyFile))
        : await (options.keyPromise
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
