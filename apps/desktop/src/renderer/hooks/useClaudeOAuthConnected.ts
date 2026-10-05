import { useEffect, useState } from 'react';

/**
 * useClaudeOAuthConnected — Claude.ai 订阅 OAuth 的连接态(TodaySpendChip 计费形态判定用)。
 *
 * 返回 null = 尚未读到(mount 后首次 IPC 未返回 / enabled=false), true/false = 已确认。
 * mount 时经 claudeOAuthStatus 读一次(main 侧 = hasClaudeNativeLogin), 此后跟随
 * AUTH_STATE_CHANGED(agentKind='claude-code')push 重查 —— Settings 登录 / 登出后
 * main 会广播。push payload 的 authenticated 是「OAuth 或网关 key」的复合态, 不能直接
 * 当 OAuth 连接态用, 所以收到 push 后重查专用 status 端点(push 频率 = 用户登录/登出,
 * 重查成本可忽略)。
 */
export function useClaudeOAuthConnected(enabled: boolean): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const query = () => {
      void window.electronAPI.maker
        .claudeOAuthStatus()
        .then((r) => {
          if (!cancelled) setConnected(r.authorized);
        })
        .catch(() => {
          /* 读不到保持现值(初始 null=形态未定), 不误判计费形态 */
        });
    };
    query();
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== 'claude-code') return;
      query();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled]);

  return connected;
}
