import { TAB_IDS, type VisibleSettingsTab } from './settingsTabs.js';

/** A navigation intent only: never a command, configuration patch or login approval. */
export interface SettingsNavigationTarget {
  tab: VisibleSettingsTab;
  deviceId: string;
  query?: string;
  section?: string;
}
export const SETTINGS_NAVIGATE_CHANNEL = 'maker:settings:navigate';
export function parseSettingsNavigationTarget(value: unknown): SettingsNavigationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !['tab', 'deviceId', 'query', 'section'].includes(key))) return null;
  if (!TAB_IDS.includes(v.tab as VisibleSettingsTab) || typeof v.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.deviceId)) return null;
  if (v.query !== undefined && (typeof v.query !== 'string' || v.query.length > 200 || /[\x00-\x1f]/.test(v.query))) return null;
  if (v.section !== undefined && (typeof v.section !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(v.section))) return null;
  return { tab: v.tab as VisibleSettingsTab, deviceId: v.deviceId, ...(v.query ? { query: v.query as string } : {}), ...(v.section ? { section: v.section as string } : {}) };
}
export function buildSettingsNavigationUrl(target: SettingsNavigationTarget): string {
  if (!parseSettingsNavigationTarget(target)) throw new Error('Invalid settings target');
  const params = new URLSearchParams({ device: target.deviceId });
  if (target.query) params.set('query', target.query);
  if (target.section) params.set('section', target.section);
  return `cindy://settings-link/${target.tab}?${params}`;
}
export function parseSettingsNavigationUrl(value: string): SettingsNavigationTarget | null {
  try {
    if (!/^cindy:\/\/settings-link\/[a-z-]+\?/.test(value) || value.length > 2048) return null;
    const url = new URL(value);
    if (url.hash || url.username || url.password || url.port || !/^\/[a-z-]+$/.test(url.pathname)) return null;
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(key => !['device', 'query', 'section'].includes(key))) return null;
    return parseSettingsNavigationTarget({ tab: url.pathname.slice(1), deviceId: url.searchParams.get('device'),
      ...(url.searchParams.has('query') ? { query: url.searchParams.get('query') } : {}),
      ...(url.searchParams.has('section') ? { section: url.searchParams.get('section') } : {}) });
  } catch { return null; }
}
export function settingsNavigationRoute(target: SettingsNavigationTarget): string {
  const params = new URLSearchParams({ tab: target.tab });
  if (target.query) params.set('query', target.query);
  if (target.section) params.set('section', target.section);
  return `/settings?${params}`;
}
/** Remote navigation must acknowledge the exact device before opening its viewer. */
export async function navigateRemoteSettings(target: SettingsNavigationTarget,
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>,
  openViewer: () => Promise<unknown> | void): Promise<void> {
  const result = await invoke(target.deviceId, SETTINGS_NAVIGATE_CHANNEL, [target]);
  if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true ||
    (result as { deviceId?: unknown }).deviceId !== target.deviceId) throw new Error('SETTINGS_NAVIGATION_UNAVAILABLE');
  await openViewer();
}
