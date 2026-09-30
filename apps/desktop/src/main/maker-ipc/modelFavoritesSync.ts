import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import {
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
  parseModelFavoriteMutation,
  parseModelFavorites,
  type RemoteModelFavorite,
} from '@cindy/device-link';
import {
  FAVORITE_HOST_READY,
  FAVORITE_HOST_REQUEST,
  FAVORITE_HOST_REPLY,
  FAVORITE_HOST_CHANGED,
  type FavoriteHostReply,
} from '../../shared/modelFavoritesSync.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** The existing renderer store is authoritative. Dispatch once to ONE owner-fenced
 * app window and acknowledge persisted results, never maintain a second database. */
export function registerModelFavoritesSync(
  broadcast: (channel: string, payload: unknown) => void,
): void {
  const hosts = new Map<number, WebContents>();
  const pending = new Map<string, { sender: number; settle(reply?: FavoriteHostReply): void }>();
  ipcMain.on(FAVORITE_HOST_READY, (event) => {
    assertTrustedAppRendererEvent(event);
    if (hosts.has(event.sender.id)) return;
    const id = event.sender.id;
    hosts.set(id, event.sender);
    event.sender.once('destroyed', () => {
      hosts.delete(id);
      for (const request of pending.values()) if (request.sender === id) request.settle();
    });
  });
  ipcMain.on(FAVORITE_HOST_REPLY, (event, reply: FavoriteHostReply) => {
    assertTrustedAppRendererEvent(event);
    if (!reply || typeof reply.requestId !== 'string') return;
    const request = pending.get(reply.requestId);
    if (request?.sender === event.sender.id) request.settle(reply);
  });
  ipcMain.on(FAVORITE_HOST_CHANGED, (event, stamp: unknown) => {
    assertTrustedAppRendererEvent(event);
    const current = getActiveDataOwnerPushStamp();
    if (
      !isAppSessionBoundaryPending() &&
      stamp &&
      typeof stamp === 'object' &&
      (stamp as typeof current).dataOwnerId === current.dataOwnerId &&
      (stamp as typeof current).ownerGeneration === current.ownerGeneration
    )
      broadcast(MODEL_FAVORITES_CHANGED, {});
  });
  const request = async (mutation?: unknown): Promise<RemoteModelFavorite[]> => {
    if (isAppSessionBoundaryPending())
      throwIpcError('PRECONDITION_FAILED', 'Favorites owner is changing');
    if (pending.size >= 64)
      throwIpcError('DEVICE_LINK_UNAVAILABLE', 'Favorites request capacity exceeded');
    let operation;
    try {
      operation = mutation === undefined ? undefined : parseModelFavoriteMutation(mutation);
    } catch {
      throwIpcError('INVALID_PARAMS', 'Invalid favorite operation');
    }
    const owner = activeOwnerScopeKey();
    const host = [...hosts.values()].find((value) => !value.isDestroyed());
    if (!host) throwIpcError('DEVICE_LINK_UNAVAILABLE', 'Favorites host not ready');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = (reply?: FavoriteHostReply, timedOut = false) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        try {
          if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
            throwIpcError('PRECONDITION_FAILED', 'Favorites were not confirmed: owner changed');
          if (!reply)
            throwIpcError(timedOut ? 'DEVICE_LINK_TIMEOUT' : 'DEVICE_LINK_UNAVAILABLE', 'Favorites were not confirmed');
          if (reply.failed)
            throwIpcError('PRECONDITION_FAILED', 'Favorites were not confirmed; refresh before retrying');
          let items;
          try { items = parseModelFavorites(reply.items); }
          catch { throwIpcError('INTERNAL', 'Invalid favorites host response'); }
          resolve(items);
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(() => settle(undefined, true), 8000);
      pending.set(requestId, { sender: host.id, settle });
      try {
        host.send(FAVORITE_HOST_REQUEST, {
          requestId,
          mutation: operation,
          ownerStamp: getActiveDataOwnerPushStamp(),
          expiresAt: Date.now() + 7500,
        });
      } catch {
        settle();
      }
    });
  };
  ipcMain.handle(MODEL_FAVORITES_GET, (event) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    return request();
  });
  ipcMain.handle(MODEL_FAVORITES_APPLY, (event, mutation: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    if (mutation === undefined) throwIpcError('INVALID_PARAMS', 'Favorite operation required');
    return request(mutation);
  });
}
