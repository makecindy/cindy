import type { ProviderView } from '@cindy/model-providers';
import type { PluginTaskRoute } from '../../shared/pluginTasks.js';
import { isPluginModelPickerRouteAvailable } from '../cindy-brain/ghostModelPicker.js';
import { GHOST_REMOTE_AGENT_MODELS } from '../cindy-brain/ghostAgentModels.js';
import { PluginTaskError } from './pluginTaskService.js';

/** The caller supplies the ordinary authenticated remote catalog reader, never picker caches.
 * Revalidate on create, setModel and send/accept; a revoked source cannot borrow local namesakes. */
export async function resolveRemotePluginTaskRoute(route: PluginTaskRoute, deps: {
  readProviders(deviceId: string): Promise<ProviderView[]>;
  assertCurrent(): void;
}): Promise<PluginTaskRoute> {
  const selection = { ...route };
  deps.assertCurrent();
  let providers: ProviderView[];
  try {
    providers = await deps.readProviders(selection.agentDeviceId!);
  } catch {
    deps.assertCurrent();
    throw new PluginTaskError('ROUTE_UNAVAILABLE', '远程模型来源不可用，请恢复连接或重新选择模型');
  }
  deps.assertCurrent();
  if (!isPluginModelPickerRouteAvailable(selection, providers, GHOST_REMOTE_AGENT_MODELS)) {
    throw new PluginTaskError('ROUTE_UNAVAILABLE', '所选来源的模型、引擎或配置已不可用，请重新选择');
  }
  return selection;
}
