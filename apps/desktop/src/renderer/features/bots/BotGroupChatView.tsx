import type { ReactNode } from 'react';
/**
 * 群聊页：顶栏（成员头像、群名、成员名单、群设置入口）+ 多作者时间线 + 输入框。
 *
 * 数据全部来自 main（docs/product-rules/bot-group-chat.md §3）：进入时读一页最新消息，
 * 之后每条 `onBotGroupChanged` 推送（含分工的 `'plan'`）都整页重读，renderer 不自己拼
 * 时间线。加载沿用 BotDirectMessageView 的新鲜度护栏：请求代次 + data owner 代次 + 推送
 * owner 戳，过期响应一律丢弃。更早的消息按需翻页，连同其引用的安排合并进当前时间线。
 *
 * 分工（§7）：安排卡、交接文件与「下一步 · 继续」「没做完 · 重试」见 BotGroupPlan.tsx；
 * 这里只负责把安排快照接到对应消息上，并调用 main 的安排操作。
 *
 * 附件（§3.1）：托盘状态（`useAttachments`）由页面持有，文件拖到页面任意位置都进托盘，
 * 与普通任务的整区拖入一致；用户消息上的图片与文件复用普通聊天用户气泡的图片视图与
 * 附件 chip。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw, Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { attachGhostMediaToSession, getGhostMediaUriFromDataTransfer } from '@/cindy-brain/ghostMediaHandover';
import { ChatImageView } from '@/components/chat/ChatImageView';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { SHARE_SESSION_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { TextLightbox } from '@/components/chat/TextLightbox';
import { UserAttachmentChip } from '@/components/chat/UserAttachmentChip';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
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
  BotGroupAttachment,
  BotGroupDetail,
  BotGroupMemberView,
  BotGroupMessageView,
  BotGroupPlanAction,
  BotGroupPlanStepView,
  BotGroupPlanView,
  BotGroupSpeakerActivity,
} from '../../../shared/botGroupChat';
import { useRegisterContentHeader } from '../feature-context';
import { BotAvatar } from './BotAvatar';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupAvatarStack } from './BotGroupAvatars';
import { botGroupAttachmentScope, splitBotGroupMessageAttachments } from './botGroupAttachments';
import { BotGroupComposer } from './BotGroupComposer';
import { ChatInviteButton, ChatMessageActions } from './ChatServerControls';
import { ChatThreadPanel } from './ChatThreadPanel';
import { BotGroupPendingInteraction } from './BotGroupPendingInteraction';
import {
  BotGroupHandoffFiles,
  BotGroupOrganizerTag,
  BotGroupPlanCard,
  BotGroupPlanEndDivider,
  BotGroupPlanFollowUpRow,
  type BotGroupFollowUpAction,
  type BotGroupPlanCardAction,
} from './BotGroupPlan';
import { splitBotGroupMentionSegments } from './botGroupMentions';
import {
  BOT_GROUP_SETTINGS_PARAM,
  botGroupComposerPlanState,
  botGroupErrorKey,
  botGroupMemberNames,
  botGroupNoticeKey,
  botGroupPlanFollowUp,
  continuableRoundEndId,
  mergeBotGroupMessages,
  mergeBotGroupPlans,
  openBotGroupPlan,
} from './botGroupPresentation';
import { botGroupApi, editBotGroupPlanStep, runBotGroupPlanAction } from './botGroupStore';
import { botGroupReadKey, markBotRead } from './botReadState';
import { collectBotMessageTimeGroups, formatBotMessageGroupTime } from './botConversationTimeline';

type GroupViewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      group: BotGroupDetail;
      /** Pages loaded through 「查看更早的消息」, merged under the latest page. */
      older: BotGroupMessageView[];
      /** Plans referenced by the older pages; the latest read wins on overlap. */
      olderPlans: BotGroupPlanView[];
      olderHasMore: boolean;
    }
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

/** Stable identity for header memoization; member arrays are new on every read. */
function memberKey(members: readonly BotGroupMemberView[]): string {
  return JSON.stringify(members.map((member) => [member.botId, member.name, member.avatar, member.avatarColor]));
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
  return <BotGroupChatContent key={groupId ?? ''} groupId={groupId ?? ''} />;
}

