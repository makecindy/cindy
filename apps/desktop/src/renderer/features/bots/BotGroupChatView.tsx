/**
 * 群聊页：顶栏（成员头像、群名、成员名单、群设置入口）+ 多作者时间线 + 输入框。
 *
 * 数据全部来自 main（docs/product-rules/bot-group-chat.md §3）：进入时读一页最新消息，
 * 之后每条 `onBotGroupChanged` 推送都整页重读，renderer 不自己拼时间线。加载沿用
 * BotDirectMessageView 的新鲜度护栏：请求代次 + data owner 代次 + 推送 owner 戳，
 * 过期响应一律丢弃。更早的消息按需翻页，合并进当前时间线。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw, Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import type {
  BotGroupDetail,
  BotGroupMemberView,
  BotGroupMessageView,
} from '../../../shared/botGroupChat';
import { useRegisterContentHeader } from '../feature-context';
import { BotAvatar } from './BotAvatar';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupAvatarStack } from './BotGroupAvatars';
import { BotGroupComposer } from './BotGroupComposer';
import { BotGroupPendingInteraction } from './BotGroupPendingInteraction';
import { splitBotGroupMentionSegments } from './botGroupMentions';
import {
  BOT_GROUP_SETTINGS_PARAM,
  botGroupMemberNames,
  continuableRoundEndId,
  mergeBotGroupMessages,
} from './botGroupPresentation';
import { botGroupApi } from './botGroupStore';
import { collectBotMessageTimeGroups, formatBotMessageGroupTime } from './botConversationTimeline';

type GroupViewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      group: BotGroupDetail;
      /** Pages loaded through 「查看更早的消息」, merged under the latest page. */
      older: BotGroupMessageView[];
      olderHasMore: boolean;
    }
  | { kind: 'missing' }
  | { kind: 'error' };

/** Stable identity for header memoization; member arrays are new on every read. */
function memberKey(members: readonly BotGroupMemberView[]): string {
  return JSON.stringify(members.map((member) => [member.botId, member.name, member.avatar, member.avatarColor]));
}

export function BotGroupChatView() {
  const { groupId } = useParams();
  return <BotGroupChatContent key={groupId ?? ''} groupId={groupId ?? ''} />;
}

function BotGroupChatContent({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<GroupViewState>({ kind: 'loading' });
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const loadRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);

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
          setState((previous) =>
            previous.kind === 'ready'
              ? { ...previous, group: result.group }
              : { kind: 'ready', group: result.group, older: [], olderHasMore: result.group.hasMoreBefore },
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
  const hasMoreBefore =
    state.kind === 'ready' && (state.older.length > 0 ? state.olderHasMore : state.group.hasMoreBefore);

  const openSettings = useCallback(() => {
    const search = new URLSearchParams(location.search);
    search.set(BOT_GROUP_SETTINGS_PARAM, '1');
    navigate(`${location.pathname}?${search.toString()}`);
  }, [location.pathname, location.search, navigate]);

  const separator = t('bots.groupChat.memberSeparator');
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
  }, [group?.name, headerMembers, openSettings, separator, settingsLabel]);
  useRegisterContentHeader(header);

  // Follow new messages only while the reader is already at the bottom.
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
  }, [lastSequence, speakingKey, messages.length]);

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
  const continueId = continuableRoundEndId(messages, group.round);
  const timeGroups = collectBotMessageTimeGroups(
    messages.map((message) => ({ clientId: message.id, createdAt: message.createdAt })),
  );
  const mentionLabels = [t('bots.groupChat.mention.all'), ...group.members.map((member) => member.name)];
  const running = group.round.status === 'running';
  const speakers = running
    ? group.round.speakers.flatMap((speaker) => {
        const member = memberById.get(speaker.botId);
        return member ? [{ member, sessionId: speaker.sessionId }] : [];
      })
    : [];

  return (
    <main className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface)]">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
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
                  member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
                  mentionLabels={mentionLabels}
                  canContinue={message.id === continueId}
                  continuing={continuing}
                  onContinue={() => void continueRound()}
                />
              </div>
            );
          })}
          {speakers.map(({ member, sessionId }) => (
            <BotGroupSpeakingRow key={member.botId} speaker={member} sessionId={sessionId} />
          ))}
        </div>
      </div>
      <BotGroupComposer
        groupId={group.id}
        members={group.members}
        running={running}
        onSent={() => {
          stickToBottomRef.current = true;
          loadRef.current();
        }}
      />
    </main>
  );
}

function BotGroupTimelineItem({
  message,
  member,
  mentionLabels,
  canContinue,
  continuing,
  onContinue,
}: {
  message: BotGroupMessageView;
  member: BotGroupMemberView | undefined;
  mentionLabels: readonly string[];
  canContinue: boolean;
  continuing: boolean;
  onContinue: () => void;
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
  if (message.kind === 'notice' || message.authorKind === 'system') {
    const name = message.authorName.trim() || member?.name || '';
    const text =
      message.noticeCode === 'member-failed'
        ? t('bots.groupChat.notice.memberFailed', { name })
        : message.noticeCode === 'member-timeout'
          ? t('bots.groupChat.notice.memberTimeout', { name })
          : message.noticeCode === 'member-unavailable'
            ? t('bots.groupChat.notice.memberUnavailable', { name })
            : message.content;
    return <p className="text-center text-12 text-[var(--text-tertiary)]">{text}</p>;
  }
  if (message.authorKind === 'user') {
    return (
      <article className="flex justify-end">
        <div
          className={`max-w-[72%] whitespace-pre-wrap break-words rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2.5 text-[var(--msg-user-text)] ${CHAT_BODY_CLASS}`}
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
      </article>
    );
  }
  // Name snapshot from when it was said; the avatar follows the live profile.
  const author = {
    name: message.authorName || member?.name || '',
    avatar: member?.avatar ?? null,
    avatarColor: member?.avatarColor ?? null,
  };
  return (
    <article className="flex min-w-0 items-start gap-2.5">
      <BotAvatar bot={author} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="select-none text-13 font-medium leading-7 text-[var(--text-primary)]">
          {author.name}
        </span>
        <div className={`min-w-0 text-[var(--msg-assistant-text)] ${CHAT_BODY_CLASS}`}>
          <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
        </div>
      </div>
    </article>
  );
}

function BotGroupSpeakingRow({
  speaker,
  sessionId,
}: {
  speaker: BotGroupMemberView;
  sessionId: string | null;
}) {
  const activity = useAgentIslandActivity(sessionId ?? '');
  const waiting = activity?.phase === 'needs-interaction';
  return (
    <article data-testid="bot-group-speaking" className="flex min-w-0 items-start gap-2.5">
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
              <BotGenerationLabel
                sessionId={sessionId ?? undefined}
                phase={activity?.workingPhase ?? 'thinking'}
                startedAt={activity?.startedAtMs ?? null}
              />
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
