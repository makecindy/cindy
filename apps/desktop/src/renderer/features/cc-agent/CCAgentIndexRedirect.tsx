/**
 * CCAgentIndexRedirect — /cc-agent index 的默认入口(F-SB-4)。
 * ---------------------------------------------------------------------------
 * Redirect 始终回到「聊天视图」,只读 chat slot —— doc slot 独立保留,不影响这里。
 *
 * 启动恢复优先级(lastViewStore.loadLastChatView)：
 *   1. 上次是 /cc-agent/new 草稿 → 直接回到 /cc-agent/new
 *   2. 上次是某个 session:
 *      - sessionId 仍在本机或远程 active 列表 → 还原到 /cc-agent/:sessionId
 *      - sessionId 已删除 / 归档 → 回落到默认逻辑
 *   3. 无记录 / 记录失效 → 默认逻辑：
 *      - 列表非空 → 取首个有效任务(保留本机列表优先,远程补充)
 *      - 列表为空 → navigate 到 /cc-agent/new
 *
 * Loading 期间不触发 navigate,显示加载占位。
 */

import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';

import { useCCSessions } from '@/hooks/useCCSessions';
import {
  getSessionDeviceId,
  remoteProjectsStore,
  useRemoteBootstrapLoadingDeviceIds,
  useRemoteInitialDiscoverySettled,
  useRemoteProjectSessions,
} from '@/features/device-link/remoteProjectsStore';
import { isOrcaLeadSession, isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import { orcaWorkflowsFor } from '@/lib/makerTransport';
import { loadLastChatView } from './lib/lastViewStore';
import { mergeSessionSources } from './lib/mergeSessionSources';

export function CCAgentIndexRedirect() {
  const { t } = useTranslation();
  const { sessions: localSessions, isLoading } = useCCSessions();
  const remoteSessions = useRemoteProjectSessions();
  const remoteLoadingDeviceIds = useRemoteBootstrapLoadingDeviceIds();
  const remoteInitialDiscoverySettled = useRemoteInitialDiscoverySettled();
  const allSessions = useMemo(
    () => mergeSessionSources(localSessions, remoteSessions),
    [localSessions, remoteSessions],
  );
  // The mirror also retains archived rows and companion/side-chat detail reads.
  // Match the ordinary active-task list before restoring or choosing a fallback.
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session) =>
          session.status !== 'archived' &&
          session.status !== 'deleted' &&
          session.source !== 'bot' &&
          session.source !== 'side-chat' &&
          (CINDY_MAKE_ENABLED || !isCindyMakeSource(session.source)),
      ),
    [allSessions],
  );
  const navigate = useNavigate();
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (isLoading || hasRedirected.current) return;

    let cancelled = false;
    const redirect = (route: string) => {
      if (cancelled || hasRedirected.current) return;
      // Lock only once navigation commits: an effect cancelled by a newer
      // snapshot (or StrictMode) must be allowed to resolve the route again.
      hasRedirected.current = true;
      navigate(route, { replace: true });
    };
    void (async () => {
      const last = loadLastChatView();
      const sessionIdSet = new Set(sessions.map((s) => s.id));
      const routeForSession = async (
        session: (typeof sessions)[number],
      ): Promise<string | null> => {
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
        redirect('/cc-agent/new');
        return;
      }

      if (last?.kind === 'session') {
        const lastSession = sessions.find((s) => s.id === last.sessionId);
        // Missing from an in-flight remote snapshot is not evidence of deletion.
        // Known archived/hidden rows may fall back immediately. Existing mirrors
        // remain usable offline; no network request or reconnect is started here.
        if (!lastSession && !allSessions.some((s) => s.id === last.sessionId)) {
          // Descendant passive effects run before the synchronizer's mount
          // effect. Let that commit finish resetting discovery after a previous
          // unmount/logout, then read live state instead of the render snapshot.
          // In particular, an empty fallback has no other await before navigation.
          await Promise.resolve();
          if (cancelled || !remoteProjectsStore.getInitialDiscoverySettled()) return;
          const deviceId = getSessionDeviceId(last.sessionId);
          if (deviceId ? remoteLoadingDeviceIds.has(deviceId) : remoteLoadingDeviceIds.size > 0)
            return;
        }
        const route = lastSession ? await routeForSession(lastSession) : null;
        if (cancelled) return;
        if (route) {
          redirect(route);
          return;
        }
        // 失效(删除 / 归档)→ 落到默认逻辑
      }

      for (const session of sessions) {
        if (cancelled) return;
        const route = await routeForSession(session);
        if (route) {
          redirect(route);
          return;
        }
      }
      // 列表为空 → transient draft route(无后端 session)
      redirect('/cc-agent/new');
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoading, sessions, allSessions, remoteLoadingDeviceIds, remoteInitialDiscoverySettled, navigate]);

  // Loading placeholder while data resolves.
  return (
    <div className="flex h-full w-full items-center justify-center">
      <p className="text-sm text-sidebar-muted">{t('ccAgent.common.loading')}</p>
    </div>
  );
}
