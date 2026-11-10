/**
 * `cindy-host login` — complete the existing Cindy browser login from the host.
 *
 * Prints the authorize URL the user must open, exchanges the callback for the
 * same session record the Desktop stores, and never prints a token.
 */

import { spawn } from 'node:child_process';

import { createRequire } from 'node:module';

import { CindyAuthClient } from '@cindy/auth-client';

import { readAuthEndpoints } from './auth/endpoints.mjs';
import { runHostLogin } from './auth/login.mjs';
import { createCredentialStore } from './credentials/store.mjs';
import { resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';

// CommonJS package without ESM named exports; use the same entry Desktop loads.
const { machineIdSync } = createRequire(import.meta.url)('node-machine-id');

/** Open the system browser without blocking the login flow on its exit. */
function openInSystemBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function parseLoginArgs(argv) {
  const regionArg = argv.find((arg) => arg.startsWith('--region='))?.split('=')[1];
  const methodArg = argv.find((arg) => arg.startsWith('--method='))?.split('=')[1];
  return { region: regionArg ?? resolveHostRegion(), method: methodArg };
}

/**
 * @param {string[]} argv arguments after `login`
 * @param {{stdout?: (line: string) => void, stderr?: (line: string) => void}} [io]
 */
export async function runLoginCommand(argv, io = {}) {
  const out = io.stdout ?? ((line) => console.log(line));
  const err = io.stderr ?? ((line) => console.error(line));
  const { region, method } = parseLoginArgs(argv);

  const endpoints = readAuthEndpoints(region);
  const userDataDir = resolveHostDataDir();
  const store = await createCredentialStore({
    userDataDir,
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
  });

  const client = new CindyAuthClient({
    baseUrl: endpoints.authApiBaseUrl,
    region,
    deviceId: machineIdSync(),
    clientType: 'desktop',
    fetch: (input, init) => globalThis.fetch(input, init),
  });

  out('Opening the Cindy login page in your browser…');
  const result = await runHostLogin({
    client,
    store,
    region,
    hostedCallbackUrl: endpoints.authDesktopCallbackUrl,
    openBrowser: async (url) => {
      out(`If it does not open, visit:\n${url}`);
      await openInSystemBrowser(url);
    },
    method,
  });
  out(`Signed in (${result.realm}). Cindy host will reuse this login on restart.`);
  if (process.env.CINDY_HOST_DATA_DIR?.trim()) {
    err(`Profile: ${userDataDir}`);
  }
  return result;
}
