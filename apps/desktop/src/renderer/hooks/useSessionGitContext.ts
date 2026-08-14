/**
 * useSessionGitContext — 会话级 git 上下文(当前分支 + 关联 PR + PR 实时状态)。
 *
 * 数据流(全部经 main,renderer 零业务逻辑):
 *   - 分支:不再读「session.working_dir 的实时 HEAD」(共享主 checkout 会全错),
 *     改用 gitContext.getForSession(sessionId) 让 main 从 agent tool-call 遥测
 *     (Codex cwd / cc 编辑路径)推断「对话真实工作目录」+ 其 HEAD + 来源 source。
 *     拿到 workdir 后 gitContext.watch 开启 HEAD 监听;对话中途换 worktree 靠
 *     focus + 周期 tick 再解析并切换监听目标。SSH / device-link 会话在真实执行端
 *     查询,不在控制端注册本地 watcher,改用 focus + 周期 tick。
 *   - PR 引用与状态:**消费 PrRefsContext 的共享缓存**(2026-08-12 统一:此前顶栏
 *     自持一份 refs/状态与拉取管线,与侧栏徽标各查各的、显示还会不同步)。本 hook
 *     只向共享缓存注册消费者(registerPrConsumer),拉取、周期/聚焦刷新、device-link
 *     远程路由、失败自愈全部由 PrRefsContext 单点负责;返回值按当前会话过滤,
 *     语义与旧实现一致(切会话/断链即空)。
 *
 * 约束:dialogue 会话(workspaceKind !== 'project')不启用——workingDir 是对话自有目录,
 * 分支语义无意义。SSH 与 device-link 远程会话则把查询发往真实执行端。
 */

import { useEffect, useMemo, useState } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import type {
  GitContextDirSource,
  GitContextSnapshot,
  GitHeadInfo,
  SessionGitDirResult,
  SessionPrRef,
  PrStatusResult,
} from '@/lib/gitContext.types';
import { useWorktreeForSession } from '@/contexts/WorktreeContext';
import { usePrActions, usePrRefsForSession, usePrStatuses } from '@/contexts/PrRefsContext';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { MAX_STATUS_QUERIES, PR_STATUS_REFRESH_INTERVAL_MS, prStatusKey } from '@/lib/prStatus';
import { createLogger } from '@/lib/logger';

const log = createLogger('useSessionGitContext');

// 正本在 lib/prStatus(避免与 PrRefsContext 循环导入);re-export 兼容存量 import 方。
export { MAX_STATUS_QUERIES, PR_STATUS_REFRESH_INTERVAL_MS, prStatusKey } from '@/lib/prStatus';

/**
 * 「对话真实工作目录」再解析间隔。对话中途 agent `cd` 进新 worktree 不产生本地事件,
 * 靠 focus + 周期 tick 跟进(focus 覆盖"切走又回来",interval 覆盖"一直盯着看")。
 * 单 session 一次 bounded DB 查询 + 几次 fs 探测,开销可忽略。
 */
const DIR_RERESOLVE_INTERVAL_MS = 60_000;

const GET_FOR_SESSION_CHANNEL = 'git-context:get-for-session';

async function invokeRemoteGitContext<T>(
  deviceId: string,
  channel: string,
  args: unknown[],
): Promise<T> {
  return (await window.electronAPI.deviceLink.invoke(deviceId, channel, args)) as T;
}

export interface SessionGitContext {
  /** 当前分支信息;null = 非 git 目录 / dialogue 会话 / 尚未加载。 */
  head: GitHeadInfo | null;
  /** head 的来源,决定徽标对分支的信任度(telemetry/worktree/remote 可信,workingDir 让位 PR)。 */
  branchSource: GitContextDirSource;
  /** 关联 PR 引用,lastSeenAt 降序。 */
  prRefs: SessionPrRef[];
  /** key = `${owner}/${repo}#${prNumber}`(小写 owner/repo)。仅含本会话引用的条目。 */
  prStatuses: Map<string, PrStatusResult>;
}

const EMPTY: SessionGitContext = {
  head: null,
  branchSource: null,
  prRefs: [],
  prStatuses: new Map(),
};

