/** Mobile partner glance keeps the native sheet: computers, nonempty todos, tasks and outputs.
 * Task navigation/read state and PR status reuse the existing Home contracts.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Linking, View } from 'react-native';
import { Check, ChevronDown, ChevronUp, Monitor, ScanSearch, MessageCircle, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult } from '@cindy/maker-shared/botDelegation';
import { todoDateLabel, todoDue, todoDueSoon, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { prStatusKey, sessionPrUrl } from '@cindy/maker-shared';
import { isAccessRevokedRemoteError } from '@cindy/maker-shared/device-link-contract';
import { getSessionListActivityAt } from '@cindy/maker-shared/session-activity';
import type { RemoteResource } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { remoteCollectionCacheOwner, readRemoteCollectionCache, remoteResourceConnectionState } from '@/device-link/remoteResourceAvailability';
import { NativePullDownMenu } from '@/platform/chrome/NativePullDownMenu';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSheet } from './CompanionSheet';
import { companionGlanceOutputs } from './companionProfileData';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import type { useCompanionGlanceTodos } from './useCompanionGlanceTodos';

import { useCloudCompanionHome } from '@/chat/useCloudCompanion';
import { remoteSessionStore, useRemoteHomeSessions } from './remoteSessionStore';
import { taskTeammateKey, isTeammateTask } from './teammateTaskSource';
import type { RemoteSession } from './types';
import { useHomeSessionPr } from './HomeSessionInfoMeta';
import type { HomeSessionPrInfo } from './homeSessionPrStore';
import { prStatusVisual } from './prStatusVisual';
import { readTeammateTasks } from './readTeammateTasks';

const TODO_PREVIEW = 2;
const TASK_PREVIEW = 5;
const OUTPUT_PREVIEW = 3;
const CINDY_BOT_ID = 'cindy-default';
/** Header avatar (原型 56pt). */
const HEADER_AVATAR = 56;
/** Leading glyph column: rows with an icon start their text (and divider) after it. */
const ICON_COLUMN = 26;
const ICON_GLYPH = 22;
const ROW_GAP = spacing.md + 2;
const DUE_DOT = 6;
const PRESENCE_DOT = 8;

type GlanceTodoState = ReturnType<typeof useCompanionGlanceTodos>;


