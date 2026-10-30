import { resolveTeammateStatus, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { deviceDisplayName } from '@/device-link/deviceName';
import { readWorkingPhase } from '@cindy/maker-shared';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useAuth } from '@/auth/AuthContext';
import { isRemoteResourceUnread } from '@/device-link/remoteResourceCache';
import type { HostedRemoteCollectionItem, RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { useMinuteNow } from '@/utils/useMinuteNow';
import { BotGroupListRow, OFFLINE_AVATAR_OPACITY } from './BotGroupList';
import { orderedBotGroups } from './botGroupRemote';
import { CompanionListRow, COMPANION_ROW_AVATAR_SIZE } from './CompanionListRow';
import { TeammateStatusDot } from './TeammateStatusDot';
import { useRosterActivities, teammateAttention } from './useTeammateStatus';
import { formatRemoteSessionSidebarTime } from './sessionList';
import { orderedTeammates } from './teammateNavigation';
import { parseMobileMarkdownInlines } from './messageMarkdown';
import { TeammateGenerationLabel } from './TeammateGenerationLabel';

interface TeammateListGroups {
  items: readonly HostedRemoteCollectionItem[];
  isOnline(host: RemoteResourceHostTarget): boolean;
  onSelect(item: HostedRemoteCollectionItem): void;
}

interface TeammateRowOptions {
  items: readonly HostedRemoteCollectionItem[];
  isOnline(host: RemoteResourceHostTarget): boolean;
  connectionState?(host: RemoteResourceHostTarget): boolean | null;
  /**
   * A cloud companion's row (docs/product-rules/cloud-companions.md §3.1): it belongs to the
   * account, so presence is not shown — like an IM contact, it stays a normal row while its
   * computer is briefly unreachable; a send that cannot get through is what asks to switch.
   */
  quietPresence?(row: HostedRemoteCollectionItem): boolean;
  onSelect(item: HostedRemoteCollectionItem): void;
  /** Group chats, mixed with the teammates by latest activity. */
  groups?: TeammateListGroups;
}

export function conversationSessionId(row: HostedRemoteCollectionItem): string | null {
  const target = row.item.links.find(({ rel, target: link }) => rel === 'conversation' && link.kind === 'session')?.target;
  return target?.kind === 'session' ? target.sessionId : null;
}

export type TeammateListEntry = { kind: 'bot' | 'group'; row: HostedRemoteCollectionItem };

/** Teammates and group chats, mixed by latest activity and filtered by the same search. */
export function useTeammateEntries(items: readonly HostedRemoteCollectionItem[], groups: readonly HostedRemoteCollectionItem[] | undefined, query = '') {
  const { i18n } = useTranslation();
  return useMemo<TeammateListEntry[]>(() => {
    const bots = orderedTeammates(items, query, i18n.language).map((row) => ({ kind: 'bot' as const, row }));
    if (!groups) return bots;
    const chats = orderedBotGroups(groups, query, i18n.language).map((row) => ({ kind: 'group' as const, row }));
    return [...bots, ...chats].sort((a, b) => (b.row.item.display.timestamp ?? 0) - (a.row.item.display.timestamp ?? 0)
      || a.row.key.localeCompare(b.row.key));
  }, [groups, items, query, i18n.language]);
}

/** The teammate / group row of the task home's teammate section. */
export function useTeammateRowRenderer({ items, isOnline, connectionState, quietPresence, onSelect, groups }: TeammateRowOptions) {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const now = useMinuteNow();
  const activities = useRosterActivities(items);
  // Resource refreshes replace objects and navigation closures even when the row
  // looks identical. Keep presses current without invalidating every visible row.
  const selection = useRef({ items, onSelect });
  useLayoutEffect(() => { selection.current = { items, onSelect }; }, [items, onSelect]);
  const select = useCallback((key: string) => {
    const current = selection.current;
    // orderedTeammates keeps the last copy of a repeated identity.
    for (let index = current.items.length - 1; index >= 0; index--) {
      const row = current.items[index];
      if (row.key === key) { current.onSelect(row); return; }
    }
  }, []);
  const duplicateNames = useMemo(() => {
    const names = new Map<string, number>();
    for (const row of items) {
      const name = resolveRemoteText(row.item.display.title, i18n.language).normalize('NFKC').toLocaleLowerCase(i18n.language);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return names;
  }, [items, i18n.language]);
  const deviceNameSources = useMemo(() => items.map(row => ({
    deviceId: row.host.deviceId, name: row.host.deviceName,
  })), [items]);
  const renderBot = (row: HostedRemoteCollectionItem, last: boolean) => {
    const display = row.item.display;
    const title = resolveRemoteText(display.title, i18n.language);
    const online = isOnline(row.host);
    const connected = connectionState ? connectionState(row.host) : online;
    const generating = online && !!display.generation
      && display.teammateActivity?.phase !== 'needs-interaction' && activities.get(row.key) !== 'needs-interaction';
    const { attention, waiting } = teammateAttention(row, online, activities, i18n.language);
    const ambiguous = (duplicateNames.get(title.normalize('NFKC').toLocaleLowerCase(i18n.language)) ?? 0) > 1;
    const unread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt);
    const timestamp = display.timestamp;
    const time = timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
      ? formatRemoteSessionSidebarTime(new Date(timestamp).toISOString(), now) : '';
    return <TeammateRow key={`bot:${row.key}`} rowKey={row.key} deviceId={row.host.deviceId} botId={row.item.ref.id}
      title={title} device={ambiguous ? deviceDisplayName(row.host.deviceId, row.host.deviceName, deviceNameSources) : undefined}
      rawPreview={!generating && display.preview ? resolveRemoteText(display.preview, i18n.language) : ''}
      subtitle={display.subtitle ? resolveRemoteText(display.subtitle, i18n.language) : ''}
      avatarKind={display.avatar?.kind} avatarValue={display.avatar?.value}
      avatarFallback={display.avatar?.fallbackText} avatarColor={display.avatar?.color}
      generating={generating} phase={generating ? display.generation!.phase : ''}
      startedAt={generating ? display.generation!.startedAt : null}
      status={resolveTeammateStatus({ online: connected, quietOffline: !!quietPresence?.(row), unread, waiting,
        failed: !!attention, working: generating, activities: [display.teammateActivity, { phase: activities.get(row.key) ?? '' }] })}
      connected={connected} quiet={!!quietPresence?.(row)} attention={attention} waiting={waiting}
      unread={unread} time={time} last={last} onSelect={select} />;
  };
  return (entry: TeammateListEntry, last: boolean) => {
    if (entry.kind === 'bot' || !groups) return renderBot(entry.row, last);
    return <BotGroupListRow key={`group:${entry.row.key}`} row={entry.row} online={groups.isOnline(entry.row.host)} last={last}
      onPress={() => groups.onSelect(entry.row)} />;
  };
}

interface TeammateRowProps {
  status: TeammateStatus;
  rowKey: string; deviceId: string; botId: string; title: string; device?: string;
  rawPreview: string; subtitle: string;
  avatarKind?: string; avatarValue?: string; avatarFallback?: string; avatarColor?: string;
  generating: boolean; phase: string; startedAt: number | null;
  connected: boolean | null; quiet: boolean; attention: string; waiting: boolean;
  unread: boolean; time: string; last: boolean;
  onSelect(key: string): void;
}

// Only display primitives cross this boundary: fresh host/resource objects and
// unrelated home updates must not reparse previews or redraw native row content.
const TeammateAvatar = memo(RemoteCompanionAvatar);
const TeammateRow = memo(function TeammateRow({ rowKey, deviceId, botId, title, device, rawPreview, subtitle,
  avatarKind, avatarValue, avatarFallback, avatarColor, generating, phase, startedAt,
  connected, quiet, attention, waiting, unread, time, last, onSelect, status }: TeammateRowProps) {
  const { t } = useTranslation();
  const preview = useMemo(() => rawPreview ? parseMobileMarkdownInlines(rawPreview)
    .map(inline => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '', [rawPreview]);
  const avatar = useMemo(() => avatarKind === undefined ? undefined : {
    kind: avatarKind, value: avatarValue ?? '', fallbackText: avatarFallback ?? '', color: avatarColor,
  }, [avatarKind, avatarValue, avatarFallback, avatarColor]);
  const press = useCallback(() => onSelect(rowKey), [onSelect, rowKey]);
  // Cached replies stay readable offline, followed by the description or invitation.
  const summary = preview || subtitle.replace(/\s+/g, ' ').trim() || t('devices.companions.startChat');
  const workingCopy = generating ? t(`devices.companions.working.${readWorkingPhase(phase) ?? 'processing'}`) : '';
  const connection = quiet ? '' : connected === false ? t('devices.resources.hostOffline')
    : connected === null ? t('devices.resources.connectionUnknown') : '';
  const prefix = status === 'awaiting' ? t('devices.companions.awaiting') : attention;
  const running = status === 'running';
  return <CompanionListRow testID={`teammates.item.${deviceId}.${botId}`}
    accessibilityLabel={[title, device, connection, prefix,
      status !== 'idle' && status !== 'awaiting' ? t(`devices.companions.avatarStatus.${status}`) : '',
      generating ? workingCopy : summary, time,
      unread ? t('devices.companions.unread') : ''].filter(Boolean).join(', ')}
    avatar={<>
      <View style={connected === false && !quiet ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
        <TeammateAvatar avatar={avatar} deviceId={deviceId} name={title} online={connected === true} size={COMPANION_ROW_AVATAR_SIZE} framed />
      </View>
      <TeammateStatusDot status={status} />
    </>}
    title={title} device={device}
    trailing={{ kind: 'time', text: time }}
    preview={running ? <TeammateGenerationLabel deviceId={deviceId} botId={botId} generation={{ phase, startedAt }} />
      : connection ? `${connection} · ${summary}` : summary}
    previewTone={connection ? 'tertiary' : 'secondary'}
    previewPrefix={connection ? undefined : prefix || undefined}
    previewPrefixTestID={attention ? 'teammate.attention' : undefined}
    unread={false} unreadLabel={t('devices.companions.unread')}
    last={last} onPress={press} />;
});
