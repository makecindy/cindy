/**
 * useStreamFadePreference — 流式输出淡入动效的开关偏好(Settings → 个性化)。
 * ---------------------------------------------------------------------------
 * 两态,默认开启(2026-08-11 裁决):
 *   - 'on'   流式输出时新内容淡入浮现(逐词 + 列表圆点,rehypeStreamWordFade)。
 *   - 'off'  关闭动效,文字直接显示。
 *
 * 规则 20(配置默认值 vs override)落法:localStorage 只存 override——
 * 用户切回 'on'(= 当前系统默认)时**删除** key 而不是写入,未自定义的用户
 * 未来自动跟随新版本默认值;isCustomized 即 "存在 override"。
 *
 * 模块级内存值做跨实例 SoT + `storage` 事件跨窗口同步,模式与
 * useLinkOpenPreference 完全一致。MarkdownRenderer 每条消息一个实例,走
 * 轻量订阅 hook useStreamFadeEnabled(listeners Set 回调,开销可忽略);
 * 切换即时生效 —— 正在流式的消息也会立刻挂上/摘掉插件。
 *
 * 注意:这是动效偏好,不是 reduced-motion 的替代 —— 系统 reduced-motion
 * 仍然无条件短路(MarkdownRenderer 侧与本开关取 AND)。
 */

import { useCallback, useEffect, useState } from 'react';

export type StreamFadePreference = 'on' | 'off';

const STORAGE_KEY = 'chat.streamFadePreference';
const DEFAULT_PREFERENCE: StreamFadePreference = 'on';

function parsePreference(raw: string | null): StreamFadePreference | null {
  return raw === 'on' || raw === 'off' ? raw : null;
}

function clearDefaultOverride(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage 不可用——保留内存中的默认值即可。
  }
}

/** 模块级内存 SoT;null = 尚未被本窗口读定/写定。 */
let memoryValue: StreamFadePreference | null = null;

/** 同步读——非 hook 路径用。 */
export function getStreamFadePreference(): StreamFadePreference {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parsePreference(localStorage.getItem(STORAGE_KEY));
    if (parsed === DEFAULT_PREFERENCE) {
      // 清理旧版本留下的默认值 override，避免它阻断未来默认值迁移。
      clearDefaultOverride();
      return (memoryValue = DEFAULT_PREFERENCE);
    }
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage 不可用——退回默认(不落定内存,留待后续写入)。
  }
  return DEFAULT_PREFERENCE;
}

const listeners = new Set<() => void>();
let storageSubscribed = false;

function notifyListeners(): void {
  listeners.forEach((fn) => fn());
}

function onStorage(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY) return;
  const parsed = parsePreference(e.newValue);
  if (parsed === DEFAULT_PREFERENCE) clearDefaultOverride();
  memoryValue = parsed ?? DEFAULT_PREFERENCE;
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageSubscribed) {
    window.addEventListener('storage', onStorage);
    storageSubscribed = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageSubscribed) {
      window.removeEventListener('storage', onStorage);
      storageSubscribed = false;
    }
  };
}

/** 消息渲染侧的轻量订阅:只关心 boolean,设置页切换后即时重渲。 */
export function useStreamFadeEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => getStreamFadePreference() === 'on');
  useEffect(() => {
    const sync = () => setEnabled(getStreamFadePreference() === 'on');
    return subscribe(sync);
  }, []);
  return enabled;
}

export function useStreamFadePreference(): {
  preference: StreamFadePreference;
  /** 是否存在用户 override(≠ 系统默认)。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setPreference: (next: StreamFadePreference) => void;
} {
  const [preference, setState] = useState<StreamFadePreference>(getStreamFadePreference);

  const setPreference = useCallback((next: StreamFadePreference) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_PREFERENCE) {
        // 切回默认 = 清除 override(而非写入默认值快照)。
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // localStorage 不可用——内存 SoT 已生效;仅跨窗口同步缺失。
    }
    notifyListeners();
  }, []);

  useEffect(() => {
    const sync = () => setState(getStreamFadePreference());
    return subscribe(sync);
  }, []);

  return { preference, isCustomized: preference !== DEFAULT_PREFERENCE, setPreference };
}

/** 测试专用:清空内存 SoT,让下一次读回落 localStorage / 默认值。 */
export function _resetStreamFadePreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
  if (storageSubscribed) {
    window.removeEventListener('storage', onStorage);
    storageSubscribed = false;
  }
}
