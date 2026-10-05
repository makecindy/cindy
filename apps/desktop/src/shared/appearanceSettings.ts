import { DEFAULT_FONT_SIZES } from './generated/appearance-tokens';

/**
 * Desktop appearance preferences shared by main, preload and renderer.
 *
 * The persisted file contains only user overrides; callers normally consume
 * the effective snapshot returned by main.
 */

export interface AppearanceOverrides {
  uiFamily?: string;
  codeFamily?: string;
  uiSize?: number;
  codeSize?: number;
  windowZoom?: number;
  wallpaperId?: WallpaperId;
  wallpaperOverlay?: number;
  wallpaperMotion?: WallpaperMotion;
}

export type WallpaperMotion = 'static' | 'dynamic';

export interface AppearanceSettings {
  uiFamily: string;
  codeFamily: string;
  uiSize: number;
  codeSize: number;
  windowZoom: number;
  wallpaperId: WallpaperId;
  wallpaperOverlay: number;
  wallpaperMotion: WallpaperMotion;
  /** Read-only, host-owned media reference; never accepted by set-patch. */
  customWallpaperUrl?: string;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  uiFamily: '',
  codeFamily: '',
  uiSize: DEFAULT_FONT_SIZES.uiSize,
  codeSize: DEFAULT_FONT_SIZES.codeSize,
  windowZoom: 1,
  wallpaperId: 'none',
  wallpaperOverlay: 0.2,
  wallpaperMotion: 'static',
  customWallpaperUrl: '',
};

export const APPEARANCE_LIMITS = {
  uiSize: { min: 12, max: 24 },
  codeSize: { min: 10, max: 24 },
  windowZoom: { min: 0.5, max: 3, step: 0.1 },
  wallpaperOverlay: { min: 0, max: 0.6, step: 0.05 },
} as const;

export const WALLPAPER_IDS = [
  'none',
  'cindy-window',
  'cindy-studio',
  'cindy-dream',
  'custom',
] as const;
export type WallpaperId = (typeof WALLPAPER_IDS)[number];

export function normalizeCustomWallpaperUrl(value: unknown): string {
  return typeof value === 'string' && /^cindy-media:\/\/client-wallpaper\/[0-9a-f]{64}\.webp$/.test(value)
    ? value
    : '';
}

export function clampAppearanceWallpaperOverlay(
  value: number,
  fallback = DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay,
): number {
  if (!Number.isFinite(value)) return fallback;
  const stepped =
    Math.round(value / APPEARANCE_LIMITS.wallpaperOverlay.step) *
    APPEARANCE_LIMITS.wallpaperOverlay.step;
  return roundDecimal(
    Math.min(
      APPEARANCE_LIMITS.wallpaperOverlay.max,
      Math.max(APPEARANCE_LIMITS.wallpaperOverlay.min, stepped),
    ),
    2,
  );
}

export function clampAppearanceUiSize(
  value: number,
  fallback = DEFAULT_APPEARANCE_SETTINGS.uiSize,
): number {
  return clampInteger(value, APPEARANCE_LIMITS.uiSize.min, APPEARANCE_LIMITS.uiSize.max, fallback);
}

export function clampAppearanceCodeSize(
  value: number,
  fallback = DEFAULT_APPEARANCE_SETTINGS.codeSize,
): number {
  return clampInteger(
    value,
    APPEARANCE_LIMITS.codeSize.min,
    APPEARANCE_LIMITS.codeSize.max,
    fallback,
  );
}

export function clampAppearanceWindowZoom(
  value: number,
  fallback = DEFAULT_APPEARANCE_SETTINGS.windowZoom,
): number {
  if (!Number.isFinite(value)) return fallback;
  const stepped =
    Math.round(value / APPEARANCE_LIMITS.windowZoom.step) * APPEARANCE_LIMITS.windowZoom.step;
  return roundDecimal(
    Math.min(APPEARANCE_LIMITS.windowZoom.max, Math.max(APPEARANCE_LIMITS.windowZoom.min, stepped)),
    2,
  );
}

export function normalizeAppearanceSettings(raw: unknown): AppearanceSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_APPEARANCE_SETTINGS };
  }
  const value = raw as Record<string, unknown>;
  return {
    uiFamily: normalizeFamily(value.uiFamily),
    codeFamily: normalizeFamily(value.codeFamily),
    uiSize:
      typeof value.uiSize === 'number'
        ? clampAppearanceUiSize(value.uiSize)
        : DEFAULT_APPEARANCE_SETTINGS.uiSize,
    codeSize:
      typeof value.codeSize === 'number'
        ? clampAppearanceCodeSize(value.codeSize)
        : DEFAULT_APPEARANCE_SETTINGS.codeSize,
    windowZoom:
      typeof value.windowZoom === 'number'
        ? clampAppearanceWindowZoom(value.windowZoom)
        : DEFAULT_APPEARANCE_SETTINGS.windowZoom,
    wallpaperId: normalizeWallpaperId(value.wallpaperId),
    wallpaperOverlay:
      typeof value.wallpaperOverlay === 'number'
        ? clampAppearanceWallpaperOverlay(value.wallpaperOverlay)
        : DEFAULT_APPEARANCE_SETTINGS.wallpaperOverlay,
    wallpaperMotion: value.wallpaperMotion === 'dynamic' ? 'dynamic' : 'static',
    customWallpaperUrl: normalizeCustomWallpaperUrl(value.customWallpaperUrl),
  };
}

function normalizeWallpaperId(value: unknown): WallpaperId {
  return typeof value === 'string' && (WALLPAPER_IDS as readonly string[]).includes(value)
    ? (value as WallpaperId)
    : (DEFAULT_APPEARANCE_SETTINGS.wallpaperId as WallpaperId);
}

function normalizeFamily(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 256) : '';
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function roundDecimal(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