export function useSessionGitContext(session: Session): SessionGitContext {
  const sessionId = session.id;
  // 本地 worktree 路径用 WorktreeContext 的 live 元数据,**不读 session.worktreePath**:
  // 那是反范式快照,worktree 删除后刻意不清(见 schema.ts),拿快照会把已删路径向上
  // walk 到主仓 .git,显示主仓分支冒充 worktree 分支(Codex review P2;
  // ADR-WT-FE-4)。远程 session 没有控制端 WorktreeContext,其 path 会在真实执行端
  // 重新 probe,因此可以使用远端 session snapshot 作为候选。
  const worktreeMeta = useWorktreeForSession(sessionId);
  const deviceLinkDeviceId =
    session.deviceLinkDeviceId ?? getStickySessionDeviceId(sessionId) ?? null;
  const remoteHostId = session.remoteHostId ?? null;
  const isProjectSession = session.workspaceKind === 'project';
  const isDeviceLinkSession = Boolean(deviceLinkDeviceId);
  const isSshSession = Boolean(remoteHostId) && !isDeviceLinkSession;
  const isLocalSession = !isDeviceLinkSession && !isSshSession;
  const workingDir = session.workingDir ?? null;
  // device-link / SSH 的 path 属于真实执行端,会在那里重新 probe；本地会话仍只使用
  // WorktreeContext 的 live 路径,不信任 session 上的历史快照。
  const worktreePath = isLocalSession
    ? (worktreeMeta?.path ?? null)
    : (session.worktreePath ?? null);

  const [head, setHead] = useState<GitHeadInfo | null>(null);
  const [branchSource, setBranchSource] = useState<GitContextDirSource>(null);

  // ── 分支:getForSession 解析真实工作目录 + 可换目录的 HEAD watch ──
  useEffect(() => {
    if (!isProjectSession) {
      setHead(null);
      setBranchSource(null);
      return;
    }
    // A single header instance can survive session switches. Clear the old
    // task's branch immediately so a failed remote invoke cannot leave stale
    // Git context beside the newly selected title.
    setHead(null);
    setBranchSource(null);
    let cancelled = false;
    // 当前监听的(已 resolve 的绝对)目录,cleanup 与目录切换都靠它——
    // 用 ref 对象而非闭包 let:解析是异步的,cleanup 必须拿到最新值才能 unwatch。
    const watchedRef: { current: string | null } = { current: null };
    // 首次解析在途期间到达的 HEAD 推送先缓冲,拿到 workdir 后回放,不丢事件。
    const pendingPush: { current: GitContextSnapshot | null } = { current: null };
    // resolveAndWatch 会被并发触发(mount / focus / 60s tick),多个在 `await
    // getForSession` 处交错。用单调代次:每次调用开头自增并捕获,await 后若已被
    // 更新的调用超越就丢弃本次陈旧结果——否则后发先至时旧结果会覆写 watchedRef、
    // 退回旧分支,正是本 PR 要修的 bug(Greptile review P2)。
    let resolveGen = 0;

    // 只有控制端本地目录能由本机 GitContextService watcher 监听。SSH / device-link
    // 路径属于真实执行端,不能在控制端对同名路径注册 watcher,否则会读错本机 checkout。
    const unsubscribe = isLocalSession
      ? window.electronAPI.gitContext.onChanged((snapshot) => {
          if (watchedRef.current === null) {
            pendingPush.current = snapshot;
            return;
          }
          if (snapshot.workdir === watchedRef.current) {
            setHead(snapshot.head);
          }
        })
      : () => undefined;

    const resolveAndWatch = async () => {
      const gen = ++resolveGen;
      try {
        const input = {
          sessionId,
          workingDir,
          worktreePath,
          ...(remoteHostId ? { remoteHostId } : {}),
        };
        const res = isDeviceLinkSession
          ? await invokeRemoteGitContext<SessionGitDirResult>(
              deviceLinkDeviceId as string,
              GET_FOR_SESSION_CHANNEL,
              [input],
            )
          : await window.electronAPI.gitContext.getForSession(input);
        // 被更新的调用超越(或 effect 已 cleanup)→ 丢弃陈旧结果,不碰 watchedRef。
        if (cancelled || gen !== resolveGen) return;
        setHead(res.head);
        setBranchSource(res.source);
        const next = res.workdir; // 已是 resolve 过的绝对路径或 null
        if (!isLocalSession) return;
        if (next === watchedRef.current) return; // 目录没变,仅刷新了 head
        const prev = watchedRef.current;
        watchedRef.current = next;
        if (next && pendingPush.current && pendingPush.current.workdir === next) {
          setHead(pendingPush.current.head);
        }
        pendingPush.current = null;
        if (prev) void window.electronAPI.gitContext.unwatch(prev).catch(() => undefined);
        if (next && !cancelled && gen === resolveGen) {
          await window.electronAPI.gitContext.watch(next);
        }
      } catch (err) {
        log.warn('git context resolve failed', String(err));
        if (!cancelled && gen === resolveGen) {
          setHead(null);
          setBranchSource(null);
        }
      }
    };

    void resolveAndWatch();
    // 对话中途换 worktree(Codex `cd` 进新目录)→ focus / 周期 tick 再解析跟进。
    const onFocus = () => void resolveAndWatch();
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => void resolveAndWatch(), DIR_RERESOLVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
      if (watchedRef.current) {
        void window.electronAPI.gitContext.unwatch(watchedRef.current).catch(() => undefined);
      }
    };
  }, [
    sessionId,
    isProjectSession,
    isLocalSession,
    isSshSession,
    isDeviceLinkSession,
    deviceLinkDeviceId,
    remoteHostId,
    workingDir,
    worktreePath,
  ]);

  // ── PR 引用 + 状态:消费 PrRefsContext 共享缓存(与侧栏徽标同一份)──
  // 注册消费者即触发拉取;周期/聚焦刷新、device-link 远程路由、失败自愈由
  // Provider 单点负责。切会话 = 换 key 读缓存(天然隔离,无需清空);断链后
  // 新会话查询失败 → 缓存无条目 → 返回空,与旧实现的"清空"语义一致。
  const { registerPrConsumer } = usePrActions();
  const sharedPrRefs = usePrRefsForSession(sessionId);
  const { statuses: allStatuses } = usePrStatuses();
  useEffect(() => {
    if (!isProjectSession) return undefined;
    return registerPrConsumer(sessionId, deviceLinkDeviceId ?? undefined);
  }, [isProjectSession, sessionId, deviceLinkDeviceId, registerPrConsumer]);

  const prRefs = isProjectSession ? sharedPrRefs : EMPTY.prRefs;
  // statuses 是全局缓存(含其它会话的 PR);按本会话前 MAX_STATUS_QUERIES 条
  // 引用过滤,保住旧契约「prStatuses 只含本会话条目」(消费方有 size 判断)。
  const prStatuses = useMemo(() => {
    const map = new Map<string, PrStatusResult>();
    for (const ref of prRefs.slice(0, MAX_STATUS_QUERIES)) {
      const key = prStatusKey(ref);
      const status = allStatuses.get(key);
      if (status) map.set(key, status);
    }
    return map;
  }, [prRefs, allStatuses]);

  if (!isProjectSession) return EMPTY;
  return { head, branchSource, prRefs, prStatuses };
}
