import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'cindy-make',
  order: 14,
  entries: [],
} satisfies SettingsSearchModule;
