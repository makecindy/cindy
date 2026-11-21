/**
 * useUserPrompt — React 包装，订阅 userPromptStore 的变化。
 *
 * 真正的 storage 实现在 lib/userPromptStore.ts，本 hook 只负责把它接入 React 状态。
 * 非 React 路径（如 ChatInput 启 session 时透传）应直接用 store 的 getUserPrompt()，
 * 避免无谓的 hook context 依赖。
 */

import { useCallback, useSyncExternalStore } from 'react';

import {
  getUserPrompt,
  setUserPrompt,
  subscribeUserPrompt,
} from '@/lib/userPromptStore';

export function useUserPrompt(): {
  value: string;
  setValue: (next: string) => void;
} {
  const value = useSyncExternalStore(subscribeUserPrompt, getUserPrompt);

  const setValue = useCallback((next: string) => {
    setUserPrompt(next);
    // 走 store.setUserPrompt 之后，subscribe 回调会更新本地 state，
    // 这里不重复 setValueState。
  }, []);

  return { value, setValue };
}
