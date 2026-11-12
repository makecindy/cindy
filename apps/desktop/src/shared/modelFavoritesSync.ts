import type { ModelFavoriteMutation, RemoteModelFavorite } from '@cindy/device-link';
import type { DataOwnerPushStamp } from './dataOwnerPush';
export const FAVORITE_HOST_READY = 'model-favorites:host-ready';
export const FAVORITE_HOST_REQUEST = 'model-favorites:host-request';
export const FAVORITE_HOST_REPLY = 'model-favorites:host-reply';
export const FAVORITE_HOST_CHANGED = 'model-favorites:host-changed';
export interface FavoriteHostRequest {
  requestId: string;
  expiresAt: number;
  ownerStamp: DataOwnerPushStamp;
  mutation?: ModelFavoriteMutation;
}
export interface FavoriteHostReply {
  requestId: string;
  items?: RemoteModelFavorite[];
  failed?: true;
}
export interface ModelFavoritesHostApi {
  ready(): void;
  changed(stamp: DataOwnerPushStamp): void;
  reply(reply: FavoriteHostReply): void;
  onRequest(listener: (request: FavoriteHostRequest) => void): () => void;
}
