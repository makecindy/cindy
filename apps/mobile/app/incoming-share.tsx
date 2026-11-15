import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { ChevronRight, Link, MessageSquare, Plus, Search, X } from 'lucide-react-native';
import { getSessionListActivityAt } from '@cindy/maker-shared/session-activity';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { goBackGuarded } from '@/utils/backGuard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { FileTypeIcon } from '@/components/FileTypeIcon';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome/SimpleStackHeader';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { toDeviceListItems } from '@/device-link/devices';
import { useRevokedDevices } from '@/device-link/revokedDevicesStore';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useAuth } from '@/auth/AuthContext';
import { leaveIncomingShareChooser, incomingShareDestination, incomingShareText, selectIncomingShareDestination, useIncomingShareBatch } from '@/session/incomingShare';
import { useTeammateRoster } from '@/session/useTeammateRoster';
import { teammateResourceRoute } from '@/session/teammateNavigation';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { serializeNewSessionDeviceOptions, type NewSessionDeviceOption } from '@/session/newSession';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

type Task = { deviceId: string; deviceName: string; session: RemoteSession };

type Row = { key: string } & (
  | { kind: 'new' }
  | { kind: 'heading'; label: string }
  | { kind: 'status'; label?: string; loading?: boolean; retry?: 'roster' | 'tasks' }
  | { kind: 'companions'; items: ReturnType<typeof useTeammateRoster>['items'] }
  | { kind: 'task'; item: Task }
);

