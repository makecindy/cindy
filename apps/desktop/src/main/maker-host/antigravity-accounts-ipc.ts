import { app, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ANTIGRAVITY_ACCOUNTS_CHANNEL, ANTIGRAVITY_ACCOUNT_BUSY } from '../../shared/antigravityAccounts.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getAntigravityAccounts } from './antigravity-host.js';
import { broadcast } from '../device-link/index.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { getActiveAppSession } from '../appSessionState.js';
import { antigravityConnected } from './antigravity-state.js';

export function registerAntigravityAccountsIpc(): void {
  ipcMain.handle(ANTIGRAVITY_ACCOUNTS_CHANNEL, async (event, raw: unknown, rawScope: unknown) => {
    assertTrustedAppRendererEvent(event);
    const accounts = getAntigravityAccounts();
    if (!accounts) throw new Error('ANTIGRAVITY_UNAVAILABLE');
    accounts.assertOwner();
    const scope = rawScope && typeof rawScope === 'object' ? rawScope as Record<string, unknown> : {};
    const session = getActiveAppSession();
    if (session.dataOwnerId !== scope.dataOwnerId || session.generation !== scope.ownerGeneration) throw new Error('ANTIGRAVITY_OWNER_CHANGED');
    const command = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    try {
      if (command.action === 'read') return accounts.read();
      if (command.action === 'usage') return await accounts.usage();
      const result = await (async () => {
        if (command.action === 'configure') {
          // The existing managed download is preferred. Other machines can select
          // an already installed copy; configure verifies the exact pinned digest.
          const managed = path.join(app.getPath('userData'), 'managed-runtimes', 'antigravity', '1.5.9-darwin-arm64', 'antigravity');
          if (fs.existsSync(managed)) {
            try { return await accounts.configure(managed); }
            catch (error) {
              if (error instanceof Error && error.message === ANTIGRAVITY_ACCOUNT_BUSY) throw error;
              // A valid existing copy can be selected below.
            }
          }
          const picked = await dialog.showOpenDialog({ properties: ['openFile'] });
          accounts.assertOwner();
          if (picked.canceled || !picked.filePaths[0]) return accounts.read();
          return accounts.configure(picked.filePaths[0]);
        }
        if (command.action === 'add') return accounts.add();
        if (typeof command.id === 'string' && command.id.length <= 36) {
          if (command.action === 'select') return accounts.select(command.id);
          if (command.action === 'remove') return accounts.remove(command.id);
        }
        throw new Error('ANTIGRAVITY_INVALID_COMMAND');
      })();
      accounts.assertOwner();
      broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: 'antigravity', authenticated: antigravityConnected(), authSource: 'oauth' });
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === ANTIGRAVITY_ACCOUNT_BUSY) throw error;
      // Filesystem and remote errors may include private paths or request details.
      throw new Error('ANTIGRAVITY_ACCOUNTS_FAILED');
    }
  });
}
