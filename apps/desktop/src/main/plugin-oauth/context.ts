import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  PluginSecretOffer,
  PluginConnectionOffer,
  PluginConnectionInput,
  PluginOauthCallback,
  PluginOauthOffer,
  PluginDeviceOffer,
  PluginAuthorizationOffer,
  PluginDeviceOpened,
} from '@cindy/device-link';

/** Captured by a validated card action, never from model/Renderer URL parameters. */
export interface RemoteOauthContext {
  scope: string;
  assertCurrent(): void;
  authorize(offer: PluginOauthOffer, signal: AbortSignal): Promise<PluginOauthCallback>;
  /** Optional additive capability; old loopback callers stay unchanged. */
  authorizeDevice?(offer: PluginDeviceOffer, signal: AbortSignal): Promise<void>;
  authorizePlugin?(
    offer: PluginAuthorizationOffer,
    signal: AbortSignal,
  ): Promise<PluginOauthCallback | PluginDeviceOpened>;
  submitSecret?(offer: PluginSecretOffer): Promise<string>;
  submitConnection?(offer: PluginConnectionOffer): Promise<PluginConnectionInput>;
  cancelled?: AbortSignal;
  finish(ok: boolean): void;
}
const storage = new AsyncLocalStorage<RemoteOauthContext>();
export const getRemoteOauthContext = () => storage.getStore();
export function withRemoteOauthContext<T>(context: RemoteOauthContext, action: () => T): T {
  return storage.run(context, action);
}
const closedListeners = new Set<(requestId: string) => void>();
export function onOauthCardClosed(listener: (requestId: string) => void): () => void {
  closedListeners.add(listener);
  return () => {
    closedListeners.delete(listener);
  };
}
export function notifyOauthCardClosed(requestId: string): void {
  for (const listener of closedListeners) listener(requestId);
}