function BotGroupChatContent({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
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
  const [state, setState] = useState<GroupViewState>({ kind: 'loading' });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const loadRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const readOwner = useRef(getDataOwnerGeneration());
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const attachmentScope = botGroupAttachmentScope(groupId);
  const attachmentState = useAttachments(attachmentScope, attachmentScope);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    const load = async () => {
      const version = ++requestVersion;
      const owner = getDataOwnerGeneration();
      const api = botGroupApi();
      const isCurrent = () =>
        !cancelled && version === requestVersion && isDataOwnerGenerationCurrent(owner);
      if (!api || !groupId) {
        if (isCurrent()) setState({ kind: groupId ? 'error' : 'missing' });
        return;
      }
      try {
        const result = await api.getBotGroup(groupId);
        if (!isCurrent()) return;
        if (result.ok) {
          readOwner.current = owner;
          setState((previous) =>
            previous.kind === 'ready'
              ? { ...previous, group: result.group }
              : {
                  kind: 'ready',
                  group: result.group,
                  older: [],
                  olderPlans: [],
                  olderHasMore: result.group.hasMoreBefore,
                },
          );
        } else if (result.errorCode === 'NOT_FOUND') {
          setState({ kind: 'missing' });
        } else {
          // Keep a timeline that is already on screen; only a first read fails loudly.
          setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
        }
      } catch {
        if (isCurrent()) setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
      }
    };
    loadRef.current = () => void load();
    void load();
    const unsubscribe =
      botGroupApi()?.onBotGroupChanged?.((payload, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp) || payload.groupId !== groupId) return;
        if (payload.change === 'deleted') {
          requestVersion += 1;
          // Unsent attachments go with the group (staged copies included).
          discardDraft(botGroupAttachmentScope(groupId));
          setState({ kind: 'missing' });
          return;
        }
        void load();
      }) ?? (() => {});
    return () => {
      cancelled = true;
      requestVersion += 1;
      loadRef.current = () => {};
      unsubscribe();
    };
  }, [groupId, reloadVersion]);

  const group = state.kind === 'ready' ? state.group : null;
  const messages = useMemo(
    () => (state.kind === 'ready' ? mergeBotGroupMessages(state.older, state.group.messages) : []),
    [state],
  );
  const acknowledge = useCallback(() => {
    if (!isDataOwnerGenerationCurrent(readOwner.current) || !stickToBottomRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const at = messages.reduce((latest, message) => message.kind === 'message' && (message.authorKind === 'bot' || message.isSelf === false)
      ? Math.max(latest, message.createdAt) : latest, 0);
    if (at > 0) markBotRead(botGroupReadKey(groupId), at);
  }, [groupId, messages]);
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge);
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('focus', acknowledge); document.removeEventListener('visibilitychange', acknowledge); };
  }, [acknowledge]);
  const plans = useMemo(
    () => (state.kind === 'ready' ? mergeBotGroupPlans(state.olderPlans, state.group.plans) : []),
    [state],
  );
  const hasMoreBefore =
    state.kind === 'ready' && (state.older.length > 0 ? state.olderHasMore : state.group.hasMoreBefore);

  const openSettings = useCallback(() => {
    const search = new URLSearchParams(location.search);
    search.set(BOT_GROUP_SETTINGS_PARAM, '1');
    navigate(`${location.pathname}?${search.toString()}`);
  }, [location.pathname, location.search, navigate]);

  const separator = t('bots.groupChat.memberSeparator');
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const settingsLabel = t('bots.groupChat.settings.open');
  const headerMembers = group ? memberKey(group.members) : '';
  const header = useMemo(() => {
    if (!group) return null;
    const names = botGroupMemberNames(group.members, separator);
    return (
      <div data-testid="bot-group-content-header" className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
        <button
          type="button"
          onClick={openSettings}
          className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <BotGroupAvatarStack members={group.members} />
          <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">{group.name}</span>
          <span className="hidden min-w-0 truncate text-12 text-[var(--text-tertiary)] sm:inline" title={names}>
            {names}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center">
          {group.serverBacked && group.canInvite && <ChatInviteButton groupId={group.id} />}
          <Tip text={settingsLabel}>
            <button
              type="button"
              onClick={openSettings}
              aria-label={settingsLabel}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              style={WINDOW_NO_DRAG_STYLE}
            >
              <Settings2 size={15} />
            </button>
          </Tip>
        </div>
      </div>
    );
    // headerMembers stands in for the member array, which is new on every read.
  }, [group?.name, group?.id, group?.serverBacked, group?.canInvite, headerMembers, openSettings, separator, settingsLabel]);
  useRegisterContentHeader(header);

  // Follow new messages and banner viewport changes only while the reader is at the bottom.
  const lastSequence = messages[messages.length - 1]?.sequence ?? 0;
  // Several Bots think at once in a broadcast round's first circle; the key follows the set.
  const speakingKey =
    group?.round.status === 'running' ? group.round.speakers.map((speaker) => speaker.botId).join(',') : '';
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
      return;
    }
    if (stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lastSequence, speakingKey, messages.length, hasControlledBanner, controlledBannerCollapsed]);

  // Markdown, code blocks and avatars finish layout after the first paint; keep a reader
  // who is at the bottom pinned there while the content grows.
  const ready = state.kind === 'ready';
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!ready || !scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && !prependAnchorRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [ready]);

  const loadOlder = async () => {
    if (state.kind !== 'ready' || loadingOlder) return;
    const first = messages[0];
    const api = botGroupApi();
    if (!first || !api) return;
    const owner = getDataOwnerGeneration();
    setLoadingOlder(true);
    try {
      const result = await api.getBotGroup(groupId, { beforeSequence: first.sequence });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) {
        toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
        return;
      }
      const element = scrollRef.current;
      if (element) prependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
      setState((previous) =>
        previous.kind === 'ready'
          ? {
              ...previous,
              older: mergeBotGroupMessages(result.group.messages, previous.older),
              olderPlans: mergeBotGroupPlans(result.group.plans, previous.olderPlans),
              olderHasMore: result.group.hasMoreBefore,
            }
          : previous,
      );
    } catch {
      toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
    } finally {
      setLoadingOlder(false);
    }
  };

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

  const resetDrag = () => {
    dragCounterRef.current = 0;
    setDragOver(false);
  };

  /** Same drop routing as a task's chat area, minus folder references a group does not have. */
  const dropAttachments = (event: DragEvent) => {
    // .cindy / .cshare drops belong to the window-level import; only clear the hint.
    if (isGlobalDropIntercepted(event.nativeEvent)) return;
    const ghostMediaUri = getGhostMediaUriFromDataTransfer(event.dataTransfer);
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
    // Local reads are fast; an empty surface avoids a spinner flash.
    return <main className="h-full bg-[var(--surface)]" />;
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

  const memberById = new Map(group.members.map((member) => [member.botId, member]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const openPlan = openBotGroupPlan({ openPlan: group.openPlan, plans });
  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(messages, group.round);
  const timeGroups = collectBotMessageTimeGroups(
    messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })),
  );
  const mentionLabels = [t('bots.groupChat.mention.all'), ...group.members.flatMap((member) => [member.name, member.nickname || member.displayName || member.name])];
  const running = group.round.status === 'running';
  const speakers = running
    ? group.round.speakers.flatMap((speaker) => {
        const member = memberById.get(speaker.botId);
        return member ? [{ member, sessionId: speaker.sessionId, activity: speaker.activity }] : [];
      })
    : [];
  const pendingFor = (planId: string | null) =>
    planId && planPending?.planId === planId ? planPending.action : null;

  return (
    <main
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface)]"
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
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          acknowledge();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-6"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
          {hasMoreBefore ? (
            <div className="flex justify-center">
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
          {messages.length === 0 && !running ? (
            <div className="py-12 text-center">
              <p className="text-13 font-medium text-[var(--text-secondary)]">
                {t('bots.groupChat.timeline.emptyTitle')}
              </p>
              <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                {t('bots.groupChat.timeline.emptyDescription')}
              </p>
            </div>
          ) : null}
          {messages.map((message) => {
            const groupTime = timeGroups.get(message.id);
            return (
              <div key={message.id} className="flex flex-col gap-4">
                {groupTime !== undefined ? (
                  <p className="select-none text-center text-12 text-[var(--text-tertiary)]">
                    {formatBotMessageGroupTime(groupTime, i18n.language)}
                  </p>
                ) : null}
                <BotGroupTimelineItem
                  message={message}
                  shareScope={shareScope}
                  sharing={sharing}
                  actions={message.kind === 'message' ? <ChatMessageActions
                    groupId={group.serverBacked ? group.id : undefined} shareScope={shareScope} message={message}
                    align={message.authorKind === 'user' && message.isSelf !== false ? 'right' : 'left'}
                    onReply={group.serverBacked ? () => setThreadRootId(message.id) : undefined}
                    onChanged={() => loadRef.current()} /> : undefined}
                  member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
                  members={group.members}
                  mentionLabels={mentionLabels}
                  canContinue={message.id === continueId}
                  continuing={continuing}
                  onContinue={() => void continueRound()}
                  plan={message.planId ? planById.get(message.planId) : undefined}
                  planActionable={
                    message.kind === 'plan' &&
                    openPlan !== null &&
                    openPlan.id === message.planId &&
                    openPlan.status === 'proposed'
                  }
                  planReassignable={
                    message.kind === 'plan' &&
                    openPlan !== null &&
                    openPlan.id === message.planId &&
                    openPlan.status === 'waiting'
                  }
                  planPending={planCardPending(pendingFor(message.planId))}
                  onPlanAction={(action) => {
                    if (message.planId) void runPlanAction(action, message.planId);
                  }}
                  onEditStep={(step, action, botId) => {
                    if (message.planId) void editPlanStep(message.planId, step, action, botId);
                  }}
                />
              </div>
            );
          })}
          {openPlan && followUp ? (
            <BotGroupPlanFollowUpRow
              followUp={followUp}
              members={group.members}
              pending={followUpPending(pendingFor(openPlan.id))}
              onContinue={() => void runPlanAction('continue', openPlan.id)}
              onRetry={() => void runPlanAction('retry', openPlan.id)}
              onEnd={() => void runPlanAction('dismiss', openPlan.id)}
            />
          ) : null}
          {speakers.map(({ member, sessionId, activity }) => (
            <BotGroupSpeakingRow
              key={`${member.botId}:${activity}`}
              speaker={member}
              sessionId={sessionId}
              activity={activity}
            />
          ))}
        </div>
      </div>
      {hasControlledBanner && (
        // Like teammate chats, keep the collapsed breathing light above the composer.
        <div className="shrink-0 px-5 pt-2">
          <div className="mx-auto flex w-full max-w-[760px] justify-center px-2">
            <ControlledBanner placement="composer" sessionId={controlledBannerKey} />
          </div>
        </div>
      )}
      {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
        getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 760} /> : group.archived ? <p className="border-t border-[var(--border-default)] p-4 text-center text-13 text-[var(--text-tertiary)]">{t('bots.groupChat.server.settings.archived')}</p> : <BotGroupComposer
        groupId={group.id}
        members={group.members}
        running={running}
        planState={botGroupComposerPlanState(openPlan)}
        attachments={attachmentState}
        attachmentScope={attachmentScope}
        dragOver={dragOver}
        onSent={() => {
          stickToBottomRef.current = true;
          loadRef.current();
        }}
      />}
      {group.migrationPending && <p role="status" className="px-4 py-2 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.migrationPending')}</p>}
      {group.serverBacked && threadRootId && <ChatThreadPanel key={`${group.id}:${threadRootId}`} group={group} rootId={threadRootId} onClose={() => setThreadRootId(null)} />}
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
  );
}

