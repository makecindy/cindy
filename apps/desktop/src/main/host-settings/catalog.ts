import type { ProviderView } from '@cindy/model-providers';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { waitForModelVisibilityMirror } from '../maker-host/model-visibility-mirror.js';
import { currentSettingsOwner, assertSettingsOwner } from './personalization.js';
import { HostSettingsError } from './operations.js';
import { sharedSettingsModelCatalog } from './catalogScope.js';

/** 只读执行端已加载目录与连接态；不发起发现、授权认领或配置修复。一批读取内共用一次。 */
export function readSettingsModelCatalog() {
  return sharedSettingsModelCatalog(readCatalog);
}
async function readCatalog() {
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
