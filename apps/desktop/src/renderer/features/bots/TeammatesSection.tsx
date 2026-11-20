import { companionDragProps } from './companionDragProps';
import { BotRosterLoadError } from './BotRosterLoadError';
import { aggregateTeammateStatus } from '@cindy/maker-shared/teammate-status';
import { localTeammateStatus, remoteTeammateStatus, groupTeammateStatus } from './teammateRosterStatus';
import { botRosterLabel } from '../../../shared/botCreation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
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
import { Spinner } from '@/components/ui/spinner';
import { SectionCollapse } from '@/features/cc-agent/sidebar/SectionCollapse';
import { SIDEBAR_LIST_ROW_ACTIVE_CLASS } from '@/features/cc-agent/sidebar/listRowStyle';
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
import { CindyDevicePicker } from './CindyDevicePicker';
import { TeammateTextRow } from './TeammateTextRow';
import type { TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { cindyDeviceKey, cindyDeviceOptions, isCindyDeviceBot } from './cindyDeviceRoster';
import { BotAvatar } from './BotAvatar';
import { BotCreateMenu } from './BotCreateMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import { refreshBotGroups, useBotGroupList } from './botGroupStore';
import { BOT_GROUP_SETTINGS_PARAM, botGroupActivityAt } from './botGroupPresentation';
import { chatErrorKey } from './chatError';
import { subscribeBotReadState, getBotLastReadAtMap, isBotGroupUnread } from './botReadState';
import { partitionBotRoster } from './botRosterDisplay';
import {
  duplicateBotProfile,
  setBotHidden,
  setBotPinned,
  useBotProfiles,
  useBotProfilesLoadState,
  hasLoadedBotProfiles,
  useBotUnreadCounts,
  type BotProfile,
} from './botStore';

const readRevision = () => JSON.stringify(getBotLastReadAtMap());


/**
 * 侧栏第一层的「伙伴」段(2026-10-13 定稿):固定在置顶段上方,与置顶、全部任务并存。
 * 点伙伴只切换主区域,左栏不再整栏切换。收起状态按账号记住。
 * 2026-11-19 起只有单行文字列表(无头像条、无图标/列表切换),与任务行同一套几何;
 * 收起时仅保留未读或等待处理的聊天。通知由任务侧栏负责。
 */
export function TeammatesSection({
  onAttentionChange,
}: {
  /** 有没有需要你看的聊天(未读 / 等你回复 / 出错),供顶部「伙伴」标签加粗。 */
  onAttentionChange?: (attention: boolean) => void;
} = {}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const { pathname } = useLocation();
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
  const cloud = useCompanionCloud();
  const rosterRemoteBots = useRemoteBots();
  // One row per companion, on its main computer (offline rows for computers never listed here).
  const remoteBots = useMemo(() => cloudRemoteBots(cloud, rosterRemoteBots), [rosterRemoteBots, cloud]);
  const devices = useDeviceLinkDeviceList();
  const allBots = useBotProfiles();
  const profileLoadState = useBotProfilesLoadState();
  const profilesLoaded = hasLoadedBotProfiles();
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
      const accepted = await confirm({ title: t(actionKey),
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
        (row.matches('button') ? row : row.querySelector<HTMLButtonElement>('button'))?.focus();
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

  const chatState = (entry: (typeof visibleChats)[number]) => {
    const unread = entry.kind === 'group' ? isBotGroupUnread(entry.group)
      : entry.kind === 'cindy' ? cindyOptions.some(option => option.unread)
        : 'deviceId' in entry.bot ? isRemoteBotUnread(entry.bot) : (unreadByBotId[entry.bot.id] ?? 0) > 0;
    const status = entry.kind === 'group' ? groupTeammateStatus(entry.group, bots, islandActivity, unread)
      : entry.kind === 'cindy' ? cindyStatus : statusForBot(entry.bot);
    return { unread, status };
  };
  const needsAttention = (entry: (typeof visibleChats)[number]) => {
    const { unread, status } = chatState(entry);
    return unread || status === 'awaiting' || status === 'error';
  };
  /** 文字行只用一个状态:运行 → 转圈;未读而状态空闲时按未读加粗。 */
  const rowStatus = (entry: (typeof visibleChats)[number]) => {
    const { unread, status } = chatState(entry);
    return status === 'idle' && unread ? 'unread' as const : status;
  };
  // 伙伴标签里列出全部聊天，不再只预览五条。
  const displayedChats = visibleChats;
  const hasAttention = visibleChats.some(needsAttention);
  useEffect(() => {
    onAttentionChange?.(hasAttention);
  }, [hasAttention, onAttentionChange]);

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

  const renderGroupRow = (group: BotGroupSummary, status: TeammateStatus) => (
    <TeammateTextRow key={'group:' + group.id} name={group.name} status={status}
      selected={group.id === selectedGroupId}
      route={`/bots/groups/${encodeURIComponent(group.id)}`}
      dataAttributes={{ 'data-bot-group-id': group.id }}
      onOpen={() => navigate('/bots/groups/' + encodeURIComponent(group.id))}
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
    </TeammateTextRow>
  );

  const chatRoute = (entry: (typeof visibleChats)[number]) => {
    if (entry.kind === 'group') return `/bots/groups/${encodeURIComponent(entry.group.id)}`;
    if (entry.kind === 'cindy') return currentCindy?.route;
    const bot = entry.bot;
    return 'deviceId' in bot ? `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}` : `/bots/${encodeURIComponent(bot.id)}`;
  };

  return (
    <div ref={sidebarRef} className="flex w-full flex-col gap-0.5" data-sidebar-section="teammates">
      {/* 「伙伴」已是侧栏顶部标签本身(2026-11-19):不再有段头与收起;新建伙伴在标签行行尾。 */}
      {!profilesLoaded && profileLoadState === 'pending' ? (
        <div role="status" className="flex items-center gap-2 px-3 py-3 text-12 text-[var(--text-secondary)]">
          <Spinner size={14} />
          {t('ccAgent.common.loading')}
        </div>
      ) : null}

      {profileLoadState === 'error' ? (
        <div className="pt-1 pr-0 pl-3"><BotRosterLoadError /></div>
      ) : null}

      <SectionCollapse collapsed={false}>
      <div className="flex flex-col pt-1 pr-0 pl-3">

      {archiveError && <p role="alert" className="mb-2 px-2.5 text-12 text-[var(--error-fg)]">{archiveError}</p>}

      <div>
        {roster.visible.length === 0 && roster.hidden.length === 0 && archivedBots.length === 0 && remoteBots.length === 0 && visibleGroups.length === 0 ? (
          profilesLoaded && profileLoadState === 'ready' ? (
            <div className="px-3 py-3">
              <BotCreateMenu label={t('bots.add')} />
            </div>
          ) : null
        ) : (
          <div className="flex flex-col gap-0.5">
            {displayedChats.map(entry => {
              const status = rowStatus(entry);
              if (entry.kind === 'group') return renderGroupRow(entry.group, status);
              if (entry.kind === 'cindy') {
                if (!currentCindy) return null;
                const bot = currentCindy.bot;
                const local = 'deviceId' in bot ? null : bot;
                const selected = Boolean(routeCindy);
                return (
                  <TeammateTextRow key="cindy-devices" name={bot.name} status={status} selected={selected}
                    route={currentCindy.route}
                    dataAttributes={{ 'data-testid': 'cindy-device-row' }}
                    onOpen={() => navigate(currentCindy.route)}
                    // 多台电脑时保留切换入口(灰色小字);只有一台就只显示名字。
                    trailing={cindyOptions.length > 1 ? (
                      <CindyDevicePicker
                        options={cindyOptions}
                        current={currentCindy}
                        onSelect={option => navigate(option.route)}
                        className={cn(
                          'min-w-0 shrink px-1 text-11 text-[var(--sidebar-list-muted)] focus-visible:ring-inset',
                          '[--button-face-bg:transparent] [--button-face-border:transparent] [--button-face-outset:0px]',
                          'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:hsl(var(--sidebar-item-hover))]',
                        )}
                      />
                    ) : null}
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
                  </TeammateTextRow>
                );
              }
              const bot = entry.bot;
              if ('deviceId' in bot) {
                const selected = bot.id === botId && bot.deviceId === deviceId;
                return (
                  <TeammateTextRow key={remoteBotKey(bot)} name={bot.name} status={status} selected={selected}
                    route={chatRoute(entry)}
                    onOpen={() => navigate(chatRoute(entry)!)} />
                );
              }
              const selected = !deviceId && bot.id === botId;
              return (
                <TeammateTextRow key={bot.id} name={botRosterLabel(bot, bots)} status={status} selected={selected}
                  route={`/bots/${encodeURIComponent(bot.id)}`}
                  onOpen={() => navigate(`/bots/${encodeURIComponent(bot.id)}`)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openContextMenu('bot', bot.id, event.currentTarget, event.clientX, event.clientY);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu('bot', bot.id, event.currentTarget, rect.left + 10, rect.bottom);
                  }}>
                  {renderBotContextMenu(bot, selected)}
                </TeammateTextRow>
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
                        className="group flex w-full items-center rounded-lg text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover"
                      >
                        <button
                          type="button"
                          {...companionDragProps(`/bots/${encodeURIComponent(bot.id)}`, bot.name)}
                          onClick={() => navigate(`/bots/${encodeURIComponent(bot.id)}`)}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left opacity-60"
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
                        'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                        selected
                          ? SIDEBAR_LIST_ROW_ACTIVE_CLASS
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
