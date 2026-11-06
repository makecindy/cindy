import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  enableGhostCardTaskAutoArchive,
  noteGhostCardTaskUserMessage,
  onGhostCardTaskArchiveRequest,
  takeGhostCardTaskSeen,
} from '@/cindy-brain/ghostCardTaskArchive';
import { getDraftPresence } from '@/lib/composerDraftStore';
import { loadConfirmedActiveBoundScheduleNames } from '@/features/scheduler/lib/archiveScheduleWarning';
import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { isHookSchedulerOrigin } from '@/lib/messageAutomationOrigin';
import { toast } from '@/lib/toast';
import { resolveWorktreeRemovalPreflight } from '@/lib/worktreeRemovalWarning';

import { isSessionRemovalRouteCurrent } from '../lib/sessionRemovalNavigation';
import { useSessionLifecycleActions } from './useSessionLifecycleActions';

/**
 * 插件卡片上的归档任务按钮(见 cindy-brain/ghostCardTaskArchive)在任务页这一侧的处理。
 *
 * - 点按钮:用 archive(与标题栏、快捷键同一套归档流程,带确认)归档这个任务。
 * - 合并后自动归档(只对本机任务):离开任务时,如果已合并的卡片在用户眼前显示过、本次没被取消,而且这个任务
 *   没有在运行、没被接管、确认没绑着定时任务(没读到也算不确认)、输入框里没有草稿、worktree
 *   确认干净,就静默归档,并给一个可撤销的提示。任一条件不满足都不归档,也不弹确认:任务留在列表里。
 * - 这里还把任务里最后一条用户发的消息报告给 ghostCardTaskArchive:待生效之后用户发了消息,
 *   本次自动归档就取消。
 */
/**
 * 这个任务页能不能在用户离开时静默归档它(「离开后自动归档」的静态资格)。登记待生效(卡片上显示提示)
 * 和离开时的归档都用它,提示才不会承诺一件永远不会发生的事:
 * - 只对本机任务:IM 接管状态只能在任务所在电脑上查,远程任务没有确认框兜底就不静默收走
 *   (卡片上的归档按钮照旧可用,走带确认的标准流程);
 * - 任务还是活跃的(已归档的任务没有可归档的);
 * - 没有被远程写入拦截;
 * - 视图本身允许(普通任务页;Orca 分屏里的成员任务和伙伴会话不自动收走)。
 * 动态条件(运行中、被接管、绑着定时任务、有草稿、worktree 不干净)只能在离开那一刻查。
 */
export function canAutoArchiveOnLeave(
  session: Session | null,
  view: { autoArchive: boolean; remoteWritesBlocked: boolean },
): boolean {
  return !!session && view.autoArchive && !view.remoteWritesBlocked &&
    !session.deviceLinkDeviceId && session.status === 'active';
}

