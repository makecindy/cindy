import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { KEYCHAIN_IDENTITY_MARKER_FILE, resolveDevKeychainDecision } from '../../../desktop/src/main/devKeychainName.js';
import { createKeychainMarkerIo } from '../../../desktop/src/main/devKeychainMarkerIo.js';

/** Preserve Electron's existing Keychain/DPAPI format instead of inventing a
 * second vault or exporting its master key into Node. Secrets use stdio only.
 * Linux keeps its display-independent Secret Service adapter.
 */
export function createNativeCredentialCodec(options) {
  // Share Desktop's atomic identity claim, including CRLF markers and races
  // with an isolated desktop launch. Never guess a key for an unreadable marker.
  const identity = resolveDevKeychainDecision({
    isPackaged: false,
    isolated: false,
    hasDirOverride: true,
    io: createKeychainMarkerIo({
      profileDir: options.userDataDir,
      markerPath: path.join(options.userDataDir, KEYCHAIN_IDENTITY_MARKER_FILE),
    }),
  });
  if (identity.kind === 'abort') throw new Error('CREDENTIAL_IDENTITY_UNAVAILABLE');
  const appName = identity.kind === 'rename' ? identity.appName : 'Cindy';
  const run = options.run ?? spawnSync;
  const binary = options.electronBinary ?? createRequire(new URL('../../../desktop/package.json', import.meta.url))('electron');
  const script = fileURLToPath(new URL('./electron-codec.cjs', import.meta.url));
  function invoke(operation, value) {
    const env = { ...process.env, CINDY_HOST_DATA_DIR: options.userDataDir, CINDY_HOST_CREDENTIAL_APP: appName };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = run(binary, [script], { input: JSON.stringify({ operation, value }), encoding: 'utf8', env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('CREDENTIAL_STORE_UNAVAILABLE');
    try {
      const response = JSON.parse(result.stdout);
      if (typeof response.value !== 'string') throw new Error();
      return response.value;
    } catch { throw new Error('CREDENTIAL_STORE_UNAVAILABLE'); }
  }
  return { encrypt: value => invoke('encrypt', value), decrypt: value => invoke('decrypt', value) };
}
