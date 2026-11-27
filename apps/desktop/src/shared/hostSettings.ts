import { ADDITIONAL_SETTINGS_DOMAINS, isAdditionalSettingsDomain, normalizeAdditionalSettingsChange } from './settingsEditableCatalog.js';
import { isValidAppearanceSetting, clampAppearanceWindowZoom, type AppearanceSettings } from './appearanceSettings.js';

export const NATIVE_HOST_SETTINGS_DOMAINS = ['newTaskDefaults', 'personalization', 'databaseWarning', 'appearance'] as const;
export const HOST_SETTINGS_DOMAINS = [...NATIVE_HOST_SETTINGS_DOMAINS, ...ADDITIONAL_SETTINGS_DOMAINS] as const;
export type HostSettingsDomain = typeof HOST_SETTINGS_DOMAINS[number];
export type SettingsHarness = 'claude-code' | 'codex' | 'pi';
export interface NewTaskDefaultSettings {
  harness: SettingsHarness;
  providerId: string | null;
  modelId: string | null;
  effort: string | null;
  fast: boolean | 'ultrafast';
  thinking: boolean;
  worktree: boolean;
  planMode: boolean;
}
export interface PersonalizationSettings { userPrompt: string }
export interface DatabaseWarningSettings { thresholdGiB: number; disabled: boolean }
export interface SettingsOwnerStamp { dataOwnerId: string | null; ownerGeneration: number }
/** value is the saved override + current defaults, NOT proof of application to a running task/window. */
export type HostSettingState<T> =
  | { status: 'ready'; value: T; defaults: T; customizedKeys: string[]; revision: string; isCustomized: boolean }
  | { status: 'unreadable' | 'unavailable'; revision: null };
export interface HostSettingsSnapshot {
  ownerStamp: SettingsOwnerStamp | null;
  newTaskDefaults: HostSettingState<NewTaskDefaultSettings>;
  personalization: HostSettingState<{ isCustomized: boolean }>;
  databaseWarning: HostSettingState<DatabaseWarningSettings>;
  appearance: HostSettingState<AppearanceSettings>;
}
export interface HostSettingsRendererApi {
  /** True only on a managed cloud instance. The window keeps its own settings. */
  readonly hostOwned: boolean;
}
export interface HostSettingsChange {
  domain: HostSettingsDomain;
  set: Record<string, import('./settingsEditableCatalog.js').SettingsEditableValue>;
  clear: string[];
}
export interface HostSettingsUpdate {
  domain: HostSettingsDomain;
  expectedRevision: string;
  operationId: string;
  /** Opaque, Host-issued identity of a known local workspace; no paths accepted. */
  workspaceId?: string;
  set?: Record<string, unknown>;
  clear?: string[];
}
export interface HostSettingsReceipt {
  operationId: string;
  domain: string;
  status: 'saved' | 'rejected' | 'unknown';
  saved: boolean;
  application: 'next_task' | 'next_agent_start' | 'applied' | 'failed' | 'not_applied';
  revision?: string;
  code?: string;
}

export function isHostSettingsDomain(value: unknown): value is HostSettingsDomain {
  return typeof value === 'string' && HOST_SETTINGS_DOMAINS.includes(value as HostSettingsDomain);
}

const fields: Record<typeof NATIVE_HOST_SETTINGS_DOMAINS[number], readonly string[]> = {
  newTaskDefaults: ['harness', 'providerId', 'modelId', 'effort', 'fast', 'thinking', 'worktree', 'planMode'],
  personalization: ['userPrompt'],
  databaseWarning: ['thresholdGiB', 'disabled'],
  appearance: ['uiFamily', 'codeFamily', 'uiSize', 'codeSize', 'windowZoom'],
};
const effortValues = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Closed grammar shared by native UI and tools; never accepts paths, owners or permissions. */
export function normalizeHostSettingsChange(raw: unknown): HostSettingsChange {
  if (!isRecord(raw) || !isHostSettingsDomain(raw.domain)) throw new Error('INVALID_SETTINGS_CHANGE');
  if (Object.keys(raw).some((key) => !['domain', 'set', 'clear'].includes(key))) throw new Error('INVALID_SETTINGS_CHANGE');
  const domain = raw.domain;
  if (isAdditionalSettingsDomain(domain)) return normalizeAdditionalSettingsChange(domain, raw.set, raw.clear);
  if (raw.set !== undefined && !isRecord(raw.set)) throw new Error('INVALID_SETTINGS_CHANGE');
  if (raw.clear !== undefined && (!Array.isArray(raw.clear) || raw.clear.some((field) => typeof field !== 'string'))) throw new Error('INVALID_SETTINGS_CHANGE');
  const set: HostSettingsChange['set'] = {};
  const clear = [...new Set((raw.clear ?? []) as string[])].sort();
  if (clear.length > fields[domain].length || clear.some((field) => !fields[domain].includes(field))) throw new Error('INVALID_SETTINGS_CHANGE');
  for (const key of Object.keys((raw.set ?? {}) as Record<string, unknown>).sort()) {
    if (!fields[domain].includes(key) || clear.includes(key)) throw new Error('INVALID_SETTINGS_CHANGE');
    const value = (raw.set as Record<string, unknown>)[key];
    if (domain === 'personalization') {
      if (typeof value !== 'string' || value.length > 8000) throw new Error('INVALID_SETTINGS_CHANGE');
      set[key] = value;
    } else if (domain === 'newTaskDefaults') {
      if (key === 'harness') {
        if (typeof value !== 'string' || !['claude-code', 'codex', 'pi'].includes(value)) throw new Error('INVALID_SETTINGS_CHANGE');
        set[key] = value as SettingsHarness;
      } else if (['providerId', 'modelId'].includes(key)) {
        // eslint-disable-next-line no-control-regex
        if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('INVALID_SETTINGS_CHANGE');
        set[key] = value.trim();
      } else if (key === 'effort') {
        if (value !== null && (typeof value !== 'string' || !effortValues.includes(value))) throw new Error('INVALID_SETTINGS_CHANGE');
        set[key] = value;
      } else {
        if (typeof value !== 'boolean' && !(key === 'fast' && value === 'ultrafast')) throw new Error('INVALID_SETTINGS_CHANGE');
        set[key] = value;
      }
    } else if (domain === 'databaseWarning') {
      if (key === 'disabled') {
        if (typeof value !== 'boolean') throw new Error('INVALID_SETTINGS_CHANGE');
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 1024) throw new Error('INVALID_SETTINGS_CHANGE');
      set[key] = value as number | boolean;
    } else {
      if (!isValidAppearanceSetting(key, value)) throw new Error('INVALID_SETTINGS_CHANGE');
      set[key] = typeof value === 'string' ? value.trim() : key === 'windowZoom' && typeof value === 'number' ? clampAppearanceWindowZoom(value) : value;
    }
  }
  if (Object.keys(set).length + clear.length === 0) throw new Error('INVALID_SETTINGS_CHANGE');
  return { domain, set, clear };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
