import { createLogger } from '../../logger';
import { listPluginEngineViews } from '../../maker-ipc/pluginEnginesIpc';
import { readRemotePluginEngines } from '../../remote-agent/controller/deviceCatalog';

const log = createLogger('im:plugin-engine-catalog');

/** The task's execution computer owns the catalog, even when provider IDs match across computers. */
export async function readImPluginEngine(route: {
  providerId?: string | null;
  agentDeviceId?: string | null;
}) {
  if (!route.providerId) return undefined;
  try {
    const engines = route.agentDeviceId
      ? await readRemotePluginEngines(route.agentDeviceId)
      : listPluginEngineViews();
    return engines.find((engine) => engine.providerId === route.providerId);
  } catch (err) {
    log.warn(`plugin engine catalog unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
