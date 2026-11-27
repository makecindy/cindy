import { CONTROLLED_MODEL_CATALOG_CHANNEL, parseModelCatalogKey } from '../../shared/controlledModelCatalog';

export function invokeModelCatalog(
  link: { invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown> },
  key: string,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const route = parseModelCatalogKey(key);
  return route
    ? link.invoke(route.taskDeviceId, CONTROLLED_MODEL_CATALOG_CHANNEL, [{
        op: 'read', agentDeviceId: route.agentDeviceId, channel, args,
      }])
    : link.invoke(key, channel, args);
}
