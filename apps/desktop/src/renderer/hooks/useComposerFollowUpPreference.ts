/**
 * useComposerFollowUpPreference — 任务运行中发送消息的默认投递方式。
 * ---------------------------------------------------------------------------
 *   - queue 排队：消息排在当前轮之后发出（默认）。
 *   - steer 插话：消息并入正在运行的这一轮，不打断。
 *
 * 与「发送快捷键」是两件事：快捷键决定按什么键发送，本偏好决定运行中发出去的是
 * 排队还是插话。空闲时的正常发送不受影响。
 *
 * 规则 20：localStorage 只存 override，选回默认（queue）即删除 key；未知值回落默认。
 * `chat.followUpBehavior` 与 appPreferenceControl / 迁移助理白名单共用同一个键。
 * 模块级内存是事件处理函数的同步真相源，`storage` 事件负责跨窗口同步。
 * 发送键悬停提示（SendDeliveryTip）里的「对调」写的也是这个偏好，与设置页同步。
 */

import { useCallback, useEffect, useState } from 'react';

export type ComposerFollowUpBehavior = 'queue' | 'steer';

export const COMPOSER_FOLLOW_UP_STORAGE_KEY = 'chat.followUpBehavior';
export const DEFAULT_COMPOSER_FOLLOW_UP: ComposerFollowUpBehavior = 'queue';

function parseBehavior(raw: string | null): ComposerFollowUpBehavior | null {
  return raw === 'steer' || raw === 'queue' ? raw : null;
}

let memoryValue: ComposerFollowUpBehavior | null = null;
const listeners = new Set<() => void>();

export function getComposerFollowUpBehavior(): ComposerFollowUpBehavior {
  if (memoryValue !== null) return memoryValue;
  try {
    const parsed = parseBehavior(localStorage.getItem(COMPOSER_FOLLOW_UP_STORAGE_KEY));
    if (parsed) return (memoryValue = parsed);
  } catch {
    // localStorage may be unavailable in a restricted renderer.
  }
  return DEFAULT_COMPOSER_FOLLOW_UP;
}

export function useComposerFollowUpPreference(): {
  preference: ComposerFollowUpBehavior;
  /** 是否存在用户 override（≠ 默认）。设置页据此显示「恢复默认」。 */
  isCustomized: boolean;
  setPreference: (next: ComposerFollowUpBehavior) => void;
} {
  const [preference, setState] = useState<ComposerFollowUpBehavior>(getComposerFollowUpBehavior);

  const setPreference = useCallback((next: ComposerFollowUpBehavior) => {
    memoryValue = next;
    setState(next);
    try {
      if (next === DEFAULT_COMPOSER_FOLLOW_UP) {
        localStorage.removeItem(COMPOSER_FOLLOW_UP_STORAGE_KEY);
      } else {
        localStorage.setItem(COMPOSER_FOLLOW_UP_STORAGE_KEY, next);
      }
    } catch {
      // The in-memory value still applies for this renderer.
    }
    listeners.forEach((fn) => fn());
  }, []);

  useEffect(() => {
    const sync = () => setState(getComposerFollowUpBehavior());
    listeners.add(sync);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== COMPOSER_FOLLOW_UP_STORAGE_KEY) return;
      memoryValue = parseBehavior(event.newValue) ?? DEFAULT_COMPOSER_FOLLOW_UP;
      listeners.forEach((fn) => fn());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return {
    preference,
    isCustomized: preference !== DEFAULT_COMPOSER_FOLLOW_UP,
    setPreference,
  };
}

/** Test-only reset for the module-level sources of truth. */
export function _resetComposerFollowUpPreferenceForTests(): void {
  memoryValue = null;
  listeners.clear();
}
