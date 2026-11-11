import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { readModelDisableOverrides, setProviderDisabled } from '../maker-host/model-disable-store.js';
import { isRemoteProviderInvocationAllowed } from '../maker-host/remote-provider-access-store.js';
import { remoteModelAccess } from '../device-link/remoteModelAccess.js';

export function setLegacyCodexAccountPaused(providerId: string, paused: boolean): void {
  setProviderDisabled(providerId, paused);
}

/** Folding a connection must not widen its model or remote-use permissions. */
export function legacyCodexAccountCanRun(
  providerId: string,
  model: string | undefined,
  options: { remote: boolean; newRoute: boolean; modelSwitch?: boolean },
): boolean {
  if (options.remote && (!isRemoteProviderInvocationAllowed(providerId)
    || !remoteModelAccess.allows(providerId, model ?? ''))) return false;
  if (!options.newRoute && !options.modelSwitch) return true;
  const access = readModelDisableOverrides();
  if (options.newRoute && isProviderDisabled(access, providerId)) return false;
  if (!model) return true;
  const bare = model.replace(/^chatgpt\//, '');
  return !isModelDisabled(access, providerId, bare)
    && !isModelDisabled(access, providerId, `chatgpt/${bare}`);
}
