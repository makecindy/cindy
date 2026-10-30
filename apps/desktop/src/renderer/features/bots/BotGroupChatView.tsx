import { RemoveChatFromListButton } from './RemoveChatFromListButton';
import { ChatInviteDialog } from './ChatInviteDialog';
import { useThreadPanelResize } from './useThreadPanelResize';
import { cn } from '@/lib/utils';
/**
 * 群聊页：顶栏（成员头像、群名、成员与负责人、此刻谁在做什么、群设置入口）+ 多作者时间线 +
 * 进行中条 + 输入框。
 *
 * 数据全部来自 main（docs/product-rules/bot-group-chat.md §3）：进入时读一页最新消息，之后每条
 * `onBotGroupChanged` 推送（含分工的 `'plan'`）都重读最新一页。读取同一时刻只有一个在飞，期间
 * 来的推送合并成一次补读——一阵推送也会边到边显示，较新的结果从不被丢掉。新的一页**并入**
 * 屏幕上已有的消息（BotGroupTimelineModel.ts）：被新消息挤出最新页的旧消息留着，不出缺口、
 * 不跳；内容没变的消息沿用原对象，memo 过的消息行不重绘。账号（data owner）代次照旧作废
 * 迟到的回包。更早的消息按需翻页，连同其引用的安排合并进当前时间线。
 *
 * 发送是乐观的：按下发送，自己的消息立刻出现在末尾（发送中略淡），main 的详情里出现这条消息
 * 后原地换成正式那条（同一个 React key，不闪不跳）；失败优先放回空输入框，否则留在原行重试。
 *
 * 分工（§7）：安排卡、交接文件与「下一步 · 继续」「没做完 · 重试」见 BotGroupPlan.tsx；进行中
 * 条、发言行与顶栏状态见 BotGroupLiveStatus.tsx；这里把安排快照接到对应消息上并调用 main。
 *
 * 引用回复（§10）：页面持有本群的待发引用（随群切换整页重建，不会串群）；已发消息上的
 * 引用块以已加载的原消息为准，点击跳到原消息并高亮，原消息不在已加载范围时向前翻几页找。
 *
 * 附件（§3.1）：托盘状态（`useAttachments`）由页面持有，文件拖到页面任意位置都进托盘，
 * 与普通任务的整区拖入一致；消息上的图片与文件复用普通聊天用户气泡的图片视图与附件 chip。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw, Settings2 } from 'lucide-react';
import { useBotGroupWorkTargets } from './useBotGroupWorkTargets';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { attachGhostMediaToSession, getGhostMediaHandoverFromDataTransfer } from '@/cindy-brain/ghostMediaHandover';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { NewMessageIndicator } from '@/components/chat/NewMessageIndicator';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useAttachments } from '@/hooks/useAttachments';
import { discardDraft } from '@/lib/composerDraftStore';
import {
  classifyUnclassifiedDroppedItems,
  getDroppedFileItems,
  type DroppedFileItems,
} from '@/lib/fileDrop';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import { toast } from '@/lib/toast';
import { ControlledBanner, useControlledBy, useComposerCollapsed } from '@/features/remote-device/ControlledBanner';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import type {
  BotGroupMemberView,
  BotGroupDetail,
  BotGroupMessageView,
  BotGroupPlanAction,
  BotGroupPlanStepView,
  BotGroupQuoteDisplay,
  BotGroupQuoteView,
} from '../../../shared/botGroupChat';
import { botGroupQuoteFromMessage, isBotGroupMessageQuotable, resolveBotGroupQuote } from '../../../shared/botGroupChat';
import { useRegisterContentHeader } from '../feature-context';
import { BotGroupAvatarStack } from './BotGroupAvatars';
import { botGroupAttachmentScope, refreshPendingBotGroupAttachments } from './botGroupAttachments';
import { BotGroupComposer } from './BotGroupComposer';
import { BotGroupThreadHint } from './BotGroupThreadHint';
import { findThreadMessageElement, flashThreadTarget } from './BotGroupThreadViews';
import {
  BotGroupHeaderStatusText,
  BotGroupProgressStrip,
  BotGroupSpeakerInteraction,
  BotGroupSpeakingLine,
  botGroupHeaderStatus,
  type BotGroupLiveSpeaker,
} from './BotGroupLiveStatus';
import { messageReactionRevision } from './ChatServerControls';
import { ChatGroupInviteMenu } from './ChatGroupInviteMenu';
import { animateThreadPanelWidth, ChatThreadPanel } from './ChatThreadPanel';
import {
  BotGroupPlanFollowUpRow,
  type BotGroupFollowUpAction,
  type BotGroupPlanCardAction,
} from './BotGroupPlan';
import { BotGroupDateDivider, BotGroupTimelineItem } from './BotGroupTimelineItem';
import {
  botGroupHandoffStepNumbers,
  botGroupMemberDisplayName,
  botGroupOwnedBotNames,
  layoutBotGroupTimeline,
  mergeBotGroupLatestPage,
  pendingBotGroupMessage,
  pendingBotGroupMessageId,
  runningBotGroupPlanStep,
  stabilizeById,
  type BotGroupLoadedTimeline,
  type BotGroupTimelineMessage,
} from './BotGroupTimelineModel';
import {
  BOT_GROUP_SETTINGS_PARAM,
  botGroupComposerPlanState,
  botGroupNewMessageCount,
  botGroupErrorKey,
  botGroupMemberNames,
  botGroupPlanFollowUp,
  continuableRoundEndId,
  mergeBotGroupMessages,
  projectBotGroupExecutionFailures,
  mergeBotGroupPlans,
  openBotGroupPlan,
} from './botGroupPresentation';
import { botGroupApi, editBotGroupPlanStep, runBotGroupPlanAction, setBotGroupAutoContinue, useBotGroupSummary } from './botGroupStore';
import { botGroupReadKey, markBotRead } from './botReadState';
import { useGroupMask, useReadLocatedMention, type GroupMaskMention } from './groupMaskPresentation';
import {
  beginBotGroupTimelineRead, discardBotGroupOutbox, getBotGroupOutboxClaims,
  getBotGroupOutboxPreviews, interleaveBotGroupOutbox, mergeBotGroupLocalAttachments,
  noteBotGroupTimeline, projectBotGroupOutbox, useBotGroupOutbox,
} from './botGroupOutbox';

type GroupViewState =
  | { kind: 'loading' }
  | ({ kind: 'ready'; readToken: number } & BotGroupLoadedTimeline)
  | { kind: 'missing' }
  | { kind: 'error' };

/** Toast copy when a plan action fails without a more specific cause. */
const PLAN_ACTION_FAILED: Record<BotGroupPlanAction, string> = {
  start: 'bots.groupChat.plan.startFailed',
  dismiss: 'bots.groupChat.plan.dismissFailed',
  continue: 'bots.groupChat.timeline.continuePlanFailed',
  retry: 'bots.groupChat.timeline.retryFailed',
};

type PlanPending = { planId: string; action: BotGroupPlanAction | 'edit' };

/** A read that lands within this needs no progress indicator, so a fast switch does not flash. */
const TIMELINE_LOADING_REVEAL_MS = 200;
/** Older pages read while looking for a quoted message before saying it is out of reach. */
const QUOTE_LOCATE_MAX_PAGES = 5;
const QUOTE_HIGHLIGHT_MS = 2000;
/** The reader counts as at the bottom within this distance. */
const STICK_TO_BOTTOM_PX = 48;
/** Read marks follow scrolling at most this often (leading edge, plus one trailing mark). */
const ACKNOWLEDGE_THROTTLE_MS = 150;
/** Match the phone's direct-chat recovery without polling healthy timelines. */
const TIMELINE_READ_RECOVERY_MS = 30_000;
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Originals that loaded quotes point at and that sit only on older pages, newest first. A push
 * refresh re-reads just the latest page, so these may have been edited or deleted since.
 */
function quotedOlderOriginals(
  older: readonly BotGroupMessageView[],
  latest: readonly BotGroupMessageView[],
): BotGroupMessageView[] {
  const latestIds = new Set(latest.map((message) => message.id));
  const olderById = new Map(older.filter((message) => !latestIds.has(message.id)).map((message) => [message.id, message]));
  const ids = new Set([...older, ...latest].flatMap((message) => {
    const target = message.quote?.messageId;
    return target && !latestIds.has(target) && olderById.has(target) ? [target] : [];
  }));
  return [...ids].map((id) => olderById.get(id)!).sort((a, b) => b.sequence - a.sequence);
}