/** A destination chooser, not a second sending pipeline. Nothing is sent by selecting a row. */
export default function IncomingShareScreen() {
  const batch = useIncomingShareBatch();
  const focused = useIsFocused();
  const router = useRouter();
  const navigation = useNavigation();
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { accountGeneration } = useAuth();
  const { readDeviceList, openLink, invoke, status, presenceVersion } = useDeviceLink();
  const revoked = useRevokedDevices();
  const roster = useTeammateRoster(focused && !!batch);
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState<{ owner: number; devices: NewSessionDeviceOption[]; tasks: Task[] } | null>(null);
  const tasks = directory?.owner === accountGeneration ? directory.tasks.filter(item => !revoked.has(item.deviceId)) : [];
  const devices = directory?.owner === accountGeneration ? directory.devices.filter(item => !revoked.has(item.deviceId)) : [];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!focused || !batch) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    setLoading(true); setError(false);
    void readDeviceList().then(async response => {
      const devices = toDeviceListItems(response.devices, Date.now(), revoked);
      const options = devices.filter(item => item.canOpen).map(({ device }) => ({ deviceId: device.deviceId, name: device.name }));
      const groups: Task[][] = devices.map(({ device }) => remoteSessionStore.getSessions()
        .filter(session => session.deviceLinkDeviceId === device.deviceId && session.status === 'active'
          && session.source !== 'bot' && session.orcaRole !== 'worker')
        .map(session => ({ deviceId: device.deviceId, deviceName: device.name, session })));
      const publishDirectory = () => {
        if (current()) setDirectory({ owner: accountGeneration, devices: options, tasks: groups.flat() });
      };
      publishDirectory();
      let failed = false;
      await Promise.all(devices.map(async ({ device, canOpen }, index) => {
        const publish = (sessions: RemoteSession[]) => {
          groups[index] = sessions.filter(session => session.status === 'active' && session.source !== 'bot'
            && session.orcaRole !== 'worker').map(session => ({ deviceId: device.deviceId, deviceName: device.name, session }));
          publishDirectory();
        };
        if (!current()) return;
        if (!canOpen) return;
        try {
          await openLink(device.deviceId);
          const sessions = await invoke<RemoteSession[]>(device.deviceId, 'local-db:sessions:list',
            [500, 'active', { includePinned: true, fresh: true }], { preSend: () => {
              if (!current()) throw new Error('INCOMING_SHARE_PICKER_CLOSED');
            } });
          if (current()) publish(Array.isArray(sessions) ? sessions : []);
        } catch { failed = true; }
      }));
      if (current()) setError(failed);
    }).catch(() => { if (current()) setError(true); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { disposed = true; };
  }, [focused, batch?.id, accountGeneration, readDeviceList, openLink, invoke, status, presenceVersion, attempt, revoked]);
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase(i18n.language);
  const rows = useMemo<Row[]>(() => {
    const matches = (title: string) => title.normalize('NFKC').toLocaleLowerCase(i18n.language).includes(needle);
    const companions = roster.items.filter(item => matches(`${resolveRemoteText(item.item.display.title, i18n.language)} ${item.host.deviceName}`));
    const matchingTasks = tasks.filter(item => matches(`${item.session.title} ${item.deviceName}`))
      .sort((a, b) => (Date.parse(getSessionListActivityAt(b.session)) || 0) - (Date.parse(getSessionListActivityAt(a.session)) || 0));
    const result: Row[] = [{ key: 'new', kind: 'new' }];
    if (companions.length || !needle) result.push({ key: 'companions', kind: 'heading', label: t('composer.incomingShare.companions') });
    if (companions.length) result.push({ key: 'companion-strip', kind: 'companions', items: companions });
    if (roster.loading) result.push({ key: 'companions-loading', kind: 'status', loading: true });
    else if (!companions.length && !needle) result.push({ key: 'companions-empty', kind: 'status', label: t('composer.incomingShare.noCompanions') });
    if (roster.error) result.push({ key: 'companions-retry', kind: 'status', retry: 'roster', label: t('composer.incomingShare.retry') });
    if (matchingTasks.length || !needle) result.push({ key: 'tasks', kind: 'heading', label: t('composer.incomingShare.tasks') });
    for (const item of matchingTasks)
      result.push({ key: `task:${incomingShareDestination(item.deviceId, item.session.id)}`, kind: 'task', item });
    if (loading) result.push({ key: 'tasks-loading', kind: 'status', loading: true });
    else if (!matchingTasks.length && !needle) result.push({ key: 'tasks-empty', kind: 'status', label: t('composer.incomingShare.noTasks') });
    if (error) result.push({ key: 'tasks-retry', kind: 'status', retry: 'tasks', label: t('composer.incomingShare.retry') });
    if (needle && !loading && !roster.loading && !error && !roster.error && !companions.length && !matchingTasks.length)
      result.push({ key: 'no-matches', kind: 'status', label: t('composer.incomingShare.noMatches') });
    return result;
  }, [needle, i18n.language, t, roster.items, roster.loading, roster.error, tasks, loading, error]);
  const text = batch ? incomingShareText(batch.payloads) : '';
  const files = batch?.payloads.filter(item => item.shareType !== 'text' && item.shareType !== 'url') ?? [];
  const handoffBatchId = useRef<string | null>(null);
  useEffect(() => {
    if (focused) handoffBatchId.current = null;
  }, [focused, batch?.id]);
  const choose = (destination: string, action: () => void) => {
    // A queued second press must not replace the destination during transition.
    if (!batch || !navigation.isFocused() || handoffBatchId.current === batch.id) return;
    handoffBatchId.current = batch.id;
    if (selectIncomingShareDestination(batch.id, destination)) action();
    else handoffBatchId.current = null;
  };
  // Removing the chooser during a handoff retains the batch for its composer.
  // Header/gesture cancellation still acknowledges and cleans the owned copies.
  usePreventRemove(!!batch, ({ data }) => {
    leaveIncomingShareChooser(batch && handoffBatchId.current !== batch.id ? batch.id : null,
      () => navigation.dispatch(data.action));
  });
  const back = () => goBackGuarded(router);
  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.root}>
    <SimpleStackHeader title={t('composer.incomingShare.title')} onBack={back} />
    {!batch ? <Text style={styles.status}>{t('composer.incomingShare.empty')}</Text> : <KeyboardAvoidingView
      style={styles.content} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.preview} testID="incomingShare.preview">
        <View style={styles.previewContent}>
          {files.length ? files[0]!.shareType === 'image'
            ? <Image source={{ uri: files[0]!.contentUri ?? files[0]!.value }} style={styles.previewImage}
              accessibilityLabel={files[0]!.originalName || t('composer.incomingShare.file')} />
            : <View style={styles.previewIcon}><FileTypeIcon name={files[0]!.originalName || ''} size={iconSize.action} /></View>
            : <View style={styles.previewIcon}><Link color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} /></View>}
          <View style={styles.rowContent}>
            {!!text && <Text numberOfLines={2} style={styles.body}>{text.replace(/\n{2,}/g, '\n')}</Text>}
            {!!files.length && <Text numberOfLines={1} style={styles.title}>{files[0]!.originalName || t('composer.incomingShare.file')}</Text>}
            {files.length > 1 && <Text style={styles.note}>{t('composer.incomingShare.fileCount', { count: files.length })}</Text>}
          </View>
        </View>
        <Text style={styles.note}>{t('composer.incomingShare.hint')}</Text>
      </View>
      <View style={styles.search}>
        <Search color={colors.textSecondary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        <TextInput value={query} onChangeText={setQuery} style={styles.searchInput} testID="incomingShare.search"
          placeholder={t('composer.incomingShare.search')} accessibilityLabel={t('composer.incomingShare.search')}
          placeholderTextColor={colors.textPlaceholder} autoCorrect={false} autoCapitalize="none" returnKeyType="search" />
        {!!query && <Pressable accessibilityRole="button" accessibilityLabel={t('composer.incomingShare.clearSearch')}
          style={({ pressed }) => [styles.clear, pressed && mobileInteractionStyles.pressed]} onPress={() => setQuery('')}>
          <X size={iconSize.sm} color={colors.textSecondary} strokeWidth={iconStroke.regular} />
        </Pressable>}
      </View>
      <FlatList<Row> data={rows} keyExtractor={row => row.key} style={styles.content}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.list}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        renderItem={({ item: row }) => {
          if (row.kind === 'heading') return <Text style={styles.sectionLabel}>{row.label}</Text>;
          if (row.kind === 'status') {
            if (row.loading) return <View style={styles.status}><ActivityIndicator color={colors.textSecondary} /></View>;
            if (row.retry) return <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button" onPress={() => row.retry === 'roster'
                ? void roster.refresh() : setAttempt(value => value + 1)}><Text style={styles.note}>{row.label}</Text></Pressable>;
            return <Text style={styles.status}>{row.label}</Text>;
          }
          if (row.kind === 'new') return <Pressable accessibilityRole="button" testID="incomingShare.newTask"
            disabled={!devices.length} style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => {
              const first = devices[0];
              if (first) choose('new', () => router.dismissTo({ pathname: '/sessions/new', params: {
                deviceId: first.deviceId, deviceName: first.name, deviceOptions: serializeNewSessionDeviceOptions(devices),
              } }));
            }}>
            <View style={styles.rowIcon}><Plus color={colors.textSecondary} size={iconSize.action} strokeWidth={iconStroke.regular} /></View>
            <View style={styles.rowContent}>
              <Text style={styles.title}>{t('composer.incomingShare.newTask')}</Text>
              {!devices.length && <Text style={styles.note}>{t(loading ? 'composer.incomingShare.loadingDevices' : 'devices.list.error.noDevice')}</Text>}
            </View>
            <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </Pressable>;
          if (row.kind === 'companions') return <ScrollView horizontal showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled" contentContainerStyle={styles.companions}>
            {row.items.map(item => {
              const name = resolveRemoteText(item.item.display.title, i18n.language);
              const conversation = item.item.links.find(link => link.rel === 'conversation')?.target;
              const available = conversation?.kind === 'session';
              return <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${name}, ${item.host.deviceName}`}
                accessibilityHint={available ? undefined : t('composer.incomingShare.unavailable')} disabled={!available}
                style={({ pressed }) => [styles.companion, pressed && mobileInteractionStyles.pressed]} onPress={() => {
                  if (conversation?.kind === 'session') choose(incomingShareDestination(item.host.deviceId, conversation.sessionId, item.item.ref),
                    () => router.dismissTo(teammateResourceRoute(item, i18n.language)));
                }}>
                <RemoteCompanionAvatar avatar={item.item.display.avatar} deviceId={item.host.deviceId} name={name} online={devices.some(device => device.deviceId === item.host.deviceId)} size={iconSize.hero} framed />
                <Text numberOfLines={1} style={styles.companionName}>{name}</Text>
                <Text numberOfLines={1} style={styles.metadata}>{available ? item.host.deviceName : t('composer.incomingShare.unavailable')}</Text>
              </Pressable>;
            })}
          </ScrollView>;
          const item = row.item;
          return <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            onPress={() => choose(incomingShareDestination(item.deviceId, item.session.id), () => router.dismissTo({
              pathname: '/sessions/[sessionId]', params: { deviceId: item.deviceId, deviceName: item.deviceName, sessionId: item.session.id },
            }))}>
            <View style={styles.rowIcon}><MessageSquare color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} /></View>
            <View style={styles.rowContent}><Text numberOfLines={1} style={styles.title}>{item.session.title}</Text>
              <Text numberOfLines={1} style={styles.metadata}>{item.deviceName}</Text></View>
            <ChevronRight color={colors.textTertiary} size={iconSize.sm} strokeWidth={iconStroke.regular} />
          </Pressable>;
        }} />
    </KeyboardAvoidingView>}
  </SafeAreaView>;
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surface },
  content: { flex: 1 },
  preview: { marginHorizontal: spacing.lg, marginVertical: spacing.md, gap: spacing.sm },
  previewContent: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  previewIcon: { width: 44, height: 44, borderRadius: radius.container, backgroundColor: c.surfaceChip, alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: 44, height: 44, borderRadius: radius.container },
  search: { marginHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingLeft: spacing.md, borderRadius: radius.pill, minHeight: 48, backgroundColor: c.surfaceChip },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: spacing.md, color: c.textPrimary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular },
  clear: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  rowIcon: { width: 44, alignItems: 'center', justifyContent: 'center' },
  rowContent: { flex: 1, minWidth: 0, gap: spacing.xs },
  pressed: { backgroundColor: c.surfaceChip, borderRadius: radius.container },
  companions: { gap: spacing.sm, paddingVertical: spacing.sm },
  companion: { width: 88, alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
  companionName: { maxWidth: '100%', fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium, color: c.textPrimary },
  title: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary },
  body: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
  metadata: { maxWidth: '100%', fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textTertiary },
  status: { paddingVertical: spacing.md, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
  sectionLabel: { marginTop: spacing.md, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, color: c.textTertiary },
});
