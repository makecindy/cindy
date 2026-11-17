import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import {
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  MODEL_FAVORITES_CHANGED,
  parseModelFavoriteMutation,
  parseModelFavorites,
  parseRemoteModelFavorite,
  type ModelFavoriteMutation,
  type RemoteModelFavorite,
} from '@cindy/device-link';
import {
  FAVORITE_HOST_READY,
  FAVORITE_HOST_REQUEST,
  FAVORITE_HOST_REPLY,
  FAVORITE_HOST_CHANGED,
  type FavoriteHostReply,
  type RecentModelHostItem,
} from '../../shared/modelFavoritesSync.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Favorites plus the renderer-owned recently used list, both newest/display order. */
export interface HostModelPreferences {
  favorites: RemoteModelFavorite[];
  recents: RecentModelHostItem[];
}
type FavoritesHostRequest = (mutation?: unknown, options?: { recents?: true }) =>
  Promise<{ items: RemoteModelFavorite[]; recents?: RecentModelHostItem[] }>;
let hostRequest: FavoritesHostRequest | null = null;

/** Recents are a short renderer list (20 kept); anything larger is a malformed reply. */
function parseRecentModels(value: unknown): RecentModelHostItem[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid recents snapshot');
  return value.map((item) => {
    const { uid: _uid, ...rest } = parseRemoteModelFavorite(item, false);
    return rest;
  });
}

/**
 * Main-side callers (plugin `/model-preferences`) reuse the same owner-fenced bridge as
 * device-link; errors carry the same IPC codes. Throws DEVICE_LINK_UNAVAILABLE before
 * registration.
 */
export async function readHostModelPreferences(): Promise<HostModelPreferences> {
  if (!hostRequest) throwIpcError('DEVICE_LINK_UNAVAILABLE', 'Favorites host not ready');
  const reply = await hostRequest(undefined, { recents: true });
  return { favorites: reply.items, recents: reply.recents ?? [] };
}
export async function applyHostModelFavorite(mutation: ModelFavoriteMutation): Promise<RemoteModelFavorite[]> {
  if (!hostRequest) throwIpcError('DEVICE_LINK_UNAVAILABLE', 'Favorites host not ready');
  return (await hostRequest(mutation)).items;
}

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
  const request: FavoritesHostRequest = async (mutation, options) => {
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
          let recents: RecentModelHostItem[] | undefined;
          try {
            items = parseModelFavorites(reply.items);
            if (options?.recents) recents = parseRecentModels(reply.recents);
          } catch { throwIpcError('INTERNAL', 'Invalid favorites host response'); }
          resolve({ items, ...(recents ? { recents } : {}) });
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
          ...(options?.recents ? { recents: true as const } : {}),
        });
      } catch {
        settle();
      }
    });
  };
  hostRequest = request;
  ipcMain.handle(MODEL_FAVORITES_GET, (event) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    return request().then((reply) => reply.items);
  });
  ipcMain.handle(MODEL_FAVORITES_APPLY, (event, mutation: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    if (mutation === undefined) throwIpcError('INVALID_PARAMS', 'Favorite operation required');
    return request(mutation).then((reply) => reply.items);
  });
}
