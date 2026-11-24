import { createHmac, randomBytes } from 'node:crypto';
import { manageAppPreferences } from '../app-settings/preferences.js';
import type { AppPreferencePatch } from '../../shared/appPreferenceControl.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import type { SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import { SETTINGS_DISPLAY_LOCALES } from '../../shared/settingsReadCatalog.js';
import { HostSettingsError } from './operations.js';

/**
 * The cloud page's desktop groups are views of the app preferences section. The app window keeps
 * these preferences, as on every desktop, and saving goes through that section, so the instance has
 * one copy. A value equal to its default follows the default.
 */
const FIELDS = {
  desktopGeneral: { themeFamilyId: 'themeFamily', theme: 'theme', locale: 'language', sidebarPinnedMode: 'sidebarPinned', sidebarMainMode: 'sidebarTasks' },
  desktopChat: { composerSendShortcut: 'sendShortcut', webLinkOpenPreference: 'webLinks', localLinkOpenPreference: 'localLinks',
    streamFadePreference: 'streamFade', promptRecommendationEnabled: 'promptRecommendations', messageNavRailEnabled: 'messageNavigation' },
  desktopNotifications: { notificationsEnabled: 'notifications', feishuNotificationsEnabled: 'feishuNotifications',
    swallowActivationClick: 'swallowActivationClick', networkDebugEnabled: 'networkDebug' },
} as const satisfies Record<string, Record<string, keyof AppPreferencePatch>>;
export type DesktopPreferenceDomain = keyof typeof FIELDS;
export const isDesktopPreferenceDomain = (domain: string): domain is DesktopPreferenceDomain => Object.hasOwn(FIELDS, domain);

// The desktop's own defaults (the setting hooks' fallbacks).
const DEFAULTS: Record<string, SettingsEditableValue> = {
  themeFamilyId: 'cindy', theme: 'system', locale: 'system', sidebarPinnedMode: 'text', sidebarMainMode: 'list', ghostPanelRestoreMode: 'bubble',
  composerSendShortcut: 'enter', webLinkOpenPreference: 'external', localLinkOpenPreference: 'sidebar', streamFadePreference: 'on',
  promptRecommendationEnabled: true, messageNavRailEnabled: true,
  notificationsEnabled: true, feishuNotificationsEnabled: false, swallowActivationClick: false, networkDebugEnabled: false,
};
// A wire field with no desktop preference behind it: it reads its default and cannot be changed.
const FIXED = { desktopGeneral: ['ghostPanelRestoreMode'] } as Partial<Record<DesktopPreferenceDomain, readonly string[]>>;

type Values = Record<string, SettingsEditableValue>;
type Choice = { value: SettingsEditableValue; label: string };
type State = HostSettingState<Values> & { choices?: Record<string, Choice[]> };
const revisionKey = randomBytes(32);

/** Reads through the app window. A window that does not answer leaves the group unreadable. */
export async function readDesktopPreferenceDomain(domain: DesktopPreferenceDomain, themeChoices: () => Choice[]): Promise<State> {
  let preferences: Partial<Record<keyof AppPreferencePatch, unknown>>;
  try { preferences = (await manageAppPreferences('get')).value as typeof preferences; }
  catch { return { status: 'unreadable', revision: null }; }
  const value: Values = {};
  for (const [field, key] of Object.entries(FIELDS[domain])) value[field] = preferences[key as keyof AppPreferencePatch] as SettingsEditableValue;
  for (const field of FIXED[domain] ?? []) value[field] = DEFAULTS[field]!;
  // A language outside the cloud wire stays in the instance's own settings rather than failing the read.
  if (domain === 'desktopGeneral' && !(SETTINGS_DISPLAY_LOCALES as readonly unknown[]).includes(value.locale)) return { status: 'unavailable', revision: null };
  const defaults = Object.fromEntries(Object.keys(value).map(field => [field, DEFAULTS[field]!]));
  const customizedKeys = Object.keys(FIELDS[domain]).filter(field => value[field] !== defaults[field]);
  const revision = createHmac('sha256', revisionKey).update(JSON.stringify([domain, value])).digest('base64url');
  const state: State = { status: 'ready', revision, value, defaults, customizedKeys, isCustomized: customizedKeys.length > 0 };
  // Listing the languages tells cloud pages this Host accepts more than the original six.
  return domain === 'desktopGeneral' ? { ...state, choices: { themeFamilyId: themeChoices(),
    locale: SETTINGS_DISPLAY_LOCALES.map(locale => ({ value: locale, label: locale })) } } : state;
}

/** The preferences a read returned for a group, which the app window compares before saving a change made from it. */
export function desktopPreferenceExpected(domain: DesktopPreferenceDomain, value: Values): Partial<Record<keyof AppPreferencePatch, SettingsEditableValue>> {
  return Object.fromEntries(Object.entries(FIELDS[domain]).map(([field, key]) => [key, value[field]]));
}

/** The preferences patch for a change, checked against the choices the read offered. */
export function desktopPreferencePatch(domain: DesktopPreferenceDomain, values: Values, before: { choices?: Record<string, Choice[]> }): Values {
  const patch: Values = {};
  for (const [field, value] of Object.entries(values)) {
    const key = (FIELDS[domain] as Record<string, string>)[field];
    if (!key) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    if (field === 'themeFamilyId' && !before.choices?.themeFamilyId?.some(choice => choice.value === value)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    patch[key] = value;
  }
  return patch;
}
