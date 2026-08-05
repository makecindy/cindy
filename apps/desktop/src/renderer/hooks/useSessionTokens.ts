/**
 * useSessionTokens — 订阅当前 session 的"终身累计 token"。
 *
 * Codex 订阅模式没有 per-session USD 实报，tooltip 使用 token 累计辅助解释
 * 每条消息的价值估算。数据来源与 useSessionSpend 同形：session 初值 + main 推送。
 */

import { useEffect, useState } from 'react';

export function useSessionTokens(
  sessionId: string | undefined,
  initialTokens: number | null | undefined,
): number | null {
  const [tokens, setTokens] = useState<number | null>(
    typeof initialTokens === 'number' ? initialTokens : null,
  );

  useEffect(() => {
    setTokens(typeof initialTokens === 'number' ? initialTokens : null);
  }, [sessionId, initialTokens]);

  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = window.electronAPI.onUsageSessionTokensChanged?.((res) => {
      if (res.sessionId === sessionId) {
        setTokens(res.totalTokens);
      }
    });
    return unsubscribe;
  }, [sessionId]);

  return tokens;
}
