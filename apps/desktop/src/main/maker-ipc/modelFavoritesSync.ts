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
  const request = (mutation?: unknown): Promise<RemoteModelFavorite[]> => {
    if (isAppSessionBoundaryPending() || pending.size >= 64)
      return Promise.reject(new Error('Favorites unavailable'));
    const operation = mutation === undefined ? undefined : parseModelFavoriteMutation(mutation);
    const owner = activeOwnerScopeKey();
    const host = [...hosts.values()].find((value) => !value.isDestroyed());
    if (!host) return Promise.reject(new Error('Favorites host not ready'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = (reply?: FavoriteHostReply) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        try {
          if (
            !reply ||
            reply.failed ||
            isAppSessionBoundaryPending() ||
            activeOwnerScopeKey() !== owner
          )
            throw new Error('Favorites were not confirmed; refresh before retrying');
          resolve(parseModelFavorites(reply.items));
        } catch (error) {
          reject(error);
        }
      };
      const timer = setTimeout(() => settle(), 8000);
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
    if (mutation === undefined) throw new Error('Favorite operation required');
    return request(mutation);
  });
}
