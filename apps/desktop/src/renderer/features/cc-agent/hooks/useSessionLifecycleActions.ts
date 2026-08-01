/**
 * useSessionLifecycleActions — 会话 archive / delete / unarchive 的共享副作用序列
 * ---------------------------------------------------------------------------
 * 两个消费方（PR #64 合并留言里的 TODO(unify)）：
 *   - CCAgentSidebarUpper：会话列表右键菜单 / 行内 archive 快捷按钮
 *   - SessionContentHeader：右栏顶栏 ··· 菜单
 *
 * 本 hook 只封装"确认之后的执行序列"（关子进程 / 写库 / 乐观补丁 / 释放内存 /
 * 清 composer draft / refresh 列表与 worktree / 必要时跳转）。**前置检查
 * （running / IM 接管拦截）和确认弹窗留在调用方** —— 两处的确认交互形态不同
 * （sidebar 是受控 ConfirmDialog + 行内两步确认，header 是 imperative
 * confirmDialog），强行收进来反而耦合。
 *
 * activeSessionId 由调用方传入：sidebar 是当前路由解析出的活跃会话（可能
 * 操作非活跃行）；header 操作的恒为当前打开的会话（传 session.id 即可）。
 *
 * includeArchived 必须与调用方自己的 useCCSessions 桶一致：unarchive 的 refreshSessions
 * 只刷当前桶，sidebar 处于 archived / all 桶时删除行后若刷的是默认 active
 * 桶，已删行会在当前列表残留（Codex review P2）。header 始终展示 active
 * 会话语境，用默认值即可。
 */

import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import * as sessionService from '@/lib/sessionService';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearDraft as clearComposerDraft } from '@/lib/composerDraftStore';
import { cleanupSessionLayoutPrefs } from '@/lib/sessionLayoutPrefs';
import { emitRefresh } from '@/lib/sessionsBus';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useRefreshWorktrees } from '@/contexts/WorktreeContext';
import { createLogger } from '@/lib/logger';
import type { ListStatusFilter } from '@/lib/sessionService';
import type { SessionStatus } from '@/lib/ccAgent.types';

const log = createLogger('useSessionLifecycleActions');

export interface RunSessionActionOptions {
  /** 当前活跃会话 id —— 决定 archive / delete 后是否需要跳走。 */
  activeSessionId: string | null | undefined;
  /**
   * 删除当前会话后的明确跳转目标。侧边栏会基于用户当前可见行顺序传入
   * "下一条 / 上一条 / 新建"；没有列表上下文的入口继续回落到 /cc-agent。
   */
  deleteRedirectRoute?: string | null;
}

