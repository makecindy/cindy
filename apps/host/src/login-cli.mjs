import { readHostProcessStatus } from './control.mjs';
import { getOrCreateHostDeviceId } from './auth/device-identity.mjs';
/**
 * `cindy-host login` — complete the existing Cindy browser login from the host.
 *
 * Prints the authorize URL the user must open, exchanges the callback for the
 * same session record the Desktop stores, and never prints a token.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';



import { CindyAuthClient } from '@cindy/auth-client';

import { readAuthEndpoints } from './auth/endpoints.mjs';
import { runHostLogin } from './auth/login.mjs';
import { hostPackageRegion } from './auth/region-policy.ts';
import { AUTH_SESSION_KEY } from '../../desktop/src/main/authCredentialKeys.ts';
import { isGhostSkillProjectionBoundaryStableForOwner, readGhostSkillProjectionBoundaryState, withGhostSkillProjectionOwnerCommit } from '../../desktop/src/main/authBoundaryQuarantine.ts';
import { withCrossProcessLock } from '../../desktop/src/main/device-link/crossProcessLock.ts';
import { AUTH_ACCOUNT_VAULT_LOCK_FILE } from '../../desktop/src/main/authRefreshCommit.ts';
import { configureAppDataDir, configureUserDataDir } from '../../desktop/src/main/userDataPath.ts';
import { createDesktopScanner } from './agent/profile-coexistence.ts';
import { allowSkillProjectionOwnerCommit, commitLoginSessionAndOwner } from './agent/skill-projection-owner.ts';
import { discoverHostOwner, resolveHostAppDataDir } from './profile-path.mjs';
import { restoreDeviceLinkRegistration } from './auth/device-link-registration.mjs';
import { createCredentialStore } from './credentials/store.mjs';
import { resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';

/**
 * Coexistence plan A for the login (release table row 25, 25b condition 1): a desktop that opens this
 * profile's database must not run while the login publishes the projection owner. An unreadable
 * registry refuses too, as the scan does, and says why.
 */
export async function assertNoDesktopOnProfile(scan) {
  let pids;
  try { pids = await scan(); }
  catch (error) {
    throw new Error(`Cannot tell whether the Cindy desktop app is using this profile (${error instanceof Error ? error.message : String(error)}); `
      + 'sign-in is refused until it can be checked.');
  }
  if (pids.length > 0) throw new Error('Quit the Cindy desktop app that is using this profile, then run cindy-host login again.');
}

/**
 * Whether a running serve allows this login (25b condition A). Without an account runtime any
 * account may sign in (nothing to tear down); with account A's runtime, only A may sign in again:
 * replacing A requires its runtime stopped (its Skill projections and Pi Subagents are swept then).
 * Returns the account check to run once the exchange names the account.
 */
