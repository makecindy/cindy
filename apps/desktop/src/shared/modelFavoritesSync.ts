import type { ModelFavoriteMutation, RemoteModelFavorite } from '@cindy/device-link';
import type { DataOwnerPushStamp } from './dataOwnerPush';
export const FAVORITE_HOST_READY = 'model-favorites:host-ready';
export const FAVORITE_HOST_REQUEST = 'model-favorites:host-request';
export const FAVORITE_HOST_REPLY = 'model-favorites:host-reply';
export const FAVORITE_HOST_CHANGED = 'model-favorites:host-changed';
/** A recently used configuration copy; read-only, no timestamps leave the renderer. */
export type RecentModelHostItem = Omit<RemoteModelFavorite, 'uid'>;
export interface FavoriteHostRequest {
  requestId: string;
  expiresAt: number;
  ownerStamp: DataOwnerPushStamp;
  mutation?: ModelFavoriteMutation;
  /** Also read the renderer-owned recently used list (plugin `/model-preferences`). Never written. */
  recents?: true;
}
export interface FavoriteHostReply {
  requestId: string;
  items?: RemoteModelFavorite[];
  /** Present only when the request asked for recents; newest first. */
  recents?: RecentModelHostItem[];
  failed?: true;
}
export interface ModelFavoritesHostApi {
  ready(): void;
  changed(stamp: DataOwnerPushStamp): void;
  reply(reply: FavoriteHostReply): void;
  onRequest(listener: (request: FavoriteHostRequest) => void): () => void;
}
