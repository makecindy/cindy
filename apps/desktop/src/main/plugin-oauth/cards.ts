import { createPluginOauthCardBindings } from '@cindy/plugin-runtime/authorization/cards';
import { initializePluginOauthHost, type OauthKeyLoader } from './runtime.js';
import type { OauthIdentityScope } from './identityStore.js';
export function initializePluginOauthCards(deps: Parameters<typeof createPluginOauthCardBindings>[0] & {
  identity: () => OauthIdentityScope | null; loadKey: OauthKeyLoader;
}): void { initializePluginOauthHost(createPluginOauthCardBindings(deps), deps.identity, deps.loadKey); }
