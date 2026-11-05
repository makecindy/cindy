import type { AppSettingsSection } from './service.js';

/** Services register their already-initialized operations; never instantiate a second runtime. */
const sections = new Map<string, AppSettingsSection>();
export function registerRuntimeSettingsSection(section: AppSettingsSection): void { sections.set(section.id, section); }
export function runtimeSettingsSections(): AppSettingsSection[] { return [...sections.values()]; }
