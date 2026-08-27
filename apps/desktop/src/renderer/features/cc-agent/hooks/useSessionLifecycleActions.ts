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
import { discardDraft as discardComposerDraft } from '@/lib/composerDraftStore';
import { cleanupSessionLayoutPrefs } from '@/lib/sessionLayoutPrefs';
import { sessionsStore, type SessionStatusTransitionToken } from '@/lib/sessionsStore';
import { useCCSessions } from '@/hooks/useCCSessions';
import { createLogger } from '@/lib/logger';
import type { ListStatusFilter } from '@/lib/sessionService';
import type { Session, SessionStatus } from '@/lib/ccAgent.types';

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
      const actionStartedAt = performance.now();
      const targetStatus: SessionStatus = action === 'delete' ? 'deleted' : 'archived';
      const statusWriteTarget = await sessionService.resolveStatusWriteTarget(sessionId);
      const isDeviceLinkSession = statusWriteTarget.kind === 'device-link';
      let statusTransition: SessionStatusTransitionToken | null = null;
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
        // 后再用 patchLocal 从所有桶移除。
        const archivedRowStaysInList = listFilter === 'all';
        const leaveArchivedSession = () => {
          if (sessionId === activeSessionId) navigate('/cc-agent/new');
        };
        if (archivedRowStaysInList) {
          flushSync(leaveArchivedSession);
        }
        if (!isDeviceLinkSession) {
          statusTransition = await sessionsStore.beginStatusTransitionWhenReady(
            sessionId,
            {
              status: 'archived',
              pinnedAt: null,
            },
            (begin) => {
              let transition: SessionStatusTransitionToken | null = null;
              flushSync(() => {
                transition = begin();
              });
              return transition;
            },
          );
          if (!statusTransition) return;
        }
        if (!archivedRowStaysInList) {
          leaveArchivedSession();
        }
      }

      // 关子进程:排在乐观更新之后 —— 它只是 fire-and-forget 地通知 main 收掉 SDK
      // query,不影响列表,没有理由挤在用户等着看到行消失的那一段前面。
      makerChatStore.closeSessionQuery(sessionId);

      const statusWriteStartedAt = performance.now();
      let statusWriteFinishedAt = statusWriteStartedAt;
      let persisted: Session;
      try {
        // setStatus 按来源路由(远程走隧道 set-status,本机走原 update);archive 时
        // handler 内部一并 unpin —— 归档列表里不该再保留 pin 标记。
        persisted = await sessionService.setStatus(sessionId, targetStatus, statusWriteTarget);
        statusWriteFinishedAt = performance.now();
        if (statusTransition) {
          sessionsStore.completeStatusTransition(statusTransition, persisted);
        }
      } catch (err) {
        log.error('[session action]', err);
        if (statusTransition) sessionsStore.rollbackStatusTransition(statusTransition);
        if (action === 'archive') {
          const failedAt = performance.now();
          log.warn('archive timing', {
            event: 'renderer.session.archive.timing',
            outcome: 'failed',
            sessionId,
            deviceLink: isDeviceLinkSession,
            preWriteMs: Math.round(statusWriteStartedAt - actionStartedAt),
            writeMs: Math.round(failedAt - statusWriteStartedAt),
            totalMs: Math.round(failedAt - actionStartedAt),
          });
        }
        toast.error(
          action === 'delete'
            ? t('ccAgent.sidebar.deleteFailed')
            : t('ccAgent.sidebar.archiveFailed'),
        );
        return;
      }
      const statusConvergedAt = performance.now();

      if (action === 'delete' && !isDeviceLinkSession) {
        // DB 已确认删除成功后再让 sessionsStore 修正所有已加载的筛选桶。
        // 仅刷新当前桶会留下陈旧的 active / all 缓存，切换筛选时已删除会话会短暂重现；
        // 不在写库前乐观移除，避免失败时出现“先消失、再恢复”的反向闪烁。
        patchLocal(sessionId, persisted);
      }

      // MEM-1: Free all in-memory state (messages, base64 images, listeners)
      // for the deleted/archived session now that the server update succeeded.
      makerChatStore.purgeSession(sessionId);
      // composer-draft-per-session: drop any leftover composer draft (text /
      // attachments) for this session — without this the draft Map would
      // hold an orphan entry forever.
      discardComposerDraft(sessionId);
      if (action === 'delete') {
        void window.electronAPI.cleanupSessionImages(sessionId).catch((err: unknown) => {
          log.warn('[session delete] cleanup images failed', err);
        });
        // RSB 布局偏好(fraction / treeWidth / collapsed)按 sessionId 持久化在
        // localStorage,删 session 时一起清掉,避免僵尸数据堆积。
        cleanupSessionLayoutPrefs(sessionId);
      }
      if (action === 'archive') {
        const finishedAt = performance.now();
        log.info('archive timing', {
          event: 'renderer.session.archive.timing',
          outcome: 'success',
          sessionId,
          deviceLink: isDeviceLinkSession,
          preWriteMs: Math.round(statusWriteStartedAt - actionStartedAt),
          writeMs: Math.round(statusWriteFinishedAt - statusWriteStartedAt),
          convergeMs: Math.round(statusConvergedAt - statusWriteFinishedAt),
          cleanupMs: Math.round(finishedAt - statusConvergedAt),
          totalMs: Math.round(finishedAt - actionStartedAt),
        });
      }

      // sessionsStore 已用任一缓存桶中的完整 row 同步迁移 active / archived / all；
      // 完全找不到 row 时也只合并补查目标桶。这里不再发全局 refresh，避免连续归档
      // 把每次状态写放大成所有已加载桶的一轮 fresh 查询。
      // 远程会话从侧边栏消失由被控端 sessions:patched{status} 回流(applyPatch 移出分片)驱动,
      // 控制端不再主动重拉 / 不再埋「主动移除」标记(掉线 vs 删除的区分见 CCAgentSessionView 优雅退出)。

      // Archive 已在前面乐观跳到 /cc-agent/new,这里只处理 delete。调用方有列表
      // 上下文时会传入按当前可见顺序解析好的 route；否则回落到 /cc-agent
      // 让 CCAgentIndexRedirect 做默认恢复。
      if (action === 'delete' && sessionId === activeSessionId) {
        navigate(deleteRedirectRoute ?? '/cc-agent');
      }
    },
    [navigate, patchLocal, listFilter, t],
  );

  /**
   * unarchive：archive 的反向状态事务，不弹确认。若归档仍在写库，先等它收敛，
   * 再以完整归档行作为恢复失败时的回滚基线。
   */
  const unarchiveSession = useCallback(
    async (sessionId: string) => {
      const statusWriteTarget = await sessionService.resolveStatusWriteTarget(sessionId);
      const isDeviceLinkSession = statusWriteTarget.kind === 'device-link';
      const statusTransition = isDeviceLinkSession
        ? null
        : await sessionsStore.beginStatusTransitionWhenReady(sessionId, { status: 'active' });
      if (!isDeviceLinkSession && !statusTransition) return;
      try {
        const persisted = await sessionService.setStatus(sessionId, 'active', statusWriteTarget);
        if (statusTransition) {
          sessionsStore.completeStatusTransition(statusTransition, persisted);
        }
      } catch (err) {
        log.error('[session unarchive]', err);
        if (statusTransition) sessionsStore.rollbackStatusTransition(statusTransition);
        toast.error(t('ccAgent.sidebar.unarchiveFailed'));
        if (!statusTransition && !isDeviceLinkSession) await refreshSessions();
        return;
      }
    },
    [refreshSessions, t],
  );

  return { runSessionAction, unarchiveSession };
}