export function useGhostCardTaskArchive({
  session,
  archive,
  remoteWritesBlocked,
  autoArchive,
}: {
  session: Session | null;
  archive: () => Promise<void>;
  remoteWritesBlocked: boolean;
  /** 这个任务页离开时是否可以自动归档(普通任务页才可以)。 */
  autoArchive: boolean;
}): void {
  const { t } = useTranslation();
  const { runSessionAction, unarchiveSession } = useSessionLifecycleActions();
  const sessionId = session?.id ?? null;

  useEffect(() => {
    if (!sessionId) return;
    return onGhostCardTaskArchiveRequest((id) => {
      if (id === sessionId) void archive();
    });
  }, [archive, sessionId]);

  // 离开时(换任务或离开任务页)才归档,读的是离开那个任务最后一次渲染时的信息。按任务保存:
  // 从任务 A 直接切到 B 时,新一轮渲染先于 A 的清理函数,只留一份「最新」会读到 B。
  const latest = useRef(new Map<string, LeaveSnapshot>());
  if (session) {
    latest.current.delete(session.id);
    latest.current.set(session.id, { session, remoteWritesBlocked, runSessionAction, unarchiveSession, t });
    // 视图可能连续换很多任务:只留最近几个。
    for (const key of latest.current.keys()) {
      if (latest.current.size <= LEAVE_SNAPSHOTS_KEPT) break;
      latest.current.delete(key);
    }
  }
  const canAutoArchive = canAutoArchiveOnLeave(session, { autoArchive, remoteWritesBlocked });
  useEffect(() => {
    if (!sessionId || !canAutoArchive) return;
    const disable = enableGhostCardTaskAutoArchive(sessionId);
    return () => {
      // 先取「看过」再注销:注销之后自动归档就不再待生效。
      const seen = takeGhostCardTaskSeen(sessionId);
      disable();
      if (!seen) return;
      const snapshot = latest.current.get(sessionId);
      if (snapshot) void autoArchiveLeftTask(snapshot);
    };
  }, [sessionId, canAutoArchive]);

  // 历史加载完成后才报告:还没读到的消息不能当成新消息。
  useEffect(() => {
    if (!sessionId) return;
    const report = () => {
      const state = makerChatStore.getSnapshot(sessionId);
      if (state.historyLoaded) noteGhostCardTaskUserMessage(sessionId, lastUserAuthoredMessage(state.messages));
    };
    report();
    return makerChatStore.subscribe(sessionId, report);
  }, [sessionId]);
}

/**
 * 最后一条由人发出的消息(本机、手机、IM、共享成员都算;自动化、其他任务和插件代发的不算)。
 * 官方 IM Hook 的渠道消息复用 scheduler 形态的 origin,但是真人发的,要算(见 isHookSchedulerOrigin)。
 */
function lastUserAuthoredMessage(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'user' && !m.sourcePlugin && (!m.automationOrigin || isHookSchedulerOrigin(m.automationOrigin))) return m.clientId;
  }
  return null;
}

interface LeaveSnapshot {
  session: Session;
  remoteWritesBlocked: boolean;
  runSessionAction: ReturnType<typeof useSessionLifecycleActions>['runSessionAction'];
  unarchiveSession: (sessionId: string) => Promise<void>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const LEAVE_SNAPSHOTS_KEPT = 4;

async function autoArchiveLeftTask(
  { session, remoteWritesBlocked, runSessionAction, unarchiveSession, t }: LeaveSnapshot,
): Promise<void> {
  const sessionId = session.id;
  // 与登记待生效同一个判断(注册时已经过了一次,这里按离开前最后一次渲染的信息再核一次)。
  if (!canAutoArchiveOnLeave(session, { autoArchive: true, remoteWritesBlocked })) return;
  // 先自己查运行状态:归档流程查到运行中会弹提示,自动归档应该什么都不说。
  if (makerChatStore.getRunningSnapshot().get(sessionId)?.isRunning) return;
  const archived = await runSessionAction(sessionId, 'archive', {
    activeSessionId: null,
    prepareArchive: async (isCurrent) => {
      const attached = await window.electronAPI.binding
        .resolveSession(sessionId)
        .then((binding) => binding.attached)
        .catch(() => true);
      if (attached) return false;
      // 没读到绑定列表不等于没有绑定:静默归档没有确认框兜底,没读到就保留任务。
      const bound = await loadConfirmedActiveBoundScheduleNames([{ id: sessionId }]);
      if (!bound || (bound.get(sessionId)?.length ?? 0) > 0) return false;
      const preflight = await resolveWorktreeRemovalPreflight(sessionId);
      // 检查期间用户又回到这个任务:不在眼前收走它。输入框里还有没发的草稿时也留着(归档会丢掉草稿)。
      return preflight === 'clean' && isCurrent() && !isSessionRemovalRouteCurrent(sessionId) && !getDraftPresence(sessionId);
    },
  });
  if (archived !== true) return;
  toast.success(t('chat.ghostCall.taskAutoArchived', { title: session.title }), {
    duration: 8000,
    action: { label: t('chat.ghostCall.taskAutoArchivedUndo'), onClick: () => { void unarchiveSession(sessionId); } },
  });
}
