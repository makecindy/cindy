import { readWorkingPhase } from '@cindy/maker-shared';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
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
import { CompanionListRow, CompanionPresenceDot, COMPANION_ROW_AVATAR_SIZE } from './CompanionListRow';
import { CompanionPresenceRing } from './CompanionPresenceRing';
import { remoteSessionStore } from './remoteSessionStore';
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

function conversationSessionId(row: HostedRemoteCollectionItem): string | null {
  const target = row.item.links.find(({ rel, target: link }) => rel === 'conversation' && link.kind === 'session')?.target;
  return target?.kind === 'session' ? target.sessionId : null;
}

/** Bot conversations stopped on a question or a permission prompt (「等你确认」). */
function useAwaitingSessions(items: readonly HostedRemoteCollectionItem[]): ReadonlySet<string> {
  const sessions = useMemo(() => items.map(conversationSessionId).filter((id): id is string => !!id), [items]);
  const snapshot = useCallback(() => sessions.filter((id) => remoteSessionStore.getSessionLiveActivity(id)?.phase === 'needs-interaction'
    || remoteSessionStore.getPendingInteractions(id).length > 0).join('\u0000'), [sessions]);
  // A joined id string keeps unrelated store churn (streaming, other sessions) from re-rendering the list.
  const key = useSyncExternalStore(remoteSessionStore.subscribe, snapshot);
  return useMemo(() => new Set(key ? key.split('\u0000') : []), [key]);
}

export type TeammateListEntry = { kind: 'bot' | 'group'; row: HostedRemoteCollectionItem };

/** Teammates and group chats, mixed by latest activity and filtered by the same search. */
export function useTeammateEntries(items: readonly HostedRemoteCollectionItem[], groups: readonly HostedRemoteCollectionItem[] | undefined, query = '') {
  const { i18n } = useTranslation();
  return useMemo<TeammateListEntry[]>(() => {
    const bots = orderedTeammates(items, query, i18n.language).map((row) => ({ kind: 'bot' as const, row }));
    if (!groups) return bots;
    const chats = orderedBotGroups(groups, query, i18n.language).map((row) => ({ kind: 'group' as const, row }));
    return [...bots, ...chats].sort((a, b) => (b.row.item.display.timestamp ?? 0) - (a.row.item.display.timestamp ?? 0));
  }, [groups, items, query, i18n.language]);
}

/** The teammate / group row of the task home's teammate section. */
export function useTeammateRowRenderer({ items, isOnline, connectionState, quietPresence, onSelect, groups }: TeammateRowOptions) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const now = useMinuteNow();
  const awaiting = useAwaitingSessions(items);
  const duplicateNames = useMemo(() => {
    const names = new Map<string, number>();
    for (const row of items) {
      const name = resolveRemoteText(row.item.display.title, i18n.language).normalize('NFKC').toLocaleLowerCase(i18n.language);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return names;
  }, [items, i18n.language]);
  const renderBot = (row: HostedRemoteCollectionItem, last: boolean) => {
    const display = row.item.display;
    const title = resolveRemoteText(display.title, i18n.language);
    const preview = display.preview ? parseMobileMarkdownInlines(resolveRemoteText(display.preview, i18n.language))
      .map(inline => inline.type === 'image' ? inline.alt : inline.text).join('').replace(/\s+/g, ' ').trim() : '';
    const online = isOnline(row.host);
    const connected = connectionState ? connectionState(row.host) : online;
    // Desktop BotsSidebar: the cached reply stays readable offline; then the description, then an invitation.
    const subtitle = display.subtitle ? resolveRemoteText(display.subtitle, i18n.language).replace(/\s+/g, ' ').trim() : '';
    const summary = preview || subtitle || t('devices.companions.startChat');
    const generating = online && !!display.generation;
    const workingCopy = generating ? t(`devices.companions.working.${readWorkingPhase(display.generation!.phase) ?? 'processing'}`) : '';
    const attention = display.status?.tone === 'warning' || display.status?.tone === 'critical'
      ? resolveRemoteText(display.status.label, i18n.language) : '';
    const sessionId = conversationSessionId(row);
    const waiting = online && !generating && !!sessionId && awaiting.has(sessionId);
    const ambiguous = (duplicateNames.get(title.normalize('NFKC').toLocaleLowerCase(i18n.language)) ?? 0) > 1;
    const unread = isRemoteResourceUnread(user?.id ?? '', row.host.deviceId, row.item.ref.id, display.lastReplyAt);
    const timestamp = display.timestamp;
    const time = timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
      ? formatRemoteSessionSidebarTime(new Date(timestamp).toISOString(), now) : '';
    const quiet = !!quietPresence?.(row);
    const connection = quiet ? ''
      : connected === false ? t('devices.resources.hostOffline') : connected === null ? t('devices.resources.connectionUnknown') : '';
    const prefix = attention || (waiting ? t('devices.companions.awaiting') : '');
    return <CompanionListRow key={`bot:${row.key}`} testID={`teammates.item.${row.host.deviceId}.${row.item.ref.id}`}
      accessibilityLabel={[title, ambiguous ? row.host.deviceName : '', connection, prefix, generating ? workingCopy : summary, time,
        unread ? t('devices.companions.unread') : ''].filter(Boolean).join(', ')}
      avatar={<>
        <View style={connected === false && !quiet ? { opacity: OFFLINE_AVATAR_OPACITY } : undefined}>
          <RemoteCompanionAvatar avatar={display.avatar} deviceId={row.host.deviceId} name={title} online={connected === true} size={COMPANION_ROW_AVATAR_SIZE} framed />
        </View>
        <CompanionPresenceRing active={generating} />
        {quiet ? null : <CompanionPresenceDot connected={connected} />}
      </>}
      title={title}
      device={ambiguous ? row.host.deviceName : undefined}
      trailing={generating ? { kind: 'working' } : { kind: 'time', text: time }}
      preview={generating
        ? <TeammateGenerationLabel deviceId={row.host.deviceId} botId={row.item.ref.id} generation={display.generation!} />
        : connection ? `${connection} · ${summary}` : summary}
      previewTone={connection ? 'tertiary' : 'secondary'}
      previewPrefix={connection ? undefined : prefix || undefined}
      previewPrefixTestID={attention ? 'teammate.attention' : undefined}
      unread={unread}
      unreadLabel={t('devices.companions.unread')}
      last={last}
      onPress={() => onSelect(row)} />;
  };
  return (entry: TeammateListEntry, last: boolean) => {
    if (entry.kind === 'bot' || !groups) return renderBot(entry.row, last);
    return <BotGroupListRow key={`group:${entry.row.key}`} row={entry.row} online={groups.isOnline(entry.row.host)} last={last}
      onPress={() => groups.onSelect(entry.row)} />;
  };
}
