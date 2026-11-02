import { teammateSelectionStyle } from './teammateSelection';
import { aggregateTeammateStatus, TEAMMATE_AVATAR } from '@cindy/maker-shared/teammate-status';
import { TeammateStatusDot } from './TeammateStatusDot';
import { localTeammateStatus, remoteTeammateStatus, groupTeammateStatus } from './teammateRosterStatus';
import { BotGenerationLabel } from './BotGenerationLabel';
import { botRosterLabel } from '../../../shared/botCreation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Pin,
  Settings,
  Trash2,
} from 'lucide-react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Tip } from '@/components/ui/tooltip';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { useCollapsibleShowAll } from '@/features/cc-agent/sidebar/hooks/useCollapsibleShowAll';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { useRemoteBots } from './useRemoteBots';
import { useCompanionCloud } from './companionCloudStore';
import { cloudRemoteBots, isCloudCompanionRemote, withoutCloudCompanions, withoutShadowedBots } from './companionCloudPresentation';
import { useDeviceLinkDeviceList } from '@/features/device-link/useDeviceLinkDeviceList';
import { remoteBotKey, isRemoteBotUnread } from './remoteBotRoster';
import { BotConnectionStatus } from './BotConnectionStatus';
import { CindyDeviceRow } from './CindyDeviceRow';
import { cindyDeviceKey, cindyDeviceOptions, isCindyDeviceBot } from './cindyDeviceRoster';
import { BotAvatar } from './BotAvatar';
import { BotCreateMenu } from './BotCreateMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotGroupSidebarRow } from './BotGroupSidebarRow';
import { BotGroupSidebarAvatar } from './BotGroupAvatars';
import { refreshBotGroups, useBotGroupList } from './botGroupStore';
import { BOT_GROUP_SETTINGS_PARAM, botGroupActivityAt } from './botGroupPresentation';
import { chatErrorKey } from './chatError';
import { subscribeBotReadState, getBotLastReadAtMap, isBotGroupUnread } from './botReadState';
import { withoutBotHiddenLanes } from './botGroupLane';
import {
  botListSubtitle,
  botListTimestampAt,
  formatBotListTimestamp,
  formatBotUnreadBadge,
} from './botListDisplay';
import { botDeviceLabel, partitionBotRoster } from './botRosterDisplay';
import { readTeammatesSectionCollapsed, writeTeammatesSectionCollapsed } from './teammatesSectionPrefs';
import {
  canonicalBotSessionId,
  duplicateBotProfile,
  setBotHidden,
  setBotPinned,
  useBotProfiles,
  useBotUnreadCounts,
  type BotProfile,
} from './botStore';

const readRevision = () => JSON.stringify(getBotLastReadAtMap());

/**
 * 未读药丸。用的是登记在 DESIGN.md §10 的窄作用域 token `--bot-unread-bg` /
 * `--bot-unread-fg`（双模式同值 #417CDD + 白字），不是反相 CTA：白底药丸落在选中行
 * 的浅灰选中态上会和选中态互相抢焦点，而「有新消息」在 IM 里本来就有一个所有人都
 * 认得的颜色。这个 token 只服务伙伴列表的未读徽标与待办点，不外溢到别的地方。
 */
const UNREAD_BADGE_CLASS =
  'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1 text-10 font-medium tabular-nums leading-none text-[var(--bot-unread-fg)]';

/** 段头悬停动作:与置顶 / 项目段头同款,鼠标离开后只保留键盘焦点或打开中的菜单。 */
const HEADER_HOVER_ACTION_CLASS = cn(
  'pointer-events-none opacity-0 transition-opacity duration-150',
  'group-hover/sidebar-header:pointer-events-auto group-hover/sidebar-header:opacity-100',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  'has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100',
);
const HEADER_ICON_BUTTON_CLASS =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]';

/** 36px 头像居中放在 48px 热区内，留出右下状态点的位置。 */
const AVATAR_SLOT_PX = TEAMMATE_AVATAR.stripTarget + TEAMMATE_AVATAR.gap;
const CHAT_PREVIEW_LIMIT = 5;

/**
 * 收起态只占一行:按内容宽度算出能放几个头像(含末尾「+N」),伙伴再多也不换行。
 * 尚未测量(宽度 0,如首帧或测试环境)时不截断。
 */
