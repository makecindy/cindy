/**
 * useLinkOpenPreference — 消息流左键的"默认打开方式"偏好。
 * ---------------------------------------------------------------------------
 * 拆成两个互不影响的开关(设置 → 个性化 → 链接打开方式):
 *   - web   外部网页。默认 'external'(系统默认浏览器)。
 *   - local 内部网页:本地硬盘 HTML 与本机地址(localhost / loopback)。
 *           默认 'sidebar'(内置侧边栏浏览器)。
 *
 * 规则 20:localStorage 只存 override。选回该开关当前系统默认时**删除**
 * 对应 key,未自定义的用户跟随新版本默认值;isCustomized 即"存在 override"。
 *
 * 旧单 key `chat.linkOpenPreference` 的一次性迁移基于"是否自定义":
 * key 仍在 = 用户对旧统一开关做过选择。把该显式选择写到新开关上**仅当**
 * 它不同于新默认;等于新默认的不落盘。不根据旧值猜测意图。
 *
 * 模块级内存 SoT + `storage` 事件跨窗口同步。消息流点击 handler 走同步读
 * getLinkOpenPreference / getLinkOpenPreferenceForUrl,不需要订阅重渲。
 */

import { useCallback, useEffect, useState } from 'react';

export type LinkOpenPreference = 'sidebar' | 'external';
export type LinkOpenKind = 'web' | 'local';

const LEGACY_STORAGE_KEY = 'chat.linkOpenPreference';

const STORAGE_KEYS: Record<LinkOpenKind, string> = {
  web: 'chat.webLinkOpenPreference',
  local: 'chat.localLinkOpenPreference',
};

export const LINK_OPEN_DEFAULTS: Record<LinkOpenKind, LinkOpenPreference> = {
  web: 'external',
  local: 'sidebar',
};

function parsePreference(raw: string | null): LinkOpenPreference | null {
  return raw === 'sidebar' || raw === 'external' ? raw : null;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isIPv4Loopback(host: string): boolean {
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

/** 本地硬盘(file:)或本机 loopback(localhost / 127/8 / ::1)。不含局域网地址。 */
export function isLocalOpenUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = hostnameOf(parsed);
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '::1') return true;
    return isIPv4Loopback(host);
  } catch {
    return false;
  }
}

/** 模块级内存 SoT;null = 尚未被本窗口读定/写定。 */
const memoryValue: Record<LinkOpenKind, LinkOpenPreference | null> = {
  web: null,
  local: null,
};

let legacyMigrated = false;

function migrateLegacyIfNeeded(): void {
  if (legacyMigrated) return;
  legacyMigrated = true;
  try {
    const legacy = parsePreference(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (!legacy) return;
    (['web', 'local'] as const).forEach((kind) => {
      if (localStorage.getItem(STORAGE_KEYS[kind])) return;
      if (legacy !== LINK_OPEN_DEFAULTS[kind]) {
        localStorage.setItem(STORAGE_KEYS[kind], legacy);
      }
    });
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // localStorage 不可用——保持新默认,不落定内存。
  }
}

function clearDefaultOverride(kind: LinkOpenKind): void {
  try {
    localStorage.removeItem(STORAGE_KEYS[kind]);
  } catch {
    // localStorage 不可用——保留内存中的默认值即可。
  }
}

/** 同步读——给消息流点击 handler 等非 hook 路径用。 */
export function getLinkOpenPreference(kind: LinkOpenKind): LinkOpenPreference {
  migrateLegacyIfNeeded();
  if (memoryValue[kind] !== null) return memoryValue[kind];
  try {
    const parsed = parsePreference(localStorage.getItem(STORAGE_KEYS[kind]));
    if (parsed === LINK_OPEN_DEFAULTS[kind]) {
      // 清掉误写入的默认值,避免阻断未来默认值迁移。
      clearDefaultOverride(kind);
      return (memoryValue[kind] = parsed);
    }
    if (parsed) return (memoryValue[kind] = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return LINK_OPEN_DEFAULTS[kind];
}

export function getLinkOpenPreferenceForUrl(url: string): LinkOpenPreference {
  return getLinkOpenPreference(isLocalOpenUrl(url) ? 'local' : 'web');
}

const listeners = new Set<() => void>();

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

export function useLinkOpenPreference(kind: LinkOpenKind): {
  preference: LinkOpenPreference;
  /** 是否存在用户 override(≠ 该开关当前系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setPreference: (next: LinkOpenPreference) => void;
} {
  const [preference, setState] = useState<LinkOpenPreference>(() => getLinkOpenPreference(kind));

  const setPreference = useCallback(
    (next: LinkOpenPreference) => {
      memoryValue[kind] = next;
      setState(next);
      try {
        if (next === LINK_OPEN_DEFAULTS[kind]) {
          localStorage.removeItem(STORAGE_KEYS[kind]);
        } else {
          localStorage.setItem(STORAGE_KEYS[kind], next);
        }
      } catch {
        // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
      }
      notifyListeners();
    },
    [kind],
  );

  useEffect(() => {
    const sync = () => setState(getLinkOpenPreference(kind));
    listeners.add(sync);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.web) {
        memoryValue.web = parsePreference(e.newValue) ?? LINK_OPEN_DEFAULTS.web;
        notifyListeners();
        return;
      }
      if (e.key === STORAGE_KEYS.local) {
        memoryValue.local = parsePreference(e.newValue) ?? LINK_OPEN_DEFAULTS.local;
        notifyListeners();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, [kind]);

  return {
    preference,
    isCustomized: preference !== LINK_OPEN_DEFAULTS[kind],
    setPreference,
  };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetLinkOpenPreferenceForTests(): void {
  memoryValue.web = null;
  memoryValue.local = null;
  legacyMigrated = false;
  listeners.clear();
}
