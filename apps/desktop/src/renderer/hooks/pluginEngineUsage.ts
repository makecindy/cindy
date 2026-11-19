import { createPluginHarnessUsageReader } from '@cindy/plugin-protocol';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PLUGIN_ENGINES_INVOKE } from '../../shared/pluginEngines';

const reader = createPluginHarnessUsageReader();

export function readPluginEngineUsage(owner: DataOwnerGeneration, deviceId: string | null, engineKey: string) {
  return reader.read(owner, deviceId, engineKey, () => {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    return deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, PLUGIN_ENGINES_INVOKE.USAGE, [engineKey])
      : window.electronAPI.maker.getPluginEngineUsage?.(engineKey);
  });
}

export function invalidateLocalPluginEngineUsage(): void {
  reader.invalidate(getDataOwnerGeneration(), null);
}