function useAvatarRowCapacity(ref: RefObject<HTMLDivElement | null>, active: boolean): number {
  const [width, setWidth] = useState(0);
  // 头像行只在收起时挂载:每次收起后重新挂上观察。
  useEffect(() => {
    const element = active ? ref.current : null;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return width > 0 ? Math.max(1, Math.floor((width + 8) / AVATAR_SLOT_PX)) : Number.POSITIVE_INFINITY;
}

/**
 * 侧栏第一层的「伙伴」段(2026-10-13 定稿):固定在置顶段上方,与置顶、全部任务并存。
 * 点伙伴只切换主区域,左栏不再整栏切换。段名在「展开(行列表)」与「收起成一排头像」
 * 之间切换,默认展开,按账号记住。通知不在这里发 —— 唯一 owner 是任务侧栏。
 */
export function TeammatesSection() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { dataOwnerId } = useAuth();
  // The sidebar lives in the shell, outside the child route's params context.
  const remoteRoute = matchPath('/bots/remote/:deviceId/:botId', pathname);
  const localRoute = [
    '/bots/:botId',
    '/bots/:botId/session/:sessionId',
    '/bots/:botId/history/:sessionId',
    '/bots/:botId/direct/:threadId',
  ].map(pattern => matchPath(pattern, pathname)).find(Boolean);
  const botId = remoteRoute?.params.botId ?? localRoute?.params.botId;
  const deviceId = remoteRoute?.params.deviceId;
  const selectedGroupId = matchPath('/bots/groups/:groupId', pathname)?.params.groupId;
  const [collapsed, setCollapsed] = useState(() => readTeammatesSectionCollapsed(dataOwnerId));
  const [showAllChats, setShowAllChats] = useCollapsibleShowAll(collapsed);
  const avatarRowRef = useRef<HTMLDivElement>(null);
  const avatarCapacity = useAvatarRowCapacity(avatarRowRef, collapsed);
  useEffect(() => {
    setCollapsed(readTeammatesSectionCollapsed(dataOwnerId));
    setShowAllChats(false);
  }, [dataOwnerId, setShowAllChats]);
  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeTeammatesSectionCollapsed(dataOwnerId, next);
  };
  const cloud = useCompanionCloud();
  const rosterRemoteBots = useRemoteBots();
  // One row per companion, on its main computer (offline rows for computers never listed here).
  const remoteBots = useMemo(() => cloudRemoteBots(cloud, rosterRemoteBots), [rosterRemoteBots, cloud]);
  const devices = useDeviceLinkDeviceList();
  const self = devices?.find((device) => device.isSelf);
  const rosterDevices = [
    ...(self ? [self] : []),
    ...remoteBots.map((bot) => ({ deviceId: bot.deviceId, name: bot.deviceName })),
  ];
  const allBots = useBotProfiles();
  // A demoted local copy runs on its main computer now; it is listed there, not here.
  const bots = useMemo(() => withoutShadowedBots(allBots, cloud), [allBots, cloud]);
  const { groups } = useBotGroupList();
  useSyncExternalStore(subscribeBotReadState, readRevision, readRevision);
  const unreadByBotId = useBotUnreadCounts();
  const rosterBots = bots.filter((bot) => bot.status !== 'archived');
  const archivedBots = bots.filter((bot) => bot.status === 'archived');
  const [showHidden, setShowHidden] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const [archiveError, setArchiveError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [contextMenu, setContextMenu] = useState<{
    kind: 'bot' | 'group';
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BotProfile | null>(null);
  const menuOriginRef = useRef<HTMLButtonElement | null>(null);
  const menuPointerDownRef = useRef(false);
  const menuRestoreFocusRef = useRef(true);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const previousSelectedGroupRef = useRef(groups.find(group => group.id === selectedGroupId));
  const pendingArchiveFocusRef = useRef<{ groupId: string; archived: boolean; origin: HTMLElement | null } | null>(null);

  const openContextMenu = (kind: 'bot' | 'group', id: string, origin: HTMLButtonElement, x: number, y: number) => {
    menuOriginRef.current = origin;
    menuPointerDownRef.current = false;
    menuRestoreFocusRef.current = true;
    setContextMenu({ kind, id, x, y });
  };

  const changeGroupArchive = async (group: BotGroupSummary) => {
    if (archiveBusyRef.current || group.dissolvedAt) return;
    archiveBusyRef.current = true;
    setArchiveBusy(true);
    setArchiveError('');
    const owner = getDataOwnerGeneration();
    const origin = menuOriginRef.current;
    let focusArchived = !!group.archived;
    const actionKey = 'bots.groupChat.server.settings.' + (group.archived ? 'unarchive' : 'archive');
    try {
      const accepted = await confirm({ presentation: 'standard', title: t(actionKey),
        description: t(actionKey + 'Hint'), confirmText: t(actionKey),
        cancelText: t('bots.cancel'), confirmVariant: 'destructive' });
      if (!accepted || !isDataOwnerGenerationCurrent(owner)) return;
      const result = await window.electronAPI.maker.chatServer.manage({ groupId: group.id,
        action: { type: 'archive', archived: !group.archived, expectedRevision: group.revision! } });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) setArchiveError(t(chatErrorKey(result.errorCode)));
      else {
        focusArchived = !group.archived;
        refreshBotGroups();
      }
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) setArchiveError(t(chatErrorKey('REQUEST_FAILED')));
    } finally {
      // Cancelled and failed confirmations also lose their menu-item opener.
      // Recover to the unchanged row after the dialog releases focus.
      if (isDataOwnerGenerationCurrent(owner)) {
        pendingArchiveFocusRef.current = { groupId: group.id, archived: focusArchived, origin };
      }
      archiveBusyRef.current = false;
      setArchiveBusy(false);
    }
  };

  // 「正在输入…」读灵动岛活动镜像(全量推送,与任务列表同源),不新增 IPC。
  const islandActivity = useAgentIslandActivityMap();
  const botRunningActivity = (bot: BotProfile) => {
    // 委派干活发生在子任务,不在主任务。只看 canonical 的话,目标伙伴侧栏会一直是
    // 静默的,发起方却在等 —— 这正是「目标侧执行过程黑洞」在列表上的样子。
    const canonicalSessionId = canonicalBotSessionId(bot);
    const canonicalActivity = canonicalSessionId ? islandActivity.get(canonicalSessionId) : undefined;
    if (canonicalActivity?.phase === 'running') return canonicalActivity;
    // 群专线在群聊行上显示运行中,不让这位伙伴自己的行也跟着「正在输入…」;
    // IM 专线在 IM 里回复,同样不点亮这一行。
    return withoutBotHiddenLanes(bot.sessions).map((session) => islandActivity.get(session.id))
      .find((activity) => activity?.phase === 'running');
  };
  // 伙伴搜索并入侧栏总搜索(TeammateSearchResults),段内不再单独筛选。
  const roster = partitionBotRoster(rosterBots, { query: '', showHidden });
  // A cloud companion is one row wherever it runs; only per-computer Cindys still merge into one entry.
  const cindyOptions = cindyDeviceOptions(withoutCloudCompanions(bots, cloud), withoutCloudCompanions(remoteBots, cloud),
    devices ?? [], unreadByBotId, t('bots.devicePicker.local'));
  const statusForBot = (bot: BotProfile | (typeof remoteBots)[number]) => 'deviceId' in bot
    ? remoteTeammateStatus(bot, isRemoteBotUnread(bot), isCloudCompanionRemote(cloud, bot))
    : localTeammateStatus(bot, islandActivity, (unreadByBotId[bot.id] ?? 0) > 0);
  const cindyStatus = aggregateTeammateStatus(cindyOptions.map(option => statusForBot(option.bot)));
  const hasMultipleCindys = cindyOptions.length > 1;
  const routeCindy = cindyOptions.find(option => option.key === cindyDeviceKey({ id: botId ?? '', deviceId }));
  // Follow the open Cindy chat; otherwise the local-first roster is the default.
  const currentCindy = routeCindy ?? cindyOptions[0];
  const showCindy = hasMultipleCindys && Boolean(currentCindy);
  const visibleBots = [
    ...roster.visible.filter(bot => !hasMultipleCindys || !cindyOptions.some(option => option.bot === bot)),
    ...remoteBots.filter(bot => !hasMultipleCindys || !isCindyDeviceBot(bot)),
  ];
  // 已归档的群不在段内列出,经侧栏总搜索找回(TeammateSearchResults)。
  const visibleGroups = groups.filter(group => !group.archived);

  useEffect(() => {
    const previous = previousSelectedGroupRef.current;
    previousSelectedGroupRef.current = groups.find(group => group.id === selectedGroupId);
    // Settings can archive the selected group without going through the row
    // menu. Reuse its recovery after the drawer and confirmation release focus.
    if (previous && !previous.archived && !pendingArchiveFocusRef.current &&
      (selectedGroupId === previous.id || pathname === '/bots/list') &&
      groups.some(group => group.id === previous.id && group.archived)) {
      pendingArchiveFocusRef.current = { groupId: previous.id, archived: true, origin: null };
    }
  }, [groups, selectedGroupId, pathname]);

  useEffect(() => {
    const pending = pendingArchiveFocusRef.current;
    if (!pending) return;
    const updatedGroup = groups.find(group => group.id === pending.groupId);
    if (!updatedGroup || updatedGroup.archived !== pending.archived) return;

    let timer: number | undefined;
    let cancelled = false;
    const restoreFocus = () => {
      if (cancelled) return;
      // The confirmation dialog keeps its AlertDialog mounted for its closing
      // animation. Wait until Radix has released focus before moving it to the
      // row that replaced the original trigger.
      if (document.querySelector('[role="alertdialog"]')) {
        timer = window.setTimeout(restoreFocus, 50);
        return;
      }

      // Focus recovery is only for the original keyboard path. If the user
      // has already moved focus to another row, the search field, or any
      // other control while the refresh was in flight, leave that choice
      // untouched. A body focus means the original row was unmounted.
      const active = document.activeElement;
      if (active !== pending.origin && active !== document.body) {
        pendingArchiveFocusRef.current = null;
        return;
      }

      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-bot-group-id]'))
        .find(element => element.dataset.botGroupId === pending.groupId);
      const rowIsVisible = visibleGroups.some(group => group.id === pending.groupId);
      if (row && rowIsVisible) {
        pendingArchiveFocusRef.current = null;
        row.focus();
        return;
      }

      // Archived groups disappear from the section and stay findable through the
      // sidebar search. Keep focus inside the section when the row is removed.
      if (pending.archived) {
        pendingArchiveFocusRef.current = null;
        const target = sidebarRef.current?.querySelector<HTMLButtonElement>('button');
        target?.focus();
        return;
      }

      // The user may have changed the search while the request was in flight.
      // Do not keep a stale request that could steal focus later when the filter
      // is cleared.
      pendingArchiveFocusRef.current = null;
    };

    timer = window.setTimeout(restoreFocus, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [groups, visibleGroups]);
  const visibleChats = [
    ...visibleBots.map(bot => ({ kind: 'bot' as const, bot,
      pinned: 'pinnedAt' in bot && Boolean(bot.pinnedAt),
      activityAt: 'activityAt' in bot ? bot.activityAt : bot.lastMessageAt ?? bot.createdAt })),
    ...visibleGroups.map(group => ({ kind: 'group' as const, group, pinned: false,
      activityAt: botGroupActivityAt(group) })),
    ...(showCindy && currentCindy ? [{ kind: 'cindy' as const, pinned: cindyOptions.some(option => 'pinnedAt' in option.bot && Boolean(option.bot.pinnedAt)),
      activityAt: Math.max(...cindyOptions.map(option => 'activityAt' in option.bot ? option.bot.activityAt : option.bot.lastMessageAt ?? option.bot.createdAt)) }] : []),
  ].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.activityAt - a.activityAt);

  // Keep the open chat in the five-row preview without growing the section.
  const selectedChat = visibleChats.find(entry => entry.kind === 'group'
    ? entry.group.id === selectedGroupId
    : entry.kind === 'cindy' ? Boolean(routeCindy)
      : entry.bot.id === botId && ('deviceId' in entry.bot ? entry.bot.deviceId === deviceId : !deviceId));
  const previewChats = visibleChats.slice(0, CHAT_PREVIEW_LIMIT);
  if (selectedChat && !previewChats.includes(selectedChat)) {
    previewChats[CHAT_PREVIEW_LIMIT - 1] = selectedChat;
  }
  const displayedChats = showAllChats ? visibleChats : previewChats;

  useEffect(() => {
    if (roster.visible.length + remoteBots.length + groups.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [roster.visible.length, remoteBots.length, groups.length]);

  // 曾经这里还按 bot 逐个拉 `getBotHealth` 只为在行尾画一个状态图标。图标下线之后
  // 这一轮 N 次 IPC 也一起下线——列表不再为一个不显示的东西查询。

  const renderContextMenu = (kind: 'bot' | 'group', id: string, children: ReactNode) => (
    <DropdownMenu
      open={contextMenu?.kind === kind && contextMenu.id === id}
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
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderBotContextMenu = (bot: BotProfile, selected: boolean) => renderContextMenu('bot', bot.id, <>
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
        {bot.templateId !== 'cindy' && (
          <>
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
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="danger" onSelect={() => setDeleteTarget(bot)}
        >
          <Trash2 size={14} className="mr-2" />
          {t('bots.lifecycle.delete')}
        </DropdownMenuItem>
  </>);

  const renderGroupRow = (group: BotGroupSummary) => (
    <BotGroupSidebarRow key={'group:' + group.id} group={group} bots={bots}
      islandActivity={islandActivity} now={now} selected={group.id === selectedGroupId}
      onOpenGroup={id => navigate('/bots/groups/' + encodeURIComponent(id))}
      onContextMenu={event => {
        event.preventDefault(); event.stopPropagation();
        openContextMenu('group', group.id, event.currentTarget, event.clientX, event.clientY);
      }}
      onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openContextMenu('group', group.id, event.currentTarget, rect.left + 10, rect.bottom);
      }}>
      {renderContextMenu('group', group.id, <>
        <DropdownMenuItem onSelect={() => navigate('/bots/groups/' + encodeURIComponent(group.id) + '?' + BOT_GROUP_SETTINGS_PARAM + '=1')}>
          <Settings size={14} className="mr-2" />{t('bots.groupChat.settings.title')}
        </DropdownMenuItem>
        {group.serverBacked && !group.dissolvedAt && group.members.some(member => member.isOwned && (member.role === 'owner' || member.role === 'admin')) && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={archiveBusy} onSelect={() => void changeGroupArchive(group)}>
            {group.archived ? <ArchiveRestore size={14} className="mr-2" /> : <Archive size={14} className="mr-2" />}
            {t('bots.groupChat.server.settings.' + (group.archived ? 'unarchive' : 'archive'))}
          </DropdownMenuItem>
        </>}
      </>)}
    </BotGroupSidebarRow>
  );

  const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
  const toggleLabel = collapsed ? t('bots.list.sectionExpand') : t('bots.list.sectionCollapse');
  const openChat = (entry: (typeof visibleChats)[number]) => {
    if (entry.kind === 'group') navigate(`/bots/groups/${encodeURIComponent(entry.group.id)}`);
    else if (entry.kind === 'cindy') { if (currentCindy) navigate(currentCindy.route); }
    else if ('deviceId' in entry.bot) navigate(`/bots/remote/${encodeURIComponent(entry.bot.deviceId)}/${encodeURIComponent(entry.bot.id)}`);
    else navigate(`/bots/${entry.bot.id}`);
  };

  return (
    <div ref={sidebarRef} style={teammateSelectionStyle} className="flex w-full flex-col gap-0.5" data-sidebar-section="teammates">
      {/* 段头与置顶 / 全部任务段头同款:高 24,左 24 / 右 12;动作悬停浮现。 */}
      <div className="group/sidebar-header flex h-6 items-center justify-between pr-3 pl-6">
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            className="text-sm leading-5 font-medium text-[var(--sidebar-list-muted)] transition-colors hover:text-[var(--sidebar-nav-text)]"
          >
            {t('bots.title')}
          </button>
          <div className={HEADER_HOVER_ACTION_CLASS}>
            <Tip text={toggleLabel} side="bottom">
              <button type="button" onClick={toggleCollapsed} aria-label={toggleLabel} aria-expanded={!collapsed} className={HEADER_ICON_BUTTON_CLASS}>
                <ToggleIcon size={13} strokeWidth={2} />
              </button>
            </Tip>
          </div>
        </div>
        <div className={cn('flex items-center gap-0.5', HEADER_HOVER_ACTION_CLASS)}>
          {roster.showHiddenSection && !collapsed ? (
            <span className="flex">
              <button
                type="button"
                onClick={() => setShowHidden((value) => !value)}
                className={HEADER_ICON_BUTTON_CLASS}
                aria-label={t(showHidden ? 'bots.list.hideHidden' : 'bots.list.showHidden')}
              >
                {showHidden ? <EyeOff size={13} strokeWidth={2} /> : <Eye size={13} strokeWidth={2} />}
              </button>
            </span>
          ) : null}
          <BotCreateMenu variant="header" />
        </div>
      </div>

      {collapsed ? (
        // 收起:单行头像,未读带点;顺序与展开时一致,放不下的收进末尾「+N」(点开即展开整段)。
        <div ref={avatarRowRef} className="flex flex-nowrap items-center gap-2 overflow-hidden py-1 pr-0 pl-[22px]">
          {(() => {
            const entries = visibleChats.map((entry) => {
              const key = entry.kind === 'group' ? `group:${entry.group.id}`
                : entry.kind === 'cindy' ? 'cindy-devices'
                  : 'deviceId' in entry.bot ? remoteBotKey(entry.bot) : entry.bot.id;
              const name = entry.kind === 'group' ? entry.group.name
                : entry.kind === 'cindy' ? currentCindy?.bot.name ?? '' : entry.bot.name;
              const selected = entry.kind === 'group' ? entry.group.id === selectedGroupId
                : entry.kind === 'cindy' ? Boolean(routeCindy)
                  : 'deviceId' in entry.bot ? entry.bot.id === botId && entry.bot.deviceId === deviceId
                    : !deviceId && entry.bot.id === botId;
              const unread = entry.kind === 'group' ? isBotGroupUnread(entry.group)
                : entry.kind === 'cindy' ? cindyOptions.some(option => option.unread)
                  : 'deviceId' in entry.bot ? isRemoteBotUnread(entry.bot) : (unreadByBotId[entry.bot.id] ?? 0) > 0;
              const status = entry.kind === 'group' ? groupTeammateStatus(entry.group, bots, islandActivity, unread)
                : entry.kind === 'cindy' ? cindyStatus : statusForBot(entry.bot);
              // 与展开行的「@」同口径:群(含话题)里有未读且 @ 了本人。
              const mentioned = entry.kind === 'group' && unread && entry.group.serverUnread?.mentioned === true;
              const label = [name, ...(status === 'idle' ? [] : [t(`bots.avatarStatus.${status}`)]),
                ...(mentioned ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ');
              return { entry, key, name, selected, unread, status, mentioned, label };
            });
            const overflow = entries.length > avatarCapacity;
            let shown = overflow ? entries.slice(0, Math.max(0, avatarCapacity - 1)) : entries;
            // 正在看的聊天始终留在行内,占最后一个可见位。
            const selectedEntry = entries.find((item) => item.selected);
            if (overflow && selectedEntry && !shown.includes(selectedEntry) && shown.length > 0) {
              shown = [...shown.slice(0, -1), selectedEntry];
            }
            const hidden = entries.filter((item) => !shown.includes(item));
            const hiddenMentioned = hidden.some(item => item.mentioned);
            // +N 的悬停提示与读屏名称共用一份文本,收进去的 @ 对鼠标用户同样可读。
            const moreLabel = [`${t('bots.list.sectionExpand')} · +${hidden.length}`,
              ...(hiddenMentioned ? [t('bots.groupChat.server.thread.hintMentioned')] : [])].join(' · ');
            return (
              <>
                {shown.map(({ entry, key, selected, status, mentioned, label }) => (
                  <Tip key={key} text={label} side="bottom">
                    <button
                      type="button"
                      onClick={() => openChat(entry)}
                      aria-label={label}
                      aria-current={selected ? 'page' : undefined}
                      className="relative isolate flex h-12 w-12 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {/* Preserve the quiet selection plate independently of the smaller portrait. */}
                      {selected ? <span aria-hidden data-teammate-selected className="absolute -inset-1 -z-10 rounded-xl bg-sidebar-item-active" /> : null}
                      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
                        {entry.kind === 'group' ? (
                          <BotGroupSidebarAvatar members={entry.group.members} compact />
                        ) : (entry.kind === 'cindy' ? currentCindy?.bot : entry.bot) ? (
                          <BotAvatar bot={(entry.kind === 'cindy' ? currentCindy?.bot : entry.bot)!} size="strip" />
                        ) : null}
                        <TeammateStatusDot status={status} mentioned={mentioned} />
                      </span>
                    </button>
                  </Tip>
                ))}
                {hidden.length > 0 ? (
                  <Tip text={moreLabel} side="bottom">
                    <button
                      type="button"
                      onClick={() => { toggleCollapsed(); setShowAllChats(true); }}
                      aria-label={moreLabel}
                      className="group/overflow flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-11 font-medium tabular-nums text-[var(--sidebar-nav-text)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[var(--surface-chip)] px-1.5 group-hover/overflow:bg-sidebar-item-hover">
                        +{hidden.length}
                        <TeammateStatusDot status={aggregateTeammateStatus(hidden.map(item => item.status))} mentioned={hiddenMentioned} />
                      </span>
                    </button>
                  </Tip>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : null}

      <SectionCollapse collapsed={collapsed}>
      <div className="flex flex-col pt-1 pr-0 pl-3">

      {archiveError && <p role="alert" className="mb-2 px-2.5 text-12 text-[var(--error-fg)]">{archiveError}</p>}

      <div>
        {roster.visible.length === 0 && roster.hidden.length === 0 && archivedBots.length === 0 && remoteBots.length === 0 && visibleGroups.length === 0 ? (
          <div className="px-3 py-3">
            <BotCreateMenu label={t('bots.add')} />
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {displayedChats.map(entry => {
              if (entry.kind === 'group') return renderGroupRow(entry.group);
              if (entry.kind === 'cindy') {
                if (!currentCindy) return null;
                const bot = currentCindy.bot;
                const local = 'deviceId' in bot ? null : bot;
                const selected = Boolean(routeCindy);
                const activity = local ? botRunningActivity(local) : undefined;
                const subtitle = local ? botListSubtitle(local) : null;
                const subtitleText = cindyStatus === 'awaiting' ? t('bots.avatarStatus.awaiting') : activity ? <BotGenerationLabel sessionId={activity.sessionId} phase={activity.workingPhase} startedAt={activity.startedAtMs} />
                  : 'deviceId' in bot && bot.online && bot.generation ? <BotGenerationLabel sessionId={bot.sessionId ?? undefined} {...bot.generation} remote={{ deviceId: bot.deviceId, botId: bot.id }} />
                  : subtitle ? subtitle.kind === 'placeholder' ? t('bots.list.startChat') : subtitle.text
                    : 'preview' in bot ? bot.preview || bot.description || t('bots.list.startChat') : '';
                return <CindyDeviceRow key="cindy-devices" current={currentCindy} options={cindyOptions}
                  status={cindyStatus} selected={selected} typing={Boolean(activity || ('deviceId' in bot && bot.online && bot.generation))} subtitle={subtitleText}
                  timestamp={formatBotListTimestamp(local
                    ? botListTimestampAt({ lastMessageAt: local.lastMessageAt, working: Boolean(activity) }, now)
                    : 'activityAt' in bot ? bot.activityAt : 0, now, t)}
                  onOpen={() => navigate(currentCindy.route)}
                  onSelect={option => navigate(option.route)}
                  onContextMenu={local ? event => {
                    event.preventDefault(); event.stopPropagation();
                    openContextMenu('bot', local.id, event.currentTarget, event.clientX, event.clientY);
                  } : undefined}
                  onKeyDown={local ? event => {
                    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu('bot', local.id, event.currentTarget, rect.left + 10, rect.bottom);
                  } : undefined}>
                  {local ? renderBotContextMenu(local, selected) : null}
                </CindyDeviceRow>;
              }
              const bot = entry.bot;
              if ('deviceId' in bot) {
                const selected = bot.id === botId && bot.deviceId === deviceId;
                const deviceName = botDeviceLabel({ deviceId: bot.deviceId, name: bot.deviceName }, rosterDevices);
                return (
                  <button key={remoteBotKey(bot)} type="button" aria-current={selected ? 'page' : undefined}
                    onClick={() => navigate(`/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`)}
                    className={cn('flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring', selected ? 'bg-sidebar-item-active text-sidebar-item-active-foreground' : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover')}>
                    <span className="relative shrink-0"><BotAvatar bot={bot} size="row" /><TeammateStatusDot status={statusForBot(bot)} /></span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 truncate text-14 leading-5">{bot.name}</span>
                        <BotConnectionStatus inline online={bot.online} connectionKnown={bot.connectionKnown} deviceName={deviceName} quiet={isCloudCompanionRemote(cloud, bot)} className={selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]'} />
                      </span>
                      <span className={cn('truncate text-12 leading-4', selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]')}>{statusForBot(bot) === 'awaiting' ? t('bots.avatarStatus.awaiting') : bot.online && bot.generation ? <BotGenerationLabel sessionId={bot.sessionId ?? undefined} {...bot.generation} remote={{ deviceId: bot.deviceId, botId: bot.id }} /> : bot.preview || bot.description || t('bots.list.startChat')}</span>
                    </span>
                    <span className={cn('min-w-10 shrink-0 self-start whitespace-nowrap pt-0.5 text-right text-11 tabular-nums', selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]')}>{formatBotListTimestamp(bot.activityAt, now, t)}</span>
                  </button>
                );
              }
              const selected = !deviceId && bot.id === botId;
              const unread = unreadByBotId[bot.id] ?? 0;
              const subtitle = botListSubtitle(bot);
              // TA 正在回话时，第二行临时让位给「正在输入…」——聊天列表里这一行
              // 回答的是「TA 现在怎么样」，进行中比上一句说过什么更要紧。回合一
              // 结束就落回最新消息预览，不留痕。
              const activity = botRunningActivity(bot);
              const typing = Boolean(activity);
              const subtitleText = statusForBot(bot) === 'awaiting' ? t('bots.avatarStatus.awaiting') : typing
                ? <BotGenerationLabel sessionId={activity?.sessionId} phase={activity?.workingPhase} startedAt={activity?.startedAtMs} />
                : subtitle.kind === 'placeholder'
                  ? t('bots.list.startChat')
                  : subtitle.text;
              // 正在干活时取此刻 —— 委派/定时任务跑着不产生消息,只看
              // lastMessageAt 会让一个正忙的伙伴显示成「20 分钟前」,
              // 和第二行的「正在输入…」自相矛盾。见 botListTimestampAt。
              const timestamp = formatBotListTimestamp(
                botListTimestampAt({ lastMessageAt: bot.lastMessageAt, working: typing }, now),
                now,
                t,
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
                      单看不出问题,和左侧头像一比就是歪的。这里的行内边距与下方按钮样式
                      保持同一套几何基线。 */}
                  <button
                    type="button"
                    onClick={() => navigate(`/bots/${bot.id}`)}
                    aria-current={selected ? 'page' : undefined}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openContextMenu('bot', bot.id, event.currentTarget, event.clientX, event.clientY);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
                        return;
                      }
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      openContextMenu('bot', bot.id, event.currentTarget, rect.left + 10, rect.bottom);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {/* Keep the existing avatar size alongside identity and message preview. */}
                    <span className="relative shrink-0"><BotAvatar bot={bot} size="row" /><TeammateStatusDot status={statusForBot(bot)} /></span>
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
                          title={botRosterLabel(bot, bots)}
                        >
                          {botRosterLabel(bot, bots)}
                        </span>
                        {!typing && <BotConnectionStatus inline className={selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]'} />}
                        {/* 权限模式仍不在聊天列表挂警告；这里仅显示 Hermes 风格、
                            已持久化且需要用户处理的运行失败。 */}

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
                          title={typeof subtitleText === 'string' ? subtitleText : undefined}
                        >
                          {subtitleText}
                        </span>
                      </span>
                    </span>
                    {/*
                      时间与未读共用右对齐列；相对时间按文字宽度撑开，避免折行。
                    */}
                    <span className="flex min-w-10 shrink-0 self-stretch flex-col items-end justify-between whitespace-nowrap py-0.5">
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
                  {renderBotContextMenu(bot, selected)}
                </div>
              );
            })}
            {visibleChats.length > CHAT_PREVIEW_LIMIT ? (
              <button
                type="button"
                aria-expanded={showAllChats}
                onClick={() => setShowAllChats(value => !value)}
                className={cn(
                  'flex h-6 w-full items-center justify-center rounded-full px-2 text-xs font-normal',
                  'text-[var(--cmd-palette-item-meta)] transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                {showAllChats ? t('bots.list.showLess') : t('ccAgent.sidebar.showAllSessions', { count: visibleChats.length })}
              </button>
            ) : null}
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
                            {botRosterLabel(bot, bots)}
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
                          title={botRosterLabel(bot, bots)}
                        >
                          {botRosterLabel(bot, bots)}
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
      </div>
      </SectionCollapse>
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
