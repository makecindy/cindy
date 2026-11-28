import { z } from 'zod';
import { registerRuntimeSettingsSection } from '../../app-settings/runtime.js';
import { writeMemorySetting, resetMemorySettings, readMemorySettingsState } from '../../maker-host/memory-settings-store.js';
import { writeSubagentModelSettingsPatch, resetSubagentModelSettings, readSubagentModelSettingsState } from '../../maker-host/subagent-model-settings-store.js';
import { writeAuxiliaryModelSettingsPatch, resetAuxiliaryModelSettings, readAuxiliaryModelSettingsState } from '../../utility-model/auxiliary-model-settings-store.js';

/**
 * The app registers these sections at startup (maker IPC and bootstrap). Tests register the same
 * store writes, with the same check right before them, without the engine restarts so Host
 * settings can be saved through them.
 */
export function registerRuntimeSectionsForTest(): void {
  const schema = z.record(z.string(), z.unknown());
  const meta = { title: 'fixture', description: 'fixture', effective: 'fixture', schema };
  registerRuntimeSettingsSection({ ...meta, id: 'memory', read: readMemorySettingsState,
    update: (patch, guard) => { guard?.assertUnchanged(); for (const [key, value] of Object.entries(patch)) writeMemorySetting(key as never, value as never); },
    reset: guard => { guard?.assertUnchanged(); resetMemorySettings(); } });
  registerRuntimeSettingsSection({ ...meta, id: 'subagent-models', read: readSubagentModelSettingsState,
    update: (patch, guard) => { guard?.assertUnchanged(); return writeSubagentModelSettingsPatch(patch as never); },
    reset: guard => { guard?.assertUnchanged(); resetSubagentModelSettings(); } });
  registerRuntimeSettingsSection({ ...meta, id: 'auxiliary-models', read: readAuxiliaryModelSettingsState,
    update: (patch, guard) => writeAuxiliaryModelSettingsPatch(patch as never, () => guard?.assertUnchanged()),
    reset: async guard => { guard?.assertUnchanged(); await resetAuxiliaryModelSettings(); } });
}
