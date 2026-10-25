import { assistPluginOauth as assist, type OauthControllerDeps } from '@cindy/plugin-runtime/authorization/controller';
import { openAuthorizationOffer } from './authorizationAdapters.js';
import { listenForOauthCallback } from './loopbackListener.js';
export * from '@cindy/plugin-runtime/authorization/controller';
export { listenForOauthCallback } from './loopbackListener.js';
export function assistPluginOauth(deps: OauthControllerDeps, action: Parameters<typeof assist>[1]) {
  return assist(Object.assign(deps, { openAuthorizationOffer, listenForOauthCallback }), action);
}
