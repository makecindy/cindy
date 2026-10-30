/**
 * 话题（Thread）面板：与主时间线同一套消息行（BotGroupTimelineItem）与密度规则——根消息、
 * 「N 条回复」分隔、回复按作者五分钟合并；有新回复且读者在底部时跟到底。
 *
 * 读取：进入读一次，之后本群每条推送重读；同一时刻只有一个读取在飞，期间的推送合并成一次
 * 补读。回复用群聊同一个输入框的话题模式（BotGroupComposer `mode="thread"`），发出即乐观插入，
 * 服务器的回复到了原地替换；失败撤掉、文字放回，原因写在输入框上方。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Bell, BellRing, Check, CornerDownRight, MessageSquareShare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { findThreadMessageElement, flashThreadTarget } from './BotGroupThreadViews';
import { useReadLocatedMention } from './groupMaskPresentation';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupDetail, BotGroupExecutionFailureView, BotGroupMessageView } from '../../../shared/botGroupChat';
import { resolveBotGroupQuote } from '../../../shared/botGroupChat';
import { botGroupThreadDraftKey, refreshPendingBotGroupAttachments } from './botGroupAttachments';
import { refreshBotGroups } from './botGroupStore';
import { mergeBotGroupMessages, projectBotGroupExecutionFailures } from './botGroupPresentation';
import { BotGroupComposer, type BotGroupOutgoingMessage, type BotGroupSendOutcome } from './BotGroupComposer';
import { BotGroupTimelineItem } from './BotGroupTimelineItem';
import {
  botGroupMemberDisplayName,
  botGroupOwnedBotNames,
  layoutBotGroupTimeline,
  matchBotGroupPendingSends,
  pendingBotGroupMessage,
  pendingBotGroupMessageId,
  stabilizeById,
  type BotGroupPendingSend,
  type BotGroupTimelineMessage,
} from './BotGroupTimelineModel';
import { chatErrorKey, messageReactionRevision } from './ChatServerControls';
import { ThreadPanel, ThreadPanelRoot } from './ThreadPanel';
import type { ThreadPanelResize } from './useThreadPanelResize';
const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
const STICK_TO_BOTTOM_PX = 48;
/** Earlier pages read while looking for a reply opened from the main chat. */
const FOCUS_PAGE_LIMIT = 5;
const threadAccessLost = (code: string) => ['NOT_FOUND', 'PERMISSION_DENIED', 'FORBIDDEN', 'NOT_MEMBER', 'NOT_A_MEMBER',
  'CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'ACTOR_NOT_FOUND', 'ACCOUNT_UNAVAILABLE'].includes(code);

interface ThreadWindow {
  revision: string; root: BotGroupMessageView; replies: BotGroupMessageView[];
  executionFailures: BotGroupExecutionFailureView[]; hasMore: boolean;
}
// Disposable warm views only. Durable messages and coverage remain in main's room projection.
const threadWindows = new Map<string, ThreadWindow>();
let windowsOwner = getDataOwnerGeneration();
function windows() {
  if (!isDataOwnerGenerationCurrent(windowsOwner)) { threadWindows.clear(); windowsOwner = getDataOwnerGeneration(); }
  return threadWindows;
}

/** Shares of this thread's replies that the main chat has loaded. */
export type BotGroupSharedReplies = ReadonlyMap<string, { messageId: string; bySelf: boolean }>;

/**
 * Replies that reached a thread while their main-chat copy did not, per group and thread.
 * Kept outside the panel, and the only copy: a copy may fail after its panel closed, or
 * while the same thread is open again, and either way that panel shows the retry.
 * Server groups keep their IDs across accounts, so the queue belongs to one data owner.
 */
const unpostedStore = { owner: getDataOwnerGeneration().dataOwnerId, replies: new Map<string, ReadonlySet<string>>(), listeners: new Set<() => void>() };
const NONE_UNPOSTED: ReadonlySet<string> = new Set();
function unpostedReplies() {
  // Same-account runtime repairs advance generation without changing this queue's owner.
  const owner = getDataOwnerGeneration().dataOwnerId;
  if (unpostedStore.owner !== owner) { unpostedStore.owner = owner; unpostedStore.replies.clear(); }
  return unpostedStore.replies;
}
function updateUnposted(key: string, update: (previous: ReadonlySet<string>) => ReadonlySet<string>) {
  const queue = unpostedReplies();
  const next = update(queue.get(key) ?? NONE_UNPOSTED);
  if (next.size) queue.set(key, next); else queue.delete(key);
  for (const listener of unpostedStore.listeners) listener();
}
function useUnposted(key: string): ReadonlySet<string> {
  return useSyncExternalStore(
    useCallback(listener => { unpostedStore.listeners.add(listener); return () => { unpostedStore.listeners.delete(listener); }; }, []),
    () => unpostedReplies().get(key) ?? NONE_UNPOSTED);
}

/**
 * Follow saves per group and Thread (bot-group-chat.md §10「关注开关」), kept outside the panel:
 * a save keeps running after its panel closes, and a reopened panel joins it rather than starting a
 * second one, so the server keeps the reader's last click. One data owner's saves never reach another.
 */
interface FollowSave {
  saving: boolean;
  /** The newest click not yet sent, and the newest click at all (shown by a panel that reopens mid-save). */
  wanted: boolean | null;
  intent?: boolean;
  /** What the server confirmed; undefined until read. */
  saved: boolean | undefined;
  /** Bumped when a save starts and ends: a read begun before it ended may carry the old choice. */
  writes: number;
  /** The open panel; a closed one shows nothing. */
  panel?: { show: (following: boolean | undefined) => void; fail: (message: string) => void; reread: () => void };
}
const followSaveStore = { owner: getDataOwnerGeneration().dataOwnerId, saves: new Map<string, FollowSave>() };
function followSave(key: string): FollowSave {
  const owner = getDataOwnerGeneration().dataOwnerId;
  if (followSaveStore.owner !== owner) { followSaveStore.owner = owner; followSaveStore.saves.clear(); }
  let save = followSaveStore.saves.get(key);
  if (!save) { save = { saving: false, wanted: null, saved: undefined, writes: 0 }; followSaveStore.saves.set(key, save); }
  return save;
}
/** Sends the newest click, one save at a time; only an account change stops it. */
async function runFollowSave(key: string, groupId: string, rootId: string, save: FollowSave, failureText: (code?: string) => string) {
  if (save.saving) return;
  save.saving = true;
  save.writes += 1;
  // Only a change of account stops the queue: a same-account generation repair keeps it.
  const ownerId = getDataOwnerGeneration().dataOwnerId;
  const ownerCurrent = () => getDataOwnerGeneration().dataOwnerId === ownerId;
  // A failed write may still have been saved (a timeout or a dropped connection): until a later
  // write succeeds, the server's value is unknown and the newest click is always sent.
  let uncertain = false;
  try {
    while (save.wanted !== null && (uncertain || save.wanted !== save.saved)) {
      const wanted: boolean = save.wanted;
      save.wanted = null;
      let failure: string | null = null;
      try {
        const result = await api().followThread({ groupId, rootId, following: wanted });
        if (result.ok) { save.saved = result.following; uncertain = false; }
        else failure = failureText(result.errorCode);
      } catch { failure = failureText(); }
      if (failure) uncertain = true;
      if (!ownerCurrent()) return;
      // A newer click is saved next; only the last outcome is shown.
      if (save.wanted !== null) continue;
      save.panel?.show(save.saved);
      if (failure) save.panel?.fail(failure);
    }
  } finally {
    save.saving = false;
    save.wanted = null;
    save.writes += 1;
    // Read what the server kept after a failure: the switch then shows the real choice.
    if (uncertain && ownerCurrent()) save.panel?.reread();
    if (!save.panel && followSaveStore.saves.get(key) === save) followSaveStore.saves.delete(key);
  }
}

export function animateThreadPanelWidth(panel: HTMLElement, from: string, to: string): Animation | null {
  const style = getComputedStyle(panel);
  const token = style.getPropertyValue('--motion-base').trim();
  const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
  if (!panel.animate || !Number.isFinite(duration) || duration <= 0) return null;
  return panel.animate([{ width: from }, { width: to }], {
    duration, easing: style.getPropertyValue('--motion-ease-move').trim() || 'linear', fill: 'forwards',
  });
}

/**
 * `quoteSources` are the main timeline's verified messages (older pages included), so a
 * 话题 root's quote reads the same as it does in the timeline; without them, the latest page.
 */
export function ChatThreadPanel({ group, rootId, quoteSources = group.messages, focus, sharedReplies, onRevealShare, onClose, resize }: {
  group: BotGroupDetail; rootId: string; quoteSources?: readonly BotGroupMessageView[];
  /** A reply to bring into view; a new nonce repeats the jump. */
  focus?: { messageId: string; nonce: number } | null;
  sharedReplies?: BotGroupSharedReplies;
  /** Scroll the main chat to a share; false when it is not loaded there. */
  onRevealShare?: (messageId: string) => boolean;
  onClose: () => void;
  resize?: ThreadPanelResize;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const shareScope = `bot-group:${group.id}:thread:${rootId}`;
  const readLocatedMention = useReadLocatedMention(group.id);
  const sharing = useShareSelectionActive(shareScope);
  const readOnly = Boolean(group.archived || group.dissolvedAt);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    (panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('header button'))?.focus();
  }, []);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const windowKey = `${group.id}:${rootId}`;
  const windowOwner = useRef(getDataOwnerGeneration());
  const [initial] = useState(() => {
    const cached = windows().get(windowKey);
    if (cached && cached.revision === group.historyRevision) return cached;
    windows().delete(windowKey);
    return undefined;
  });
  const revisionRef = useRef(initial?.revision);
  const historyEpochRef = useRef(0);
  const latestReadRef = useRef(0);
  const [root, setRoot] = useState<BotGroupMessageView | null>(initial?.root ?? null);
  const [executionFailures, setExecutionFailures] = useState<BotGroupExecutionFailureView[]>(initial?.executionFailures ?? []);
  const [replies, setReplies] = useState<BotGroupMessageView[]>(initial?.replies ?? []);
  const [hasMore, setHasMore] = useState(initial?.hasMore ?? false);
  const [error, setError] = useState('');
  // Off by default: a reply stays in the thread unless the user asks for both.
  const [alsoSend, setAlsoSend] = useState(false);
  const unpostedKey = `${group.id}:${rootId}`;
  const unposted = useUnposted(unpostedKey);
  const setUnposted = (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) => updateUnposted(unpostedKey, update);
  const [posting, setPosting] = useState<ReadonlySet<string>>(new Set());
  const postingRef = useRef(new Set<string>());
  /** Shares confirmed in this panel (reply → main-chat message, null when unknown). */
  const [posted, setPosted] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [pendingSends, setPendingSends] = useState<BotGroupPendingSend[]>([]);
  const repliesRef = useRef(replies);
  repliesRef.current = replies;
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const queuedSourcesRef = useRef(new Set<string>());
  const changedRepliesRef = useRef(new Set<string>());

  /** Lowest sequence of the last latest-page read; replies below it live only on opened older pages. */
  const latestFloorRef = useRef(Number.POSITIVE_INFINITY);
  /** Where the reader had read up to when the panel opened; fixed for the panel's life. */
  const [readBefore, setReadBefore] = useState<number | null>(null);
  const readBeforeRef = useRef<number | null>(null);
  /** Whether the reader follows this Thread; undefined until known, or when the server keeps no read state. */
  const [following, setFollowing] = useState<boolean | undefined>(undefined);
  const followKey = `${group.id}:${rootId}`;
  useEffect(() => {
    if (!isDataOwnerGenerationCurrent(windowOwner.current)) return;
    if (!root || !revisionRef.current) { windows().delete(windowKey); return; }
    const cache = windows();
    cache.delete(windowKey);
    cache.set(windowKey, { revision: revisionRef.current, root, replies: replies.slice(-500), executionFailures,
      hasMore: hasMore || replies.length > 500 });
    if (cache.size > 20) cache.delete(cache.keys().next().value!);
  }, [windowKey, root, replies, executionFailures, hasMore]);

  const clearHistory = useCallback((wholeRoom = true) => {
    historyEpochRef.current++;
    queuedSourcesRef.current.clear();
    changedRepliesRef.current.clear();
    for (const key of windows().keys())
      if (key === windowKey || (wholeRoom && key.startsWith(`${group.id}:`))) windows().delete(key);
    repliesRef.current = [];
    setReplies([]); setRoot(null); setExecutionFailures([]); setHasMore(false);
    readBeforeRef.current = null; setReadBefore(null); setFollowing(undefined);
    latestFloorRef.current = Number.POSITIVE_INFINITY;
  }, [group.id, windowKey]);

  /**
   * Reads the latest page, or the page before `before`. `rereadOnly` re-reads an opened page for a
   * changed copy: it is not the oldest page, so its `hasMore` says nothing about what is loaded.
   */
  const read = useCallback(async (before?: number, rereadOnly = false, onAccepted?: () => void) => {
    const owner = getDataOwnerGeneration();
    const epoch = historyEpochRef.current;
    const latestRead = latestReadRef.current;
    const current = () => aliveRef.current && isDataOwnerGenerationCurrent(owner) && epoch === historyEpochRef.current;
    const shown = repliesRef.current;
    // A page can land before React commits its rows. Keep those sources explicit
    // so the coalesced refresh also validates their execution state.
    const extraSources = before ? [] : [...queuedSourcesRef.current];
    if (!before) queuedSourcesRef.current.clear();
    const changedReplies = before ? [] : [...changedRepliesRef.current];
    if (!before) changedRepliesRef.current.clear();
    // An older page belongs below the reply it was read from; a latest page that started over
    // meanwhile dropped that reply, and the page would sit under the new one with the gap still in it.
    const anchorId = before ? shown[0]?.id : undefined;
    const anchored = (replies: BotGroupMessageView[]) => !anchorId || replies.some(reply => reply.id === anchorId);
    try {
      // Background updates (including a companion's replies) never consume human unread.
      // Match the main timeline: only a focused, visible reader at the newest reply acknowledges it.
      const markRead = !before && stickToBottomRef.current
        && document.visibilityState === 'visible' && document.hasFocus();
      const save = followSave(followKey);
      const followWrites = save.writes;
      const result = await api().thread({ groupId: group.id, rootId, before,
        sourceMessageIds: [...new Set([...shown.map(message => message.id), ...extraSources])], markRead });
      if (!current()) return;
      if (!result.ok) {
        if (threadAccessLost(result.errorCode)) clearHistory(result.errorCode !== 'MESSAGE_NOT_FOUND');
        setError(t(chatErrorKey(result.errorCode))); return;
      }
      const reset = !!result.historyRevision && !!revisionRef.current && result.historyRevision !== revisionRef.current;
      if (reset) {
        clearHistory();
        revisionRef.current = result.historyRevision;
        if (before) { refreshRef.current(); return; }
      } else if (result.historyRevision) revisionRef.current = result.historyRevision;
      // A later latest-page refresh owns updates to already visible rows and metadata.
      const stalePage = !!before && latestRead !== latestReadRef.current;
      if (!before) latestReadRef.current++;
      // A read that overlaps a follow save may carry the old choice; the save's own answer wins.
      if (!before && followWrites === save.writes && !save.saving) {
        save.saved = result.following;
        setFollowing(result.following);
      }
      if (readBeforeRef.current === null && result.readBefore !== undefined) {
        readBeforeRef.current = result.readBefore;
        setReadBefore(result.readBefore);
      }
      if (!stalePage) setRoot(previous => (previous && JSON.stringify(previous) === JSON.stringify(result.root) ? previous : result.root));
      setError('');
      const floor = result.replies.reduce((min, reply) => Math.min(min, reply.sequence), Number.POSITIVE_INFINITY);
      // A latest page that neither overlaps nor directly adjoins the shown replies may leave a gap:
      // start over from it, as on first load, so 「查看更早」 reads on from right below it.
      const gap = !before && result.hasMore && result.replies.length > 0 && shown.length > 0
        && floor > shown.reduce((max, reply) => Math.max(max, reply.sequence), Number.NEGATIVE_INFINITY) + 1;
      if (!reset && !anchored(repliesRef.current)) return;
      const addedSources = new Set(stalePage
        ? result.replies.filter(reply => !repliesRef.current.some(shown => shown.id === reply.id)).map(reply => reply.id) : []);
      if (!stalePage) setExecutionFailures(result.executionFailures ?? []);
      else if (addedSources.size) setExecutionFailures(previous => [
        ...previous.filter(failure => !addedSources.has(failure.sourceMessageId)),
        ...(result.executionFailures ?? []).filter(failure => addedSources.has(failure.sourceMessageId)),
      ]);
      onAccepted?.();
      setReplies(previous => {
        if (reset || gap) return result.replies;
        if (!anchored(previous)) return previous;
        const incoming = stalePage ? result.replies.filter(reply => !previous.some(old => old.id === reply.id))
          : mergeBotGroupMessages(result.replies, result.messageUpdates ?? []);
        return stabilizeById(previous, mergeBotGroupMessages(previous, incoming));
      });
      if (!before) latestFloorRef.current = floor;
      if (!rereadOnly && (before || shown.length === 0 || gap || reset)) setHasMore(result.hasMore);
      if (addedSources.size) {
        for (const id of addedSources) queuedSourcesRef.current.add(id);
        refreshRef.current();
      }
      // Recheck local reactions after the latest page settles, inside the same
      // coalesced refresh. Otherwise that refresh can invalidate this recheck.
      // A durable projection already returns the changed reply in messageUpdates.
      if (!before && !gap && !reset) {
        const refreshedIds = new Set([...result.replies, ...(result.messageUpdates ?? [])].map(reply => reply.id));
        for (const reply of shown) {
          if (!changedReplies.includes(reply.id) || refreshedIds.has(reply.id)) continue;
          if (!current()) return;
          await readRef.current(reply.sequence + 1, true);
        }
      }
      // A refresh reads only the latest page: replies on opened older pages keep the attachments they
      // arrived with, so re-read the pages whose attachments were not here yet.
      if (!before && !gap && !reset && result.replies.length > 0) {
        const refreshed = await refreshPendingBotGroupAttachments(shown, floor, async page => {
          const earlier = await api().thread({ groupId: group.id, rootId, before: page });
          if (!current()) return null;
          if (!earlier.ok) {
            if (threadAccessLost(earlier.errorCode)) {
              clearHistory(earlier.errorCode !== 'MESSAGE_NOT_FOUND'); setError(t(chatErrorKey(earlier.errorCode)));
            }
            return null;
          }
          if (earlier.historyRevision && earlier.historyRevision !== revisionRef.current) {
            clearHistory(); revisionRef.current = earlier.historyRevision; refreshRef.current(); return null;
          }
          return earlier.replies;
        });
        if (refreshed && current()) {
          const fresh = new Map(refreshed.map(message => [message.sequence, message]));
          setReplies(previous => previous.map(message => message.sequence < floor ? fresh.get(message.sequence) ?? message : message));
        }
      }
    } catch { if (current()) setError(t(key('requestFailed'))); }
  }, [group.id, rootId, t, clearHistory]);
  const readRef = useRef(read);
  readRef.current = read;
  /** One refresh in flight; pushes meanwhile collapse into one follow-up read. */
  const refresh = useCallback(() => {
    if (inFlightRef.current) { queuedRef.current = true; return; }
    inFlightRef.current = true;
    void read().finally(() => {
      inFlightRef.current = false;
      if (queuedRef.current && aliveRef.current) {
        queuedRef.current = false;
        refresh();
      }
    });
  }, [read]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const groupRevisionRef = useRef(group.historyRevision);
  useEffect(() => {
    const previous = groupRevisionRef.current;
    groupRevisionRef.current = group.historyRevision;
    if (group.historyRevision && previous !== group.historyRevision && revisionRef.current !== group.historyRevision) {
      clearHistory(); revisionRef.current = group.historyRevision; refreshRef.current();
    }
  }, [group.historyRevision, clearHistory]);
  /** Following is the reader's own switch, off by default: replying or being named never turns it on. */
  const toggleFollowing = useCallback(() => {
    if (following === undefined) return;
    const save = followSave(followKey);
    save.wanted = !following;
    save.intent = save.wanted;
    setFollowing(save.wanted);
    void runFollowSave(followKey, group.id, rootId, save, code => t(code ? chatErrorKey(code) : key('requestFailed')));
  }, [following, followKey, group.id, rootId, t]);
  useEffect(() => {
    const save = followSave(followKey);
    const panel = { show: setFollowing, fail: (message: string) => toast.error(message), reread: () => refreshRef.current() };
    save.panel = panel;
    // Reopened while an earlier panel's save still runs: show the reader's last click.
    if (save.saving && save.intent !== undefined) setFollowing(save.intent);
    return () => {
      if (save.panel !== panel) return;
      save.panel = undefined;
      if (!save.saving && followSaveStore.saves.get(followKey) === save) followSaveStore.saves.delete(followKey);
    };
  }, [followKey]);
  useEffect(() => {
    aliveRef.current = true;
    refreshRef.current();
    const acknowledgeVisible = () => {
      if (document.visibilityState === 'visible' && document.hasFocus() && stickToBottomRef.current)
        refreshRef.current();
    };
    window.addEventListener('focus', acknowledgeVisible);
    document.addEventListener('visibilitychange', acknowledgeVisible);
    const stop = window.electronAPI.maker.onBotGroupChanged((event, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && event.groupId === group.id) refreshRef.current();
    });
    return () => {
      aliveRef.current = false; stop();
      window.removeEventListener('focus', acknowledgeVisible);
      document.removeEventListener('visibilitychange', acknowledgeVisible);
    };
  }, [group.id, rootId]);

  const members = group.members;
  const mentionLabels = useMemo(
    () => [t('bots.groupChat.mention.all'), ...members.flatMap((member) => [member.name, botGroupMemberDisplayName(member), member.nickname || member.displayName || member.name])],
    [members, t],
  );
  const memberById = useMemo(() => new Map(members.map((member) => [member.botId, member])), [members]);
  const separator = t('bots.groupChat.memberSeparator');

  const realReplies = useMemo(() => projectBotGroupExecutionFailures(replies, executionFailures), [replies, executionFailures]);
  const adoptedKeysRef = useRef(new Map<string, string>());
  const pendingMatches = useMemo(() => matchBotGroupPendingSends(pendingSends, realReplies, adoptedKeysRef.current), [pendingSends, realReplies]);
  for (const [clientId, messageId] of pendingMatches) adoptedKeysRef.current.set(messageId, pendingBotGroupMessageId(clientId));
  useEffect(() => {
    if (pendingMatches.size === 0) return;
    setPendingSends((previous) => previous.filter((send) => !pendingMatches.has(send.clientId)));
  }, [pendingMatches]);
  const replyRows = useMemo<BotGroupTimelineMessage[]>(
    () => [...realReplies, ...pendingSends.filter((send) => !pendingMatches.has(send.clientId)).map(pendingBotGroupMessage)],
    [realReplies, pendingSends, pendingMatches],
  );
  const rootRows = useMemo(() => projectBotGroupExecutionFailures(root ? [root] : [], executionFailures), [root, executionFailures]);
  const layout = useMemo(() => layoutBotGroupTimeline(replyRows), [replyRows]);
  const lastRealSequenceRef = useRef(0);
  lastRealSequenceRef.current = realReplies[realReplies.length - 1]?.sequence ?? 0;

  // The root and the latest page come with every refresh; a reply opened through 「加载更早」 sits
  // below that page, so the page holding it is re-read for its new reaction state.
  const onChanged = useCallback((messageId: string) => {
    const reply = repliesRef.current.find(candidate => candidate.id === messageId);
    if (reply && reply.sequence < latestFloorRef.current) changedRepliesRef.current.add(messageId);
    refreshRef.current();
  }, []);
  const onSendStart = useCallback((message: BotGroupOutgoingMessage) => {
    stickToBottomRef.current = true;
    setPendingSends((previous) => [
      ...previous.filter((send) => send.clientId !== message.clientId),
      { ...message, createdAt: Date.now(), afterSequence: lastRealSequenceRef.current },
    ]);
  }, []);
  const onSendSettled = useCallback((clientId: string, outcome: BotGroupSendOutcome) => {
    setPendingSends((previous) => outcome.ok
      ? previous.map((send) => (send.clientId === clientId ? { ...send, messageId: outcome.messageId } : send))
      : previous.filter((send) => send.clientId !== clientId));
  }, []);
  // A share opened this thread: find its reply, reading back a few pages if needed.
  const focusSearch = useRef<{ nonce: number; pages: number } | null>(null);
  useEffect(() => {
    if (!focus || !replies.length) return;
    if (focusSearch.current?.nonce !== focus.nonce) focusSearch.current = { nonce: focus.nonce, pages: 0 };
    const search = focusSearch.current;
    if (search.pages < 0) return;
    const target = findThreadMessageElement(contentRef.current, focus.messageId);
    if (target) {
      stickToBottomRef.current = false; search.pages = -1; flashThreadTarget(target);
      if (!replies.find(reply => reply.id === focus.messageId)?.deleted) readLocatedMention(focus.messageId, target);
      return;
    }
    if (!hasMore || search.pages >= FOCUS_PAGE_LIMIT) { search.pages = -1; return; }
    // A push refresh may overtake this page; then its replies trigger the next attempt, and
    // only a page that was merged counts against the limit.
    void readRef.current(replies[0]?.sequence, false, () => { search.pages += 1; });
  }, [focus, replies, hasMore, readLocatedMention]);

  /** One server operation per reply and person, so a retry never posts twice. */
  async function postToMain(messageId: string, fromComposer: boolean) {
    if (readOnly || postingRef.current.has(messageId)) return false;
    postingRef.current.add(messageId); setPosting(new Set(postingRef.current));
    const owner = getDataOwnerGeneration();
    const failed = (code?: string) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (code === 'SHARE_UNAVAILABLE') {
        setUnposted(previous => { const next = new Set(previous); next.delete(messageId); return next; });
        toast.error(t(chatErrorKey(code)));
      } else if (fromComposer) setUnposted(previous => new Set(previous).add(messageId));
      else toast.error(t(code ? chatErrorKey(code) : key('requestFailed')));
    };
    try {
      const result = await api().shareToMain({ groupId: group.id, messageId });
      if (!isDataOwnerGenerationCurrent(owner)) return false;
      if (!result.ok) { failed(result.errorCode); return false; }
      setPosted(previous => new Map(previous).set(messageId, result.messageId));
      setUnposted(previous => { const next = new Set(previous); next.delete(messageId); return next; });
      if (result.alreadyShared && !fromComposer) toast.info(t(key('thread.alreadyPosted')));
      refreshBotGroups();
      return true;
    } catch { failed(); return false; }
    finally { postingRef.current.delete(messageId); setPosting(new Set(postingRef.current)); }
  }
  async function retryUnposted() {
    // The queue belongs to the account that started the retry; stop once it is switched.
    const owner = getDataOwnerGeneration();
    for (const messageId of unposted) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      await postToMain(messageId, true);
    }
  }
  /** The reader's own share wins over another member's, even when only this panel knows it. */
  const sharedState = (messageId: string) => {
    const known = sharedReplies?.get(messageId);
    if (known?.bySelf) return { bySelf: true, shareId: known.messageId };
    if (posted.has(messageId)) return { bySelf: true, shareId: posted.get(messageId) ?? null };
    return known ? { bySelf: false, shareId: known.messageId } : null;
  };
  /** The share may sit on an older page the main chat has not loaded. */
  const revealShare = (shareId: string) => {
    if (!onRevealShare?.(shareId)) toast.info(t(key('thread.shareNotLoaded')));
  };
  const sendReply = async (input: { text: string; clientId: string; mentions: BotGroupMessageView['mentions'] }) => {
    const owner = getDataOwnerGeneration();
    const toMain = alsoSend;
    const result = await api().reply({ groupId: group.id, rootId, ...input });
    if (result.ok && isDataOwnerGenerationCurrent(owner)) {
      setAlsoSend(false);
      if (toMain) await postToMain(result.messageId, true);
    }
    return result;
  };
  const onSent = useCallback(() => { refreshRef.current(); refreshBotGroups(); }, []);

  // Follow new replies while the reader is at the bottom, including content that grows later.
  const lastKey = replyRows[replyRows.length - 1]?.id ?? '';
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lastKey, replyRows.length, root]);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const renderRow = (message: BotGroupTimelineMessage, continued: boolean) => {
    const member = message.authorBotId ? memberById.get(message.authorBotId) : undefined;
    const authorName = (member && message.authorKind !== 'system' ? botGroupMemberDisplayName(member) : '') || message.authorName || member?.name || '';
    const owned = message.authorKind === 'user' && message.isSelf === false ? botGroupOwnedBotNames(member, members).join(separator) : '';
    const shared = message.id !== root?.id && !message.pending ? sharedState(message.id) : null;
    const onReveal = shared?.shareId ? () => revealShare(shared.shareId!) : undefined;
    const postAction = readOnly || message.pending || message.id === root?.id || message.deleted || message.kind !== 'message' ? undefined
      : shared?.bySelf ? onReveal && { key: 'reveal-in-main', label: t(key('thread.viewInMain')), icon: <CornerDownRight size={14} strokeWidth={2} className="shrink-0" />, onSelect: onReveal }
      : { key: 'post-to-main', label: t(key('thread.postToMain')), disabled: posting.has(message.id), icon: <MessageSquareShare size={14} strokeWidth={2} className="shrink-0" />, onSelect: () => void postToMain(message.id, false) };
    return (
      <BotGroupTimelineItem
        message={message}
        continued={continued}
        authorName={authorName}
        avatar={{ name: authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }}
        ownerOf={owned || undefined}
        members={members}
        mentionLabels={mentionLabels}
        locale={locale}
        shareScope={shareScope}
        sharing={sharing}
        reactionGroupId={group.id}
        reactionRevision={messageReactionRevision(group, message.id)}
        // A 话题 root may itself be a 引用回复; its original lives in the main timeline.
        quoteDisplay={message.quote ? resolveBotGroupQuote(message.quote, quoteSources) : undefined}
        onChanged={onChanged}
        menuActions={postAction ? [postAction] : undefined}
        footer={shared ? <button type="button" onClick={onReveal} disabled={!onReveal}
          className="-ml-1.5 inline-flex min-h-6 select-none items-center gap-1 self-start rounded-full px-1.5 text-12 text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          <CornerDownRight size={12} aria-hidden />{t(key(shared.bySelf ? 'thread.postedBySelf' : 'thread.postedToMain'))}
        </button> : null}
      />
    );
  };
  const replyCount = Math.max(root?.replyCount ?? 0, realReplies.filter(reply => reply.kind === 'message').length);
  // The first reply from someone else after where the reader had read; only worth a divider
  // when older replies sit above it.
  const firstNewIndex = readBefore === null ? -1 : replyRows.findIndex(message => message.sequence > readBefore && !message.isSelf && !message.deleted && message.authorKind !== 'system');
  const firstNewId = firstNewIndex > 0 ? replyRows[firstNewIndex]!.id : null;

  return <ThreadPanel panelRef={panelRef} resize={resize} onClose={onClose} actions={<>
            {following !== undefined ? (
              <Tip text={t(key(following ? 'thread.unfollowTip' : 'thread.followTip'))}>
                <Button variant="secondary" tone="quiet" size="sm" aria-pressed={following} data-thread-follow=""
                  className={cn('gap-1.5 px-2.5', following ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}
                  onClick={() => void toggleFollowing()}>
                  {following ? <BellRing size={14} aria-hidden /> : <Bell size={14} aria-hidden />}
                  {t(key(following ? 'thread.following' : 'thread.follow'))}
                </Button>
              </Tip>
            ) : null}
        </>}>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3"
          onScroll={(event) => {
            const element = event.currentTarget;
            const wasAtBottom = stickToBottomRef.current;
            stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
            // Back at the newest reply: what arrived meanwhile has now been seen.
            if (!wasAtBottom && stickToBottomRef.current) refreshRef.current();
          }}>
          <div ref={contentRef} className="flex min-w-0 flex-col">
            <ThreadPanelRoot replyCount={replyCount} testId="bot-group-thread-replies">
              {rootRows.map(message => <Fragment key={message.id}>{renderRow(message, false)}</Fragment>)}
            </ThreadPanelRoot>
            {hasMore && <div className="mt-2"><Button variant="secondary" size="sm" onClick={() => void read(replies[0]?.sequence)}>{t('bots.groupChat.timeline.loadEarlier')}</Button></div>}
            {replyRows.map(message => (
              <Fragment key={adoptedKeysRef.current.get(message.id) ?? message.id}>
                {message.id === firstNewId ? (
                  <div data-testid="bot-group-thread-new-replies" className="mt-3 flex select-none items-center gap-3 text-12 font-medium text-[var(--text-primary)]">
                    <span className="flex shrink-0 items-center gap-1.5"><span aria-hidden className="size-1.5 rounded-full bg-[var(--bot-unread-bg)]" />{t(key('thread.newSeparator'))}</span>
                    <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
                  </div>
                ) : null}
                {renderRow(message, firstNewId === message.id ? false : layout.get(message.id)?.continued ?? false)}
              </Fragment>
            ))}
          </div>
        </div>
        {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
          getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 400} /> : <>
          {error && <p role="alert" className="px-4 pt-3 text-13 text-[var(--error-fg)]">{error}</p>}
          {/* Kept apart from read errors: a thread refresh must not hide the retry. */}
          {unposted.size > 0 && <div role="alert" className="mb-2 px-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-[var(--error-fg)]">
            <span className="min-w-0">{t(key('thread.alsoSendFailed'), { count: unposted.size })}</span>
            <Button variant="secondary" size="sm" compact disabled={readOnly} loading={[...unposted].some(id => posting.has(id))} onClick={() => void retryUnposted()}>
              {t(key('thread.retryPost'))}</Button>
          </div>}
            <BotGroupComposer
              mode="thread"
              groupId={group.id}
              draftKey={botGroupThreadDraftKey(group.id, rootId)}
              members={members}
              running={false}
              disabled={readOnly}
              footerStart={sending => (
                <button type="button" role="checkbox" aria-checked={alsoSend} disabled={sending || readOnly}
                  onClick={() => setAlsoSend(value => !value)}
                  className="-ml-1.5 inline-flex min-h-7 min-w-0 select-none items-center gap-2 rounded-full px-1.5 text-13 text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50">
                  <span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--motion-fast)]',
                    alsoSend ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]' : 'border border-[var(--border-default)]')}>
                    {alsoSend ? <Check size={10} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 truncate" title={t(key('thread.alsoSend'))}>{t(key('thread.alsoSend'))}</span>
                </button>
              )}
              sendReply={sendReply}
              onSendStart={onSendStart}
              onSendSettled={onSendSettled}
              onSent={onSent}
            />
        </>}
  </ThreadPanel>;
}
