import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Copy,
  Eye,
  EyeOff,
  Pin,
  Search,
  Trash2,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { cn } from '@/lib/utils';
import * as sessionService from '@/lib/sessionService';
import { isOrcaWorkerSession } from '@/lib/orcaSessionIdentity';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { sendSessionEventNotification } from '@/lib/sessionEventNotification';
import { useSidebarCollapsedState, useRegisterSidebarUpper } from '../feature-context';
import { BotAvatar } from './BotAvatar';
import { BotCreateMenu } from './BotCreateMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import {
  botListSubtitle,
  botListTimestampAt,
  formatBotListTimestamp,
  formatBotUnreadBadge,
} from './botListDisplay';
import { subscribeBotReadState } from './botReadState';
import { partitionBotRoster } from './botRosterDisplay';
import {
  canonicalBotSessionId,
  duplicateBotProfile,
  refreshBotProfiles,
  setBotHidden,
  setBotPinned,
  useBotProfiles,
  useBotUnreadCounts,
  type BotProfile,
} from './botStore';

/** Debounce for message-driven refreshes: one turn writes many rows. */
const MESSAGE_REFRESH_DEBOUNCE_MS = 800;

/**
 * 未读药丸。用的是登记在 DESIGN.md §10 的窄作用域 token `--bot-unread-bg` /
 * `--bot-unread-fg`（双模式同值 #417CDD + 白字），不是反相 CTA：白底药丸落在选中行
 * 的浅灰选中态上会和选中态互相抢焦点，而「有新消息」在 IM 里本来就有一个所有人都
 * 认得的颜色。这个 token 只服务伙伴列表的未读徽标与待办点，不外溢到别的地方。
 */
const UNREAD_BADGE_CLASS =
  'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1 text-10 font-medium tabular-nums leading-none text-[var(--bot-unread-fg)]';

function BotsSidebarContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const bots = useBotProfiles();
  const unreadByBotId = useBotUnreadCounts();
  const rosterBots = bots.filter((bot) => bot.status !== 'archived');
  const archivedBots = bots.filter((bot) => bot.status === 'archived');
  const collapsed = useSidebarCollapsedState();
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{
    botId: string;
    x: number;
    y: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BotProfile | null>(null);
  const menuOriginRef = useRef<HTMLButtonElement | null>(null);
  const menuPointerDownRef = useRef(false);
  const menuRestoreFocusRef = useRef(true);

  const openBotContextMenu = (botId: string, origin: HTMLButtonElement, x: number, y: number) => {
    menuOriginRef.current = origin;
    menuPointerDownRef.current = false;
    menuRestoreFocusRef.current = true;
    setContextMenu({ botId, x, y });
  };

  /*
    「正在输入…」的信号来源：灵动岛活动镜像(state/agentIslandActivity)。
    **没有新增 IPC** —— 主进程本来就在广播这份 per-session 快照，任务列表的
    SessionCard 用的也是它，这里只是多一个读者。

    为什么选它而不是 makerChatStore 的全局 running 快照：
     - 它是全量推送，主进程持有状态机，窗口在一次 turn 中途冷启动也补得回来；
       makerChatStore 的分片要等该会话**下一个**事件到达才materialize，长工具
       调用期间会是空的。
     - 它与灵动岛开关无关，非 macOS 上服务也以 headless 方式跑着照常广播
       (main/agent-island/service.ts 的 publish 两条分支都会 emit)。
     - 依赖轻：只吃 shared 里的类型，不用把整个聊天 store 拖进侧栏。

    当前侧栏只有一个 owner：进入伙伴页时普通任务侧栏会被这个节点替换，因此这里
    必须接手 useSessionRunningStatus。否则用户停留在伙伴页时，伙伴和普通任务的
    完成、失败、待回复都没有系统通知。
  */
  const islandActivity = useAgentIslandActivityMap();
  const isBotWorking = (bot: BotProfile): boolean => {
    // 委派干活发生在子任务,不在主任务。只看 canonical 的话,目标伙伴侧栏会一直是
    // 静默的,发起方却在等 —— 这正是「目标侧执行过程黑洞」在列表上的样子。
    const canonicalSessionId = canonicalBotSessionId(bot);
    if (canonicalSessionId && islandActivity.get(canonicalSessionId)?.phase === 'running') {
      return true;
    }
    return bot.sessions.some((session) => islandActivity.get(session.id)?.phase === 'running');
  };
  const roster = partitionBotRoster(rosterBots, { query, showHidden });
  const showSearch = rosterBots.length >= 8 || query.trim().length > 0;

  const sessionOwners = useMemo(() => {
    const next = new Map<string, { bot: BotProfile; title: string }>();
    for (const bot of bots) {
      for (const session of bot.sessions) next.set(session.id, { bot, title: session.title });
    }
    return next;
  }, [bots]);
  const activeBotSessionId = useMemo(() => {
    if (sessionId) return sessionId;
    const selectedBot = bots.find((bot) => bot.id === botId);
    return selectedBot ? canonicalBotSessionId(selectedBot) : undefined;
  }, [botId, bots, sessionId]);
  const fireSessionNotification = useCallback(
    (targetSessionId: string, kind: 'done' | 'error' | 'needs-reply') => {
      const owner = sessionOwners.get(targetSessionId);
      if (owner) {
        const title =
          owner.title.trim() && owner.title !== owner.bot.name
            ? `${owner.bot.name} · ${owner.title}`
            : owner.bot.name;
        sendSessionEventNotification(targetSessionId, title, kind);
        return;
      }
      // useSessionRunningStatus observes the shared runtime map, so it also
      // keeps ordinary tasks notifying while the user is on the Bots page.
      // Resolve their real title lazily instead of exposing an internal id.
      void sessionService
        .get(targetSessionId)
        .then((session) => {
          if (isOrcaWorkerSession(session)) return;
          sendSessionEventNotification(
            targetSessionId,
            projectDraftSessionTitle(session.title, t('ccAgent.common.unnamedSession')),
            kind,
          );
        })
        .catch(() => {
          sendSessionEventNotification(
            targetSessionId,
            t('ccAgent.common.unnamedSession'),
            kind,
          );
        });
    },
    [sessionOwners, t],
  );
  const handleSessionDone = useCallback(
    (targetSessionId: string) => fireSessionNotification(targetSessionId, 'done'),
    [fireSessionNotification],
  );
  const handleSessionError = useCallback(
    (targetSessionId: string) => fireSessionNotification(targetSessionId, 'error'),
    [fireSessionNotification],
  );
  const handleSessionNeedsReply = useCallback(
    (targetSessionId: string) => fireSessionNotification(targetSessionId, 'needs-reply'),
    [fireSessionNotification],
  );
  useSessionRunningStatus(activeBotSessionId, {
    onSessionDone: handleSessionDone,
    onSessionError: handleSessionError,
    onSessionNeedsReply: handleSessionNeedsReply,
  });

  useEffect(() => {
    if (roster.visible.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [roster.visible.length]);

  // 曾经这里还按 bot 逐个拉 `getBotHealth` 只为在行尾画一个状态图标。图标下线之后
  // 这一轮 N 次 IPC 也一起下线——列表不再为一个不显示的东西查询。

  // A chat list has to move when a message lands. There is no Bot-scoped
  // message push, so reuse the existing localDb message broadcast and only
  // refresh when the row belongs to a Bot task (a normal Cindy chat must not
  // make the Bots list re-query).
  useEffect(() => {
    const botSessionIds = new Set<string>();
    for (const bot of bots) {
      for (const session of bot.sessions) botSessionIds.add(session.id);
    }
    if (botSessionIds.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== 'string' || !botSessionIds.has(sessionId)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshBotProfiles();
      }, MESSAGE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [bots]);

  // Unread counts are computed main-side against the read positions this
  // renderer owns, so a read position moving (the user opened a Bot chat, or
  // kept watching one) has to re-ask for the list. Same debounce as the
  // message feed: a streaming turn advances the position row by row.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeBotReadState(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshBotProfiles();
      }, MESSAGE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 pt-3">
        <button
          type="button"
          onClick={() => navigate('/bots')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.title')}
        >
          <Bot size={16} />
        </button>
        <BotCreateMenu compact />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
      {/* 小节头与伙伴行的正文左边缘对齐:容器 12px + 行内 10px = 22px。 */}
      <div className="flex items-center justify-between px-2.5 pb-2">
        <div className="flex items-center gap-2 text-12 font-medium text-[var(--sidebar-list-muted)]">
          <Bot size={14} />
          <span>{t('bots.title')}</span>
        </div>
        <span className="flex items-center gap-0.5">
          {roster.showHiddenSection ? (
            <button
              type="button"
              onClick={() => setShowHidden((value) => !value)}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]"
              aria-label={t(showHidden ? 'bots.list.hideHidden' : 'bots.list.showHidden')}
            >
              {showHidden ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          ) : null}
          <BotCreateMenu />
        </span>
      </div>

      {showSearch ? (
        <label className="relative mb-2 block px-2.5">
          <Search
            size={13}
            aria-hidden="true"
            className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-[var(--sidebar-list-muted)]"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('bots.list.searchPlaceholder')}
            aria-label={t('bots.list.search')}
            className="h-7 w-full rounded-lg border border-[var(--border-default)] bg-transparent pl-7 pr-2 text-11 text-[var(--sidebar-nav-text)] outline-none placeholder:text-[var(--sidebar-list-muted)] focus:border-[var(--border-strong)]"
          />
        </label>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {roster.visible.length === 0 && roster.hidden.length === 0 && archivedBots.length === 0 ? (
          <div className="px-3 py-3">
            <BotCreateMenu label={t('bots.add')} />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {roster.visible.map((bot) => {
              const selected = bot.id === botId;
              const unread = unreadByBotId[bot.id] ?? 0;
              const subtitle = botListSubtitle(bot);
              // TA 正在回话时，第二行临时让位给「正在输入…」——聊天列表里这一行
              // 回答的是「TA 现在怎么样」，进行中比上一句说过什么更要紧。回合一
              // 结束就落回最新消息预览，不留痕。
              const typing = isBotWorking(bot);
              const subtitleText = typing
                ? t('bots.list.typing')
                : subtitle.kind === 'placeholder'
                  ? t('bots.list.startChat')
                  : subtitle.text;
              // 正在干活时取此刻 —— 委派/定时任务跑着不产生消息,只看
              // lastMessageAt 会让一个正忙的伙伴显示成「20 分钟前」,
              // 和第二行的「正在输入…」自相矛盾。见 botListTimestampAt。
              const timestamp = formatBotListTimestamp(
                botListTimestampAt({ lastMessageAt: bot.lastMessageAt, working: typing }, now),
                now,
              );
              // The selected pill is a light/dark gray fill, not an inverse one,
              // so muted text on it would sit at a far lower contrast than on
              // the sidebar background. Dim by opacity there, use the sidebar's
              // tertiary token everywhere else.
              const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
              return (
                <div
                  key={bot.id}
                  className={cn(
                    'group relative flex w-full items-center rounded-xl transition-colors',
                    selected
                      ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                      : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
                  )}
                >
                  {/* 定稿原型 `.row-open{padding:8px 10px;gap:10px}`:整行只有这一个
                      可点区域,左右内边距对称。行尾曾经还挂过一列齿轮/状态图标,
                      它下线后 `pr-2` 的占位残留了下来 —— 右边比左边窄一截,
                      单看不出问题,和左侧头像一比就是歪的。数值基线见
                      __tests__/botsSidebarSpacing.test.ts。 */}
                  <button
                    type="button"
                    onClick={() => navigate(`/bots/${bot.id}`)}
                    aria-current={selected ? 'page' : undefined}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openBotContextMenu(bot.id, event.currentTarget, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
                        return;
                      }
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openBotContextMenu(bot.id, event.currentTarget, rect.left + 10, rect.bottom);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {/* 40px。28px 会让两行式行高塌成一行的观感——头像撑不住两行文字,
                        整行读起来像一条被拉高的单行列表。 */}
                    <BotAvatar bot={bot} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-2">
                        {bot.pinnedAt ? (
                          <Pin
                            size={11}
                            aria-label={t('bots.list.pinned')}
                            className="shrink-0 text-[var(--sidebar-list-muted)]"
                          />
                        ) : null}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-14 leading-5',
                            unread > 0 ? 'font-medium' : 'font-normal',
                          )}
                          title={bot.name}
                        >
                          {bot.name}
                        </span>
                        {/* 权限模式仍不在聊天列表挂警告；这里仅显示 Hermes 风格、
                            已持久化且需要用户处理的运行失败。 */}
                        {bot.needsAttention ? (
                          <AlertTriangle
                            size={13}
                            className="shrink-0 text-[var(--warning-fg)]"
                            aria-label={t('bots.list.needsAttention')}
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 items-center gap-2">
                        {/* 未读只强调名字与数字，预览保持次级，避免整行同时争抢注意力。 */}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-12 leading-4',
                            // 「正在输入…」是个过程说明,不是消息内容:斜体 + 三级色,
                            // 哪怕这一行有未读也不跟着提到一级——否则一个瞬时状态
                            // 会比真正的新消息还抢眼。
                            mutedClass,
                            typing && 'italic',
                          )}
                          title={subtitleText}
                        >
                          {subtitleText}
                        </span>
                      </span>
                    </span>
                    {/*
                      Grok / Hermes 都把消息行当成完整的联系人入口。时间与未读因此
                      有自己的固定右列，不再跟名字和预览抢剩余宽度；无论名字多长、
                      有没有未读，所有数字都落在同一条垂直线上。
                    */}
                    <span className="flex w-10 shrink-0 self-stretch flex-col items-end justify-between py-0.5">
                      <span className={cn('min-h-4 text-11 tabular-nums', mutedClass)}>{timestamp}</span>
                      <span className="flex min-h-4 items-center justify-end">
                        {unread > 0 ? (
                          <span
                            className={UNREAD_BADGE_CLASS}
                            aria-label={t('bots.list.unread', { count: unread })}
                          >
                            {formatBotUnreadBadge(unread)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                  <DropdownMenu
                    open={contextMenu?.botId === bot.id}
                    onOpenChange={(open) => { if (!open) setContextMenu(null); }}
                  >
                    <DropdownMenuTrigger asChild>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none fixed h-0 w-0"
                        style={{ left: contextMenu?.x ?? 0, top: contextMenu?.y ?? 0 }}
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      className="min-w-40"
                      onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        if (menuRestoreFocusRef.current) menuOriginRef.current?.focus({ preventScroll: true });
                      }}
                      onInteractOutside={() => { menuRestoreFocusRef.current = false; }}
                      onPointerDownCapture={(event) => {
                        menuPointerDownRef.current = event.button === 0 && !event.ctrlKey;
                      }}
                      onPointerUpCapture={(event) => {
                        // Radix synthesizes a click on release when the press happened
                        // outside an item. Opening a context menu must never select it.
                        if (!menuPointerDownRef.current || event.button !== 0 || event.ctrlKey) {
                          event.preventDefault();
                        }
                        menuPointerDownRef.current = false;
                      }}
                      onClickCapture={(event) => {
                        if (event.button !== 0 || event.ctrlKey) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                    >
                      <DropdownMenuItem onSelect={() => void setBotPinned(bot.id, !bot.pinnedAt)}>
                        <Pin size={14} className="mr-2" />
                        {t(bot.pinnedAt ? 'bots.list.unpin' : 'bots.list.pin')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          void setBotHidden(bot.id, true).then(() => {
                            if (!selected) return;
                            const fallback = roster.visible.find(
                              (candidate) => candidate.id !== bot.id,
                            );
                            navigate(fallback ? `/bots/${fallback.id}` : '/bots');
                          });
                        }}
                      >
                        <EyeOff size={14} className="mr-2" />
                        {t('bots.list.hide')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          void duplicateBotProfile(bot.id).then((copy) =>
                            navigate(`/bots/${copy.id}`),
                          );
                        }}
                      >
                        <Copy size={14} className="mr-2" />
                        {t('bots.list.duplicate')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-[var(--text-danger)] focus:text-[var(--text-danger)]"
                        onSelect={() => setDeleteTarget(bot)}
                      >
                        <Trash2 size={14} className="mr-2" />
                        {t('bots.lifecycle.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            })}
            {roster.showHiddenSection ? (
              <div className="mt-3 border-t border-[var(--border-default)] pt-3">
                <button
                  type="button"
                  onClick={() => setShowHidden((value) => !value)}
                  className="mb-1 flex w-full items-center gap-2 px-2.5 text-left text-10 font-medium text-[var(--sidebar-list-muted)]"
                  aria-expanded={roster.showHiddenRows}
                >
                  {roster.showHiddenRows ? <EyeOff size={12} /> : <Eye size={12} />}
                  <span>{t('bots.list.hidden', { count: roster.hidden.length })}</span>
                </button>
                {roster.showHiddenRows
                  ? roster.hidden.map((bot) => (
                      <div
                        key={bot.id}
                        className="group flex w-full items-center rounded-xl text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover"
                      >
                        <button
                          type="button"
                          onClick={() => navigate(`/bots/${bot.id}`)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left opacity-60"
                        >
                          <BotAvatar bot={bot} size="sm" />
                          <span className="min-w-0 flex-1 truncate text-13 font-medium">
                            {bot.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void setBotHidden(bot.id, false)}
                          className="mr-1 flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--surface-hover)]"
                          aria-label={t('bots.list.unhideNamed', { name: bot.name })}
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(bot)}
                          className="mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-danger)] hover:bg-[var(--danger-bg-soft)]"
                          aria-label={t('bots.lifecycle.deleteTitle')}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  : null}
              </div>
            ) : null}
            {archivedBots.length > 0 ? (
              <div className="mt-3 border-t border-[var(--border-default)] pt-3">
                <div className="mb-1 flex items-center gap-2 px-2.5 text-10 font-medium text-[var(--sidebar-list-muted)]">
                  <AlertTriangle size={12} />
                  <span>{t('bots.lifecycle.stoppedBots')}</span>
                </div>
                {archivedBots.map((bot) => {
                  const selected = bot.id === botId;
                  return (
                    <div
                      key={bot.id}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
                        selected
                          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                          : 'text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => navigate(`/bots/${bot.id}?settings=1`)}
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      >
                        <BotAvatar bot={bot} size="sm" className="opacity-70" />
                        <span
                          className="min-w-0 flex-1 truncate text-13 font-medium"
                          title={bot.name}
                        >
                          {bot.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(bot)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-danger)] opacity-0 hover:bg-[var(--danger-bg-soft)] group-hover:opacity-100 focus:opacity-100"
                        aria-label={t('bots.lifecycle.deleteTitle')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
      <BotDeleteDialog
        bot={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDeleted={(deletedBotId) => {
          if (botId !== deletedBotId) return;
          const fallback = bots.find(
            (candidate) => candidate.id !== deletedBotId && candidate.status !== 'archived',
          );
          navigate(fallback ? `/bots/${fallback.id}` : '/bots', { replace: true });
        }}
      />
    </div>
  );
}

export function BotsSidebar() {
  const content = useMemo(() => <BotsSidebarContent />, []);
  useRegisterSidebarUpper(content);
  return null;
}
