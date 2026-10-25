/**
 * 伙伴近况（手机）：点伙伴聊天顶栏的头像打开，与桌面 BotGlancePopover 同三块——电脑 / 待办 / 输出内容；
 * 没内容的块整块不出现。规则见 docs/product-rules/cindy-bots-runtime.md「伙伴近况」，版式按原型
 * Designs/cindy/teammate-glance（手机 r1.1）：系统 sheet 外壳，内容是 inset grouped 卡片。
 * 待办块第一行「帮我查查」让伙伴现在去已连接的来源里找新待办（作为主人的一句话发进对话），下面的开关让它
 * 每个工作日早上自己查一次。待办行没有按钮：点一条交给对话（作为待办引用放进输入框），长按系统菜单只有「删除」，可撤销。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { Check, ChevronDown, ChevronUp, Monitor, ScanSearch } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import type { BotDelegationListResult } from '@cindy/maker-shared/botDelegation';
import { todoDateLabel, todoDue, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import type { RemoteResource } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { readRemoteCollectionCache, remoteResourceConnectionState } from '@/device-link/remoteResourceAvailability';
import { NativePullDownMenu } from '@/platform/chrome/NativePullDownMenu';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSheet } from './CompanionSheet';
import { companionGlanceOutputs } from './companionProfileData';
import { useRemoteCompanionQuery } from './useRemoteCompanionQuery';
import type { useCompanionGlanceTodos } from './useCompanionGlanceTodos';

const TODO_PREVIEW = 5;
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

function dayLabel(at: number, language: string): string {
  const now = new Date();
  const date = new Date(at);
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  // Hermes has no Intl.RelativeTimeFormat; there recent days show as dates too.
  if (days >= 0 && days <= 1 && typeof Intl.RelativeTimeFormat === 'function') return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-days, 'day');
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(date);
}

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
  onOpenTask(sessionId: string): void;
  onOpenCindy(hosted: HostedRemoteCollectionItem): void;
  onSwitchHome(): void;
}) {
  const styles = useThemedStyles(makeStyles);
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
      <Outputs botId={botId} deviceId={deviceId} sessionId={sessionId} online={online}
        onOpenTask={taskId => afterClose(() => onOpenTask(taskId))} />
    </ScrollView>
  </CompanionSheet>;
}

// ---------------------------------------------------------------- 分组与行（原型 inset grouped 卡片）

function Section({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.section}>
    <Text style={styles.sectionLabel}>{label}</Text>
    <View style={styles.card}>{children}</View>
  </View>;
}

/** Rows separated by a hairline that starts at the text column, like the system list. */
function joinRows(rows: ReactNode[], inset: boolean, styles: ReturnType<typeof makeStyles>): ReactNode[] {
  return rows.flatMap((row, index) => index === 0 ? [row]
    : [<View key={`divider-${index}`} style={[styles.divider, inset && styles.dividerInset]} />, row]);
}

