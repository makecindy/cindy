/**
 * botReadStateIpc — this computer's windows read and advance the host-side companion read
 * positions (`botReadStateStore`), and every change is pushed back to them and invalidated for
 * device-link controllers, so the phone and other Macs re-read the teammate row.
 */

import { BrowserWindow, ipcMain } from 'electron';

import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { broadcastBotGroupRemoteResourceChanged } from './botGroupRemoteResourceInvalidation.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import {
  loadBotReadState,
  loadAcknowledgedBotReadState,
  markBotReadPositions,
  onBotReadStateChanged,
  pruneBotReadState,
  seedBotReadPositions,
  type BotReadStateMap,
} from './botReadStateStore.js';

const log = createLogger('maker-ipc:bot-read-state');

export const BOT_READ_STATE_CHANGED_CHANNEL = 'local-db:bots:read-state:changed';

const MAX_PRUNE_IDS = 5000;

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, MAX_PRUNE_IDS).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160);
}

/**
 * The renderer names the account it shows. A request from a window that has not caught up with
 * an account switch (or one sent mid-switch) must not write into the other account's ledger.
 */
function isRequestOwnerCurrent(ownerId: unknown): boolean {
  if (isAppSessionBoundaryPending()) return false;
  const current = getActiveAppSession().dataOwnerId;
  return typeof ownerId === 'string' && !!current && ownerId === current;
}

function snapshot(): { ownerId: string | null; positions: BotReadStateMap; acknowledgedPositions: BotReadStateMap } {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId || isAppSessionBoundaryPending()) return { ownerId: null, positions: {}, acknowledgedPositions: {} };
  try {
    return { ownerId, positions: loadBotReadState(), acknowledgedPositions: loadAcknowledgedBotReadState() };
  } catch (error) {
    // A broken ledger costs badges, never the teammate list.
    log.warn('bot read state load failed', { error: error instanceof Error ? error.name : typeof error });
    return { ownerId, positions: {}, acknowledgedPositions: {} };
  }
}

function broadcastSnapshot(): void {
  const payload = snapshot();
  const stamp = getSafeDataOwnerPushStamp();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (stamp === undefined) win.webContents.send(BOT_READ_STATE_CHANGED_CHANNEL, payload);
      else win.webContents.send(BOT_READ_STATE_CHANGED_CHANNEL, payload, stamp);
    } catch { /* per-window push failures never block the others */ }
  }
}

let registered = false;

export function registerBotReadStateIpc(): void {
  if (registered) return;
  registered = true;
  onBotReadStateChanged((changed) => {
    broadcastSnapshot();
    for (const key of changed) {
      if (key.startsWith('thread:')) continue;
      if (key.startsWith('group:')) broadcastBotGroupRemoteResourceChanged(key.slice('group:'.length));
      else broadcastBotRemoteResourceChanged(key, { local: false });
    }
  });

  ipcMain.handle('local-db:bots:read-state:get', (event) => {
    assertTrustedAppRendererEvent(event);
    return snapshot();
  });

  /**
   * `{ ownerId, mark?, seed?, prune? }`: `mark` advances positions, `seed` fills missing ones,
   * `prune` drops companions / local groups that no longer exist. Returns the current map.
   */
  ipcMain.handle('local-db:bots:read-state:update', (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (!isRequestOwnerCurrent(body.ownerId)) return snapshot();
    if (body.mark !== undefined) markBotReadPositions(body.mark);
    if (body.seed !== undefined) seedBotReadPositions(body.seed);
    const prune = body.prune && typeof body.prune === 'object' ? body.prune as Record<string, unknown> : null;
    if (prune) {
      const botIds = idList(prune.botIds);
      const groupIds = idList(prune.groupIds);
      if (botIds || groupIds) pruneBotReadState({ ...(botIds ? { botIds } : {}), ...(groupIds ? { groupIds } : {}) });
    }
    return snapshot();
  });
}
