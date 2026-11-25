import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostRuntimeLayout, resolveSourceElectronBinary } from '../runtime-layout.mjs';
import { KEYCHAIN_IDENTITY_MARKER_FILE, resolveDevKeychainDecision } from '../../../desktop/src/main/devKeychainName.js';
import { createKeychainMarkerIo } from '../../../desktop/src/main/devKeychainMarkerIo.js';

function unavailable() {
  return Object.assign(new Error('CREDENTIAL_STORE_UNAVAILABLE'), { code: 'CREDENTIAL_STORE_UNAVAILABLE' });
}

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
  const layout = hostRuntimeLayout();
  const script = layout.credentialScript;
  function invoke(operation, value) {
    const binary = options.electronBinary
      ?? (layout.packaged ? layout.electronBinary : resolveSourceElectronBinary());
    if (!binary) throw unavailable();
    const env = { ...process.env, CINDY_HOST_DATA_DIR: options.userDataDir, CINDY_HOST_CREDENTIAL_APP: appName };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = run(binary, [script], { input: JSON.stringify({ operation, value }), encoding: 'utf8', env, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw unavailable();
    try {
      const response = JSON.parse(result.stdout);
      if (typeof response.value !== 'string') throw new Error();
      return response.value;
    } catch { throw unavailable(); }
  }
  return { encrypt: value => invoke('encrypt', value), decrypt: value => invoke('decrypt', value) };
}
