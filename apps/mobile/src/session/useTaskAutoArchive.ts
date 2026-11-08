import { useEffect, useRef } from 'react';
import { useIsFocused, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { getRemoteResource } from '@/device-link/remoteResources';
import { lastUserAuthoredClientId, taskAutoArchive } from '@/plugins/taskAutoArchive';
import { loadConfirmedActiveBoundScheduleNames } from '@/session/archiveScheduleConfirm';
import { readComposerDocumentDraft, readComposerDraft } from '@/session/composerDraftStore';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { showTaskArchiveUndo } from '@/session/TaskArchiveUndoNotice';
import type { RemoteMessage, RemoteSession } from '@/session/types';

type PatchSession = (session: RemoteSession, patch: { status: 'archived' | 'active' }) => Promise<void>;

/**
 * 插件卡片上的归档任务按钮(见 plugins/taskAutoArchive)在手机任务页这一侧的处理,与电脑端
 * useGhostCardTaskArchive 同一套规则:
 *
 * - 点「立即归档」:走与右上角菜单相同的归档流程(带自动化确认)。
 * - 合并后自动归档:离开任务页时,如果已合并的卡片在用户眼前显示过、本次没被取消,并且电脑端重新确认
 *   (再读一次卡片)任务全部 PR 已合并、没被 IM 接管,任务还是活跃的、没在运行、确认没绑着活跃自动化
 *   (没读到也算不确认)、手机输入框里没有草稿、worktree 确认干净,用户也没回到这个任务,就静默归档,
 *   并给一个可撤销的提示。任一条件不满足都不归档,也不弹确认:任务留在列表里。
 * - 这里还把任务里最后一条用户发的消息报告给 taskAutoArchive:待生效之后用户发了消息,本次就取消。
 */
export function useTaskAutoArchive({
  session,
  deviceId,
  invoke,
  enabled,
  historyLoaded,
  messages,
  archive,
  patchSession,
}: {
  session: RemoteSession | null;
  deviceId: string | undefined;
  invoke: RemoteInvoke;
  /** 普通任务页(不是主机托管、协同成员或伙伴会话),离开时才可以自动归档。 */
  enabled: boolean;
  /** 本次进入后历史已与电脑同步过:之前读到的最后一条消息不能当成「新消息」。 */
  historyLoaded: boolean;
  messages: readonly RemoteMessage[];
  /** 与菜单「归档」相同的流程(带确认)。 */
  archive: () => void;
  patchSession: PatchSession;
}): void {
  const { t } = useTranslation();
  const sessionId = session?.id ?? null;

  const archiveRef = useRef(archive);
  archiveRef.current = archive;
  useEffect(() => {
    if (!sessionId) return;
    return taskAutoArchive.onArchiveRequest((id) => {
      if (id === sessionId) archiveRef.current();
    });
  }, [sessionId]);

  // 离开时读的是离开那个任务最后一次渲染时的信息。按任务保存:任务抽屉从 A 原地切到 B 时,
  // 新一轮渲染先于 A 的清理函数,只留一份「最新」会读到 B。
  const latest = useRef(new Map<string, LeaveSnapshot>());
  if (session && deviceId) {
    latest.current.delete(session.id);
    latest.current.set(session.id, { session, deviceId, invoke, patchSession, t });
    // 视图可能连续换很多任务:只留最近几个。
    for (const key of latest.current.keys()) {
      if (latest.current.size <= LEAVE_SNAPSHOTS_KEPT) break;
      latest.current.delete(key);
    }
  }
  // 离开 = 卸载、原地换任务,或失焦且聚焦的是另一个任务页(任务链接、来源任务用 push,本页仍挂在栈里)。
  // 失焦到文件、设置这类非任务页不算离开。回到本任务页时重新登记,核对中途回来的会放弃。
  const focused = useIsFocused();
  const pathname = usePathname();
  const movedToOtherTask = !focused && isOtherTaskPath(pathname, sessionId);
  const canAutoArchive = enabled && !!deviceId && session?.status === 'active' && !movedToOtherTask;
  useEffect(() => {
    if (!sessionId || !canAutoArchive) return;
    const owner = getMobileAuthOwner();
    const disable = taskAutoArchive.enable(sessionId);
    return () => {
      // 先取「看过」再注销:注销之后自动归档就不再待生效。
      const seen = taskAutoArchive.takeSeen(sessionId);
      const cards = taskAutoArchive.armedCards(sessionId);
      disable();
      const snapshot = latest.current.get(sessionId);
      if (seen && snapshot) void autoArchiveLeftTask({ ...snapshot, cards, owner });
    };
  }, [sessionId, canAutoArchive]);

  // 历史同步完成后才报告:还没读到的消息不能当成新消息。
  const lastUserMessage = historyLoaded ? lastUserAuthoredClientId(messages) : undefined;
  useEffect(() => {
    if (sessionId && lastUserMessage !== undefined) taskAutoArchive.noteUserMessage(sessionId, lastUserMessage);
  }, [sessionId, lastUserMessage]);
}

/** 任务页路径是 `/sessions/<id>`(含新建页 `/sessions/new`);文件、设置等路径不是。 */
function isOtherTaskPath(pathname: string, sessionId: string | null): boolean {
  const match = /^\/sessions\/([^/?#]+)/.exec(pathname);
  if (!match || !sessionId) return false;
  try { return decodeURIComponent(match[1]) !== sessionId; } catch { return true; }
}

interface LeaveSnapshot {
  session: RemoteSession;
  deviceId: string;
  invoke: RemoteInvoke;
  patchSession: PatchSession;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const LEAVE_SNAPSHOTS_KEPT = 4;

const CARD_PRIMITIVES = ['plugin-card-actions', 'plugin-card-forms', 'plugin-card-rich'];

/** 电脑端此刻的判断:任一张符合条件的卡片仍带 `taskArchive.auto`(全部 PR 已合并、没被 IM 接管)。 */
async function hostStillAllowsAutoArchive(invoke: RemoteInvoke, deviceId: string, sessionId: string, cards: readonly string[]): Promise<boolean> {
  for (const callId of cards) {
    try {
      const resource = await getRemoteResource(invoke, { deviceId, deviceName: deviceId },
        { collectionId: 'plugin-results', kind: 'card', id: JSON.stringify([sessionId, callId]) }, undefined, CARD_PRIMITIVES);
      const data = resource.blocks?.find((block) => block.primitive === 'plugin-card-actions')?.data as { taskArchive?: { auto?: unknown } } | undefined;
      if (data?.taskArchive?.auto === true) return true;
    } catch {
      // 读不到这一张就看下一张;都读不到不归档。
    }
  }
  return false;
}

/** 静默归档没有确认框兜底:查询失败按「有改动」处理,保留任务。 */
async function worktreeConfirmedClean(invoke: RemoteInvoke, deviceId: string, sessionId: string): Promise<boolean> {
  try {
    const preview = await invoke<{ hasWorktree?: unknown; dirty?: unknown }>(deviceId, 'worktree:removal-preview', [sessionId]);
    return !!preview && (preview.hasWorktree !== true || preview.dirty === false);
  } catch {
    return false;
  }
}

async function hasComposerDraft(sessionId: string): Promise<boolean> {
  const [text, document] = await Promise.all([
    readComposerDraft(sessionId).catch(() => 'unknown'),
    readComposerDocumentDraft(sessionId).catch(() => null),
  ]);
  return !!text?.trim() || !!document;
}

async function autoArchiveLeftTask({ session, deviceId, invoke, patchSession, t, cards, owner }: LeaveSnapshot & {
  cards: readonly string[];
  owner: ReturnType<typeof getMobileAuthOwner>;
}): Promise<void> {
  const sessionId = session.id;
  const current = () => remoteSessionStore.getSessions().find((s) => s.id === sessionId);
  // 用户又回到了这个任务(任务页重新登记),或换了账号:不在眼前收走它。
  const stillAway = () => isMobileAuthOwnerCurrent(owner) && taskAutoArchive.getState(sessionId) === 'inactive';
  const ok = () => stillAway() && current()?.status === 'active' && !remoteSessionStore.isSessionRunning(sessionId);
  if (!cards.length || !ok()) return;
  // 先核对完再归档:放进列表的归档事务里核对,首页会先移走这一行、核对失败再放回来。
  if (!await hostStillAllowsAutoArchive(invoke, deviceId, sessionId, cards) || !ok()) return;
  const bound = await loadConfirmedActiveBoundScheduleNames({ deviceId, invoke, sessionId, source: session.source });
  if (!bound || bound.length > 0 || !ok()) return;
  if (await hasComposerDraft(sessionId) || !ok()) return;
  if (!await worktreeConfirmedClean(invoke, deviceId, sessionId) || !ok()) return;
  // 归档成功后任务会从手机的活跃列表里移走,所以撤销用归档前取到的任务快照,不再读列表。
  const target = current() ?? session;
  try {
    await patchSession(target, { status: 'archived' });
  } catch {
    // 失败已由列表事务恢复;静默归档不弹错误。
    return;
  }
  // 写入被后来的操作取代时(任务仍在活跃列表里)没有归档,不提示。
  if (current()?.status === 'active' || !isMobileAuthOwnerCurrent(owner)) return;
  const title = projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')).trim() || t('devices.list.untitled');
  showTaskArchiveUndo(title, () => {
    if (isMobileAuthOwnerCurrent(owner)) void patchSession({ ...target, status: 'archived' }, { status: 'active' }).catch(() => {});
  });
}
