/**
 * useVendorReadiness — M33: Vendor 就绪状态 hook（F7-mini）
 * ---------------------------------------------------------------------------
 * 输出统一的 Readiness 枚举。判定分两条**正交**的轴：
 *
 *   1. 有没有可用来源（hasUsableConnectedSource）：
 *        cc / codex / pi 看目录已连接供应商；grok-build 看 SuperGrok / xAI。
 *      与 useConnectedSource（渲染期空態判定）同源，这里在 send 门禁时刻现拉一次避免 stale。
 *   2. 运行时前提（codex / pi / grok-build）：本地 hosted-loop 二进制缺失时先拦截。
 *      cc 二进制随包分发、永远在，无此轴。
 *
 * revalidate() 供 send 门禁 / DropdownMenu onOpenChange(true) 时手动触发，不自动轮询。
 */

import { useCallback, useEffect, useState } from 'react';

import { hasUsableConnectedSource, type AgentKind, type ProviderView } from '@cindy/model-providers';

export type Readiness = 'ready' | 'unauthenticated' | 'binary-missing' | 'loading';

/**
 * Codex 与 Pi 都依赖随应用分发的本地运行时。二进制缺失和模型来源未连接是
 * 两种不同的恢复路径，不能把 Pi 的缺包状态伪装成未授权。
 */
export function readinessFromBinaryStatus(
  vendorKey: 'cc' | 'codex' | 'pi' | 'grok-build',
  binaryReady: boolean,
): Readiness | null {
  return vendorKey !== 'cc' && !binaryReady ? 'binary-missing' : null;
}

export function useVendorReadiness(vendorKey: 'cc' | 'codex' | 'pi' | 'grok-build'): {
  readiness: Readiness;
  revalidate: (opts?: { includeSuspended?: boolean }) => Promise<Readiness>;
} {
  const [readiness, setReadiness] = useState<Readiness>('loading');

  const revalidate = useCallback(async (opts?: { includeSuspended?: boolean }): Promise<Readiness> => {
    const agent: AgentKind = vendorKey === 'cc' ? 'claude-code' : vendorKey === 'pi' ? 'pi' : vendorKey === 'grok-build' ? 'grok-build' : 'codex';

    // 轴 2(codex / pi,正交于来源):本地二进制是运行时前提,缺了连发都发不了 → 优先返回
    // binary-missing。binary 状态走 maker:agent:status(其 authReady 是 codex OAuth 专属,已被
    // 下方 provider 维度的来源判定取代,这里只取 binaryReady)。cc 二进制随包分发,无此轴。
    if (vendorKey !== 'cc') {
      setReadiness('loading');
      try {
        const status = (await window.electronAPI.maker.agent.getStatus(agent)) as {
          binaryReady: boolean;
          authReady: boolean;
        };
        const missing = readinessFromBinaryStatus(vendorKey, status.binaryReady);
        if (missing) {
          setReadiness(missing);
          return missing;
        }
      } catch {
        // status 查询失败(罕见 IPC 错):保守判未就绪,引导用户去连接,不误放行。
        setReadiness('unauthenticated');
        return 'unauthenticated';
      }
    }

    // 轴 1:该 agent 有没有可用来源。Grok Build 看 SuperGrok / xAI,其余走目录
    // connectedProvidersForAgent。listProviders 极快;失败按空列表处理。
    let providers: ProviderView[] = [];
    try {
      providers = (await window.electronAPI.maker.listProviders()).providers;
    } catch {
      providers = [];
    }
    // includeSuspended:已建会话的发送门禁传 true —— 供应商级停用是准入轴,不打断
    // 运行中会话,门禁只回答「凭证还连着吗」;全停时把继续发送判成 unauthenticated
    // 会误堵旧会话(PR #744 review 第十七轮)。新路由(草稿)保持准入口径。
    const next: Readiness = hasUsableConnectedSource(providers, agent, undefined, {
      includeSuspended: opts?.includeSuspended === true,
    })
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