/** The previous value while `key` is unchanged (member arrays are new on every read). */
function useStableByKey<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}

/** Same objects for unchanged rows, so memoized rows skip rendering. */
function useStableRows<T extends { id: string }>(rows: T[]): T[] {
  const ref = useRef<T[]>(rows);
  ref.current = stabilizeById(ref.current, rows);
  return ref.current;
}

/**
 * Files from the system or media dragged out of a Plugin panel. Plain text keeps its
 * native drop into the input.
 */
function isAttachmentDrag(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes('Files') || types.includes('text/uri-list');
}

export function BotGroupChatView() {
  const { groupId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [createdInvite, setCreatedInvite] = useState<{ groupId: string; owner: ReturnType<typeof getDataOwnerGeneration> } | null>(null);
  const createdGroup = useBotGroupSummary(createdInvite?.groupId ?? null);
  const direct = new URLSearchParams(location.search).get('conversationKind') === 'direct';
  useEffect(() => {
    if (!groupId || direct || location.state?.createdGroupInvite !== groupId) {
      setCreatedInvite(current => current?.groupId !== groupId || direct ? null : current);
      return;
    }
    setCreatedInvite({ groupId, owner: getDataOwnerGeneration() });
    // Consume the one-off intent so Back, Forward or a refresh cannot create another link.
    navigate(location.pathname + location.search, { replace: true, state: { ...location.state, createdGroupInvite: null } });
  }, [groupId, direct, location.state, location.pathname, location.search, navigate]);
  return <>
    <BotGroupChatContent key={`${groupId}:${direct}`} groupId={groupId ?? ''} direct={direct} />
    {createdInvite !== null && createdInvite.groupId === groupId && !direct && isDataOwnerGenerationCurrent(createdInvite.owner)
      ? <ChatInviteDialog key={groupId} groupId={groupId} created members={createdGroup?.members} onClose={() => setCreatedInvite(null)} /> : null}
  </>;
}

function BotGroupChatContent({ groupId, direct }: { groupId: string; direct: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const controlledBy = useControlledBy();
  const hasControlledBanner = controlledBy.length > 0;
  // Groups have no single task session; namespace their existing composer UI state.
  const controlledBannerKey = `bot-group:${groupId}`;
  const shareScope = controlledBannerKey;
  const sharing = useShareSelectionActive(shareScope);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const controlledBannerCollapsed = useComposerCollapsed(controlledBannerKey);
  const navigate = useNavigate();
  const location = useLocation();
  const notificationTarget = useMemo(() => {
    const query = new URLSearchParams(location.search);
    const messageId = query.get('messageId');
    const threadRootId = query.get('threadRootId');
    return messageId && /^[0-9a-f-]{36}$/i.test(messageId)
      && (!threadRootId || /^[0-9a-f-]{36}$/i.test(threadRootId)) ? { messageId, threadRootId } : null;
  }, [location.search]);
  const handledNotification = useRef<string | null>(null);
  const [state, setState] = useState<GroupViewState>({ kind: 'loading' });
  const stateRef = useRef(state); stateRef.current = state;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const loadRef = useRef<(additionalSources?: string[], changedIds?: string[]) => void>(() => {});
  const resetHistoryRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [seenThrough, setSeenThrough] = useState<string | null>(null);
  const readOwner = useRef(getDataOwnerGeneration());
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const attachmentScope = botGroupAttachmentScope(groupId);
  const attachmentState = useAttachments(attachmentScope, attachmentScope);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  /** 引用回复 waiting in this group's composer; the page is rebuilt per group. */
  const [quoteDraft, setQuoteDraft] = useState<BotGroupQuoteView | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** Quoted originals on older pages not re-read since the last push: quotes use their snapshot. */
  const [unverifiedOriginals, setUnverifiedOriginals] = useState<ReadonlySet<string>>(NO_IDS);
  const loadingOlderRef = useRef(false);
  const locatingRef = useRef(false);

  // Every older-page read belongs to the generation visible when it started. A
  // reset discovered here must also cancel in-flight latest-page/auxiliary reads.
  const acceptHistoryPage = useCallback((page: BotGroupDetail, revision: string | undefined) => {
    const current = stateRef.current;
    if (current.kind !== 'ready' || current.group.historyRevision !== revision) return false;
    if (page.historyRevision && page.historyRevision !== revision) {
      resetHistoryRef.current();
      return false;
    }
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const discardOutbox = () => {
      const shown = stateRef.current;
      discardBotGroupOutbox(groupId);
      if (shown.kind === 'ready' && shown.group.id !== groupId) discardBotGroupOutbox(shown.group.id);
    };
    /** Bumped when a read starts (and on delete): re-checks spawned by older reads stop. */
    let version = 0;
    let inFlight = false;
    let queued: { sources: string[]; changed: string[] } | null = null;
    // A queued read can finish before React commits the previous successful snapshot.
    let hasTimeline = stateRef.current.kind === 'ready';
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const clearRetry = () => {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const retryRead = (owner: ReturnType<typeof getDataOwnerGeneration>, sources: string[], changed: string[]) => {
      // A first read already has an explicit retry; keep the visible history on a failed refresh.
      if (!hasTimeline) return;
      clearRetry();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!cancelled && isDataOwnerGenerationCurrent(owner)) load(sources, changed);
      }, TIMELINE_READ_RECOVERY_MS);
    };
    const run = async (additionalSources: string[], changedIds: string[]) => {
      clearRetry();
      inFlight = true;
      const current = ++version;
      const readToken = beginBotGroupTimelineRead();
      const owner = getDataOwnerGeneration();
      const api = botGroupApi();
      const isCurrent = () => !cancelled && current === version && isDataOwnerGenerationCurrent(owner);
      // Reads run one at a time, so a result is never older than what is on screen; only the
      // account (data owner) or a delete can make it stale.
      const isApplicable = () => !cancelled && isDataOwnerGenerationCurrent(owner) && current <= version;
      try {
        if (!api || !groupId) {
          if (isApplicable()) setState({ kind: groupId ? 'error' : 'missing' });
          return;
        }
        const displayed = stateRef.current;
        if (!hasTimeline && reloadVersion === 0) void api.getBotGroup(groupId, { cacheOnly: true, ...(direct ? { conversationKind: 'direct' } : {}) }).then(cached => {
          if (!cached.ok || hasTimeline || !isCurrent()) return;
          hasTimeline = true;
          setState({ kind: 'ready', group: cached.group, older: [], olderPlans: [], olderHasMore: cached.group.hasMoreBefore, readToken: 0 });
        }).catch(() => undefined);
        const shown = displayed.kind === 'ready' && displayed.group.id === groupId;
        const sourceMessageIds = [...new Set([...(shown
          ? mergeBotGroupMessages(displayed.older, displayed.group.messages).map(message => message.id) : []), ...additionalSources])];
        // Older pages are not re-read, so their shares ask for the reply's current state.
        const shownShares = shown ? botGroupShownShares(displayed.older) : [];
        const result = sourceMessageIds.length || shownShares.length
          ? await api.getBotGroup(groupId, { ...(direct ? { conversationKind: 'direct' as const } : {}), sourceMessageIds, ...(shownShares.length ? { shownShares } : {}) })
          : await api.getBotGroup(groupId, direct ? { conversationKind: 'direct' } : undefined);
        if (!isApplicable()) return;
        if (result.ok) {
          hasTimeline = true;
          readOwner.current = owner;
          const shown = stateRef.current;
          setState((previous) => {
            if (previous.kind !== 'ready') {
              return { kind: 'ready', group: result.group, older: [], olderPlans: [], olderHasMore: result.group.hasMoreBefore, readToken };
            }
            const merged = mergeBotGroupLatestPage(previous, result.group);
            merged.older = applyBotGroupThreadShareUpdates(merged.older, result.group);
            return { kind: 'ready', ...merged, readToken };
          });
          if (shown.kind === 'ready') {
            const quoted = quotedOlderOriginals([...shown.older, ...shown.group.messages], result.group.messages);
            // A message changed here (a reaction) that sits only on an opened older page: the
            // latest page cannot refresh its copy, so its page is re-read like a quoted original's.
            const latestIds = new Set(result.group.messages.map((message) => message.id));
            const changed = shown.older.filter((message) => changedIds.includes(message.id)
              && !latestIds.has(message.id) && !quoted.some((target) => target.id === message.id));
            const targets = [...quoted, ...changed].sort((a, b) => b.sequence - a.sequence);
            if (targets.length > 0) void recheckOlderCopies(api, targets, result.group.historyRevision, isCurrent);
          }
          if (displayed.kind === 'ready' && displayed.group.id === groupId && result.group.messages.length > 0) {
            const latestFrom = Math.min(...result.group.messages.map((message) => message.sequence));
            const refreshed = await refreshPendingBotGroupAttachments(displayed.older, latestFrom, async (before) => {
              const page = await api.getBotGroup(groupId, { ...(direct ? { conversationKind: 'direct' as const } : {}), beforeSequence: before });
              return page.ok && isCurrent() && acceptHistoryPage(page.group, result.group.historyRevision) ? page.group.messages : null;
            });
            if (refreshed && isCurrent()) {
              const fresh = new Map(refreshed.map((message) => [message.sequence, message]));
              setState((previous) => previous.kind === 'ready' && previous.group.id === groupId
                ? { ...previous, older: previous.older.map((message) => fresh.get(message.sequence) ?? message) }
                : previous);
            }
          }
        } else if (result.errorCode === 'NOT_FOUND' || result.errorCode === 'PERMISSION_DENIED') {
          // A disk read started beside this request may finish after the rejection.
          // It must never restore a conversation whose access was just revoked.
          version += 1;
          hasTimeline = false;
          discardOutbox();
          setState({ kind: 'missing' });
        } else {
          // Keep a timeline that is already on screen; only a first read fails loudly.
          setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
          if (['REQUEST_TIMEOUT', 'SERVICE_ERROR', 'CHAT_UNAVAILABLE', 'HOST_NOT_READY', 'INTERNAL'].includes(result.errorCode)) {
            retryRead(owner, additionalSources, changedIds);
          }
        }
      } catch {
        if (isApplicable()) {
          setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
          retryRead(owner, additionalSources, changedIds);
        }
      } finally {
        inFlight = false;
        if (queued && !cancelled) {
          const next = queued;
          queued = null;
          void run(next.sources, next.changed);
        }
      }
    };
    /**
     * One read in flight; pushes meanwhile collapse into one follow-up read. `changedIds` are
     * messages this client just changed (a reaction): their copies on opened older pages are
     * re-read, since the latest page does not cover them.
     */
    const load = (additionalSources: string[] = [], changedIds: string[] = []) => {
      if (inFlight) {
        queued = { sources: [...(queued?.sources ?? []), ...additionalSources], changed: [...(queued?.changed ?? []), ...changedIds] };
        return;
      }
      void run(additionalSources, changedIds);
    };
    /**
     * Re-reads the older pages holding quoted originals (and copies this client changed) after a
     * push and updates only messages already loaded; history that was never opened is not fetched.
     * Each read covers at least the newest remaining target, so it ends after at most one read per
     * target. A newer read supersedes this one; a failed read leaves the rest unverified, so their
     * quotes show the snapshot, not the stale copy.
     */
    const recheckOlderCopies = async (
      api: NonNullable<ReturnType<typeof botGroupApi>>,
      targets: BotGroupMessageView[],
      historyRevision: string | undefined,
      isCurrent: () => boolean,
    ) => {
      setUnverifiedOriginals((previous) => new Set([...previous, ...targets.map((target) => target.id)]));
      let remaining = targets;
      for (let page = 0; remaining.length > 0 && page < targets.length; page += 1) {
        let messages: BotGroupMessageView[] | null = null;
        try {
          const read = await api.getBotGroup(groupId, { ...(direct ? { conversationKind: 'direct' as const } : {}), beforeSequence: remaining[0]!.sequence + 1 });
          messages = read.ok && isCurrent() && acceptHistoryPage(read.group, historyRevision) ? read.group.messages : null;
        } catch {
          messages = null;
        }
        if (!isCurrent() || !messages) return;
        const fresh = new Map(messages.map((message) => [message.id, message]));
        const oldest = messages.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
        const covered = remaining.filter((target) => fresh.has(target.id) || target.sequence >= oldest);
        setState((previous) => previous.kind === 'ready'
          ? { ...previous, older: previous.older.map((message) => fresh.get(message.id) ?? message) }
          : previous);
        // An original missing from a page that covers it is no longer readable here: it stays unverified.
        setUnverifiedOriginals((previous) => {
          const next = new Set(previous);
          for (const target of covered) if (fresh.has(target.id)) next.delete(target.id);
          return next;
        });
        remaining = remaining.filter((target) => !covered.includes(target));
        if (covered.length === 0) return;
      }
    };
    loadRef.current = (additionalSources, changedIds) => load(additionalSources, changedIds);
    resetHistoryRef.current = () => {
      cancelled = true;
      queued = null;
      clearRetry();
      prependAnchorRef.current = null;
      stateRef.current = { kind: 'loading' };
      setState(stateRef.current);
      setReloadVersion(value => value + 1);
    };
    load();
    const unsubscribe =
      botGroupApi()?.onBotGroupChanged?.((payload, ownerStamp) => {
        if (cancelled || !isDataOwnerPushCurrent(ownerStamp) || payload.groupId !== groupId) return;
        if (payload.change === 'deleted' || (payload.change === 'list' && payload.listState?.hidden)) {
          cancelled = true;
          queued = null;
          clearRetry();
          // Unsent attachments go with the group (staged copies included).
          discardDraft(botGroupAttachmentScope(groupId));
          discardOutbox();
          setState({ kind: 'missing' });
          // The authoritative hide can unmount the drawer before its IPC reply.
          // This mounted page owns selection, so clear the route here as well.
          if (payload.change === 'list') navigate('/bots');
          return;
        }
        load();
      }) ?? (() => {});
    return () => {
      cancelled = true;
      queued = null;
      clearRetry();
      version += 1;
      loadRef.current = () => {};
      resetHistoryRef.current = () => {};
      unsubscribe();
    };
  }, [groupId, reloadVersion, navigate, acceptHistoryPage]);

  // An older page may land across a refresh. Recheck that set once per version; source
  // and attachment completion pushes then refresh every displayed share together.
  // The derived key stays unchanged if a read cannot confirm a source, avoiding a loop.
  const staleSharesKey = state.kind === 'ready' && staleBotGroupShares(state.older, state.group.threadShareVersion).length
    ? JSON.stringify([state.group.threadShareVersion, staleBotGroupShares(state.older, state.group.threadShareVersion).map(message => message.id)]) : '';
  useEffect(() => {
    if (staleSharesKey) loadRef.current();
  }, [staleSharesKey]);

  const group = state.kind === 'ready' ? state.group : null;
  // Until the timeline arrives, the header comes from the group's sidebar row (same account).
  const listed = useBotGroupSummary(state.kind === 'loading' || state.kind === 'error' ? groupId : null);
  const headerGroup = group ?? listed;
  const members = useStableByKey(headerGroup?.members ?? [], JSON.stringify(headerGroup?.members ?? []));
  const memberById = useMemo(() => new Map(members.map((member) => [member.botId, member])), [members]);
  const displayName = useCallback((member: BotGroupMemberView) => botGroupMemberDisplayName(member), []);
  const avatarById = useMemo(() => new Map(members.map((member) => [member.botId, {
    name: botGroupMemberDisplayName(member), avatar: member.avatar ?? null, avatarUrl: member.avatarUrl, avatarColor: member.avatarColor ?? null,
  }])), [members]);
  const allLabel = t('bots.groupChat.mention.all');
  const mentionLabels = useMemo(
    () => [allLabel, ...members.flatMap((member) => [member.name, botGroupMemberDisplayName(member), member.nickname || member.displayName || member.name])],
    [allLabel, members],
  );

  const realMessages = useMemo(
    () => (state.kind === 'ready' ? projectBotGroupExecutionFailures(mergeBotGroupMessages(state.older, state.group.messages), state.group.executionFailures) : []),
    [state],
  );
  /** Thread replies already in the loaded main chat, with the share to reveal. */
  const sharedReplies = useMemo(() => {
    const shares = new Map<string, { messageId: string; bySelf: boolean }>();
    for (const message of realMessages) {
      const share = message.threadShare;
      // Only a share the server resolved inside its claimed thread stands for that reply.
      if (share?.status !== 'available') continue;
      const bySelf = message.authorKind === 'user' && message.isSelf !== false;
      // Prefer the reader's own share: it is the one a repeat would return.
      if (!shares.has(share.messageId) || bySelf) shares.set(share.messageId, { messageId: message.id, bySelf });
    }
    return shares;
  }, [realMessages]);
  // The composer sends under the group's own id; an older local route can still lead here.
  const outboxGroupId = group?.id ?? groupId;
  const outbox = useBotGroupOutbox(outboxGroupId);
  useLayoutEffect(() => {
    if (state.kind === 'ready') noteBotGroupTimeline(outboxGroupId, mergeBotGroupMessages(state.older, state.group.messages), state.readToken);
  }, [outboxGroupId, state, outbox]);
  const { pending, localAttachments, replacements } = useMemo(
    () => projectBotGroupOutbox(outbox, realMessages, getBotGroupOutboxClaims(outboxGroupId), getBotGroupOutboxPreviews(outboxGroupId)),
    [outboxGroupId, realMessages, outbox],
  );
  /** Retain the same row when a queue entry becomes the server's message. */
  const adoptedKeysRef = useRef(new Map<string, string>());
  for (const [messageId, clientId] of replacements) adoptedKeysRef.current.set(messageId, pendingBotGroupMessageId(clientId));
  const rows = useStableRows(useMemo<BotGroupTimelineMessage[]>(
    () => interleaveBotGroupOutbox(realMessages, pending).map((row) => {
      if (row.entry) {
        const entry = row.entry;
        return { ...pendingBotGroupMessage({
          clientId: entry.input.clientId, text: entry.input.text, mentions: entry.input.mentions,
          attachments: [...entry.attachments], quote: entry.quote ?? null,
          createdAt: entry.createdAt, afterSequence: entry.after,
        }), outbox: entry };
      }
      const local = localAttachments.get(row.message.id);
      return local && row.message.isSelf !== false && !row.message.deleted
        ? { ...row.message, attachments: mergeBotGroupLocalAttachments(row.message.attachments, local) }
        : row.message;
    }),
    [realMessages, pending, localAttachments],
  ));
  const unreadReceipts = pending.flatMap((entry) => entry.status === 'sent' && entry.messageId ? [entry.messageId] : []).join(',');
  useEffect(() => { if (unreadReceipts) loadRef.current(); }, [unreadReceipts]);
  const messageByIdRef = useRef(new Map<string, BotGroupMessageView>());
  messageByIdRef.current = new Map(realMessages.map((message) => [message.id, message]));
  const lastRealSequence = realMessages[realMessages.length - 1]?.sequence ?? 0;
  /** Rows after this sequence arrived while the page was open: they fade in. */
  const enterAfterRef = useRef<number | null>(null);
  if (enterAfterRef.current === null && state.kind === 'ready') enterAfterRef.current = lastRealSequence;

  // Quotes resolve against verified copies only; an unverified original falls back to the snapshot.
  const quoteSources = useMemo(
    () => (unverifiedOriginals.size > 0 ? realMessages.filter((message) => !unverifiedOriginals.has(message.id)) : realMessages),
    [realMessages, unverifiedOriginals],
  );
  const quoteDisplayCache = useRef(new Map<string, { key: string; display: BotGroupQuoteDisplay }>());
  const quoteDisplays = useMemo(() => {
    const next = new Map<string, { key: string; display: BotGroupQuoteDisplay }>();
    for (const message of rows) {
      if (!message.quote) continue;
      const display = resolveBotGroupQuote(message.quote, quoteSources);
      const key = JSON.stringify(display);
      const cached = quoteDisplayCache.current.get(message.id);
      next.set(message.id, cached && cached.key === key ? cached : { key, display });
    }
    quoteDisplayCache.current = next;
    return next;
  }, [rows, quoteSources]);

  // Read marks: the newest incoming message (a Bot or another human) once it is in view.
  // Same range as the unread count (`incomingMessageTimes`): spoken messages and a Bot's
  // plan card; notices never count, so a plan card at the tail cannot leave a stuck badge.
  const latestIncomingAt = useMemo(() => realMessages.reduce((latest, message) =>
    (message.kind === 'message' || message.kind === 'plan') && (message.authorKind === 'bot' || message.isSelf === false)
      ? Math.max(latest, message.createdAt) : latest, 0), [realMessages]);
  const latestIncomingRef = useRef(latestIncomingAt);
  latestIncomingRef.current = latestIncomingAt;
  const latestSequence = realMessages.reduce((latest, message) => {
    const position = message.serverSequence ?? String(message.sequence);
    return BigInt(position) > BigInt(latest) ? position : latest;
  }, '0');
  const latestSequenceRef = useRef(latestSequence);
  latestSequenceRef.current = latestSequence;
  useEffect(() => {
    if (state.kind === 'ready') setSeenThrough(previous => previous ?? latestSequence);
  }, [state.kind, latestSequence]);
  const newMessageCount = botGroupNewMessageCount(realMessages, seenThrough);
  const readRequest = useRef<string | null>(null);
  const readMessages = useRef(realMessages); readMessages.current = realMessages;
  const acknowledge = useCallback(() => {
    if (!isDataOwnerGenerationCurrent(readOwner.current) || !stickToBottomRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const element = scrollRef.current;
    if (!element || element.scrollHeight - element.scrollTop - element.clientHeight >= STICK_TO_BOTTOM_PX) return;
    setSeenThrough(latestSequenceRef.current);
    const at = latestIncomingRef.current;
    if (at > 0) markBotRead(botGroupReadKey(groupId), at);
    const current = stateRef.current;
    const latest = readMessages.current.at(-1);
    if (current.kind === 'ready' && current.group.serverUnread && latest && readRequest.current !== latest.id) {
      readRequest.current = latest.id;
      void window.electronAPI.maker.chatServer.manage({ groupId, action: { type: 'read', messageId: latest.id, ...(direct ? { conversationKind: 'direct' as const } : {}) } })
        .then(result => { if (!result.ok && readRequest.current === latest.id) readRequest.current = null; })
        .catch(() => { if (readRequest.current === latest.id) readRequest.current = null; });
    }
  }, [groupId]);
  const lastAcknowledgeRef = useRef(0);
  const acknowledgeTimerRef = useRef<number | null>(null);
  /** Leading-edge throttle for scroll: the first event marks at once, a burst marks once more after. */
  const acknowledgeSoon = useCallback(() => {
    const now = Date.now();
    if (now - lastAcknowledgeRef.current >= ACKNOWLEDGE_THROTTLE_MS) {
      lastAcknowledgeRef.current = now;
      acknowledge();
      return;
    }
    if (acknowledgeTimerRef.current !== null) return;
    acknowledgeTimerRef.current = window.setTimeout(() => {
      acknowledgeTimerRef.current = null;
      lastAcknowledgeRef.current = Date.now();
      acknowledge();
    }, ACKNOWLEDGE_THROTTLE_MS);
  }, [acknowledge]);
  useEffect(() => () => { if (acknowledgeTimerRef.current !== null) window.clearTimeout(acknowledgeTimerRef.current); }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge);
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('focus', acknowledge); document.removeEventListener('visibilitychange', acknowledge); };
  }, [acknowledge, latestIncomingAt, latestSequence]);

  const plans = useMemo(
    () => (state.kind === 'ready' ? mergeBotGroupPlans(state.olderPlans, state.group.plans) : []),
    [state],
  );
  const hasMoreBefore =
    state.kind === 'ready' && (state.older.length > 0 ? state.olderHasMore : state.group.hasMoreBefore);

  const openSettings = useCallback(() => {
    if (direct) return;
    const search = new URLSearchParams(location.search);
    search.set(BOT_GROUP_SETTINGS_PARAM, '1');
    navigate(`${location.pathname}?${search.toString()}`);
  }, [direct, location.pathname, location.search, navigate]);

  const separator = t('bots.groupChat.memberSeparator');
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const threadRootIdRef = useRef(threadRootId);
  threadRootIdRef.current = threadRootId;
  /** A reply to bring into view when a main-chat share opens its thread. */
  const [threadFocus, setThreadFocus] = useState<{ messageId: string; nonce: number } | null>(null);
  const threadOpenerRef = useRef<HTMLElement | null>(null);
  const threadLayoutRef = useRef<HTMLDivElement>(null);
  const threadHeaderRef = useRef<HTMLDivElement>(null);
  const threadCloseAnimationRef = useRef<Animation | null>(null);
  const threadOpenAnimationRef = useRef<Animation | null>(null);
  const cancelThreadOpening = useCallback(() => threadOpenAnimationRef.current?.cancel(), []);
  const threadResize = useThreadPanelResize(threadLayoutRef, threadRootId, cancelThreadOpening);
  const threadWasOpenRef = useRef(false);
  useLayoutEffect(() => {
    const opening = !!threadRootId && !threadWasOpenRef.current;
    threadWasOpenRef.current = !!threadRootId;
    if (!opening) return;
    const panel = threadLayoutRef.current?.querySelector('aside');
    const animation = panel && animateThreadPanelWidth(panel, '0px',
      threadResize.width === undefined ? '50%' : `${threadResize.width}px`);
    if (!animation) return;
    threadOpenAnimationRef.current = animation;
    void animation.finished.then(() => animation.cancel(), () => {});
    return () => animation.cancel();
  }, [threadRootId, threadResize.width]);
  const closeThread = useCallback(() => {
    if (threadCloseAnimationRef.current) return;
    const panel = threadLayoutRef.current?.querySelector('aside');
    const animation = panel && animateThreadPanelWidth(panel, `${panel.getBoundingClientRect().width}px`, '0px');
    threadOpenerRef.current?.focus();
    if (!panel || !animation) { setThreadRootId(null); return; }
    panel.inert = true;
    threadCloseAnimationRef.current = animation;
    void animation.finished.then(() => {
      if (threadCloseAnimationRef.current !== animation) return;
      threadCloseAnimationRef.current = null;
      setThreadRootId(null);
    }, () => {});
  }, []);
  useLayoutEffect(() => () => {
    threadCloseAnimationRef.current?.cancel();
    threadCloseAnimationRef.current = null;
  }, [threadRootId]);
  /** From a thread reply back to where it was shared in the main chat. */
  const revealMainMessage = useCallback((messageId: string) => {
    const target = findThreadMessageElement(contentRef.current, messageId);
    if (!target) return false;
    stickToBottomRef.current = false;
    flashThreadTarget(target);
    return true;
  }, []);
  useEffect(() => {
    if (!group?.serverBacked || !threadRootId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target !== document.body && !threadLayoutRef.current?.contains(event.target as Node) && !threadHeaderRef.current?.contains(event.target as Node)) return;
      if (document.querySelector('[data-text-lightbox-overlay], [data-mermaid-lightbox-overlay]')) return;
      if (shareSelectionStore.isActive(shareScope) || shareSelectionStore.isActive(`${shareScope}:thread:${threadRootId}`)) return;
      event.stopPropagation();
      closeThread();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [group?.serverBacked, threadRootId, closeThread, shareScope]);

  const settingsLabel = t('bots.groupChat.settings.open');
  const headerStatus = headerGroup ? botGroupHeaderStatus(headerGroup, displayName, t) : null;
  const personalMask = useGroupMask(groupId);
  const readLocatedMention = useReadLocatedMention(groupId);
  const header = useMemo(() => {
    if (!headerGroup) return null;
    const shown = direct ? members.filter(member => !member.isSelf) : members;
    const names = botGroupMemberNames(shown.map((member) => ({ name: botGroupMemberDisplayName(member) })), separator);
    // A group reads its size, not a roll call (owner request 2026-10-26); the names stay in the
    // tooltip and the settings drawer. Live activity takes the line over while it lasts.
    const summary = direct ? names : t('bots.groupChat.memberCount', { count: members.length });
    return (
      <div ref={threadHeaderRef} data-testid="bot-group-content-header" className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
        <button
          type="button"
          onClick={direct ? undefined : openSettings}
          disabled={direct}
          title={names}
          className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <BotGroupAvatarStack members={shown} />
          <span className="flex min-w-0 flex-col">
            <span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{headerGroup.name}</span>
            {headerStatus
              ? <BotGroupHeaderStatusText text={headerStatus} className="text-11 leading-4" />
              : <span data-testid="bot-group-header-summary" className="min-w-0 truncate text-11 leading-4 tabular-nums text-[var(--text-tertiary)]">{summary}</span>}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center">
          {/* One 邀请 entry for every member; what each can use inside follows the server. */}
          {headerGroup.serverBacked && !direct && !headerGroup.dissolvedAt && !headerGroup.archived &&
            <ChatGroupInviteMenu key={headerGroup.id} group={{ id: headerGroup.id, members, canInvite: headerGroup.canInvite }} variant="icon" />}
          {!direct && <Tip text={settingsLabel}>
            <button
              type="button"
              onClick={openSettings}
              aria-label={settingsLabel}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              style={WINDOW_NO_DRAG_STYLE}
            >
              <Settings2 size={15} />
            </button>
          </Tip>}
        </div>
      </div>
    );
  }, [direct, headerGroup?.name, headerGroup?.id, headerGroup?.serverBacked, headerGroup?.canInvite, headerGroup?.dissolvedAt, headerGroup?.archived, members, headerStatus, openSettings, separator, settingsLabel, t]);
  useRegisterContentHeader(header);

  const running = group?.round.status === 'running';
  // Several Bots think at once in a broadcast round's first circle; the key follows the set.
  const speakingKey = running && group ? group.round.speakers.map((speaker) => (speaker.executionId ?? `${speaker.botId}:${speaker.activity}`)).join(',') : '';
  const lastRowKey = rows[rows.length - 1]?.id ?? '';
  const firstRealSequence = realMessages[0]?.sequence ?? 0;

  // Older rows were prepended: keep the reader's place (applied before the bottom pin below).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const anchor = prependAnchorRef.current;
    if (!element || !anchor) return;
    prependAnchorRef.current = null;
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
  }, [firstRealSequence]);
  // Follow new messages and banner viewport changes only while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || prependAnchorRef.current) return;
    if (stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lastRowKey, speakingKey, rows.length, hasControlledBanner, controlledBannerCollapsed]);

  // Markdown, code blocks and avatars finish layout after the first paint, and the composer or
  // progress strip may grow: keep a reader who is at the bottom pinned there.
  const ready = state.kind === 'ready';
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!ready || !scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && !prependAnchorRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ready]);

  /** Reads one older page; returns it so 引用 can keep paging toward the original. */
  const loadOlder = async (beforeSequence?: number): Promise<{ messages: BotGroupMessageView[]; hasMore: boolean } | null> => {
    const base = stateRef.current;
    if (base.kind !== 'ready' || loadingOlderRef.current) return null;
    const loaded = mergeBotGroupMessages(base.older, base.group.messages);
    const before = beforeSequence ?? loaded[0]?.sequence;
    const anchorId = loaded[0]?.id;
    const api = botGroupApi();
    if (!before || !api) return null;
    const owner = getDataOwnerGeneration();
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const sourceMessageIds = loaded.map(message => message.id);
      const result = await api.getBotGroup(groupId, { ...(direct ? { conversationKind: 'direct' as const } : {}), beforeSequence: before, sourceMessageIds });
      if (!isDataOwnerGenerationCurrent(owner)) return null;
      if (!result.ok) {
        toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
        return null;
      }
      if (!acceptHistoryPage(result.group, base.group.historyRevision)) return null;
      // The latest page started over meanwhile (more than a page arrived): this page was read
      // below a timeline that is gone and would sit under the new one with the gap still in it.
      const stillLoaded = (timeline: GroupViewState) => timeline.kind === 'ready'
        && timeline.group.historyRevision === base.group.historyRevision
        && (!anchorId || timeline.group.messages.some(message => message.id === anchorId) || timeline.older.some(message => message.id === anchorId));
      if (!stillLoaded(stateRef.current)) return null;
      const element = scrollRef.current;
      const current = stateRef.current;
      const shownFirst = current.kind === 'ready' ? mergeBotGroupMessages(current.older, current.group.messages)[0]?.sequence : undefined;
      // Only rows that land above the first one move the content; a re-read in place does not.
      const prepends = result.group.messages.some((message) => shownFirst === undefined || message.sequence < shownFirst);
      if (element && prepends) prependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
      const newerRefresh = current.kind === 'ready' && current.group !== base.group;
      setState((previous) => {
        if (previous.kind !== 'ready' || !stillLoaded(previous)) return previous;
        // A newer push refresh wins over an older in-flight pagination request.
        const executionFailures = previous.group === base.group
          ? result.group.executionFailures ?? previous.group.executionFailures
          : previous.group.executionFailures;
        const updates = new Map(previous.group === base.group ? result.group.messageUpdates?.map(message => [message.id, message]) : []);
        const applyUpdates = (messages: BotGroupMessageView[]) => updates.size
          ? messages.map(message => updates.get(message.id) ?? message) : messages;
        const older = previous.group === base.group
          ? mergeBotGroupMessages(previous.older, result.group.messages)
          : mergeBotGroupMessages(result.group.messages, previous.older);
        return {
          ...previous,
          group: { ...previous.group, messages: applyUpdates(previous.group.messages), executionFailures },
          older: applyUpdates(older),
          olderPlans: mergeBotGroupPlans(result.group.plans, previous.olderPlans),
          olderHasMore: result.group.hasMoreBefore,
        };
      });
      // A push may have refreshed before these sources were displayed. Reconcile their current state too.
      if (newerRefresh) loadRef.current(result.group.messages.map(message => message.id));
      return { messages: result.group.messages, hasMore: result.group.hasMoreBefore };
    } catch {
      toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
      return null;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  /**
   * Goes to a quoted message in this group's main timeline, paging back a bounded number
   * of times. A deleted or unreachable original says so instead of jumping anywhere else.
   */
  const locateQuoted = async (quote: Pick<BotGroupQuoteView, 'messageId' | 'sequence'>) => {
    if (locatingRef.current) return;
    const find = (list: readonly BotGroupMessageView[]) => list.find(message => message.id === quote.messageId && !message.threadRootId);
    const settle = (original: BotGroupMessageView | undefined) => {
      if (original && !original.deleted) setJumpTarget(original.id);
      else toast.info(t(original ? 'bots.groupChat.quote.deleted' : 'bots.groupChat.quote.unavailable'));
    };
    const base = stateRef.current;
    if (base.kind !== 'ready') return;
    const latest = find(base.group.messages);
    if (latest) { settle(latest); return; }
    locatingRef.current = true;
    // Push refreshes re-read only the newest page, so an original on an older page may have
    // changed since it was paged in: re-read its page first and go by what that says.
    const paged = find(base.older);
    if (paged) {
      try {
        // A failed re-read is not a verified original: stay put rather than jump to a stale copy.
        const read = await loadOlder(paged.sequence + 1);
        if (!read) return;
        const original = find(read.messages);
        if (original) setUnverifiedOriginals((previous) => {
          if (!previous.has(original.id)) return previous;
          const next = new Set(previous);
          next.delete(original.id);
          return next;
        });
        settle(original);
      } finally {
        locatingRef.current = false;
      }
      return;
    }
    try {
      let hasMore = base.older.length > 0 ? base.olderHasMore : base.group.hasMoreBefore;
      let before: number | undefined;
      for (let page = 0; hasMore && page < QUOTE_LOCATE_MAX_PAGES; page += 1) {
        const read = await loadOlder(before);
        if (!read) return;
        const original = find(read.messages);
        if (original) { settle(original); return; }
        const oldest = read.messages.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
        hasMore = read.hasMore && Number.isFinite(oldest) && (quote.sequence === null || oldest > quote.sequence);
        before = Number.isFinite(oldest) ? oldest : undefined;
      }
      settle(undefined);
    } finally {
      locatingRef.current = false;
    }
  };

  // The original is on screen after the render that loaded it: center it, move focus, light it up.
  useEffect(() => {
    if (!jumpTarget) return;
    const target = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-bot-group-message-id]') ?? [])]
      .find(element => element.dataset.botGroupMessageId === jumpTarget);
    if (!target) return;
    setJumpTarget(null);
    stickToBottomRef.current = false;
    target.scrollIntoView?.({ block: 'center' });
    target.focus({ preventScroll: true });
    setHighlightId(jumpTarget);
    readLocatedMention(jumpTarget, target);
  }, [jumpTarget, rows, readLocatedMention]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), QUOTE_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const continueRound = async () => {
    const api = botGroupApi();
    if (!api || continuing) return;
    setContinuing(true);
    stickToBottomRef.current = true;
    try {
      const result = await api.continueBotGroupRound(groupId);
      if (!result.ok) toast.error(t('bots.groupChat.timeline.continueFailed'));
      else loadRef.current();
    } catch {
      toast.error(t('bots.groupChat.timeline.continueFailed'));
    } finally {
      setContinuing(false);
    }
  };

  /** Stops your own work; owners and admins may choose `all` (bot-group-chat.md §4.4). */
  const stopRound = async (scope?: 'all') => {
    const api = botGroupApi();
    if (!api || stopping) return;
    setStopping(true);
    try {
      const result = await (scope ? api.stopBotGroupRound(groupId, scope) : api.stopBotGroupRound(groupId));
      if (!result.ok) toast.error(t('bots.groupChat.composer.stopFailed'));
    } catch {
      toast.error(t('bots.groupChat.composer.stopFailed'));
    } finally {
      setStopping(false);
    }
  };

  /** 开始 / 不用了 / 继续 / 重试 / 结束分工; main pushes 'plan' and the view re-reads. */
  const runPlanAction = async (action: BotGroupPlanAction, planId: string) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action });
    stickToBottomRef.current = true;
    try {
      const result = await runBotGroupPlanAction(action, { groupId, planId });
      if (!result) return;
      if (!result.ok) toast.error(t(botGroupErrorKey(result.errorCode, PLAN_ACTION_FAILED[action])));
      loadRef.current();
    } catch {
      toast.error(t(PLAN_ACTION_FAILED[action]));
    } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const editPlanStep = async (
    planId: string,
    step: BotGroupPlanStepView,
    action: 'reassign' | 'remove',
    botId?: string,
  ) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action: 'edit' });
    try {
      const result = await editBotGroupPlanStep({
        groupId,
        planId,
        position: step.position,
        action,
        ...(botId ? { botId } : {}),
      });
      if (!result) return;
      if (!result.ok) toast.error(t(botGroupErrorKey(result.errorCode, 'bots.groupChat.plan.editFailed')));
      loadRef.current();
    } catch {
      toast.error(t('bots.groupChat.plan.editFailed'));
    } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const setAutoContinue = async (on: boolean) => {
    try {
      const result = await setBotGroupAutoContinue(groupId, on);
      if (!result) return;
      if (!result.ok) toast.error(t(botGroupErrorKey(result.errorCode, 'bots.groupChat.settings.autoContinueSaveFailed')));
      loadRef.current();
    } catch {
      toast.error(t('bots.groupChat.settings.autoContinueSaveFailed'));
    }
  };

  // Stable handlers for the memoized rows; each reads the latest page state through refs.
  const actionsRef = useRef({ locateQuoted, continueRound, runPlanAction, editPlanStep, setAutoContinue });
  actionsRef.current = { locateQuoted, continueRound, runPlanAction, editPlanStep, setAutoContinue };
  const onLocateQuote = useCallback((quote: BotGroupQuoteView) => void actionsRef.current.locateQuoted(quote), []);
  const onContinue = useCallback(() => void actionsRef.current.continueRound(), []);
  const onPlanAction = useCallback((action: 'start' | 'dismiss', planId: string) => void actionsRef.current.runPlanAction(action, planId), []);
  const onEditStep = useCallback((planId: string, step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) =>
    void actionsRef.current.editPlanStep(planId, step, action, botId), []);
  const onPlanAutoContinue = useCallback((_planId: string, on: boolean) => void actionsRef.current.setAutoContinue(on), []);
  const onChanged = useCallback((messageId: string) => loadRef.current([], [messageId]), []);
  const onQuote = useCallback((messageId: string) => {
    const message = messageByIdRef.current.get(messageId);
    if (message) setQuoteDraft(botGroupQuoteFromMessage(message));
  }, []);
  const onOpenThread = useCallback((messageId: string, focusMessageId?: string) => {
    threadOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (threadCloseAnimationRef.current) {
      threadCloseAnimationRef.current.cancel();
      threadCloseAnimationRef.current = null;
      const panel = threadLayoutRef.current?.querySelector('aside');
      if (panel) panel.inert = false;
      if (messageId === threadRootIdRef.current) {
        (panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('header button'))?.focus();
      }
    }
    setThreadRootId(messageId);
    setThreadFocus(focusMessageId ? { messageId: focusMessageId, nonce: Date.now() } : null);
  }, []);
  const locateMention = useCallback((entry: GroupMaskMention) => {
    if (entry.threadRootId) onOpenThread(entry.threadRootId, entry.messageId);
    else void actionsRef.current.locateQuoted({ messageId: entry.messageId, sequence: null });
  }, [onOpenThread]);
  const onSending = useCallback(() => { stickToBottomRef.current = true; }, []);
  const locateNotification = useRef(locateQuoted); locateNotification.current = locateQuoted;
  useEffect(() => {
    if (state.kind !== 'ready' || !notificationTarget || handledNotification.current === location.key) return;
    handledNotification.current = location.key;
    stickToBottomRef.current = false;
    if (notificationTarget.threadRootId) onOpenThread(notificationTarget.threadRootId, notificationTarget.messageId);
    else void locateNotification.current({ messageId: notificationTarget.messageId, sequence: null });
  }, [state.kind, notificationTarget, location.key, onOpenThread]);

  const planById = useMemo(() => new Map(plans.map((plan) => [plan.id, plan])), [plans]);
  const layout = useMemo(() => layoutBotGroupTimeline(rows), [rows]);
  const stepNumbers = useMemo(() => botGroupHandoffStepNumbers(realMessages, planById), [realMessages, planById]);
  /** Finish time of each done step (1-based) per plan, from the hand-off messages; stable per content. */
  const doneAtCache = useRef(new Map<string, { key: string; value: ReadonlyMap<number, number> }>());
  const planDoneAt = useMemo(() => {
    const byPlan = new Map<string, Map<number, number>>();
    for (const message of realMessages) {
      const number = stepNumbers.get(message.id);
      if (number === undefined || !message.planId) continue;
      const entry = byPlan.get(message.planId) ?? new Map<number, number>();
      entry.set(number, message.createdAt);
      byPlan.set(message.planId, entry);
    }
    const next = new Map<string, { key: string; value: ReadonlyMap<number, number> }>();
    for (const [planId, value] of byPlan) {
      const key = JSON.stringify([...value]);
      const cached = doneAtCache.current.get(planId);
      next.set(planId, cached && cached.key === key ? cached : { key, value });
    }
    doneAtCache.current = next;
    return next;
  }, [realMessages, stepNumbers]);

  const openPlan = group ? openBotGroupPlan({ openPlan: group.openPlan, plans }) : null;
  const runningStep = runningBotGroupPlanStep(openPlan);
  const workTargets = useBotGroupWorkTargets(group);
  const speakers = useMemo<BotGroupLiveSpeaker[]>(() => (running && group
    ? group.round.speakers.flatMap((speaker) => {
        const member = memberById.get(speaker.botId);
        const target = speaker.executionId ? workTargets.get(speaker.executionId) : undefined;
        return member ? [{ ...speaker, member, displayName: botGroupMemberDisplayName(member), sessionId: speaker.sessionId || target?.sessionId || null, target }] : [];
      })
    : []), [running, group, memberById, workTargets]);
  const stepSpeaker = runningStep
    ? speakers.find((speaker) => speaker.activity === 'step' && speaker.member.botId === runningStep.step.botId)
    : undefined;
  const stepLive = useAgentIslandActivity(stepSpeaker?.sessionId ?? '');
  const planRunningSince = runningStep ? stepLive?.startedAtMs ?? runningStep.plan.updatedAt : null;

  const resetDrag = () => {
    dragCounterRef.current = 0;
    setDragOver(false);
  };

  /** Same drop routing as a task's chat area, minus folder references a group does not have. */
  const dropAttachments = (event: DragEvent) => {
    // .cindy / .cshare drops belong to the window-level import; only clear the hint.
    if (isGlobalDropIntercepted(event.nativeEvent)) return;
    const ghostMediaUri = getGhostMediaHandoverFromDataTransfer(event.dataTransfer);
    if (ghostMediaUri) {
      void attachGhostMediaToSession(ghostMediaUri, attachmentScope, t);
      return;
    }
    const attach = (items: Pick<DroppedFileItems, 'files' | 'directories'>) => {
      if (items.directories.length > 0) toast.warning(t('bots.groupChat.composer.folderNotSupported'));
      if (items.files.length > 0) void attachmentState.addFiles(items.files);
    };
    const dropped = getDroppedFileItems(event.dataTransfer);
    attach(dropped);
    if (dropped.unclassified.length > 0) {
      void classifyUnclassifiedDroppedItems(dropped.unclassified, {
        getFilePath: (file) => window.electronAPI.getFilePath(file),
        classifyPath: (path) => window.electronAPI.localDb.sessionShare.classifyPath({ path }),
      }).then(attach);
    }
  };

  if (state.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <BotGroupTimelineLoading />
      </main>
    );
  }
  if (state.kind !== 'ready' || !group) {
    const failed = state.kind === 'error';
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert size={24} className="mx-auto text-[var(--text-danger)]" aria-hidden />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(failed ? 'bots.groupChat.loadFailedTitle' : 'bots.groupChat.unavailableTitle')}
          </h1>
          <p className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
            {t(failed ? 'bots.groupChat.loadFailedDescription' : 'bots.groupChat.unavailableDescription')}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="lg" compact type="button" onClick={() => navigate('/bots')}>
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </Button>
            {!failed && groupId && <RemoveChatFromListButton key={groupId} groupId={groupId} onRemoved={() => navigate('/bots')} />}
            {failed ? (
              <Button
                variant="cta"
                size="lg"
                compact
                type="button"
                onClick={() => {
                  setState({ kind: 'loading' });
                  setReloadVersion((value) => value + 1);
                }}
              >
                <RefreshCcw size={14} />
                {t('bots.retry')}
              </Button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(realMessages, group.round);
  const pendingFor = (planId: string | null) =>
    planId && planPending?.planId === planId ? planPending.action : null;
  const canQuote = !!group.serverBacked && !group.archived && !group.dissolvedAt;
  const enterAfter = enterAfterRef.current;

  return (
    <div ref={threadLayoutRef} className={cn('flex h-full min-w-0 overflow-hidden', threadResize.isDragging && 'select-none [&_*]:cursor-col-resize')}>
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]"
      onDragEnter={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragOver(false);
      }}
      onDrop={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        resetDrag();
        dropAttachments(event);
      }}
    >
      <div
        ref={scrollRef}
        data-testid="bot-group-timeline"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (stickToBottomRef.current) setSeenThrough(latestSequenceRef.current);
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
          if (stickToBottomRef.current) acknowledgeSoon();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-4"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[760px] flex-col">
          {hasMoreBefore ? (
            <div className="mb-2 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                compact
                type="button"
                loading={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {t('bots.groupChat.timeline.loadEarlier')}
              </Button>
            </div>
          ) : null}
          {rows.length === 0 && !running ? (
            <div className="py-12 text-center">
              <p className="text-13 font-medium text-[var(--text-secondary)]">
                {t('bots.groupChat.timeline.emptyTitle')}
              </p>
              <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                {t('bots.groupChat.timeline.emptyDescription')}
              </p>
            </div>
          ) : null}
          {rows.map((message) => {
            const rowLayout = layout.get(message.id);
            const member = message.authorBotId ? memberById.get(message.authorBotId) : undefined;
            const isPlanCard = message.kind === 'plan';
            const plan = message.planId ? planById.get(message.planId) : undefined;
            const organizer = isPlanCard ? memberById.get(plan?.organizerBotId ?? '') : undefined;
            const identity = isPlanCard ? organizer : member;
            const authorName = isPlanCard
              ? (organizer ? botGroupMemberDisplayName(organizer) : plan?.organizerName ?? '')
              : (member && message.authorKind !== 'system' ? botGroupMemberDisplayName(member) : '') || message.authorName || member?.name || '';
            const owned = !isPlanCard && message.authorKind === 'user' && message.isSelf === false
              ? botGroupOwnedBotNames(member, members).join(separator) : '';
            const isOpenPlanCard = isPlanCard && openPlan !== null && openPlan.id === message.planId;
            const quotable = canQuote && !message.pending && isBotGroupMessageQuotable(message);
            return (
              <Fragment key={adoptedKeysRef.current.get(message.id) ?? message.id}>
                {rowLayout?.dateDivider != null ? <BotGroupDateDivider timestamp={rowLayout.dateDivider} locale={locale} /> : null}
                <BotGroupTimelineItem
                  message={message}
                  continued={rowLayout?.continued ?? false}
                  authorName={authorName}
                  avatar={identity ? avatarById.get(identity.botId) : undefined}
                  ownerOf={owned || undefined}
                  stepNumber={stepNumbers.get(message.id)}
                  members={members}
                  mentionLabels={mentionLabels}
                  locale={locale}
                  shareScope={shareScope}
                  sharing={sharing}
                  reactionGroupId={group.serverBacked && !direct ? group.id : undefined}
                  reactionRevision={messageReactionRevision(group, message.id)}
                  readOnly={Boolean(group.archived || group.dissolvedAt)}
                  quoteDisplay={quoteDisplays.get(message.id)?.display}
                  onLocateQuote={onLocateQuote}
                  onQuote={quotable ? onQuote : undefined}
                  onOpenThread={group.serverBacked && !direct && !message.pending ? onOpenThread : undefined}
                  onChanged={onChanged}
                  highlighted={highlightId === message.id}
                  focusable={jumpTarget === message.id || highlightId === message.id}
                  entering={enterAfter !== null && (message.pending === true || message.sequence > enterAfter)}
                  canContinue={message.id === continueId}
                  continuing={continuing}
                  onContinue={onContinue}
                  plan={plan}
                  planActionable={isOpenPlanCard && openPlan!.status === 'proposed'}
                  planReassignable={isOpenPlanCard && openPlan!.status === 'waiting'}
                  planPending={planCardPending(pendingFor(message.planId))}
                  planRunningSince={isOpenPlanCard ? planRunningSince : null}
                  planDoneAt={message.planId ? planDoneAt.get(message.planId)?.value : undefined}
                  onPlanAction={onPlanAction}
                  onEditStep={onEditStep}
                  // The choice is the group's on this computer; the open 分工 you started shows it.
                  onPlanAutoContinue={isOpenPlanCard && plan?.autoContinue !== undefined && !group.archived && !group.dissolvedAt
                    ? onPlanAutoContinue : undefined}
                />
              </Fragment>
            );
          })}
          {openPlan && followUp && (openPlan.canManage ?? true) ? (
            <div className="mt-3">
              <BotGroupPlanFollowUpRow
                talk={openPlan.kind === 'talk'}
                plan={openPlan}
                followUp={followUp}
                members={members}
                pending={followUpPending(pendingFor(openPlan.id))}
                onContinue={() => void runPlanAction('continue', openPlan.id)}
                onRetry={() => void runPlanAction('retry', openPlan.id)}
                onEnd={() => void runPlanAction('dismiss', openPlan.id)}
              />
            </div>
          ) : null}
          {speakers.map((speaker) => (runningStep && speaker.activity === 'step'
            // The progress strip carries a running step's status; only its confirmations stay here.
            ? <BotGroupSpeakerInteraction key={speaker.executionId ?? `${speaker.member.botId}:${speaker.activity}`} speaker={speaker} />
            : <BotGroupSpeakingLine key={speaker.executionId ?? `${speaker.member.botId}:${speaker.activity}`} speaker={speaker} />))}
        </div>
      </div>
      <div className="relative h-0 shrink-0" inert={newMessageCount <= 0}>
        <NewMessageIndicator visible={newMessageCount > 0} count={newMessageCount} bottomOffset={12} onClick={() => {
          const element = scrollRef.current;
          if (!element) return;
          stickToBottomRef.current = true;
          element.scrollTop = element.scrollHeight;
          acknowledge();
        }} />
      </div>
      {hasControlledBanner && (
        // Like teammate chats, keep the collapsed breathing light above the composer.
        <div className="shrink-0 px-5 pt-2">
          <div className="mx-auto flex w-full max-w-[760px] justify-center px-2">
            <ControlledBanner placement="composer" sessionId={controlledBannerKey} />
          </div>
        </div>
      )}
      {(group.threads?.length || personalMask) && !sharing && !group.archived ? (
        // Floats over the bottom of the timeline, at the column's right edge (bot-group-chat.md §10).
        <div className="relative h-0 shrink-0 px-5">
          <div className="pointer-events-none relative mx-auto h-0 w-full max-w-[760px] px-2">
            <BotGroupThreadHint key={group.id} threads={group.threads ?? []} members={group.members} openRootId={threadRootId}
              onOpen={rootId => onOpenThread(rootId)} mentions={personalMask?.unreadMentions} onLocateMention={locateMention}
              onReadMentions={personalMask ? () => personalMask.markMentionsRead() : undefined} saving={personalMask?.saving} />
          </div>
        </div>
      ) : null}
      {running && (runningStep || speakers.length > 0) && !sharing && !group.archived ? (
        <BotGroupProgressStrip
          key={runningStep ? `step:${runningStep.plan.id}:${runningStep.step.position}` : speakingKey}
          step={runningStep ? {
            ...runningStep,
            member: memberById.get(runningStep.step.botId),
            displayName: (() => {
              const member = memberById.get(runningStep.step.botId);
              return member ? botGroupMemberDisplayName(member) : runningStep.step.botName;
            })(),
          } : null}
          speakers={speakers}
          onStop={scope => void stopRound(scope)}
          canStopAll={!!group.canStopAll && !!group.round.othersActive}
          stopping={stopping}
        />
      ) : null}
      {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
        getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 760} /> : group.archived || group.dissolvedAt ? <p className="border-t border-[var(--border-default)] p-4 text-center text-13 text-[var(--text-tertiary)]">{t(group.dissolvedAt ? 'bots.groupChat.lifecycle.dissolved' : 'bots.groupChat.server.settings.archived')}</p> : <BotGroupComposer
        groupId={group.id}
        conversationKind={direct ? 'direct' : undefined}
        draftKey={attachmentScope}
        members={group.members}
        running={running}
        planState={botGroupComposerPlanState(openPlan, group.replyMode)}
        divisionSteps={!!group.singleSpeaker}
        attachments={attachmentState}
        attachmentScope={attachmentScope}
        dragOver={dragOver}
        quote={quoteDraft ? { view: quoteDraft, display: resolveBotGroupQuote(quoteDraft, quoteSources) } : null}
        onQuoteChange={setQuoteDraft}
        onSending={onSending}
      />}
      {group.migrationPending && <p role="status" className="px-4 py-2 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.migrationPending')}</p>}
      {/* Whole-page drop hint, as over a task's chat area; the card repeats it. */}
      {dragOver ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-50"
          style={{
            backgroundColor: 'var(--drop-overlay-bg)',
            border: '2px dashed var(--drop-overlay-border)',
          }}
        />
      ) : null}
    </main>
    {group.serverBacked && threadRootId && <ChatThreadPanel key={`${group.id}:${threadRootId}`} group={group} rootId={threadRootId} quoteSources={quoteSources}
      focus={threadFocus} sharedReplies={sharedReplies} onRevealShare={revealMainMessage} onClose={closeThread} resize={threadResize} />}
    </div>
  );
}

