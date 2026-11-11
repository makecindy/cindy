import path from 'node:path';
import { createGithubStar } from './githubStar.js';
import { app, BrowserWindow, ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { configureManagedGhRoot } from './ghBinary.js';
import { createGithubSetup } from './githubSetup.js';
import { getSharedGhCliTokenSource } from './ghCliTokenSource.js';
import { githubConnection } from './githubConnection.js';
import { readGhostSecret } from '../secrets/providerSecretStore.js';
import {
  createPluginLogicalIdentity,
  pluginInstallStoragePart,
  pluginNewInstallRelId,
} from '../../shared/pluginIdentity.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { getActiveAppSession, activeOwnerScopeKey } from '../appSessionState.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { isSecondaryAppWindow } from '../secondary-windows.js';
import type { GithubConnectionState } from '../../shared/githubSetup.js';

export const GITHUB_SETUP_OPEN_CHANNEL = 'git-context:github-setup:open';

const cindyGithubRootInstance = () => pluginInstallStoragePart(
  pluginNewInstallRelId(createPluginLogicalIdentity(null, 'cindy-github')),
);

/**
 * This computer's effective GitHub sign-in for the active owner: gh first, then the fallback token the
 * requested plugin would actually use (`fallback`: its installed instance and declared secret key; the
 * GitHub plugin's own token when omitted).
 */
export async function readGithubConnection(
  fallback?: { instanceId: string; key: string },
): Promise<GithubConnectionState> {
  const owner = activeOwnerScopeKey();
  const source = getSharedGhCliTokenSource();
  source.invalidate();
  const rootInstance = cindyGithubRootInstance();
  const result = await githubConnection({
    readGh: () => source.readToken(),
    readFallback: () =>
      owner !== activeOwnerScopeKey()
        ? null
        : fallback
          ? readGhostSecret(fallback.instanceId, fallback.key)
          : readGhostSecret(rootInstance, 'github_pat') ?? readGhostSecret('cindy-github', 'github_pat'),
    fetch: outboundFetch,
  });
  return owner === activeOwnerScopeKey() ? result : { status: 'missing' };
}

/**
 * Open Cindy's own GitHub sign-in dialog in the window the user is looking at (or the main window),
 * but only a window that mounts the App (the main and secondary windows; detached sidebar windows run
 * their own entry and could not show it),
 * for a task that asked to connect a plugin signing in through this computer's GitHub login.
 * Does not take focus; returns false when no app window can show it.
 */
export function openGithubSignIn(): boolean {
  const main = getDeepLinkMainWindow();
  const focused = BrowserWindow.getFocusedWindow();
  const win = focused && !focused.isDestroyed() && (focused === main || isSecondaryAppWindow(focused)) ? focused : main;
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(GITHUB_SETUP_OPEN_CHANNEL);
  return true;
}

/** Local app UI only. These channels intentionally have no device-link grant:
 * authorizing this machine's GitHub identity is not a shared-task capability. */
export function registerGithubSetupIpc(invalidateStatuses: () => void): void {
  const root = path.join(app.getPath('userData'), 'managed-tools');
  configureManagedGhRoot(root);
  const changed = () => {
    getSharedGhCliTokenSource().invalidate();
    invalidateStatuses();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('git-context:github-connected');
    }
  };
  const setup = createGithubSetup(root, changed);
  const star = createGithubStar({
    owner: () => getActiveAppSession().dataOwnerId ? activeOwnerScopeKey() : null,
    readToken: async () => {
      const owner = activeOwnerScopeKey();
      // `gh auth switch` happens outside Cindy: never act as a previously cached account.
      const source = getSharedGhCliTokenSource();
      source.invalidate();
      const token = await source.readToken();
      if (owner !== activeOwnerScopeKey()) return null;
      return token ?? readGhostSecret(cindyGithubRootInstance(), 'github_pat')
        ?? readGhostSecret('cindy-github', 'github_pat');
    },
    fetch: outboundFetch,
  });
  const unsubscribes = ['cindy-github', cindyGithubRootInstance()].map(id => getGhostSetupChangeBus().subscribe(id, (event) => {
    if (event.source === 'secret') changed();
  }));
  for (const [channel, handle] of [
    [
      'git-context:github-setup:connection',
      readGithubConnection,
    ],
    ['git-context:github-star:check', star.check],
    ['git-context:github-star:add', star.star],
    ['git-context:github-setup:status', () => setup.snapshot()],
    ['git-context:github-setup:start', () => setup.start()],
    ['git-context:github-setup:cancel', () => setup.cancel()],
  ] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      if (args.length) throwIpcError('INVALID_PARAMS', 'No arguments expected');
      return handle();
    });
  }
  app.once('before-quit', () => {
    unsubscribes.forEach(unsubscribe => unsubscribe());
    setup.cancel();
  });
}
