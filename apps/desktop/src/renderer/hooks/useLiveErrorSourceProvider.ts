/**
 * useLiveErrorSourceProvider —— live 错误的「来源 provider」快照。
 *
 * 语义:错误**出现的那一刻**记下当时的 session provider,错误存续期间用户切换
 * provider 不跟随 —— 余额分类必须绑错误发生时的来源(ErrorBanner 的
 * errorSourceProviderId),否则「xd 报余额不足 → 切到 OpenAI」会丢充值入口,
 * 「OpenAI 报配额 → 切到 xd」会误挂 Cindy AI 充值入口。
 *
 * **任务身份是快照边界的一部分**:同一个 `:sessionId` 路由复用同一个组件实例,
 * 只跟 error 文本走的快照会在「两个任务恰好有相同错误文本」时沿用上一任务的
 * 来源(deps 相等,effect 不重跑),把错误引向错误的充值入口。所以 sessionId
 * 变化时必须重新取值;同一任务同一条错误存续期间仍保持稳定。
 *
 * currentProviderId 刻意不进 deps:那正是「快照」与「跟随」的分界。
 */

import { useEffect, useState } from 'react';

export function useLiveErrorSourceProvider(
  error: string | null,
  sessionId: string | null | undefined,
  currentProviderId: string | null,
): string | null {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  useEffect(() => {
    if (error) setSnapshot(currentProviderId);
    else setSnapshot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 快照语义:只在错误出现/消失或任务切换时取值,provider 变化不跟随
  }, [error, sessionId]);
  return snapshot;
}