/** Older shares checked before the latest edit, deletion or reset: they may be out of date. */
function staleBotGroupShares(older: readonly BotGroupMessageView[], version: number | undefined) {
  return older.filter(message => message.threadShare && version !== undefined && (message.threadShare.version ?? 0) < version);
}

/** One refresh covers all loaded references, including pending sources and attachments. */
function botGroupShownShares(older: readonly BotGroupMessageView[]) {
  return older.filter(message => message.threadShare).map(message => ({
    id: message.id, messageId: message.threadShare!.messageId, threadRootId: message.threadShare!.threadRootId,
    ...(message.authorBotId ? { sharerId: message.authorBotId } : {}) }));
}

/**
 * Apply the refreshed older shares. One this refresh could not check that is older than the
 * latest version stops quoting its old text until a later refresh confirms it.
 */
function applyBotGroupThreadShareUpdates(older: BotGroupMessageView[], group: Pick<BotGroupDetail, 'threadShareUpdates' | 'threadShareVersion'>) {
  const { threadShareUpdates: updates, threadShareVersion: version } = group;
  if (!updates && version === undefined) return older;
  let changed = false;
  const next = older.map(message => {
    const share = message.threadShare;
    if (!share) return message;
    const update = updates?.[message.id];
    if (update) { changed = true; return { ...message, threadShare: update }; }
    if (version === undefined || (share.version ?? 0) >= version || share.status !== 'available') return message;
    changed = true;
    return { ...message, threadShare: { ...share, status: 'loading' as const, authorName: '', authorBotId: null, content: '', attachments: [], edited: false } };
  });
  return changed ? next : older;
}

function BotGroupTimelineLoading() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), TIMELINE_LOADING_REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <Spinner
      size={20}
      data-testid="bot-group-timeline-loading"
      className="text-[var(--text-tertiary)]"
      role="status"
      aria-label={t('ccAgent.common.loading')}
    />
  );
}

function planCardPending(action: PlanPending['action'] | null): BotGroupPlanCardAction | null {
  return action === 'start' || action === 'dismiss' || action === 'edit' ? action : null;
}

function followUpPending(action: PlanPending['action'] | null): BotGroupFollowUpAction | null {
  return action === 'continue' || action === 'retry' || action === 'dismiss' ? action : null;
}
