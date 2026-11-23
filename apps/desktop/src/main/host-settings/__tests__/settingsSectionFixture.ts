import { z } from 'zod';
import { registerRuntimeSettingsSection } from '../../app-settings/runtime.js';
import { writeMemorySetting, resetMemorySettings, readMemorySettingsState } from '../../maker-host/memory-settings-store.js';
import { writeSubagentModelSettingsPatch, resetSubagentModelSettings, readSubagentModelSettingsState } from '../../maker-host/subagent-model-settings-store.js';
import { writeAuxiliaryModelSettingsPatch, resetAuxiliaryModelSettings, readAuxiliaryModelSettingsState } from '../../utility-model/auxiliary-model-settings-store.js';

/**
 * The app registers these sections at startup (maker IPC and bootstrap). Tests register the same
 * store writes without the engine restarts so Host settings can be saved through them.
 */
export function registerRuntimeSectionsForTest(): void {
  const schema = z.record(z.string(), z.unknown());
  const meta = { title: 'fixture', description: 'fixture', effective: 'fixture', schema };
  registerRuntimeSettingsSection({ ...meta, id: 'memory', read: readMemorySettingsState,
    update: patch => { for (const [key, value] of Object.entries(patch)) writeMemorySetting(key as never, value as never); },
    reset: () => { resetMemorySettings(); } });
  registerRuntimeSettingsSection({ ...meta, id: 'subagent-models', read: readSubagentModelSettingsState,
    update: patch => writeSubagentModelSettingsPatch(patch as never), reset: () => { resetSubagentModelSettings(); } });
  registerRuntimeSettingsSection({ ...meta, id: 'auxiliary-models', read: readAuxiliaryModelSettingsState,
    update: patch => writeAuxiliaryModelSettingsPatch(patch as never), reset: async () => { await resetAuxiliaryModelSettings(); } });
}
