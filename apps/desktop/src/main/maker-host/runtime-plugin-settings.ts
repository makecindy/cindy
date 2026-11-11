import { parseRuntimePluginSettings, type RuntimePluginSettings } from '../../shared/pluginRuntime.js';
import { activeDataOwnerId, ownerScopedPath } from '../ownerContext.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { desktopMakerLogger } from './logger-adapter.js';

interface RuntimePluginPreferences { tasks: Record<string, RuntimePluginSettings> }

const store = createOverrideSettingsFile<RuntimePluginPreferences>({
  filePath: () => ownerScopedPath('runtime-plugin-prefs.json'),
  defaults: { tasks: {} },
  normalize: raw => {
    const tasks: Record<string, RuntimePluginSettings> = {};
    const source = raw && typeof raw === 'object' ? (raw as { tasks?: unknown }).tasks : undefined;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [id, value] of Object.entries(source)) {
        const settings = parseRuntimePluginSettings(value);
        if (id && settings && Object.keys(settings).length) tasks[id] = settings;
      }
    }
    return { tasks };
  },
  log: desktopMakerLogger.child('runtime-plugins'),
  label: 'runtime-plugins',
  logLoadedValue: false,
  preserveUnreadableFile: true,
  maxBytes: 1_048_576,
});

/** Runtime reads use the ordinary settings cache; they never enumerate installed plugins. */
export function readRuntimePluginSettings(sessionId: string): RuntimePluginSettings | undefined {
  return store.read().tasks[sessionId];
}

/** Load the bounded file during existing owner initialization, before sends. */
export function warmRuntimePluginSettings(): void {
  if (activeDataOwnerId()) store.read();
}

export async function writeRuntimePluginSettings(sessionId: string, value: RuntimePluginSettings): Promise<void> {
  if (!sessionId) throw new Error('Session id required');
  const settings = parseRuntimePluginSettings(value);
  if (!settings) throw new Error('Invalid runtime plugin settings');
  await store.updateAtomic(current => {
    const tasks = { ...current.value.tasks };
    if (Object.keys(settings).length) tasks[sessionId] = settings;
    else delete tasks[sessionId];
    return { tasks };
  });
}
