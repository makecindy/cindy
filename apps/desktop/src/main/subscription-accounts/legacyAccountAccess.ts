import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { readModelDisableOverrides, setProviderDisabled } from '../maker-host/model-disable-store.js';
import { isRemoteProviderInvocationAllowed, isRemoteProviderOpenToOwnComputers } from '../maker-host/remote-provider-access-store.js';
import { remoteModelAccess } from '../device-link/remoteModelAccess.js';

export function setLegacyCodexAccountPaused(providerId: string, paused: boolean): void {
  setProviderDisabled(providerId, paused);
}

/** Folding a connection must not widen its model or remote-use permissions. */
export function legacyCodexAccountCanRun(
  providerId: string,
  model: string | undefined,
  /** ownComputer：远程调用来自自己的其他电脑(不是受邀者)，此时也认「让我的其他电脑用本机模型」。 */
  options: { remote: boolean; ownComputer?: boolean; newRoute: boolean; modelSwitch?: boolean },
): boolean {
  const remoteAllowed = options.ownComputer ? isRemoteProviderOpenToOwnComputers : isRemoteProviderInvocationAllowed;
  if (options.remote && (!remoteAllowed(providerId)
    || !remoteModelAccess.allows(providerId, model ?? ''))) return false;
  if (!options.newRoute && !options.modelSwitch) return true;
  const access = readModelDisableOverrides();
  if (options.newRoute && isProviderDisabled(access, providerId)) return false;
  if (!model) return true;
  const bare = model.replace(/^chatgpt\//, '');
  return !isModelDisabled(access, providerId, bare)
    && !isModelDisabled(access, providerId, `chatgpt/${bare}`);
}

/** A task leaving a merged connection continues on `openai`; that route's own switches still apply. */
export function openAiRouteAllowsModel(
  model: string | undefined,
  options: { remote?: boolean; ownComputer?: boolean } = {},
): boolean {
  return subscriptionRouteAllowsModel('openai', model, options);
}

/** New account assignments must respect the destination provider's own grants. */
export function subscriptionRouteAllowsModel(
  providerId: string,
  model: string | undefined,
  options: { remote?: boolean; ownComputer?: boolean } = {},
): boolean {
  const remoteAllowed = options.ownComputer ? isRemoteProviderOpenToOwnComputers : isRemoteProviderInvocationAllowed;
  if (options.remote && (!remoteAllowed(providerId) || !remoteModelAccess.allows(providerId, model ?? '')))
    return false;
  const access = readModelDisableOverrides();
  if (isProviderDisabled(access, providerId)) return false;
  if (!model) return true;
  const bare = model.replace(/^chatgpt\//, '');
  return !isModelDisabled(access, providerId, bare) && !isModelDisabled(access, providerId, `chatgpt/${bare}`);
}