function Row({ icon, title, meta, trailing, muted = false, onPress, testID }: {
  icon?: ReactNode; title: string; meta?: string; trailing?: ReactNode; muted?: boolean; onPress?(): void; testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = <>
    {icon ? <View style={styles.icon}>{icon}</View> : null}
    <View style={styles.rowText}>
      <Text numberOfLines={1} style={[styles.rowTitle, muted && styles.rowTitleMuted]}>{title}</Text>
      {meta ? <Text numberOfLines={1} style={styles.rowMeta}>{meta}</Text> : null}
    </View>
    {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
  </>;
  if (!onPress) return <View style={styles.row} testID={testID}>{body}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={meta ? `${title}, ${meta}` : title} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} testID={testID}>{body}</Pressable>;
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
    return readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, 'teammates')
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
    <Row key="current" icon={monitor('here')} title={deviceName} meta={online ? t('devices.glance.runningHere') : t('devices.glance.offline')}
      trailing={<Check size={iconSize.lg} strokeWidth={iconStroke.medium} color={colors.textPrimary} />} testID="companion.glance.computer.current" />,
    ...onlineCopies.map(copy => <Row key={copy.row.key} icon={monitor('online')} title={copy.row.host.deviceName} meta={t('devices.glance.online')}
      onPress={() => onOpenCindy(copy.row)} testID={`companion.glance.computer.${copy.row.host.deviceId}`} />),
  ];
  if (offlineCopies.length > 0) rows.push(<FoldRow key="offline" inset label={t('devices.glance.offlineCount', { count: offlineCopies.length })}
    open={showOffline} onPress={() => setShowOffline(value => !value)} testID="companion.glance.computer.offline" />);
  if (showOffline) rows.push(...offlineCopies.map(copy => <Row key={copy.row.key} icon={monitor('offline')} title={copy.row.host.deviceName}
    meta={t('devices.glance.offline')} muted />));
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
  const [showDone, setShowDone] = useState(false);
  const [deleted, setDeleted] = useState<TeammateTodo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { open, done, doneTotal, openTotal, dailyCheck } = todos.todos;
  // Not offered by this desktop, or not read yet while offline: no section at all.
  if (!todos.loaded) return null;
  const checkRow = <Row key="check" icon={<ScanSearch size={ICON_GLYPH} strokeWidth={iconStroke.regular} color={colors.textSecondary} />}
    title={t('devices.glance.check')} meta={t('devices.glance.checkMeta')} muted={!online || !onCheck} onPress={online ? onCheck : undefined} testID="companion.glance.todo.check" />;
  const changeDaily = async (next: boolean) => {
    setError(null);
    setDailyBusy(true);
    try { await todos.setDailyCheck(next); } catch { setError(t('devices.glance.dailyCheckFailed')); } finally { setDailyBusy(false); }
  };
  // Older desktops do not report the switch; then only 「帮我查查」 shows.
  const dailyRow = dailyCheck === null ? null : <Row key="daily" icon={<View />} title={t('devices.glance.dailyCheck')} meta={t('devices.glance.dailyCheckMeta')}
    trailing={<Switch accessibilityLabel={t('devices.glance.dailyCheck')} value={dailyCheck} disabled={!online || dailyBusy}
      onValueChange={value => void changeDaily(value)} testID="companion.glance.todo.daily" />} />;
  const head = [checkRow, ...(dailyRow ? [dailyRow] : [])];
  // A failed first read is not "no todos": keep the section with a retry instead of hiding it.
  if (todos.failed && open.length === 0 && doneTotal === 0) return <Section label={t('devices.glance.todos')}>
    {joinRows(head, true, styles)}
    <View style={styles.divider} />
    <Pressable accessibilityRole="button" onPress={() => void todos.refresh()} disabled={!online}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} testID="companion.glance.todo.retry">
      <Text numberOfLines={1} style={styles.undoNote}>{t('devices.glance.loadFailed')}</Text>
      <Text style={styles.undoAction}>{t('devices.resources.retry')}</Text>
    </Pressable>
  </Section>;

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
  const row = (todo: TeammateTodo, isDone: boolean) => {
    const due = !isDone && todoDue(todo);
    const date = isDone ? '' : todoDateLabel(todo, i18n.language);
    const completion = isDone ? todo.history[todo.history.length - 1]?.summary : undefined;
    const content = <Row title={todo.title} meta={completion || sourceText(todo, t)} muted={isDone}
      trailing={date ? <View style={styles.date}>
        {due ? <View style={styles.dueDot} accessibilityLabel={t('devices.glance.dueUnseen')} /> : null}
        <Text style={[styles.dateText, due && styles.dateDue]}>{date}</Text>
      </View> : undefined}
      onPress={() => onQuote(todo)} testID={isDone ? 'companion.glance.todo.done' : 'companion.glance.todo'} />;
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
  rows.push(...(showAll ? open : open.slice(0, TODO_PREVIEW)).map(todo => row(todo, false)));
  if (openTotal > TODO_PREVIEW) rows.push(<FoldRow key="more" inset={false} label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
    open={showAll} onPress={() => setShowAll(value => !value)} testID="companion.glance.todo.more" />);
  if (doneTotal > 0) rows.push(<FoldRow key="done" inset={false} label={t('devices.glance.doneCount', { count: doneTotal })}
    open={showDone} onPress={() => setShowDone(value => !value)} testID="companion.glance.todo.doneToggle" />);
  if (showDone) rows.push(...done.map(todo => row(todo, true)));
  return <View>
    <Section label={t('devices.glance.todos')}>
      {joinRows(head, true, styles)}
      {rows.length > 0 ? <><View style={styles.divider} />{joinRows(rows, false, styles)}</> : null}
    </Section>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
}

// ---------------------------------------------------------------- 输出内容

function Outputs({ botId, deviceId, sessionId, online, onOpenTask }: {
  botId: string; deviceId: string; sessionId: string; online: boolean; onOpenTask(sessionId: string): void;
}) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [showAll, setShowAll] = useState(false);
  const { value } = useRemoteCompanionQuery<BotDelegationListResult>(deviceId, 'maker:bot-delegations:list', [sessionId], { enabled: online && !!sessionId });
  const files = useMemo(() => companionGlanceOutputs(value, botId), [botId, value]);
  if (files.length === 0) return null;
  const rows: ReactNode[] = (showAll ? files : files.slice(0, OUTPUT_PREVIEW)).map(file => <Row key={file.key}
    icon={<FileTypeIcon name={file.name} size={ICON_GLYPH} color={colors.textSecondary} />} title={file.name}
    meta={t('devices.glance.outputMeta', { time: dayLabel(file.at, i18n.language), task: file.taskTitle })}
    onPress={() => onOpenTask(file.childSessionId)} testID="companion.glance.output" />);
  if (files.length > OUTPUT_PREVIEW) rows.push(<FoldRow key="more" inset label={showAll ? t('devices.glance.showLess') : t('devices.glance.showMore')}
    open={showAll} onPress={() => setShowAll(value => !value)} testID="companion.glance.output.more" />);
  return <Section label={t('devices.glance.outputs')}>{joinRows(rows, true, styles)}</Section>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  // The sheet host already insets content by 16 (原型 .shbody 0 16).
  content: { paddingBottom: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', gap: ROW_GAP, paddingTop: spacing.sm, paddingBottom: spacing.xl - 2, paddingHorizontal: spacing.xs },
  headerName: { flex: 1, color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.semibold },
  section: { marginBottom: spacing.xl - 2 },
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