export function useSessionLifecycleActions(options?: { includeArchived?: ListStatusFilter }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  // patchLocal / refreshSessions 转发到 sessionsStore 模块级单例，
  // 与调用方组件里的 useCCSessions 实例共享同一份 cache。
  // includeArchived 跟随调用方的桶（见文件头注释）。
  const { refreshSessions, patchLocal } = useCCSessions(options);
  const refreshWorktrees = useRefreshWorktrees();
  // 取成 string 再进 deps —— options 是调用方每次渲染新建的字面量对象,直接放进
  // runSessionAction 的 deps 会让它每次重建,打穿 sidebar 的行 handler memo
  // (行渲染隔离不变量,见 SessionItem.tsx)。
  const listFilter: ListStatusFilter = options?.includeArchived ?? 'active';

  /**
   * archive / delete 实际执行序列。不关心确认弹窗的开合状态——由调用方负责。
   */
  const runSessionAction = useCallback(
    async (
      sessionId: string,
      action: 'delete' | 'archive',
      { activeSessionId, deleteRedirectRoute }: RunSessionActionOptions,
    ) => {
      const targetStatus: SessionStatus = action === 'delete' ? 'deleted' : 'archived';
      // device-link 远程会话:status 写经隧道(setStatus 内部按来源路由 patch-meta),被控端写库后
      // 广播 sessions:patched{status} → 控制端 applyPatch 把它移出分片(纯镜像,无需乐观/重拉)。

      if (action === 'archive') {
        // 乐观更新的顺序取决于**被归档的行还会不会留在当前列表里**,两种情况相反:
        //
        //   · 会留下(调用方在 'all' 桶):patchLocal 只是把它重排到归档段,行还在。
        //     必须先让 navigate commit + paint 掉 isActive 高亮,再重排,否则会看到
        //     "那行被归档后还在新位置短暂高亮"。两次独立 flushSync 就是为这个。
        //   · 会消失(active 桶,最常见):store 已经把它从桶里就地移除,高亮随行一起
        //     消失,不存在残留问题。这时**不能**让 navigate 先跑 —— flushSync 里的
        //     navigate 要同步渲染整个主视图切换(卸下会话视图、挂上新建页),那一帧
        //     几十毫秒全堵在"行消失"之前。改成先 flushSync 掉行(只重渲染 sidebar,
        //     便宜),navigate 不加 flushSync 让它排到后面的帧。
        //
        // 乐观更新还**依赖 sessionsStore.patchLocal 就地移除、不 drop 桶**:早期 store
        // 对跨桶迁移一律 drop + 重拉,桶变 null 会让 useCCSessions 跳过 setState,
        // 本段全部白做,行要等 sessions:list 回来(数百毫秒)才消失。改 store 那段
        // 逻辑前先看它的 patchLocal 注释。
        //
        // 借鉴 Codex 的 onArchivedCurrentThread 思路 navigate 到 /cc-agent/new
        // 空白态,而不是 /cc-agent 让 CCAgentIndexRedirect 挑下一条 —— 后者会按
        // 启发式跳到任意 session,sidebar 高亮"无规律地跳到某行",跟鼠标位置无关。
        //
        // Delete 仍走原来的"先 DB 后清理"流程:delete 不可逆,乐观删除如果 DB 失
        // 败会让用户看到"行消失又出现"的诡异闪烁,代价比 archive 大。写库成功
        // 后再用 patchLocal 从所有桶移除,并由 emitRefresh 强制重拉所有桶兜底。
        const archivedRowStaysInList = listFilter === 'all';
        const leaveArchivedSession = () => {
          if (sessionId === activeSessionId) navigate('/cc-agent/new');
        };
        if (archivedRowStaysInList) {
          flushSync(leaveArchivedSession);
        }
        flushSync(() => {
          patchLocal(sessionId, { status: 'archived', pinnedAt: null });
        });
        if (!archivedRowStaysInList) {
          leaveArchivedSession();
        }
      }

      // 关子进程:排在乐观更新之后 —— 它只是 fire-and-forget 地通知 main 收掉 SDK
      // query,不影响列表,没有理由挤在用户等着看到行消失的那一段前面。
      makerChatStore.closeSessionQuery(sessionId);

      try {
        // setStatus 按来源路由(远程走隧道 set-status,本机走原 update);archive 时
        // handler 内部一并 unpin —— 归档列表里不该再保留 pin 标记。
        await sessionService.setStatus(sessionId, targetStatus);
      } catch (err) {
        log.error('[session action]', err);
        // Archive 乐观更新失败的回滚:把 status 改回 active(pinnedAt 已被乐观
        // 清了,如果回滚不补回原值就会丢 pin。但 oldPinnedAt 在闭包里没捕获,
        // 这里只能补 status —— pin 丢失是已知 trade-off,概率极低(只有 DB
        // 写失败这种边界场景才触发)。
        if (action === 'archive') {
          patchLocal(sessionId, { status: 'active' });
        }
        toast.error(
          action === 'delete'
            ? t('ccAgent.sidebar.deleteFailed')
            : t('ccAgent.sidebar.archiveFailed'),
        );
        return;
      }

      if (action === 'delete') {
        // DB 已确认删除成功后再让 sessionsStore 修正所有已加载的筛选桶。
        // 仅刷新当前桶会留下陈旧的 active / all 缓存，切换筛选时已删除会话会短暂重现；
        // 不在写库前乐观移除，避免失败时出现“先消失、再恢复”的反向闪烁。
        patchLocal(sessionId, { status: 'deleted' });
      }

      // MEM-1: Free all in-memory state (messages, base64 images, listeners)
      // for the deleted/archived session now that the server update succeeded.
      makerChatStore.purgeSession(sessionId);
      // composer-draft-per-session: drop any leftover composer draft (text /
      // attachments) for this session — without this the draft Map would
      // hold an orphan entry forever.
      clearComposerDraft(sessionId);
      if (action === 'delete') {
        void window.electronAPI.cleanupSessionImages(sessionId).catch((err: unknown) => {
          log.warn('[session delete] cleanup images failed', err);
        });
        // RSB 布局偏好(fraction / treeWidth / collapsed)按 sessionId 持久化在
        // localStorage,删 session 时一起清掉,避免僵尸数据堆积。
        cleanupSessionLayoutPrefs(sessionId);
      }

      // 写库成功后强制重拉**所有已加载桶**。不 await —— 列表视觉已由上面的
      // patchLocal 就地改好,这里只是让缓存跟 DB 对齐;sessions:list 是
      // LEFT JOIN messages + GROUP BY + latest-message 子查询的重查询,await 它
      // 只会把后面的 refreshWorktrees / delete 跳转推迟几百毫秒。
      //
      // 为什么必须全桶、不能只刷当前桶(codex review):归档时 patchLocal 会 drop
      // 目标桶(archived,本地没有这条的完整 row)并立刻重拉,而那次重拉发生在
      // setStatus 写库**之前**,拿回来的是「还没归档」的快照。本机
      // local-db:sessions:update 又只在 title / settings / project 变化时才广播
      // sessions:patched(status 不在其中),archived 桶再没有别的修正机会 —— 用户
      // 切到「已归档」筛选会看不到刚归档的这条,直到某次无关刷新。
      // 与 unarchiveSession 末尾的 emitRefresh 同口径。
      emitRefresh();
      // 远程会话从侧边栏消失由被控端 sessions:patched{status} 回流(applyPatch 移出分片)驱动,
      // 控制端不再主动重拉 / 不再埋「主动移除」标记(掉线 vs 删除的区分见 CCAgentSessionView 优雅退出)。
      // I-2: delete/archive 都要顺手刷一次 worktree map。上面的 emitRefresh 已经会
      // 触发 WorktreeContext(它订阅 sessionsBus.onRefresh),这里再显式刷一次是为了
      // 不依赖那条链;worktree 回收真正跑完后 main 还会广播 worktree:changed。
      void refreshWorktrees();

      // Archive 已在前面乐观跳到 /cc-agent/new,这里只处理 delete。调用方有列表
      // 上下文时会传入按当前可见顺序解析好的 route；否则回落到 /cc-agent
      // 让 CCAgentIndexRedirect 做默认恢复。
      if (action === 'delete' && sessionId === activeSessionId) {
        navigate(deleteRedirectRoute ?? '/cc-agent');
      }
    },
    [navigate, refreshWorktrees, patchLocal, listFilter, t],
  );

  /**
   * unarchive：archive 的反向操作，无副作用直接 patch，不弹确认。
   * 调用方 filter.status === 'archived' 时，unarchive 后 session 不再匹配筛选，
   * 由 refreshSessions 拉到最新列表后自然消失。
   */
  const unarchiveSession = useCallback(
    async (sessionId: string) => {
      // 乐观更新本地状态，避免 refresh 期间残留 archived 视觉
      patchLocal(sessionId, { status: 'active' });
      try {
        await sessionService.setStatus(sessionId, 'active');
      } catch (err) {
        log.error('[session unarchive]', err);
        toast.error(t('ccAgent.sidebar.unarchiveFailed'));
        await refreshSessions();
        return;
      }
      // 兜底:status 跨桶迁移由 sessionsStore.patchLocal 自动 drop+refetch 相关桶,
      // 这里再 emitRefresh 一次,确保即便存在 pre-fix 陈旧 cache,active/archived/all
      // 三桶都会被强制重拉,跟 DB 对齐(unarchive 频次低,代价可接受)。
      emitRefresh();
    },
    [patchLocal, refreshSessions, t],
  );

  return { runSessionAction, unarchiveSession };
}