export function serveLoginAdmission(status) {
  if (status.running === false) return () => {};
  if (status.running !== true) throw new Error('Cindy Host is not responding. Stop it before changing its sign-in, then start it again.');
  const owner = status.runtime?.owner ?? null;
  if (!owner) return () => {};
  return (membership) => {
    if (membership?.id !== owner) {
      throw new Error('Cindy Host is running another account. Stop it (cindy-host stop), sign in, then start it again.');
    }
  };
}
import { hostAuthFetch } from './auth-fetch.mjs';
import { hostRuntimeLayout } from './runtime-layout.mjs';


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
  const deps = io.deps ?? {};
  const running = await (deps.readStatus ?? readHostProcessStatus)(userDataDir);
  const admitAccount = serveLoginAdmission(running);
  await assertNoDesktopOnProfile(deps.scanDesktops ?? createDesktopScanner(userDataDir));
  // This process is the one that publishes the Skill projection owner of a Host's own profile.
  configureUserDataDir(userDataDir);
  configureAppDataDir(resolveHostAppDataDir());
  allowSkillProjectionOwnerCommit();
  const store = deps.store ?? await createCredentialStore({
    userDataDir,
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
  });

  const deviceId = getOrCreateHostDeviceId(userDataDir);
  const clientOptions = {
    baseUrl: endpoints.authApiBaseUrl,
    region,
    deviceId,
    clientType: 'desktop',
    fetch: (input, init) => hostAuthFetch(input, init),
  };
  // Tests replace the transport only (their fake auth servers listen on plain loopback HTTP).
  const client = deps.createAuthClient ? deps.createAuthClient(clientOptions) : new CindyAuthClient(clientOptions);

  const noOpen = argv.includes('--no-open') || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  out(noOpen ? 'Open the following Cindy login page on a device with a browser.' : 'Opening the Cindy login page in your browser…');
  const result = await runHostLogin({
    client,
    deviceId,
    store,
    region,
    packageRegion: hostPackageRegion(),
    warn: err,
    admitAccount,
    persistSession: async (record, membership) => {
      // The browser step can take minutes: check the desktop and serve again right before committing.
      await assertNoDesktopOnProfile(deps.scanDesktops ?? createDesktopScanner(userDataDir));
      const now = await (deps.readStatus ?? readHostProcessStatus)(userDataDir);
      serveLoginAdmission(now)(membership);
      // A running serve's sessions use the current projections: a transition would revoke them under
      // it, and serve cannot project them again. Only a boundary already stable for this account may
      // be committed while serve runs; otherwise serve must stop first.
      if (now.running === true && now.runtime?.owner && !isGhostSkillProjectionBoundaryStableForOwner(membership.id)) {
        throw new Error('Stop Cindy Host (cindy-host stop), run cindy-host login again, then start it: this sign-in needs to set up the account\'s Skills.');
      }
      const stable = readGhostSkillProjectionBoundaryState();
      const previousOwnerId = stable?.phase === 'stable' ? stable.ownerId : discoverHostOwner(userDataDir).ownerId;
      await commitLoginSessionAndOwner({
        userDataDir, record, nextOwnerId: membership.id, store, sessionKey: AUTH_SESSION_KEY, previousOwnerId,
        withVaultLock: (task) => withCrossProcessLock(path.join(userDataDir, AUTH_ACCOUNT_VAULT_LOCK_FILE),
          { label: 'auth-account-vault', waitMs: 5000 }, async (lock) => {
            if (!lock.held) throw new Error('Saved account credentials are busy; retry cindy-host login');
            return task();
          }),
        commitOwner: (options) => withGhostSkillProjectionOwnerCommit(options),
      });
    },
    hostedCallbackUrl: endpoints.authDesktopCallbackUrl,
    openBrowser: async (url) => {
      out(`If it does not open, visit:\n${url}`);
      if (!noOpen) {
        try { await openInSystemBrowser(url); }
        catch { err('The browser could not open automatically. Open the link above; login is still waiting.'); }
      }
    },
    method,
    // A Host removed from the account in Device Link registers again only with this fresh sign-in (serve starts from a
    // refreshed token, which cannot): say hello once with it (auth/device-link-registration.mjs).
    onSignedIn: async (token) => {
      if (!endpoints.deviceLinkApiBaseUrl) return;
      // Started while the browser sign-in was open: a second hello with this device would replace its live connection.
      if ((await readHostProcessStatus(userDataDir)).running !== false) return;
      let registration = 'failed';
      try {
        registration = await restoreDeviceLinkRegistration({ apiBaseUrl: endpoints.deviceLinkApiBaseUrl, token,
          version: hostRuntimeLayout().version });
      } catch { /* The sign-in is saved either way. */ }
      if (registration !== 'registered') err('This computer could not register with remote connections now; start Cindy Host and try signing in again if it stays unavailable.');
    },
  });
  out(`Signed in (${result.realm}). Cindy host will reuse this login on restart.`);
  // serve keeps its current session until it restarts (it does not adopt a new one while running).
  if (running.running === true) {
    out('This sign-in takes effect after Cindy Host restarts. As a systemd user service (docs/host/systemd.md): '
      + 'systemctl --user restart cindy-host. Otherwise: cindy-host stop, then start cindy-host again.');
  }
  if (process.env.CINDY_HOST_DATA_DIR?.trim()) {
    err(`Profile: ${userDataDir}`);
  }
  return result;
}