export function CompanionGlanceSheet({
  visible, onClose, name, avatar, botId, deviceId, deviceName, sessionId, online, cloudHome, todos,
  onQuoteTodo, onCheckTodos, onOpenTask, onOpenCindy, onSwitchHome,
}: {
  visible: boolean;
  onClose(): void;
  name: string;
  avatar: RemoteResource['display']['avatar'];
  botId: string;
  deviceId: string;
  deviceName: string;
  /** The teammate's conversation, whose delegations carry the outputs. */
  sessionId: string;
  online: boolean;
  /** A cloud companion homed on this computer: another computer is chosen in the existing switch flow. */
  cloudHome: boolean;
  todos: GlanceTodoState;
  onQuoteTodo(todo: TeammateTodo): void;
  /** 「帮我查查」: ask the teammate, as the owner, to look for new todos now; absent while this chat cannot send. */
  onCheckTodos?(): void;
  onOpenTask(sessionId: string, deviceId?: string): void;
  onOpenCindy(hosted: HostedRemoteCollectionItem): void;
  onSwitchHome(): void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { accountGeneration } = useAuth();
  // Row actions that leave the sheet run once it has closed, so nothing is presented over it.
  const pending = useRef<(() => void) | null>(null);
  const afterClose = (action: () => void) => { pending.current = action; onClose(); };
  return <CompanionSheet visible={visible} onClose={onClose} title="" contentScrolls testID="companion.glance"
    onClosed={() => { const action = pending.current; pending.current = null; action?.(); }}>
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <RemoteCompanionAvatar avatar={avatar} name={name} deviceId={deviceId} online={online} size={HEADER_AVATAR} framed />
        <Text numberOfLines={1} style={styles.headerName}>{name}</Text>
      </View>
      <Computers botId={botId} deviceId={deviceId} deviceName={deviceName} online={online} cloudHome={cloudHome}
        onOpenCindy={hosted => afterClose(() => onOpenCindy(hosted))} onSwitchHome={() => afterClose(onSwitchHome)} />
      <Todos todos={todos} online={online} onQuote={todo => afterClose(() => onQuoteTodo(todo))} onCheck={onCheckTodos ? () => afterClose(onCheckTodos) : undefined} />
      {visible ? <Activity key={`${accountGeneration}:${deviceId}:${botId}`} botId={botId} deviceId={deviceId} deviceName={deviceName} sessionId={sessionId} online={online}
        onOpenTask={(taskId, taskDeviceId) => afterClose(() => onOpenTask(taskId, taskDeviceId))} /> : null}
    </ScrollView>
  </CompanionSheet>;
}

// ---------------------------------------------------------------- 分组与行（原型 inset grouped 卡片）

function Section({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.section}>
    <View style={styles.sectionHeading}><Text style={styles.sectionLabel}>{label}</Text>{action}</View>
    <View style={styles.card}>{children}</View>
  </View>;
}

/** Rows separated by a hairline that starts at the text column, like the system list. */
function joinRows(rows: ReactNode[], inset: boolean, styles: ReturnType<typeof makeStyles>): ReactNode[] {
  return rows.flatMap((row, index) => index === 0 ? [row]
    : [<View key={`divider-${index}`} style={[styles.divider, inset && styles.dividerInset]} />, row]);
}

function Row({ icon, title, meta, inlineMeta = false, trailing, muted = false, onPress, testID }: {
  icon?: ReactNode; title: string; meta?: string; inlineMeta?: boolean; trailing?: ReactNode; muted?: boolean; onPress?(): void; testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = <>
    {icon ? <View style={styles.icon}>{icon}</View> : null}
    <View style={[styles.rowText, inlineMeta && styles.inlineText]}>
      <Text numberOfLines={1} style={[styles.rowTitle, inlineMeta && styles.inlineTitle, muted && styles.rowTitleMuted]}>{title}</Text>
      {meta ? <Text numberOfLines={1} style={[styles.rowMeta, inlineMeta && styles.inlineMeta]}>{meta}</Text> : null}
    </View>
    {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
  </>;
  if (!onPress) return <View style={[styles.row, inlineMeta && styles.compactRow]} testID={testID}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={meta ? `${title}, ${meta}` : title} onPress={onPress}
    style={({ pressed }) => [styles.row, inlineMeta && styles.compactRow, pressed && styles.rowPressed]} testID={testID}>{body}</Pressable>;
}

function FoldRow({ label, open, inset, onPress, testID }: { label: string; open: boolean; inset: boolean; onPress(): void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const Icon = open ? ChevronUp : ChevronDown;
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onPress}
    style={({ pressed }) => [styles.row, inset && styles.foldInset, pressed && styles.rowPressed]} testID={testID}>
    <Text style={styles.foldLabel}>{label}</Text>
    <Icon size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textTertiary} />
  </Pressable>;
}

// ---------------------------------------------------------------- 电脑

function Computers({ botId, deviceId, deviceName, online, cloudHome, onOpenCindy, onSwitchHome }: {
  botId: string; deviceId: string; deviceName: string; online: boolean; cloudHome: boolean;
  onOpenCindy(hosted: HostedRemoteCollectionItem): void; onSwitchHome(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { user, accountGeneration } = useAuth();
  // getPresenceAvailability is stable and reads live presence; presenceVersion is what changes.
  const { status, getPresenceAvailability, presenceVersion } = useDeviceLink();
  const [showOffline, setShowOffline] = useState(false);
  // Cindy runs a copy on each computer: the other copies come from the teammate list already read
  // on this phone (no extra discovery); other teammates only show the computer they run on.
  const copies = useMemo(() => {
    if (cloudHome || botId !== CINDY_BOT_ID) return [];
    return readRemoteCollectionCache(remoteCollectionCacheOwner(user?.id ?? '', accountGeneration), 'teammates')
      .filter(row => row.item.ref.kind === 'bot' && row.item.ref.id === CINDY_BOT_ID && row.host.deviceId !== deviceId)
      .map(row => ({ row, online: remoteResourceConnectionState(status, getPresenceAvailability(row.host.deviceId)) === true }));
  }, [accountGeneration, botId, cloudHome, deviceId, getPresenceAvailability, presenceVersion, status, user?.id]);
  const onlineCopies = copies.filter(copy => copy.online);
  const offlineCopies = copies.filter(copy => !copy.online);
  const monitor = (state: 'here' | 'online' | 'offline') => <View>
    <Monitor size={ICON_GLYPH} strokeWidth={iconStroke.regular} color={state === 'offline' ? colors.textTertiary : colors.textSecondary} />
    {state === 'here' && online ? <View style={styles.presence} /> : null}
  </View>;
  const rows: ReactNode[] = [
    <Row key="current" icon={monitor('here')} title={deviceName} meta={online ? t('devices.glance.runningHere') : t('devices.glance.offline')} inlineMeta
      trailing={<Check size={iconSize.lg} strokeWidth={iconStroke.medium} color={colors.textPrimary} />} testID="companion.glance.computer.current" />,
    ...onlineCopies.map(copy => <Row key={copy.row.key} icon={monitor('online')} title={copy.row.host.deviceName} meta={t('devices.glance.online')} inlineMeta
      onPress={() => onOpenCindy(copy.row)} testID={`companion.glance.computer.${copy.row.host.deviceId}`} />),
  ];
  if (offlineCopies.length > 0) rows.push(<FoldRow key="offline" inset label={t('devices.glance.offlineCount', { count: offlineCopies.length })}
    open={showOffline} onPress={() => setShowOffline(value => !value)} testID="companion.glance.computer.offline" />);
  if (showOffline) rows.push(...offlineCopies.map(copy => <Row key={copy.row.key} icon={monitor('offline')} title={copy.row.host.deviceName}
    meta={t('devices.glance.offline')} inlineMeta muted />));
  if (cloudHome && online) rows.push(<FoldRow key="switch" inset label={t('devices.cloudCompanion.switchAction')} open={false}
    onPress={onSwitchHome} testID="companion.glance.computer.switch" />);
  return <Section label={t('devices.glance.computers')}>{joinRows(rows, true, styles)}</Section>;
}

// ---------------------------------------------------------------- 待办

function sourceText(todo: TeammateTodo, t: (key: string) => string): string {
  const source = todo.sources[0];
  if (!source || source.kind === 'conversation') return t('devices.glance.source.conversation');
  const kind = t(`devices.glance.source.${source.kind}`);
  const label = source.label?.trim();
  // 来源名已含标签（「来自 GitHub」+「GitHub」）时不再重复。
  return label && !kind.toLowerCase().includes(label.toLowerCase()) ? `${kind} · ${label}` : kind;
}

function Todos({ todos, online, onQuote, onCheck }: {
  todos: GlanceTodoState; online: boolean; onQuote(todo: TeammateTodo): void; onCheck?(): void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [deleted, setDeleted] = useState<TeammateTodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dailyCheck } = todos.todos;
  const now = new Date();
  const open = todos.todos.open.filter(todo => todoDueSoon(todo, now));
  const openTotal = open.length;
  // Not offered by this desktop, or not read yet while offline: no section at all.
  if (!todos.loaded) return null;
  const checkAction = <Pressable accessibilityRole="button" accessibilityLabel={t('devices.glance.check')}
    disabled={!online || !onCheck} onPress={onCheck} style={styles.headerAction} testID="companion.glance.todo.check">
    <ScanSearch size={iconSize.sm} strokeWidth={iconStroke.regular} color={colors.textSecondary} />
  </Pressable>;
  const changeDaily = async (next: boolean) => {
    setError(null);
    setDailyBusy(true);
    try { await todos.setDailyCheck(next); } catch { setError(t('devices.glance.dailyCheckFailed')); } finally { setDailyBusy(false); }
  };
  const dailyRow = !dailyCheck ? null : <Row key="daily" title={t('devices.glance.dailyCheck')} meta={t('devices.glance.dailyCheckMeta')}
    trailing={<Pressable accessibilityRole="button" accessibilityLabel={t('devices.glance.stopDailyCheck')}
      disabled={!online || dailyBusy} style={styles.headerAction} onPress={() => void changeDaily(false)} testID="companion.glance.todo.daily">
      <X size={iconSize.sm} strokeWidth={iconStroke.regular} color={colors.textSecondary} /></Pressable>} />;
  const head = dailyRow ? [dailyRow] : [];
  // A failed first read is not "no todos": keep the section with a retry instead of hiding it.
  if (todos.failed && open.length === 0) return <Section label={t('devices.glance.todos')}>
    <Pressable accessibilityRole="button" onPress={() => void todos.refresh()} disabled={!online}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} testID="companion.glance.todo.retry">
      <Text numberOfLines={1} style={styles.undoNote}>{t('devices.glance.loadFailed')}</Text>
      <Text style={styles.undoAction}>{t('devices.resources.retry')}</Text>
    </Pressable>
  </Section>;

  if (openTotal === 0 && !deleted) return null;

  const remove = async (todo: TeammateTodo) => {
    setError(null);
    try {
      const result = await todos.patch({ id: todo.id, expectedRevision: todo.revision, operation: 'delete' });
      setDeleted(result ?? todo);
      void todos.refresh();
    } catch {
      setError(t('devices.glance.deleteFailed'));
    }
  };
  const undo = async () => {
    const target = deleted;
    if (!target) return;
    setError(null);
    try {
      await todos.patch({ id: target.id, expectedRevision: target.revision, operation: 'restore' });
      setDeleted(null);
      void todos.refresh();
    } catch {
      setError(t('devices.glance.undoFailed'));
    }
  };
  const row = (todo: TeammateTodo) => {
    const due = todoDue(todo);
    const date = todoDateLabel(todo, i18n.language);
    const content = <Row title={todo.title} meta={sourceText(todo, t)}
      trailing={date ? <View style={styles.date}>
        {due ? <View style={styles.dueDot} accessibilityLabel={t('devices.glance.dueUnseen')} /> : null}
        <Text style={[styles.dateText, due && styles.dateDue]}>{date}</Text>
      </View> : undefined}
      onPress={() => onQuote(todo)} testID="companion.glance.todo" />;
    // 长按：系统上下文菜单（行浮起、背景模糊），只有「删除」。
    return <NativePullDownMenu key={todo.id} longPress disabled={!online} accessibilityLabel={todo.title}
      actions={[{ id: 'delete', title: t('devices.glance.delete'), destructive: true, image: 'trash' }]}
      onAction={() => void remove(todo)} onPress={() => onQuote(todo)}>{content}</NativePullDownMenu>;
  };
  const rows: ReactNode[] = [];
  if (deleted) rows.push(<Pressable key="undo" accessibilityRole="button" onPress={() => void undo()}
    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} testID="companion.glance.todo.undo">
    <Text numberOfLines={1} style={styles.undoNote}>{t('devices.glance.deleted')}</Text>
    <Text style={styles.undoAction}>{t('devices.glance.undo')}</Text>
  </Pressable>);
  rows.push(...(showAll ? open : open.slice(0, TODO_PREVIEW)).map(row));
  if (openTotal > TODO_PREVIEW) rows.push(<FoldRow key="more" inset={false} label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
    open={showAll} onPress={() => setShowAll(value => !value)} testID="companion.glance.todo.more" />);
  return <View>
    <Section label={t('devices.glance.todos')} action={checkAction}>
      {joinRows(head, true, styles)}
      {rows.length > 0 ? <>{head.length ? <View style={styles.divider} /> : null}{joinRows(rows, false, styles)}</> : null}
    </Section>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

// ---------------------------------------------------------------- 输出内容

function Outputs({ botId, deviceId, sessionId, online, onOpenTask, prs }: {
  botId: string; deviceId: string; sessionId: string; online: boolean; onOpenTask(sessionId: string): void; prs: HomeSessionPrInfo[];
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [showAll, setShowAll] = useState(false);
  const { value } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId, 'maker:bot-delegations:list', [sessionId], { enabled: online && !!sessionId });
  const files = useMemo(() => companionGlanceOutputs(value, botId), [botId, value]);
  const outputs = [
    ...files.map(file => ({ kind: 'file' as const, key: `file:${file.key}`, at: file.at, file })),
    ...prs.map(pr => ({ kind: 'pr' as const, key: `pr:${prStatusKey(pr.ref)}`, at: pr.ref.lastSeenAt, pr })),
  ].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  if (outputs.length === 0) return null;
  const rows: ReactNode[] = (showAll ? outputs : outputs.slice(0, OUTPUT_PREVIEW)).map(output => output.kind === 'pr'
    ? <PrOutput key={output.key} pr={output.pr} /> : <Row key={output.key}
      icon={<FileTypeIcon name={output.file.name} size={ICON_GLYPH} color={colors.textSecondary} />} title={output.file.name} inlineMeta
      onPress={() => onOpenTask(output.file.childSessionId)} testID="companion.glance.output" />);
  if (outputs.length > OUTPUT_PREVIEW) rows.push(<FoldRow key="more" inset label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
    open={showAll} onPress={() => setShowAll(value => !value)} testID="companion.glance.output.more" />);
  return <Section label={t('devices.glance.outputs')}>{joinRows(rows, true, styles)}</Section>;
}

/** Uses Home's existing teammate attribution, PR cache and live attention; owns no read state. */
function Activity({ botId, deviceId, deviceName, sessionId, online, onOpenTask }: {
  botId: string; deviceId: string; deviceName: string; sessionId: string; online: boolean;
  onOpenTask(id: string, deviceId?: string): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const cached = useRemoteHomeSessions();
  const { user, accountGeneration } = useAuth();
  const cloud = useCloudCompanionHome(false);
  const hosts = new Map([[deviceId, deviceName]]);
  // The same teammate identity rules as Home determine which known computers contribute.
  const cloudIds = new Set(cloud.actors.filter(actor => actor.kind === 'bot').map(actor => actor.externalId));
  const cindyIds = new Set(cloud.cindyIds);
  const target = taskTeammateKey(botId, deviceId, cloudIds, cindyIds);
  for (const row of readRemoteCollectionCache(remoteCollectionCacheOwner(user?.id ?? '', accountGeneration), 'teammates')) {
    if (row.item.ref.kind === 'bot' && taskTeammateKey(row.item.ref.id, row.host.deviceId, cloudIds, cindyIds) === target)
      hosts.set(row.host.deviceId, row.host.deviceName);
  }
  const [snapshots, setSnapshots] = useState<Record<string, RemoteSession[]>>({});
  const receiveTasks = useCallback((host: string, rows: RemoteSession[]) =>
    setSnapshots(previous => ({ ...previous, [host]: rows })), []);
  const hostIdsKey = JSON.stringify([...hosts.keys()]);
  const sessions = useMemo(() => {
    const visibleHosts = new Set(JSON.parse(hostIdsKey) as string[]);
    return [...cached.filter(row => !snapshots[row.deviceLinkDeviceId ?? '']),
      ...Object.entries(snapshots).filter(([host]) => visibleHosts.has(host)).flatMap(([, rows]) => rows)];
  }, [cached, snapshots, hostIdsKey]);
  const tasks = useMemo(() => {
    const cloudIds = new Set(cloud.actors.filter(actor => actor.kind === 'bot').map(actor => actor.externalId));
    const cindyIds = new Set(cloud.cindyIds);
    const target = taskTeammateKey(botId, deviceId, cloudIds, cindyIds);
    return sessions.filter(task => {
      const creator = task.taskTeammate?.id ?? (isTeammateTask(task) ? task.companion?.id : undefined);
      return task.id !== sessionId && task.orcaRole !== 'worker' && creator
        && (task.status === 'active' || task.status === 'archived')
        && taskTeammateKey(creator, task.deviceLinkDeviceId ?? '', cloudIds, cindyIds) === target;
    }).sort((a, b) => Date.parse(getSessionListActivityAt(b) ?? '') - Date.parse(getSessionListActivityAt(a) ?? '')).slice(0, 30);
  }, [sessions, cloud.actors, cloud.cindyIds, botId, deviceId, sessionId]);
  const [allTasks, setAllTasks] = useState(false);
  const [results, setResults] = useState<Record<string, HomeSessionPrInfo | null>>({});
  const receive = useCallback((id: string, value: HomeSessionPrInfo | null) =>
    setResults(previous => previous[id] === value ? previous : { ...previous, [id]: value }), []);
  const prs = useMemo(() => {
    const unique = new Map<string, HomeSessionPrInfo>();
    const values = tasks.flatMap(task => { const value = results[taskKey(task)]; return value ? [value, ...(value.additional ?? [])] : []; }).filter((value): value is HomeSessionPrInfo => !!value)
      .sort((a, b) => b.ref.lastSeenAt - a.ref.lastSeenAt);
    for (const value of values) if (!unique.has(prStatusKey(value.ref))) unique.set(prStatusKey(value.ref), value);
    return [...unique.values()];
  }, [results, tasks]);
  const rows = (allTasks ? tasks : tasks.slice(0, TASK_PREVIEW)).map(task =>
    <RecentTask key={taskKey(task)} task={task} onOpen={() => onOpenTask(task.id, task.deviceLinkDeviceId)} />);
  return <>
    {[...hosts].map(([id, name]) => <TaskReader key={id} deviceId={id} deviceName={name} receive={receiveTasks} />)}
    {tasks.map(task => <PrReader key={taskKey(task)} task={task} receive={receive} />)}
    {tasks.length ? <Section label={t('devices.glance.recentTasks')}>
      {joinRows(rows, true, styles)}
      {tasks.length > TASK_PREVIEW ? <FoldRow inset label={t(allTasks ? 'devices.glance.showLess' : 'devices.glance.showMore')}
        open={allTasks} onPress={() => setAllTasks(value => !value)} testID="companion.glance.tasks.more" /> : null}
    </Section> : null}
    <Outputs botId={botId} deviceId={deviceId} sessionId={sessionId} online={online} onOpenTask={id => onOpenTask(id, deviceId)} prs={prs} />
  </>;
}

const taskKey = (task: RemoteSession) => JSON.stringify([task.deviceLinkDeviceId, task.id]);

/** Read all statuses while this sheet is open; never replace Home's filtered snapshot. */
function TaskReader({ deviceId, deviceName, receive }: {
  deviceId: string; deviceName: string; receive(host: string, rows: RemoteSession[]): void;
}) {
  const { invoke, connectionEpoch } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const { value, cause } = useRemoteCompanionQuery<RemoteSession[]>(deviceId, 'local-db:sessions:list', [200, 'all', { fresh: true }], {
    // Home may be filtered; keep this independent snapshot current while the sheet is open.
    refreshIntervalMs: 30_000,
  });
  useEffect(() => {
    if (isAccessRevokedRemoteError(cause)) { receive(deviceId, []); return; }
    if (!Array.isArray(value)) return;
    let disposed = false;
    void readTeammateTasks({ invoke, deviceId, deviceName, sessions: value, previous: remoteSessionStore.getHomeSessions(),
      scope: JSON.stringify([accountGeneration, connectionEpoch, deviceId]), status: 'all', limit: 200, current: () => !disposed,
    }).then(rows => {
      if (!disposed) receive(deviceId, rows.map(row => ({ ...row, deviceLinkDeviceId: deviceId, deviceLinkDeviceName: deviceName })));
    }).catch(error => {
      if (!disposed && isAccessRevokedRemoteError(error)) receive(deviceId, []);
      // Other failures keep the last known same-account snapshot.
    });
    return () => { disposed = true; };
  }, [value, cause, invoke, accountGeneration, connectionEpoch, deviceId, deviceName, receive]);
  return null;
}

function PrReader({ task, receive }: { task: RemoteSession; receive(id: string, value: HomeSessionPrInfo | null): void }) {
  const value = useHomeSessionPr(task.deviceLinkDeviceId, task.id, true, task.updatedAt, true, true);
  const key = taskKey(task);
  useEffect(() => receive(key, value), [receive, key, value]);
  return null;
}

function RecentTask({ task, onOpen }: { task: RemoteSession; onOpen(): void }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const unread = useSyncExternalStore(remoteSessionStore.subscribeHomeStatus, () => {
    const activity = remoteSessionStore.getSessionLiveActivity(task.id, task.deviceLinkDeviceId);
    return activity?.phase === 'completed' && activity.attention === true;
  });
  return <Row icon={<MessageCircle size={ICON_GLYPH} color={colors.textSecondary} strokeWidth={iconStroke.regular} />}
    title={task.title} inlineMeta onPress={onOpen} testID="companion.glance.task"
    trailing={unread ? <View accessibilityLabel={t('devices.glance.unread')} style={styles.unreadDot} /> : undefined} />;
}

function PrOutput({ pr }: { pr: HomeSessionPrInfo }) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [failed, setFailed] = useState(false);
  const visual = prStatusVisual(pr.status?.ok ? pr.status.status : null, colors);
  return <><Row icon={<visual.Icon size={ICON_GLYPH} color={visual.color} strokeWidth={iconStroke.regular} />}
    title={(pr.status?.ok ? pr.status.title?.trim() : undefined) || `${pr.ref.owner}/${pr.ref.repo}`} inlineMeta
    onPress={() => { setFailed(false); void Linking.openURL(sessionPrUrl(pr.ref)).catch(() => setFailed(true)); }} testID="companion.glance.pr" />
    {failed ? <Text accessibilityRole="alert" style={styles.error}>{t('devices.glance.openFailed')}</Text> : null}</>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerAction: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  unreadDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.statusDone },
  // The sheet host already insets content by 16 (原型 .shbody 0 16).
  content: { paddingBottom: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, paddingTop: spacing.sm, paddingBottom: spacing.lg, paddingHorizontal: spacing.xs },
  headerName: { flex: 1, color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold },
  section: { marginBottom: spacing.lg },
  sectionLabel: {
    color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold,
    paddingHorizontal: spacing.lg, paddingBottom: spacing.sm - 1,
  },
  // Inset grouped card matching the native sheet Section, which iOS 26 rounds at 26 (registered exemption).
  card: { backgroundColor: colors.sheetActionSurface, borderRadius: 26, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.lg },
  dividerInset: { marginLeft: spacing.lg + ICON_COLUMN + ROW_GAP },
  row: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, minHeight: 44, paddingVertical: spacing.md - 1, paddingHorizontal: spacing.lg },
  rowPressed: { backgroundColor: colors.surfaceChip },
  icon: { width: ICON_COLUMN, alignItems: 'center' },
  presence: {
    position: 'absolute', right: -2, bottom: -1, width: PRESENCE_DOT, height: PRESENCE_DOT, borderRadius: radius.pill,
    backgroundColor: colors.statusReady, borderWidth: 2, borderColor: colors.sheetActionSurface,
  },
  rowText: { flex: 1, minWidth: 0 },
  compactRow: { paddingVertical: spacing.sm },
  inlineText: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  inlineTitle: { flex: 1, minWidth: 0 },
  inlineMeta: { maxWidth: '40%', flexShrink: 0 },
  rowTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  rowTitleMuted: { color: colors.textSecondary, fontWeight: fontWeight.regular },
  rowMeta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  trailing: { flexShrink: 0, alignItems: 'flex-end' },
  date: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  dueDot: { width: DUE_DOT, height: DUE_DOT, borderRadius: radius.pill, backgroundColor: colors.statusError },
  dateText: { color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  dateDue: { color: colors.textPrimary },
  foldInset: { paddingLeft: spacing.lg + ICON_COLUMN + ROW_GAP },
  foldLabel: { flex: 1, color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  undoNote: { flex: 1, color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  undoAction: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  error: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, paddingHorizontal: spacing.lg, marginTop: -spacing.md },
});
