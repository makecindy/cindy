/**
 * useSessionGitContext — 会话级 git 上下文(当前分支 + 关联 PR + PR 实时状态)。
 *
 * 数据流(全部经 main,renderer 零业务逻辑):
 *   - 分支:不再读「session.working_dir 的实时 HEAD」(共享主 checkout 会全错),
 *     改用 gitContext.getForSession(sessionId) 让 main 从 agent tool-call 遥测
 *     (Codex cwd / cc 编辑路径)推断「对话真实工作目录」+ 其 HEAD + 来源 source。
 *     拿到 workdir 后 gitContext.watch 开启 HEAD 监听;对话中途换 worktree 靠
 *     focus + 周期 tick 再解析并切换监听目标。
 *   - PR 引用:listPrRefs(sessionId) + git-context:pr-refs-changed 推送刷新。
 *   - PR 状态:引用变化后对前 MAX_STATUS_QUERIES 条批量查一次(main 60s TTL 缓存,
 *     重复查询便宜);未配 PAT 时返回 no-token,UI 显示 PR 号不显示状态。结果含
 *     PR 源分支 branch:遥测拿不到本地目录时,徽标用它兜底显示分支。
 *
 * 约束:dialogue 会话(workspaceKind !== 'project')与远端会话(remoteHostId)
 * 不启用——前者 workingDir 是对话自有目录分支语义无意义,后者本地读 .git 没意义,
 * 直接返回空态,不发任何 IPC。
 */

import { useEffect, useState } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import type {
  GitContextDirSource,
  GitContextSnapshot,
  GitHeadInfo,
  SessionPrRef,
  PrStatusResult,
} from '@/lib/gitContext.types';
import { useWorktreeForSession } from '@/contexts/WorktreeContext';
import { createLogger } from '@/lib/logger';

const log = createLogger('useSessionGitContext');

/** 只对最近的几条 PR 引用查状态(徽标也只展示这几条)。 */
export const MAX_STATUS_QUERIES = 3;

/**
 * PR 状态周期刷新间隔。GitHub 侧 open→merged / review 评论 resolve 这类变化
 * 不会产生本地 pr-refs-changed 事件,长开会话只靠初次加载会一直显示旧状态
 * (review 反馈)。取值刻意 > main 侧 60s TTL,保证每次 tick 都真的打到远端。
 */
const STATUS_REFRESH_INTERVAL_MS = 90_000;

/**
 * 「对话真实工作目录」再解析间隔。对话中途 agent `cd` 进新 worktree 不产生本地事件,
 * 靠 focus + 周期 tick 跟进(focus 覆盖"切走又回来",interval 覆盖"一直盯着看")。
 * 单 session 一次 bounded DB 查询 + 几次 fs 探测,开销可忽略。
 */
const DIR_RERESOLVE_INTERVAL_MS = 60_000;

export interface SessionGitContext {
  /** 当前分支信息;null = 非 git 目录 / dialogue 会话 / 尚未加载。 */
  head: GitHeadInfo | null;
  /** head 的来源,决定徽标对分支的信任度(telemetry/worktree 可信,workingDir 让位 PR)。 */
  branchSource: GitContextDirSource;
  /** 关联 PR 引用,lastSeenAt 降序。 */
  prRefs: SessionPrRef[];
  /** key = `${owner}/${repo}#${prNumber}`(小写 owner/repo)。 */
  prStatuses: Map<string, PrStatusResult>;
}