function planCardPending(action: PlanPending['action'] | null): BotGroupPlanCardAction | null {
  return action === 'start' || action === 'dismiss' || action === 'edit' ? action : null;
}

function followUpPending(action: PlanPending['action'] | null): BotGroupFollowUpAction | null {
  return action === 'continue' || action === 'retry' || action === 'dismiss' ? action : null;
}

function BotGroupTimelineItem({
  message,
  shareScope,
  sharing,
  actions,
  member,
  members,
  mentionLabels,
  canContinue,
  continuing,
  onContinue,
  plan,
  planActionable,
  planReassignable,
  planPending,
  onPlanAction,
  onEditStep,
}: {
  message: BotGroupMessageView;
  shareScope: string;
  sharing: boolean;
  actions?: ReactNode;
  member: BotGroupMemberView | undefined;
  members: readonly BotGroupMemberView[];
  mentionLabels: readonly string[];
  canContinue: boolean;
  continuing: boolean;
  onContinue: () => void;
  /** Snapshot of the plan this message belongs to (安排卡, hand-off or plan end). */
  plan: BotGroupPlanView | undefined;
  planActionable: boolean;
  /** The open plan stopped after a step: a step not yet done can change hands before 继续 / 重试. */
  planReassignable: boolean;
  planPending: BotGroupPlanCardAction | null;
  onPlanAction: (action: 'start' | 'dismiss') => void;
  onEditStep: (step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => void;
}) {
  const { t } = useTranslation();
  if (message.kind === 'round-end') {
    return (
      <div className="flex select-none items-center gap-3 text-12 text-[var(--text-tertiary)]">
        <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
        <span>{t('bots.groupChat.timeline.roundEnded')}</span>
        {canContinue ? (
          <Button variant="secondary" size="sm" compact type="button" loading={continuing} onClick={onContinue}>
            {t('bots.groupChat.timeline.continue')}
          </Button>
        ) : null}
        <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
      </div>
    );
  }
  if (message.kind === 'plan-end') {
    return <BotGroupPlanEndDivider stepCount={plan ? plan.steps.length : null} />;
  }
  if (message.kind === 'notice' || message.authorKind === 'system') {
    const name = message.authorName.trim() || member?.name || '';
    const key = botGroupNoticeKey(message.noticeCode, message.planId !== null);
    const text = key ? t(key, { name }) : message.content;
    return <p className="text-center text-12 text-[var(--text-tertiary)]">{text}</p>;
  }
  if (message.authorKind === 'user' && message.isSelf !== false) {
    // An attachment-only message shows just its attachments, without an empty bubble.
    const hasText = message.content.trim().length > 0;
    return (
      <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
        className={`relative flex justify-end ${sharing ? 'ml-10' : ''}`}>
        {sharing && <ShareMessageCheckbox clientId={message.id} />}
        <div className="flex min-w-0 max-w-[72%] flex-col items-end gap-2">
          <BotGroupUserAttachments attachments={message.attachments} />
          {hasText ? (
            <div
              className={`max-w-full whitespace-pre-wrap break-words rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2.5 text-[var(--msg-user-text)] ${CHAT_BODY_CLASS}`}
            >
              {splitBotGroupMentionSegments(message.content, mentionLabels).map((segment, index) =>
                segment.mention ? (
                  <span
                    key={index}
                    className="rounded-full bg-[var(--surface-chip)] px-1.5 font-medium"
                  >
                    {segment.text}
                  </span>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </div>
          ) : null}
          {actions}
        </div>
      </article>
    );
  }
  // Name snapshot from when it was said; the avatar follows the live profile.
  const author = {
    name: message.authorName || member?.name || '',
    avatar: member?.avatar ?? null,
    avatarUrl: member?.avatarUrl,
    avatarColor: member?.avatarColor ?? null,
  };
  const isPlanCard = message.kind === 'plan';
  const hasText = message.content.trim().length > 0;
  return (
    <article {...(message.kind === 'message' ? { [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id } : {})}
      className={`relative flex min-w-0 items-start gap-2.5 ${sharing ? 'ml-10' : ''}`}>
      {sharing && message.kind === 'message' && <ShareMessageCheckbox clientId={message.id} />}
      <BotAvatar bot={author} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 select-none items-center gap-2">
          <span className="min-w-0 truncate text-13 font-medium leading-7 text-[var(--text-primary)]">
            {author.name}
          </span>
          {isPlanCard ? <BotGroupOrganizerTag /> : null}
        </span>
        {isPlanCard ? (
          <BotGroupPlanCard
            plan={plan}
            members={members}
            actionable={planActionable}
            reassignable={planReassignable}
            pending={planPending}
            onStart={() => onPlanAction('start')}
            onDismiss={() => onPlanAction('dismiss')}
            onEditStep={onEditStep}
          />
        ) : (
          <>
            {hasText ? (
              <div className={`min-w-0 text-[var(--msg-assistant-text)] ${CHAT_BODY_CLASS}`}>
                <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
              </div>
            ) : null}
            <BotGroupUserAttachments attachments={message.attachments} />
            <BotGroupHandoffFiles files={message.files} workDir={plan?.workDir ?? null} />
            {actions}
          </>
        )}
      </div>
    </article>
  );
}

/**
 * A user message's images and files, drawn like a task's user bubble: each image as the
 * same attached-image view (click for the lightbox, right-click to copy or reveal), files
 * as the same chips (text preview or the system app, right-click menu).
 */
function BotGroupUserAttachments({ attachments }: { attachments: readonly BotGroupAttachment[] }) {
  const [textPreview, setTextPreview] = useState<{ path: string; name: string } | null>(null);
  const chipRef = useRef<HTMLElement | null>(null);
  const { images, files } = splitBotGroupMessageAttachments(attachments);
  if (images.length === 0 && files.length === 0) return null;
  return (
    <>
      {images.map((image) => (
        <ChatImageView key={image.id} src={image.url} filename={image.name} variant="user-attached" />
      ))}
      {files.length > 0 ? (
        <div className="flex flex-wrap items-end justify-end gap-1.5">
          {files.map((file) => (
            <UserAttachmentChip
              key={file.id}
              file={{ name: file.name, path: file.path }}
              onOpenTextPreview={(chip) => {
                chipRef.current = chip;
                setTextPreview({ path: file.path, name: file.name });
              }}
            />
          ))}
        </div>
      ) : null}
      {textPreview ? (
        <TextLightbox
          filePath={textPreview.path}
          fileName={textPreview.name}
          triggerRef={chipRef}
          onClose={() => setTextPreview(null)}
        />
      ) : null}
    </>
  );
}

function BotGroupSpeakingRow({
  speaker,
  sessionId,
  activity: speakerActivity,
}: {
  speaker: BotGroupMemberView;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
}) {
  const { t } = useTranslation();
  const activity = useAgentIslandActivity(sessionId ?? '');
  const waiting = activity?.phase === 'needs-interaction';
  return (
    <article
      data-testid="bot-group-speaking"
      data-activity={speakerActivity}
      className="flex min-w-0 items-start gap-2.5"
    >
      <BotAvatar bot={speaker} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="select-none text-13 font-medium leading-7 text-[var(--text-primary)]">
          {speaker.name}
        </span>
        {!waiting ? (
          <p
            role="status"
            aria-live="polite"
            className="-mt-2 flex min-w-0 items-center gap-1.5 text-13 text-[var(--status-bar-accent)]"
          >
            <Sparkles size={14} className="shrink-0 -translate-y-px" aria-hidden />
            <span className="min-w-0 truncate">
              {speakerActivity === 'planning' ? (
                // The organizer's decision runs outside any Session, so there is no live phase to show.
                t('bots.groupChat.speaking.planning')
              ) : (
                <BotGenerationLabel
                  sessionId={sessionId ?? undefined}
                  phase={activity?.workingPhase ?? 'thinking'}
                  startedAt={activity?.startedAtMs ?? null}
                />
              )}
            </span>
          </p>
        ) : null}
        {sessionId ? (
          <BotGroupPendingInteraction
            sessionId={sessionId}
            bot={{ id: speaker.botId, name: speaker.name, avatar: speaker.avatar, avatarColor: speaker.avatarColor }}
          />
        ) : null}
      </div>
    </article>
  );
}
