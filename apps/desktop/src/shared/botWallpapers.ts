import { normalizeCustomWallpaperUrl } from './appearanceSettings.js';

/** 伙伴 ID → 自定义壁纸 URL（client-wallpaper 媒体库）。只在本机，不进跨端协议。 */
export type BotWallpaperMap = Readonly<Record<string, string>>;

export const BOT_WALLPAPERS_CHANGED_CHANNEL = 'appearance-settings:bot-wallpapers-changed';
const MAX_BOT_ID_LENGTH = 200;
export const MAX_BOT_WALLPAPERS = 1000;

export function isBotWallpaperKey(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_BOT_ID_LENGTH && !/[\u0000-\u001f]/.test(value);
}

export function normalizeBotWallpaperMap(raw: unknown): BotWallpaperMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: [string, string][] = [];
  for (const [botId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length >= MAX_BOT_WALLPAPERS) break;
    const url = normalizeCustomWallpaperUrl(value);
    if (isBotWallpaperKey(botId) && url) out.push([botId, url]);
  }
  // fromEntries defines own properties, so an ID such as "__proto__" stays plain data.
  return Object.fromEntries(out);
}
