/**
 * CCAgentIndexRedirect — /cc-agent index 的默认入口(F-SB-4)。
 * ---------------------------------------------------------------------------
 * Redirect 始终回到「聊天视图」,只读 chat slot —— doc slot 独立保留,不影响这里。
 *
 * 启动恢复优先级(lastViewStore.loadLastChatView)：
 *   1. 上次是 /cc-agent/new 草稿 → 直接回到 /cc-agent/new
 *   2. 上次是某个 session:
 *      - sessionId 仍在当前 active 列表 → 还原到 /cc-agent/:sessionId
 *      - sessionId 已删除 / 归档 → 回落到默认逻辑
 *   3. 无记录 / 记录失效 → 默认逻辑：
 *      - 列表非空 → navigate 到 sessions[0].id(最近更新的)
 *      - 列表为空 → navigate 到 /cc-agent/new
 *
 * Loading 期间不触发 navigate,显示加载占位。
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';

import { useCCSessions } from '@/hooks/useCCSessions';
import {
  isOrcaLeadSession,
  isOrcaWorkerSession,
} from '@/lib/orcaSessionIdentity';
import { orcaWorkflowsFor } from '@/lib/makerTransport';
import { loadLastChatView } from './lib/lastViewStore';

export function CCAgentIndexRedirect() {
  const { t } = useTranslation();
  const { sessions, isLoading } = useCCSessions();
  const navigate = useNavigate();
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (isLoading || hasRedirected.current) return;
    hasRedirected.current = true;

    let cancelled = false;
    void (async () => {
      const last = loadLastChatView();
      const sessionIdSet = new Set(sessions.map((s) => s.id));
      const routeForSession = async (session: typeof sessions[number]): Promise<string | null> => {
        if (!CINDY_MAKE_ENABLED && isCindyMakeSource(session.source)) return null;
        if (isOrcaLeadSession(session)) return `/cc-agent/${session.id}`;
        if (!isOrcaWorkerSession(session)) return `/cc-agent/${session.id}`;
        const workflow = await orcaWorkflowsFor(session.id)
          .getByWorkerSession(session.id)
          .catch(() => null);
        if (!workflow) return null;
        // 防御 orphan workflow：lead session 已被删除/归档时不要再路由到一个找不到 lead
        // 的 Orca 视图,否则 OrcaWorkflowRoute 会把我们弹回 /cc-agent,而 index redirect
        // 又会再次选中这个 worker → 同样路由 → 死循环闪烁(用户无法点击任何 session)。
        if (!sessionIdSet.has(workflow.leadSessionId)) return null;
        return `/cc-agent/${workflow.leadSessionId}?worker=${session.id}`;
      };

      if (last?.kind === 'new') {
        if (!cancelled) navigate('/cc-agent/new', { replace: true });
        return;
      }

      if (last?.kind === 'session') {
        const lastSession = sessions.find((s) => s.id === last.sessionId);
        const route = lastSession ? await routeForSession(lastSession) : null;
        if (route) {
          if (!cancelled) navigate(route, { replace: true });
          return;
        }
        // 失效(删除 / 归档)→ 落到默认逻辑
      }

      for (const session of sessions) {
        const route = await routeForSession(session);
        if (route) {
          if (!cancelled) navigate(route, { replace: true });
          return;
        }
      }
      // 列表为空 → transient draft route(无后端 session)
      if (!cancelled) navigate('/cc-agent/new', { replace: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoading, sessions, navigate]);

  // Loading placeholder while data resolves.
  return (
    <div className="flex h-full w-full items-center justify-center">
      <p className="text-sm text-sidebar-muted">{t('ccAgent.common.loading')}</p>
    </div>
  );
}
