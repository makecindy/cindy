/**
 * useSwallowActivationClickSettings — Windows 后台窗口首次左键点击是否吞掉的开关。
 * ---------------------------------------------------------------------------
 * PR #446 在 Windows 上补齐了 macOS `acceptFirstMouse: false` 的等效体验:后台窗
 * 口被左键单击激活时,那一下点击只把窗口带到前台、不透传给页面元素,避免误触。
 * 绝大多数用户受益,但双屏用户切回时会觉得"要点两次才能操作",故加此开关允许
 * 用户按自己习惯关闭。
 *
 * 存储 & 同步策略沿用 useNotificationSettings 的模式:localStorage 单键 + storage
 * 事件跨实例同步 + 独立 getter 供非 hook 路径使用(index.tsx 里 DOM adapter 的
 * 事件回调是同步路径,不走 React,必须用 getter 而非 hook state)。
 *
 * 默认 false —— 首次点击直接透传,双屏使用时一次点击即可继续操作。用户如果
 * 明确要防误触可自行开启。注意这是相对 PR #446 / macOS 原生 acceptFirstMouse:
 * false 的**行为变更**:Windows 用户升级后不再自动吞后台激活点击,macOS 端下
 * 次启动创建 BrowserWindow 时也会以 `acceptFirstMouse: true` 建窗。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

const STORAGE_KEY = 'input.swallowActivationClick';
const DEFAULT_ENABLED = false;

/** 同步读 localStorage——DOM adapter 的事件回调用它。坏数据当默认值。 */
export function getSwallowActivationClickEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // localStorage 不可用——退回默认。
  }
  return DEFAULT_ENABLED;
}

export function useSwallowActivationClickSettings(): {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(getSwallowActivationClickEnabled);

  const request = useRef(0);
  const setEnabled = useCallback((next: boolean) => {
    const sequence = ++request.current;
    const apply = () => {
      if (sequence !== request.current) return;
      setEnabledState(next);
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* State still reflects Main's confirmed value. */ }
    };
    const saved = window.electronAPI?.windowBehavior?.setSwallowActivationClick?.(next);
    if (!saved) {
      apply();
      return;
    }
    void saved.then(apply, error => {
      if (sequence === request.current) {
        toast.error(i18n.t(mapIpcErrorToI18nKey(error, { fallback: 'ipcError.INTERNAL' })));
      }
    });
  }, []);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setEnabledState(getSwallowActivationClickEnabled());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  return { enabled, setEnabled };
}
