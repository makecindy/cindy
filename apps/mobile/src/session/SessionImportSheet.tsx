/**
 * 电脑详情页 → 从其他工具导入。
 *
 * 通过远程资源 `session-import` 读取电脑上可导入的任务（只有标题、来源、分组名、时间与大小，
 * 路径不出电脑），勾选后在电脑后台导入，进度与结果和桌面设置页同源。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { Check, CircleCheck, CircleX, Clock, TriangleAlert } from 'lucide-react-native';
import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION } from '@cindy/device-link';
import { IMPORT_SOURCE_MARKS, IMPORT_SOURCE_NAMES, type ImportSourceKey } from '@cindy/maker-shared/import-source-marks';
import { PROVIDER_LOGO_PATHS } from '@cindy/model-providers/branding';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { MobileAgentMark } from '@/components/MobileAgentMark';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSheet } from './CompanionSheet';

const COLLECTION = 'session-import';
const PRIMITIVE = 'session-import';
const CONFIRM_COUNT = 50;
const CONFIRM_BYTES = 1024 * 1024 * 1024;
const MAX_KEYS = 400;
const HARNESS: Record<string, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };

interface Candidate {
  key: string; source: ImportSourceKey; title: string; group: string; groupName: string; dialogue: boolean;
  updatedAt: number; archived: boolean; sizeBytes: number; missingDir: boolean; unsupported: boolean;
}
interface ScanData { kind: 'scan'; total: number; candidates: Candidate[]; hiddenTotal: number }
interface JobItem { key: string; source: ImportSourceKey; title: string; status: string; step: string | null; messagesWritten: number; mode: string | null; harness: string | null; issue: string | null; sessionId: string | null }
interface JobData { kind: 'job'; requestId: string; status: string; items: JobItem[] }

function blockData(raw: unknown): unknown {
  const blocks = (raw as { blocks?: Array<{ primitive?: string; data?: unknown }> } | null)?.blocks;
  return blocks?.find(b => b.primitive === PRIMITIVE)?.data;
}

export function ImportSourceMarkNative({ source, color, size = iconSize.md }: { source: ImportSourceKey; color: string; size?: number }) {
  if (source === 'claude') return <MobileAgentMark agentKind="claude-code" color={color} size={size} />;
  if (source === 'codex' || source === 'pi') return <MobileAgentMark agentKind={source} color={color} size={size} />;
  const mark = source === 'opencode' || source === 'deepseek'
    ? { viewBox: '0 0 24 24', paths: [PROVIDER_LOGO_PATHS[source]] }
    : IMPORT_SOURCE_MARKS[source];
  return <Svg accessible={false} width={size} height={size} viewBox={mark.viewBox}>
    <G fill={color} fillRule="evenodd" clipRule="evenodd">{mark.paths.map((d, i) => <Path key={i} d={d} />)}</G>
  </Svg>;
}

export function SessionImportSheet({ visible, onClose, onClosed, deviceId, deviceName, online, onOpenSession }: {
  visible: boolean; onClose(): void; onClosed?(): void; deviceId: string; deviceName: string; online: boolean; onOpenSession(sessionId: string): void;
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: string, vars?: Record<string, unknown>) => t(`devices.sessionImport.${key}`, vars);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { invoke, openLink } = useDeviceLink();
  const [scan, setScan] = useState<ScanData>();
  const [job, setJob] = useState<JobData>();
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const get = useCallback(async (id: string) => {
    await openLink(deviceId);
    const raw = await invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{
      ref: { collectionId: COLLECTION, kind: 'import', id },
      client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: [PRIMITIVE], locale: i18n.language },
    }]);
    return blockData(raw);
  }, [deviceId, invoke, openLink, i18n.language]);

  const load = useCallback(async (force: boolean) => {
    setError(false);
    try {
      const latest = await get('job:latest') as JobData | undefined;
      if (alive.current && latest?.status === 'running') setJob(latest);
      const data = await get(force ? 'scan:force' : 'scan') as ScanData | undefined;
      if (alive.current && data?.kind === 'scan') setScan(data);
    } catch {
      if (alive.current) setError(true);
    }
  }, [get]);

  useEffect(() => {
    alive.current = true;
    if (visible) void load(false);
    return () => { alive.current = false; };
  }, [visible, load]);

  // 导入进行中：每秒读一次进度；某次没读到（断线、空结果）也接着读，不停在旧进度上。
  const [pollTick, setPollTick] = useState(0);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const timer = setTimeout(() => {
      void get(`job:${job.requestId}`).then(data => {
        if (!alive.current) return;
        if ((data as JobData | undefined)?.kind === 'job') setJob(data as JobData);
        else setPollTick(n => n + 1);
      }).catch(() => {
        if (alive.current) setPollTick(n => n + 1);
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [job, get, pollTick]);

  const visibleItems = useMemo(() => {
    const kw = query.trim().toLocaleLowerCase();
    return (scan?.candidates ?? []).filter(c => !kw || c.title.toLocaleLowerCase().includes(kw) || c.groupName.toLocaleLowerCase().includes(kw));
  }, [scan, query]);
  const groups = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const c of visibleItems) map.set(c.group, [...(map.get(c.group) ?? []), c]);
    return [...map.entries()].sort(([a], [b]) => Number(a === 'dialogue') - Number(b === 'dialogue'));
  }, [visibleItems]);
  const byKey = useMemo(() => new Map((scan?.candidates ?? []).map(c => [c.key, c])), [scan]);
  const picked = [...selected].map(k => byKey.get(k)).filter((c): c is Candidate => !!c);
  const pickedBytes = picked.reduce((acc, c) => acc + c.sizeBytes, 0);
  const formatSize = (bytes: number) => {
    const gb = bytes >= CONFIRM_BYTES;
    const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: gb ? 1 : 0 });
    return gb ? `${nf.format(bytes / CONFIRM_BYTES)} GB` : `${nf.format(Math.max(1, bytes / 1048576))} MB`;
  };

  const toggle = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const start = async () => {
    if (busy || !online || picked.length === 0) return;
    if (!confirming && (picked.length > CONFIRM_COUNT || pickedBytes > CONFIRM_BYTES)) { setConfirming(true); return; }
    setBusy(true); setError(false);
    try {
      const keys = picked.map(c => c.key).slice(0, MAX_KEYS);
      const response = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId: COLLECTION, actionId: 'import', input: { keys } }, i18n.language);
      const data = response.result as JobData | undefined;
      if (alive.current && data?.kind === 'job') { setJob(data); setSelected(new Set()); setConfirming(false); }
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const stop = () => { if (job) void invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId: COLLECTION, actionId: 'cancel', input: { requestId: job.requestId } }, i18n.language).catch(() => undefined); };
  const done = () => { setJob(undefined); void load(true); };

  const resultLine = (it: JobItem): { icon: React.ReactNode; text: string } => {
    const size = iconSize.sm;
    if (it.status === 'queued') return { icon: <Clock size={size} strokeWidth={iconStroke.regular} color={colors.textTertiary} />, text: tr('queued') };
    if (it.status === 'running') return { icon: <Clock size={size} strokeWidth={iconStroke.regular} color={colors.textTertiary} />, text: it.step === 'copy' ? tr('copy') : it.step === 'verify' ? tr('verify') : tr('messages', { count: it.messagesWritten }) };
    if (it.status === 'action') return { icon: <TriangleAlert size={size} strokeWidth={iconStroke.regular} color={colors.warningFg} />, text: tr('missingDir') };
    if (it.status === 'failed') return { icon: <CircleX size={size} strokeWidth={iconStroke.regular} color={colors.statusError} />, text: tr(`failure.${it.issue ?? 'read-failed'}`) };
    if (it.status === 'cancelled') return { icon: <Clock size={size} strokeWidth={iconStroke.regular} color={colors.textTertiary} />, text: tr('cancelled') };
    const harness = HARNESS[it.harness ?? 'cc'] ?? 'Claude Code';
    return { icon: <CircleCheck size={size} strokeWidth={iconStroke.regular} color={colors.statusDone} />, text: it.mode === 'native' ? tr('readyNative', { harness }) : tr('readyHandoff', { harness }) };
  };

  const running = job?.status === 'running';
  const count = (s: string) => job?.items.filter(it => it.status === s).length ?? 0;
  const order: Record<string, number> = { action: 0, failed: 1, cancelled: 2, ready: 3 };
  const jobItems = job ? (running ? job.items : [...job.items].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4))) : [];

  const footer = job ? <View style={styles.footer}>
    {running ? <Text style={styles.note}>{tr('background')}</Text> : null}
    <MainWindowActionButton grow action={running ? { label: tr('stop'), onPress: stop, testID: 'sessionImport.stop' } : { label: tr('done'), tone: 'primary', onPress: done, testID: 'sessionImport.done' }} />
  </View> : scan && scan.candidates.length > 0 ? <View style={styles.footer}>
    {confirming ? <Text style={styles.note}>{tr('confirmBody', { count: picked.length, size: formatSize(pickedBytes) })}</Text> : picked.length > 0 ? <Text style={styles.note}>{tr('selected', { count: picked.length, size: formatSize(pickedBytes) })}</Text> : null}
    <MainWindowActionButton grow action={{ label: picked.length ? tr('importCount', { count: picked.length }) : tr('import'), tone: 'primary', busy, disabled: !online || busy || picked.length === 0, onPress: () => void start(), testID: 'sessionImport.start' }} />
  </View> : undefined;

  return <CompanionSheet visible={visible} title={tr('title')} contentScrolls onClose={onClose} onClosed={onClosed} footer={footer} testID="sessionImport.sheet">
    <View style={styles.content}>
      {!online || error ? <Text accessibilityRole="alert" style={styles.note}>{!online ? t('devices.companionProfile.offline', { deviceName }) : tr('loadFailed')}</Text> : null}
      {error ? <MainWindowActionButton action={{ label: tr('retry'), disabled: !online, onPress: () => void load(true) }} /> : null}
      {job ? <>
        <Text style={styles.heading}>{running ? tr('progressTitle', { count: job.items.length }) : tr('resultTitle', { count: count('ready') + count('action') })}</Text>
        {!running ? <View style={styles.summary}>
          {count('ready') ? <Text style={styles.note}>{tr('sumReady', { count: count('ready') })}</Text> : null}
          {count('action') ? <Text style={styles.note}>{tr('sumAction', { count: count('action') })}</Text> : null}
          {count('failed') ? <Text style={styles.note}>{tr('sumFailed', { count: count('failed') })}</Text> : null}
        </View> : <Text style={styles.count}>{job.items.length - count('queued') - count('running')} / {job.items.length}</Text>}
        <View style={styles.box}>
          {jobItems.map((it, i) => {
            const line = resultLine(it);
            const openable = !running && it.status === 'ready' && !!it.sessionId;
            return <Pressable key={it.key} accessibilityRole={openable ? 'button' : undefined} disabled={!openable} onPress={() => { if (it.sessionId) { onOpenSession(it.sessionId); onClose(); } }}
              style={[styles.resultRow, i > 0 && styles.separator]}>
              <View style={styles.markSlot}><ImportSourceMarkNative source={it.source} color={colors.textPrimary} /></View>
              <View style={styles.flex}>
                <Text numberOfLines={1} style={styles.title}>{it.title}</Text>
                <View style={styles.lineRow}>{line.icon}<Text style={[styles.note, styles.flex]}>{line.text}</Text></View>
              </View>
            </Pressable>;
          })}
        </View>
      </> : !scan ? (!error ? <Text style={styles.note}>{tr('scanning')}</Text> : null) : scan.candidates.length === 0 ? <>
        <Text style={styles.heading}>{tr('emptyTitle')}</Text>
        <Text style={styles.note}>{tr('emptyDescription')}</Text>
        <View style={styles.supported}>{(Object.keys(IMPORT_SOURCE_NAMES) as ImportSourceKey[]).map(k => <View key={k} style={styles.supportedItem}>
          <ImportSourceMarkNative source={k} color={colors.textSecondary} /><Text style={styles.note}>{IMPORT_SOURCE_NAMES[k]}</Text></View>)}</View>
        <MainWindowActionButton action={{ label: tr('rescan'), disabled: !online, onPress: () => void load(true) }} />
      </> : <>
        <Text style={styles.sub}>{tr('found', { count: scan.total, device: deviceName })}</Text>
        <TextInput accessibilityLabel={tr('search')} placeholder={tr('search')} value={query} onChangeText={setQuery} style={styles.input} testID="sessionImport.search" />
        {groups.length === 0 ? <Text style={styles.note}>{tr('noMatch')}</Text> : null}
        {groups.map(([group, items]) => <View key={group} style={styles.group}>
          <View style={styles.groupHead}>
            <Text numberOfLines={1} style={[styles.groupName, styles.flex]}>{group === 'dialogue' ? tr('dialogue') : items[0]!.groupName}</Text>
            {items.some(c => c.missingDir) ? <Text style={styles.warn}>{tr('folderMissing')}</Text> : null}
            <Text style={styles.count}>{tr('groupTasks', { count: items.length })}</Text>
          </View>
          <View style={styles.box}>
            {items.map((c, i) => {
              const on = selected.has(c.key);
              return <Pressable key={c.key} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: c.unsupported }} accessibilityLabel={c.title}
                disabled={c.unsupported || !!job} onPress={() => { toggle(c.key); setConfirming(false); }} style={[styles.row, i > 0 && styles.separator]} testID={`sessionImport.row.${c.key}`}>
                <View style={[styles.check, on && styles.checkOn, c.unsupported && styles.dim]}>{on ? <Check size={iconSize.sm} strokeWidth={iconStroke.bold} color={colors.ctaText} /> : null}</View>
                <View style={[styles.markSlot, c.unsupported && styles.dim]}><ImportSourceMarkNative source={c.source} color={colors.textPrimary} /></View>
                <View style={styles.flex}>
                  <Text numberOfLines={1} style={[styles.title, c.unsupported && styles.dimText]}>{c.title}</Text>
                  {c.unsupported || c.archived ? <Text style={styles.count}>{c.unsupported ? tr('unsupported') : tr('archived')}</Text> : null}
                </View>
              </Pressable>;
            })}
          </View>
        </View>)}
      </>}
    </View>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.md },
  flex: { flex: 1, minWidth: 0 },
  heading: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.semibold, color: colors.textPrimary, textAlign: 'center' },
  sub: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary, textAlign: 'center' },
  summary: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: spacing.md, rowGap: spacing.xs },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  count: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textTertiary },
  warn: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.warningFg },
  input: { minHeight: 44, borderRadius: radius.pill, paddingHorizontal: spacing.lg, fontSize: typeScale.bodySmall, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  group: { gap: spacing.xs },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs },
  groupName: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.medium, color: colors.textSecondary },
  box: { backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border, borderRadius: radius.container, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm },
  resultRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.md },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  check: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.cta, borderColor: colors.cta },
  markSlot: { width: iconSize.md, alignItems: 'center', paddingTop: 2 },
  title: { fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, color: colors.textPrimary },
  dim: { opacity: 0.4 },
  dimText: { color: colors.textTertiary },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs + 2, marginTop: 2 },
  supported: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'center' },
  supportedItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  footer: { gap: spacing.sm },
});
