import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, FlatList, StyleSheet, View } from 'react-native';
import { useIsFocused, useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { goBackGuarded } from '@/utils/backGuard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
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
import { fontWeight, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

type Task = { deviceId: string; deviceName: string; session: RemoteSession };

type Row = { key: string } & (
  | { kind: 'new' }
  | { kind: 'heading'; label: string }
  | { kind: 'status'; label?: string; loading?: boolean; retry?: 'roster' | 'tasks' }
  | { kind: 'companion'; item: ReturnType<typeof useTeammateRoster>['items'][number] }
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!focused || !batch) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    setTasks([]); setLoading(true); setError(false);
    void readDeviceList().then(async response => {
      const devices = toDeviceListItems(response.devices, Date.now(), revoked);
      const groups: Task[][] = devices.map(() => []);
      let failed = false;
      await Promise.all(devices.map(async ({ device, canOpen }, index) => {
        const publish = (sessions: RemoteSession[]) => {
          groups[index] = sessions.filter(session => session.status === 'active' && session.source !== 'bot'
            && session.orcaRole !== 'worker').map(session => ({ deviceId: device.deviceId, deviceName: device.name, session }));
          if (current()) setTasks(groups.flat());
        };
        if (!current()) return;
        publish(remoteSessionStore.getSessions().filter(session => session.deviceLinkDeviceId === device.deviceId));
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
    const result: Row[] = [{ key: 'new', kind: 'new' },
      { key: 'companions', kind: 'heading', label: t('composer.incomingShare.companions') }];
    for (const item of roster.items) if (matches(resolveRemoteText(item.item.display.title, i18n.language)))
      result.push({ key: `companion:${item.key}`, kind: 'companion', item });
    if (roster.loading) result.push({ key: 'companions-loading', kind: 'status', loading: true });
    else if (!roster.items.length) result.push({ key: 'companions-empty', kind: 'status', label: t('composer.incomingShare.noCompanions') });
    if (roster.error) result.push({ key: 'companions-retry', kind: 'status', retry: 'roster', label: t('composer.incomingShare.retry') });
    result.push({ key: 'tasks', kind: 'heading', label: t('composer.incomingShare.tasks') });
    for (const item of tasks) if (matches(item.session.title))
      result.push({ key: `task:${incomingShareDestination(item.deviceId, item.session.id)}`, kind: 'task', item });
    if (loading) result.push({ key: 'tasks-loading', kind: 'status', loading: true });
    else if (!tasks.length) result.push({ key: 'tasks-empty', kind: 'status', label: t('composer.incomingShare.noTasks') });
    if (error) result.push({ key: 'tasks-retry', kind: 'status', retry: 'tasks', label: t('composer.incomingShare.retry') });
    return result;
  }, [needle, i18n.language, t, roster.items, roster.loading, roster.error, tasks, loading, error]);
  const text = batch ? incomingShareText(batch.payloads) : '';
  const files = batch?.payloads.filter(item => item.shareType !== 'text' && item.shareType !== 'url') ?? [];
  const handoffBatchId = useRef<string | null>(null);
  const choose = (destination: string, action: () => void) => {
    if (!batch) return;
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
    {!batch ? <Text style={styles.note}>{t('composer.incomingShare.empty')}</Text> : <>
      <View style={styles.preview}>
        {!!text && <Text numberOfLines={4} style={styles.body}>{text}</Text>}
        {files.slice(0, 3).map((file, index) => <Text key={index} numberOfLines={1} style={styles.note}>
          {file.originalName || t('composer.incomingShare.file')}
        </Text>)}
        {files.length > 3 && <Text style={styles.note}>{t('composer.incomingShare.fileCount', { count: files.length })}</Text>}
        <Text style={styles.note}>{t('composer.incomingShare.hint')}</Text>
      </View>
      <TextInput value={query} onChangeText={setQuery} style={styles.search}
        placeholder={t('composer.incomingShare.search')} accessibilityLabel={t('composer.incomingShare.search')}
        placeholderTextColor={colors.textPlaceholder} autoCorrect={false} />
      <FlatList<Row> data={rows} keyExtractor={row => row.key}
        keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}
        initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
        renderItem={({ item: row }) => {
          if (row.kind === 'heading') return <Text style={styles.sectionLabel}>{row.label}</Text>;
          if (row.kind === 'status') {
            if (row.loading) return <ActivityIndicator color={colors.textSecondary} />;
            if (row.retry) return <Pressable style={styles.row} onPress={() => row.retry === 'roster'
              ? void roster.refresh() : setAttempt(value => value + 1)}><Text style={styles.note}>{row.label}</Text></Pressable>;
            return <Text style={styles.note}>{row.label}</Text>;
          }
          if (row.kind === 'new') return <Pressable accessibilityRole="button" style={styles.row}
            onPress={() => choose('new', () => router.dismissTo('/sessions/new'))}>
            <Text style={styles.title}>{t('composer.incomingShare.newTask')}</Text>
          </Pressable>;
          if (row.kind === 'companion') {
            const item = row.item;
            const conversation = item.item.links.find(link => link.rel === 'conversation')?.target;
            return <Pressable accessibilityRole="button" style={styles.row}
              disabled={conversation?.kind !== 'session'} onPress={() => {
                if (conversation?.kind === 'session') choose(incomingShareDestination(item.host.deviceId, conversation.sessionId, item.item.ref),
                  () => router.dismissTo(teammateResourceRoute(item, i18n.language)));
              }}>
              <Text style={styles.title}>{resolveRemoteText(item.item.display.title, i18n.language)}</Text>
              <Text style={styles.note}>{item.host.deviceName}{conversation?.kind !== 'session' ? ` · ${t('composer.incomingShare.unavailable')}` : ''}</Text>
            </Pressable>;
          }
          const item = row.item;
          return <Pressable accessibilityRole="button" style={styles.row}
            onPress={() => choose(incomingShareDestination(item.deviceId, item.session.id), () => router.dismissTo({
              pathname: '/sessions/[sessionId]', params: { deviceId: item.deviceId, deviceName: item.deviceName, sessionId: item.session.id },
            }))}>
            <Text style={styles.title}>{item.session.title}</Text><Text style={styles.note}>{item.deviceName}</Text>
          </Pressable>;
        }} />
    </>}
  </SafeAreaView>;
}
const makeStyles = (c: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.surface },
  preview: { margin: spacing.md, gap: spacing.xs },
  search: { marginHorizontal: spacing.md, padding: spacing.md, borderRadius: radius.control,
    backgroundColor: c.surfaceChip, color: c.textPrimary, fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular },
  list: { padding: spacing.md },
  row: { minHeight: 48, paddingVertical: spacing.md, gap: spacing.xs },
  title: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: c.textPrimary },
  body: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.regular, color: c.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: c.textSecondary },
  sectionLabel: { marginTop: spacing.md, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, color: c.textTertiary },
});
