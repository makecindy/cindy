export const DESKTOP_COMPANION_GET_STATE_CHANNEL = 'desktop-companion:get-state';
export const DESKTOP_COMPANION_SET_ENABLED_CHANNEL = 'desktop-companion:set-enabled';
export const DESKTOP_COMPANION_SET_LOCATION_ENABLED_CHANNEL = 'desktop-companion:set-location-enabled';
export const DESKTOP_COMPANION_REFRESH_CHANNEL = 'desktop-companion:refresh';
export const DESKTOP_COMPANION_STATE_EVENT_CHANNEL = 'desktop-companion:state';
export const DESKTOP_COMPANION_GET_PREVIEW_CHANNEL = 'desktop-companion:get-preview';

export const DESKTOP_COMPANION_REUSE_MS = 6 * 60 * 60 * 1000;
export const DESKTOP_COMPANION_TICK_MS = 60 * 60 * 1000;
export const DESKTOP_COMPANION_TASK_WINDOW_MS = 60 * 60 * 1000;

export type DesktopCompanionTimeSlot = 'morning' | 'noon' | 'dusk' | 'night';
export type DesktopCompanionCharacterMode = 'together' | 'companion';
export type DesktopCompanionStatus = 'idle' | 'generating' | 'ready' | 'error';

export interface DesktopCompanionSettings {
  enabled: boolean;
  locationEnabled: boolean;
}

export const DEFAULT_DESKTOP_COMPANION_SETTINGS: DesktopCompanionSettings = {
  enabled: false,
  locationEnabled: false,
};

export interface DesktopCompanionReuseItem {
  fingerprint: string;
  stillPath: string;
  videoPath: string | null;
  topic: string;
  expiresAt: number;
}

export interface DesktopCompanionSnapshot {
  supported: boolean;
  enabled: boolean;
  locationEnabled: boolean;
  status: DesktopCompanionStatus;
  lastTopic: string | null;
  lastUpdatedAt: number | null;
  lastError: string | null;
  previewSrc: string | null;
  imageReady: boolean;
  videoReady: boolean;
}

export function normalizeDesktopCompanionSettings(raw: unknown): DesktopCompanionSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DESKTOP_COMPANION_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    locationEnabled: record.locationEnabled === true,
  };
}

export function isDesktopCompanionSupportedPlatform(platform: string | undefined): boolean {
  return platform === 'darwin';
}
