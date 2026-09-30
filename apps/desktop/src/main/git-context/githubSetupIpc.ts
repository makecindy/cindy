import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { configureManagedGhRoot } from './ghBinary.js';
import { createGithubSetup } from './githubSetup.js';
import { getSharedGhCliTokenSource } from './ghCliTokenSource.js';
import { githubConnection } from './githubConnection.js';
import { readGhostSecret } from '../secrets/providerSecretStore.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';

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
  const unsubscribe = getGhostSetupChangeBus().subscribe('cindy-github', (event) => {
    if (event.source === 'secret') changed();
  });
  for (const [channel, handle] of [
    [
      'git-context:github-setup:connection',
      async () => {
        const owner = activeOwnerScopeKey();
        const source = getSharedGhCliTokenSource();
        source.invalidate();
        const result = await githubConnection({
          readGh: () => source.readToken(),
          readFallback: () =>
            owner === activeOwnerScopeKey() ? readGhostSecret('cindy-github', 'github_pat') : null,
          fetch: outboundFetch,
        });
        return owner === activeOwnerScopeKey() ? result : { status: 'missing' as const };
      },
    ],
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
    unsubscribe();
    setup.cancel();
  });
}
