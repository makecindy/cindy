/**
 * 伙伴外观：每位伙伴可以有自己的主题和壁纸，打开它的对话时整窗换上，离开时回到全局外观。
 *
 * - 只存在本机 renderer localStorage（`bots.appearance`），与全局主题的 `theme.familyId`
 *   同一层；不进伙伴资料、数据库或跨端协议，也不改 `appearance-settings.json`。
 * - 只记录用户显式选择（override）；没有记录 = 跟随全局。选「跟随全局」删除该项。
 * - 主题指向的本地主题被删掉时，应用侧按无效 ID 回落全局，不改写这里的记录。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { WALLPAPER_IDS, type WallpaperId } from '@/../shared/appearanceSettings';
import { setAppearanceOverride } from '@/appearance/appearanceOverride';

export const BOT_APPEARANCE_STORAGE_KEY = 'bots.appearance';

/** 自定义图片走全局壁纸的导入与存放流程，伙伴外观只提供内置壁纸和「无」。 */
export type BotWallpaperId = Exclude<WallpaperId, 'custom'>;

export interface BotAppearance {
  familyId?: string;
  wallpaperId?: BotWallpaperId;
}

type BotAppearanceMap = Record<string, BotAppearance>;

const EMPTY: BotAppearance = Object.freeze({});
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedMap: BotAppearanceMap = {};
/**
 * Set only after a write fails (storage full or unavailable): this window keeps the
 * new choice until a later write succeeds, instead of re-reading the stale stored value.
 */
let unsavedMap: BotAppearanceMap | null = null;

export function isBotWallpaperId(value: unknown): value is BotWallpaperId {
  return typeof value === 'string' && value !== 'custom' && (WALLPAPER_IDS as readonly string[]).includes(value);
}

function parse(raw: string | null): BotAppearanceMap {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: BotAppearanceMap = {};
  for (const [botId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { familyId, wallpaperId } = entry as Record<string, unknown>;
    const next: BotAppearance = {};
    if (typeof familyId === 'string' && familyId) next.familyId = familyId;
    if (isBotWallpaperId(wallpaperId)) next.wallpaperId = wallpaperId;
    if (next.familyId !== undefined || next.wallpaperId !== undefined) out[botId] = Object.freeze(next);
  }
  return out;
}

function readMap(): BotAppearanceMap {
  if (unsavedMap) return unsavedMap;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BOT_APPEARANCE_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMap = parse(raw);
  }
  return cachedMap;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function getBotAppearance(botId: string | null | undefined): BotAppearance {
  if (!botId) return EMPTY;
  return readMap()[botId] ?? EMPTY;
}

/** `null` 表示回到「跟随全局」，删除对应字段。 */
export function setBotAppearance(
  botId: string,
  patch: { familyId?: string | null; wallpaperId?: BotWallpaperId | null },
): void {
  const map = { ...readMap() };
  const next: BotAppearance = { ...map[botId] };
  if (patch.familyId !== undefined) {
    if (patch.familyId) next.familyId = patch.familyId;
    else delete next.familyId;
  }
  if (patch.wallpaperId !== undefined) {
    if (patch.wallpaperId && isBotWallpaperId(patch.wallpaperId)) next.wallpaperId = patch.wallpaperId;
    else delete next.wallpaperId;
  }
  if (next.familyId === undefined && next.wallpaperId === undefined) delete map[botId];
  else map[botId] = next;
  const parsed = parse(JSON.stringify(map));
  try {
    if (Object.keys(map).length) localStorage.setItem(BOT_APPEARANCE_STORAGE_KEY, JSON.stringify(map));
    else localStorage.removeItem(BOT_APPEARANCE_STORAGE_KEY);
    unsavedMap = null;
  } catch {
    // localStorage may be full or unavailable; keep the choice for this window only.
    unsavedMap = parsed;
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other windows (and DevTools) write through the storage event.
  const onStorage = (event: StorageEvent) => {
    if (event.key === BOT_APPEARANCE_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useBotAppearance(botId: string | null | undefined): BotAppearance {
  return useSyncExternalStore(subscribe, () => getBotAppearance(botId));
}

/**
 * 当前视图属于某位伙伴时整窗换上它的外观；`botId` 为 null（离开、失焦的分屏面板）时
 * 释放，窗口回到全局主题与壁纸。
 */
export function useBotAppearanceOverride(botId: string | null): void {
  const owner = useRef(Symbol('bot-appearance')).current;
  const appearance = useBotAppearance(botId);
  useEffect(() => {
    setAppearanceOverride(owner, botId ? appearance : null);
  }, [owner, botId, appearance]);
  useEffect(() => () => setAppearanceOverride(owner, null), [owner]);
}

export function __resetBotAppearanceCacheForTest(): void {
  cachedRaw = undefined;
  cachedMap = {};
  unsavedMap = null;
  listeners.clear();
}
