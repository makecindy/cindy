/**
 * useVendorReadiness — M33: Vendor 就绪状态 hook（F7-mini）
 * ---------------------------------------------------------------------------
 * 输出统一的 Readiness 枚举。判定分两条**正交**的轴：
 *
 *   1. 有没有可用来源（与 agent 类型无关，唯一真相）：
 *        connectedProvidersForAgent(providers, agent).length > 0 → 'ready' | 'unauthenticated'
 *      cc 由 XD 网关 key / claude.ai 订阅满足；codex 由 codex OAuth / XD key 满足 —— 同一条规则，
 *      与 useConnectedSource（渲染期空態判定）同源，这里在 send 门禁时刻现拉一次避免 stale。
 *   2. 运行时前提（仅 codex）：本地二进制缺失 → 'binary-missing'，优先于来源判定。
 *      cc 二进制随包分发、永远在，无此轴 —— 这是整个判定里唯一与 agent 类型相关的地方。
 *
 * revalidate() 供 send 门禁 / DropdownMenu onOpenChange(true) 时手动触发，不自动轮询。
 */

import { useCallback, useEffect, useState } from 'react';

import { connectedProvidersForAgent, type AgentKind, type ProviderView } from '@cindy/model-providers';

export type Readiness = 'ready' | 'unauthenticated' | 'binary-missing' | 'loading';

export function useVendorReadiness(vendorKey: 'cc' | 'codex'): {
  readiness: Readiness;
  revalidate: (opts?: { includeSuspended?: boolean }) => Promise<Readiness>;
} {
  const [readiness, setReadiness] = useState<Readiness>('loading');

  const revalidate = useCallback(async (opts?: { includeSuspended?: boolean }): Promise<Readiness> => {
    const agent: AgentKind = vendorKey === 'cc' ? 'claude-code' : 'codex';

    // 轴 2(仅 codex,正交于来源):本地二进制是运行时前提,缺了连发都发不了 → 优先返回
    // binary-missing。binary 状态走 maker:agent:status(其 authReady 是 codex OAuth 专属,已被
    // 下方 provider 维度的来源判定取代,这里只取 binaryReady)。cc 二进制随包分发,无此轴。
    if (vendorKey === 'codex') {
      setReadiness('loading');
      try {
        const status = (await window.electronAPI.maker.agent.getStatus('codex')) as {
          binaryReady: boolean;
          authReady: boolean;
        };
        if (!status.binaryReady) {
          setReadiness('binary-missing');
          return 'binary-missing';
        }
      } catch {
        // status 查询失败(罕见 IPC 错):保守判未就绪,引导用户去连接,不误放行。
        setReadiness('unauthenticated');
        return 'unauthenticated';
      }
    }

    // 轴 1(与 agent 类型无关,唯一真相):该 agent 有没有「已连接的可选来源」。连接态走本地 IPC
    // listProviders(极快),send 门禁时刻现拉避免 stale;失败按空列表处理(判未就绪,引导去连接)。
    let providers: ProviderView[] = [];
    try {
      providers = (await window.electronAPI.maker.listProviders()).providers;
    } catch {
      providers = [];
    }
    // includeSuspended:已建会话的发送门禁传 true —— 供应商级停用是准入轴,不打断
    // 运行中会话,门禁只回答「凭证还连着吗」;全停时把继续发送判成 unauthenticated
    // 会误堵旧会话(PR #744 review 第十七轮)。新路由(草稿)保持准入口径。
    const next: Readiness =
      connectedProvidersForAgent(providers, agent, {
        includeSuspended: opts?.includeSuspended === true,
      }).length > 0
        ? 'ready'
        : 'unauthenticated';
    setReadiness(next);
    return next;
  }, [vendorKey]);

  useEffect(() => {
    void revalidate();
  }, [revalidate]);

  return { readiness, revalidate };
}
