/**
 * Teammate-wide preferences (Settings › 伙伴).
 *
 * These are *how you get told*, not *what a teammate is*: banner, sound, quiet
 * hours. They are app-level and local, so they follow the same localStorage +
 * `storage` event shape as `useNotificationSettings` rather than inventing a
 * second preference mechanism.
 *
 * Scope note (deliberate): the desktop notification master switch stays where it
 * is — this section does not shadow it. A teammate that watches task activity by
 * itself (阿枢/本本) is expressing a capability, not a notification setting; that
 * lives in its own Settings, and the footnote in the UI says so.
 */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'cindy.bots.preferences.v1';

export interface BotPreferences {
  /** Banner toast when a teammate says something while you are elsewhere. */
  banner: boolean;
  /** Sound with that banner. */
  sound: boolean;
  /** Quiet hours, `HH:MM-HH:MM`. Not editable yet — displayed as the default. */
  quietHours: string;
}

export const DEFAULT_BOT_PREFERENCES: BotPreferences = {
  banner: true,
  sound: false,
  quietHours: '22:00-08:00',
};

/**
 * 「22:00 – 08:00」。
 *
 * 存的仍然是机器形状 `HH:MM-HH:MM`（半角连字符，将来要解析的就是它）；给人看的那一
 * 行用 en dash + 两侧空格 —— `22:00-08:00` 里的半角连字符在两个时间中间读起来像减号。
 * 只做展示层转换，不动存储格式。
 */
export function formatQuietHours(value: string): string {
  const match = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(value.trim());
  return match ? `${match[1]} – ${match[2]}` : value;
}

export function readBotPreferences(): BotPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_BOT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BOT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<BotPreferences> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_BOT_PREFERENCES };
    return {
      banner: typeof parsed.banner === 'boolean' ? parsed.banner : DEFAULT_BOT_PREFERENCES.banner,
      sound: typeof parsed.sound === 'boolean' ? parsed.sound : DEFAULT_BOT_PREFERENCES.sound,
      quietHours:
        typeof parsed.quietHours === 'string' && parsed.quietHours
          ? parsed.quietHours
          : DEFAULT_BOT_PREFERENCES.quietHours,
    };
  } catch {
    return { ...DEFAULT_BOT_PREFERENCES };
  }
}

export function writeBotPreferences(next: BotPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the in-memory value still drives the UI.
  }
}

export function useBotPreferences(): {
  preferences: BotPreferences;
  setPreference: <K extends keyof BotPreferences>(key: K, value: BotPreferences[K]) => void;
} {
  const [preferences, setPreferences] = useState<BotPreferences>(readBotPreferences);

  const setPreference = useCallback(
    <K extends keyof BotPreferences>(key: K, value: BotPreferences[K]) => {
      setPreferences((current) => {
        const next = { ...current, [key]: value };
        writeBotPreferences(next);
        return next;
      });
    },
    [],
  );

  // Cross-instance sync, same as the desktop notification switch.
  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      setPreferences(readBotPreferences());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return { preferences, setPreference };
}
