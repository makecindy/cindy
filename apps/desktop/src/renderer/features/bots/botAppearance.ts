/**
 * 伙伴外观：每位伙伴可以有自己的主题和壁纸，打开它的对话时整窗换上，离开时回到全局外观。
 *
 * - 只存在本机 renderer localStorage（`bots.appearance`），与全局主题的 `theme.familyId`
 *   同一层；不进伙伴资料、数据库或跨端协议，也不改 `appearance-settings.json`。
 * - 只记录用户显式选择（override）；没有记录 = 跟随全局。选「跟随全局」删除该项。
 * - 主题指向的本地主题被删掉时，应用侧按无效 ID 回落全局，不改写这里的记录。
 * - 自定义图片（`wallpaperId: 'custom'`）的媒体引用记在主进程 `bot-wallpapers.json`，
 *   与全局自定义壁纸共用媒体库和回收；这里只记「选了自定义」。图片缺失时按跟随全局显示。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { WALLPAPER_IDS, type WallpaperId } from '@/../shared/appearanceSettings';
import { setAppearanceOverride } from '@/appearance/appearanceOverride';

export const BOT_APPEARANCE_STORAGE_KEY = 'bots.appearance';

export type BotWallpaperId = WallpaperId;

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
  return typeof value === 'string' && (WALLPAPER_IDS as readonly string[]).includes(value);
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
  const out: [string, BotAppearance][] = [];
  for (const [botId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { familyId, wallpaperId } = entry as Record<string, unknown>;
    const next: BotAppearance = {};
    if (typeof familyId === 'string' && familyId) next.familyId = familyId;
    if (isBotWallpaperId(wallpaperId)) next.wallpaperId = wallpaperId;
    if (next.familyId !== undefined || next.wallpaperId !== undefined) out.push([botId, Object.freeze(next)]);
  }
  // fromEntries defines own properties, so an ID such as "__proto__" stays plain data.
  return Object.fromEntries(out);
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
  const map = readMap();
  return Object.hasOwn(map, botId) ? map[botId]! : EMPTY;
}

/** `null` 表示回到「跟随全局」，删除对应字段。 */
export function setBotAppearance(
  botId: string,
  patch: { familyId?: string | null; wallpaperId?: BotWallpaperId | null },
): void {
  const entries = new Map(Object.entries(readMap()));
  const next: BotAppearance = { ...entries.get(botId) };
  if (patch.familyId !== undefined) {
    if (patch.familyId) next.familyId = patch.familyId;
    else delete next.familyId;
  }
  if (patch.wallpaperId !== undefined) {
    if (patch.wallpaperId && isBotWallpaperId(patch.wallpaperId)) next.wallpaperId = patch.wallpaperId;
    else delete next.wallpaperId;
  }
  if (next.familyId === undefined && next.wallpaperId === undefined) entries.delete(botId);
  else entries.set(botId, next);
  const raw = JSON.stringify(Object.fromEntries(entries));
  const parsed = parse(raw);
  try {
    if (entries.size) localStorage.setItem(BOT_APPEARANCE_STORAGE_KEY, raw);
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

// ── 伙伴自定义壁纸（主进程持有引用）──────────────────────────────────────────

const EMPTY_URLS: Readonly<Record<string, string>> = Object.freeze({});
let customUrls: Readonly<Record<string, string>> = EMPTY_URLS;
let customUrlsLoaded = false;
const customUrlListeners = new Set<() => void>();
let stopCustomUrlBridge: (() => void) | null = null;

function setCustomUrls(next: Record<string, string> | null | undefined): void {
  if (!next || typeof next !== 'object') return;
  customUrls = Object.freeze(Object.fromEntries(Object.entries(next)));
  for (const listener of [...customUrlListeners]) listener();
}

function subscribeCustomUrls(listener: () => void): () => void {
  customUrlListeners.add(listener);
  const bridge = typeof window !== 'undefined' ? window.electronAPI?.appearanceSettings : undefined;
  if (!stopCustomUrlBridge && bridge?.onBotWallpapersChanged) {
    stopCustomUrlBridge = bridge.onBotWallpapersChanged(setCustomUrls);
  }
  if (!customUrlsLoaded && bridge?.getBotWallpapers) {
    customUrlsLoaded = true;
    void bridge.getBotWallpapers().then(setCustomUrls, () => {
      customUrlsLoaded = false;
    });
  }
  return () => {
    customUrlListeners.delete(listener);
    if (!customUrlListeners.size && stopCustomUrlBridge) {
      stopCustomUrlBridge();
      stopCustomUrlBridge = null;
      // Changes made while nobody listened are picked up on the next subscription.
      customUrlsLoaded = false;
    }
  };
}

/** 这位伙伴自己的图片或视频；没有时为 null。 */
export function useBotCustomWallpaperUrl(botId: string | null | undefined): string | null {
  return useSyncExternalStore(subscribeCustomUrls, () => (botId && Object.hasOwn(customUrls, botId) ? customUrls[botId]! : null));
}

/** 打开系统文件选择器，为这位伙伴导入图片或视频；取消返回 false。 */
export async function importBotCustomWallpaper(botId: string): Promise<boolean> {
  const bridge = window.electronAPI?.appearanceSettings;
  if (!bridge?.importBotWallpaper) return false;
  const next = await bridge.importBotWallpaper(botId);
  if (!next) return false;
  setCustomUrls(next);
  return true;
}

export async function removeBotCustomWallpaper(botId: string): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.electronAPI?.appearanceSettings : undefined;
  if (!bridge?.removeBotWallpaper) return;
  setCustomUrls(await bridge.removeBotWallpaper(botId));
}

/**
 * 伙伴被删除后，清掉这台电脑上为它记下的外观：localStorage 记录和它的自定义壁纸引用。
 * 远程伙伴由它所在的电脑删除，但壁纸图片是在本机（控制端）导入、存在本机的，只能由本机清理。
 * 失败只影响残留，不影响删除结果，所以这里吞掉错误。
 */
export async function forgetBotAppearance(botId: string): Promise<void> {
  try {
    if (getBotAppearance(botId) !== EMPTY) setBotAppearance(botId, { familyId: null, wallpaperId: null });
  } catch {
    // localStorage may be unavailable
  }
  try {
    await removeBotCustomWallpaper(botId);
  } catch {
    // The reference stays; the media is kept rather than risked.
  }
}

/**
 * 当前视图属于某位伙伴时整窗换上它的外观；`botId` 为 null（离开、失焦的分屏面板）时
 * 释放，窗口回到全局主题与壁纸。
 */
export function useBotAppearanceOverride(botId: string | null): void {
  const owner = useRef(Symbol('bot-appearance')).current;
  const appearance = useBotAppearance(botId);
  const customUrl = useBotCustomWallpaperUrl(botId);
  useEffect(() => {
    if (!botId) {
      setAppearanceOverride(owner, null);
      return;
    }
    const { wallpaperId, ...rest } = appearance;
    // Custom without its media (not loaded yet, or removed) shows the global wallpaper.
    if (wallpaperId === 'custom') {
      setAppearanceOverride(owner, customUrl ? { ...rest, wallpaperId, customWallpaperUrl: customUrl } : rest);
    } else {
      setAppearanceOverride(owner, appearance);
    }
  }, [owner, botId, appearance, customUrl]);
  useEffect(() => () => setAppearanceOverride(owner, null), [owner]);
}

export function __resetBotAppearanceCacheForTest(): void {
  cachedRaw = undefined;
  cachedMap = {};
  unsavedMap = null;
  listeners.clear();
  customUrls = EMPTY_URLS;
  customUrlsLoaded = false;
  customUrlListeners.clear();
  stopCustomUrlBridge?.();
  stopCustomUrlBridge = null;
}