export function prStatusKey(ref: { owner: string; repo: string; prNumber: number }): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.prNumber}`;
}

const EMPTY: SessionGitContext = {
  head: null,
  branchSource: null,
  prRefs: [],
  prStatuses: new Map(),
};

export function useSessionGitContext(session: Session): SessionGitContext {
  const sessionId = session.id;
  // worktree 路径用 WorktreeContext 的 live 元数据,**不读 session.worktreePath**:
  // 那是反范式快照,worktree 删除后刻意不清(见 schema.ts),拿快照会把已删
  // 路径向上 walk 到主仓 .git,显示主仓分支冒充 worktree 分支(Codex review P2;
  // ADR-WT-FE-4:徽标一律按 store 是否存在判定)。它仅作为遥测拿不到时的兜底之一。
  const worktreeMeta = useWorktreeForSession(sessionId);
  // dialogue 会话分支语义无意义;远端会话(remoteHostId)本地读 .git 没意义 → 不启用。
  const isProjectLocal = session.workspaceKind === 'project' && !session.remoteHostId;
  const workingDir = session.workingDir ?? null;
  const worktreePath = worktreeMeta?.path ?? null;

  const [head, setHead] = useState<GitHeadInfo | null>(null);
  const [branchSource, setBranchSource] = useState<GitContextDirSource>(null);
  const [prRefs, setPrRefs] = useState<SessionPrRef[]>([]);
  const [prStatuses, setPrStatuses] = useState<Map<string, PrStatusResult>>(new Map());

  // ── 分支:getForSession 解析真实工作目录 + 可换目录的 HEAD watch ──
  useEffect(() => {
    if (!isProjectLocal) {
      setHead(null);
      setBranchSource(null);
      return;
    }
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

    // 先订阅再解析:在途窗口的推送进 pendingPush 缓冲;match 用 watchedRef.current。
    const unsubscribe = window.electronAPI.gitContext.onChanged((snapshot) => {
      if (watchedRef.current === null) {
        pendingPush.current = snapshot;
        return;
      }
      if (snapshot.workdir === watchedRef.current) {
        setHead(snapshot.head);
      }
    });

    const resolveAndWatch = async () => {
      const gen = ++resolveGen;
      try {
        const res = await window.electronAPI.gitContext.getForSession({
          sessionId,
          workingDir,
          worktreePath,
        });
        // 被更新的调用超越(或 effect 已 cleanup)→ 丢弃陈旧结果,不碰 watchedRef。
        if (cancelled || gen !== resolveGen) return;
        setHead(res.head);
        setBranchSource(res.source);
        const next = res.workdir; // 已是 resolve 过的绝对路径或 null
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
  }, [sessionId, isProjectLocal, workingDir, worktreePath]);

  // ── PR 引用 + 状态 ──
  useEffect(() => {
    if (!isProjectLocal) {
      setPrRefs([]);
      setPrStatuses(new Map());
      return;
    }
    let cancelled = false;

    const loadRefs = async () => {
      try {
        const refs = await window.electronAPI.gitContext.listPrRefs(sessionId);
        if (cancelled) return;
        setPrRefs(refs);
        const queries = refs.slice(0, MAX_STATUS_QUERIES).map((r) => ({
          owner: r.owner,
          repo: r.repo,
          prNumber: r.prNumber,
        }));
        if (queries.length === 0) {
          setPrStatuses(new Map());
          return;
        }
        const results = await window.electronAPI.gitContext.getPrStatuses(queries);
        if (cancelled) return;
        setPrStatuses(new Map(results.map((r) => [prStatusKey(r), r])));
      } catch (err) {
        log.warn('pr refs load failed', String(err));
      }
    };

    void loadRefs();
    const unsubscribe = window.electronAPI.gitContext.onPrRefsChanged((data) => {
      if (data.sessionId === sessionId) void loadRefs();
    });
    // 远端状态变化(merged / closed / review resolve)没有本地事件可订阅,
    // 用周期 tick + 窗口聚焦兜底刷新;批量上限 3 条 + main 侧缓存,开销可忽略。
    const interval = setInterval(() => void loadRefs(), STATUS_REFRESH_INTERVAL_MS);
    const onFocus = () => void loadRefs();
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [sessionId, isProjectLocal]);

  if (!isProjectLocal) return EMPTY;
  return { head, branchSource, prRefs, prStatuses };
}
