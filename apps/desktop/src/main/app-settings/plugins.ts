import { z } from 'zod';
import { isGhostHostUiSettingValue, type GhostHostUiSetting } from '@cindy/plugin-protocol';
import type { AppSettingsSection } from './service.js';

export interface PluginSettingsEntry {
  instance: string;
  title: string;
  settings: readonly GhostHostUiSetting[];
  assertCurrent(): void;
}
export interface PluginSettingsStore {
  read(instance: string): Record<string, unknown>;
  write(instance: string, value: Record<string, unknown>): void;
}
function settingSchema(field: GhostHostUiSetting): z.ZodType {
  if (field.options) return z.union(field.options.map(option => z.literal(option.value)));
  if (field.type === 'boolean') return z.boolean();
  if (field.type === 'string') return z.string().max(field.maxLength ?? 32768);
  let schema = z.number();
  if (field.min !== undefined) schema = schema.min(field.min);
  if (field.max !== undefined) schema = schema.max(field.max);
  return schema;
}

/** Projection over the existing approved UI source and the original instance KV. */
export function createPluginSettingsSections(entries: readonly PluginSettingsEntry[], store: PluginSettingsStore): AppSettingsSection[] {
  return entries.filter(entry => entry.settings.length).map(entry => {
    const defaults = Object.fromEntries(entry.settings.map(field => [field.id, field.default]));
    return {
      id: `plugins.${entry.instance}`, title: entry.title,
      description: entry.settings.map(field => `${field.title} ${field.description ?? ''}`).join(' '), effective: 'immediate',
      schema: z.strictObject(Object.fromEntries(entry.settings.map(field => [field.id,
        settingSchema(field).optional(),
      ]))),
      read() {
        entry.assertCurrent();
        const saved = store.read(entry.instance);
        const overrides = Object.fromEntries(entry.settings.filter(field => Object.hasOwn(saved, field.id) &&
          isGhostHostUiSettingValue(field, saved[field.id])).map(field => [field.id, saved[field.id]]));
        return { value: { ...defaults, ...overrides }, defaults, customizedKeys: Object.keys(overrides) };
      },
      update(patch) {
        entry.assertCurrent();
        const next = { ...store.read(entry.instance) };
        for (const field of entry.settings) {
          if (Object.hasOwn(next, field.id) && !isGhostHostUiSettingValue(field, next[field.id])) delete next[field.id];
        }
        Object.assign(next, patch);
        entry.assertCurrent();
        store.write(entry.instance, next);
      },
      reset() {
        entry.assertCurrent();
        const next = { ...store.read(entry.instance) };
        for (const field of entry.settings) delete next[field.id];
        entry.assertCurrent();
        store.write(entry.instance, next);
      },
    };
  });
}

// Startup injects ports; registration/approval remain in the original App registry.
let ports: (PluginSettingsStore & { entries(): readonly PluginSettingsEntry[] }) | undefined;
export function configurePluginSettings(value: NonNullable<typeof ports>): void { ports = value; }
export const pluginSettingsSections = (): AppSettingsSection[] => ports ? createPluginSettingsSections(ports.entries(), ports) : [];
