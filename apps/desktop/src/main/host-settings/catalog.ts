import type { ProviderView } from '@cindy/model-providers';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { waitForModelVisibilityMirror } from '../maker-host/model-visibility-mirror.js';
import { currentSettingsOwner, assertSettingsOwner } from './personalization.js';
import { HostSettingsError } from './operations.js';

/** 只读执行端已加载目录与连接态；不发起发现、授权认领或配置修复。 */
export async function readSettingsModelCatalog() {
  const owner = currentSettingsOwner();
  if (!owner) throw new HostSettingsError('OWNER_CHANGED');
  await waitForModelVisibilityMirror();
  assertSettingsOwner(owner);
  let providers: ProviderView[];
  try {
    providers = await getDesktopProviderService({ allowSideEffects: false }).listProviders({ allowSideEffects: false, includeMediaReadiness: false });
  } finally { assertSettingsOwner(owner); }
  const agents = getMakerIfReady()?.listAvailableAgents() ?? [];
  return { providers, agents, assertCurrent: () => assertSettingsOwner(owner) };
}
