import { createPluginHarnessUsageReader } from '@cindy/plugin-protocol';
import { isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { PLUGIN_ENGINES_INVOKE } from '../../shared/pluginEngines';

const reader = createPluginHarnessUsageReader();

/**
 * `sessionId`: an engine with several accounts reports the task's own account,
 * so the read is cached per task rather than shared by every task of the engine.
 */
export function readPluginEngineUsage(owner: DataOwnerGeneration, deviceId: string | null, engineKey: string, sessionId?: string, hosted = false) {
  const task = sessionId ? { sessionId, ...(hosted ? { hosted: true } : {}) } : undefined;
  return reader.read(owner, deviceId, task ? `${engineKey}|${hosted ? 'hosted' : 'task'}:${sessionId}` : engineKey, () => {
    if (!isDataOwnerGenerationCurrent(owner)) return;
    return deviceId
      ? window.electronAPI.deviceLink.invoke(deviceId, PLUGIN_ENGINES_INVOKE.USAGE, task ? [engineKey, task] : [engineKey])
      : task ? window.electronAPI.maker.getPluginEngineUsage?.(engineKey, task) : window.electronAPI.maker.getPluginEngineUsage?.(engineKey);
  });
}

export const retainReportingPluginEngines = reader.retainReportingEngines;
