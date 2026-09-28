import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { parseRemoteActionInvokeRequest, REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION, type RemoteResourceRef } from '@cindy/device-link';
import { areCompanionImportEntriesSelected, toggleCompanionImportEntries, companionImportIssueKey, companionImportCategories, remoteCompanionImportApi, type CompanionImportPreview, type CompanionImportResult, type CompanionImportSelection, type CompanionImportSource } from '@cindy/maker-shared/companion-import';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionSheet } from './CompanionSheet';
import { CompanionPortraitPicker, randomCompanionPortrait } from './CompanionPortraitPicker';

export function CompanionImportSheet({ visible, onClose, onClosed, deviceId, deviceName, online, onCreated }: {
  visible: boolean; onClose(): void; onClosed?(): void; deviceId: string; deviceName: string; online: boolean; onCreated(ref: RemoteResourceRef): void;
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`devices.companionImport.${key}`);
  const styles = useThemedStyles(makeStyles);
  const { invoke, openLink } = useDeviceLink();
  const api = useMemo(() => remoteCompanionImportApi(
    async id => { await openLink(deviceId); return invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{ ref: { collectionId: 'companion-import', kind: 'import', id }, client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['companion-import'], locale: i18n.language } }]); },
    (sourceId, selection) => invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId: 'companion-import', resourceRef: { collectionId: 'companion-import', kind: 'import', id: `preview:${sourceId}` }, actionId: 'import', input: { ...selection } }, i18n.language),
  ), [deviceId, deviceName, invoke, openLink, i18n.language]);
  const [sources, setSources] = useState<CompanionImportSource[]>();
  const [preview, setPreview] = useState<CompanionImportPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string>('automations');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [takeover, setTakeover] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [result, setResult] = useState<CompanionImportResult>();
  const alive = useRef(true); const lock = useRef(false);
  const intent = useRef<CompanionImportSelection | undefined>(undefined);
  useEffect(() => { alive.current = true; void api.sources().then(value => { if (alive.current) setSources(value); }).catch(() => { if (alive.current) setError(true); }); return () => { alive.current = false; }; }, [api]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current || !online) return;
    lock.current = true; setBusy(true); setError(false);
    try { await fn(); } catch (cause) {
      // Only definitive creation/preflight rejections unlock editing. An ambiguous ACK
      // keeps the same request ID and is reconciled before any retry.
      if (cause instanceof Error && /INVALID_SELECTION|PROFILE_TEXT_TOO_LARGE|IMPORT_NAME_EXISTS|SOURCE_SNAPSHOT_TOO_LARGE|SOURCE_TOO_MANY_FILES|SOURCE_FILE_TOO_LARGE|SOURCE_ITEM_TOO_LARGE|SOURCE_LINK_OUTSIDE_FOLDER|SOURCE_LINK_CYCLE|SOURCE_NOT_REGULAR_FILE|SOURCE_CHANGED/.test(cause.message)) {
        intent.current = undefined;
        if (alive.current) setResult(undefined);
      }
      if (cause instanceof Error && /PREVIEW_EXPIRED|SELECTION_CHANGED/.test(cause.message)) {
        intent.current = undefined;
        if (alive.current) { setPreview(undefined); setResult(undefined); }
        // Host restarts invalidate source IDs too. Reuse the existing source step.
        try { const refreshed = await api.sources(); if (alive.current) setSources(refreshed); } catch { /* Existing source buttons allow another attempt. */ }
      }
      if (alive.current) setError(true);
    }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const choose = (sourceId: string) => act(async () => {
    const value = await api.preview(sourceId);
    const portrait = value.avatarImageBase64 || await randomCompanionPortrait();
    if (!alive.current) return;
    setPreview(value); setName(value.name); setAvatar(portrait); setSelected(value.entries.filter(entry => entry.selected).map(entry => entry.id));
  });
  const submit = () => act(async () => {
    if (!preview || !name.trim() || !avatar) return;
    if (!intent.current) {
      const selection = { requestId: randomUUID(), previewId: preview.id, name: name.trim(), avatarImageBase64: avatar, entryIds: selected, takeover };
      // Validate the complete action with the host's wire parser before freezing
      // this request. Oversized inputs must remain editable, never retry forever.
      if (!parseRemoteActionInvokeRequest({
        client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['companion-import'], locale: i18n.language },
        collectionId: 'companion-import', actionId: 'import',
        resourceRef: { collectionId: 'companion-import', kind: 'import', id: `preview:${preview.source.id}` },
        input: selection,
      })) throw new Error('INVALID_SELECTION');
      intent.current = selection;
    }
    let value = await api.status(intent.current.requestId);
    if (!value || value.status === 'needs-attention') value = await api.start(intent.current);
    while (alive.current && value?.status === 'running') {
      setResult(value); await new Promise(resolve => setTimeout(resolve, 1000));
      value = await api.status(intent.current.requestId);
      if (!value) throw new Error('IMPORT_RECEIPT_MISSING');
    }
    if (alive.current && value) setResult(value);
  });
  const toggle = (ids: string[], checked: boolean) => setSelected(value => toggleCompanionImportEntries(preview?.entries ?? [], value, ids, checked));
  const locked = busy || !!intent.current || !online;
  return <CompanionSheet visible={visible} title={tr('title')} onClose={() => { if (!busy || result) onClose(); }} onClosed={onClosed} preventDismiss={busy && !result}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Text style={styles.note}>{tr('description')}</Text>
      {!online || error ? <Text accessibilityRole="alert" style={styles.note}>{!online ? t('devices.companionProfile.offline', { deviceName }) : tr('error')}</Text> : null}
      {!preview ? <>{sources?.map(source => <MainWindowActionButton key={source.id} action={{ label: `${source.name} · ${source.kind === 'hermes' ? 'Hermes' : 'OpenClaw'}`, disabled: busy || !online, onPress: () => void choose(source.id) }} />)}{sources?.length === 0 ? <Text style={styles.note}>{tr('empty')}</Text> : null}</> : <>
        <Text style={styles.label}>{t('devices.companionProfile.name')}</Text>
        <TextInput accessibilityLabel={t('devices.companionProfile.name')} maxLength={200} value={name} onChangeText={setName} editable={!locked} style={styles.input} />
        <CompanionPortraitPicker value={avatar} onChange={setAvatar} disabled={locked} />
        {companionImportCategories.map(category => {
          const entries = preview.entries.filter(entry => entry.category === category);
          if (!entries.length) return null;
          const count = entries.filter(entry => selected.includes(entry.id)).length;
          const allSelected = areCompanionImportEntriesSelected(entries, selected);
          return <View key={category} style={styles.group}>
            <View style={styles.row}><Pressable accessibilityRole="button" accessibilityState={{ expanded: expanded === category }} style={styles.expand} onPress={() => setExpanded(expanded === category ? '' : category)}><Text style={styles.label}>{tr(category)}</Text><Text style={styles.count}>{count} / {entries.length}</Text></Pressable><Switch accessibilityLabel={tr(category)} value={allSelected} disabled={locked} onValueChange={value => toggle(entries.map(entry => entry.id), value)} /></View>
            {expanded === category ? entries.map(entry => <View key={entry.id} style={styles.row}><View style={styles.expand}><Text style={styles.label}>{entry.name}</Text>{entry.description ? <Text style={styles.note}>{entry.description}</Text> : null}{entry.enabled === false ? <Text style={styles.note}>{tr('paused')}</Text> : null}{entry.issues?.length ? <Text style={styles.note}>{tr(companionImportIssueKey(entry.issues[0]))}</Text> : null}</View><Switch accessibilityLabel={entry.name} value={selected.includes(entry.id)} disabled={locked} onValueChange={value => toggle([entry.id], value)} /></View>) : null}
          </View>;
        })}
        {preview.entries.some(entry => entry.category === 'automations' && selected.includes(entry.id)) ? <View style={styles.row}><View style={styles.expand}><Text style={styles.label}>{tr('takeover')}</Text><Text style={styles.note}>{tr('takeoverNote')}</Text></View><Switch accessibilityLabel={tr('takeover')} value={takeover} onValueChange={setTakeover} disabled={locked} /></View> : null}
      </>}
      {result ? <><Text style={styles.note}>{tr(result.status === 'running' ? 'running' : result.status === 'complete' ? 'complete' : 'attention')}</Text>{result.checks.filter(check => check.status === 'needs-attention').map(check => <Text key={check.entryId} style={styles.note}>{preview?.entries.find(entry => entry.id === check.entryId)?.name ?? tr('title')} · {tr(companionImportIssueKey(check.message))}{preview?.entries.find(entry => entry.id === check.entryId)?.category === 'automations' ? ` · ${tr('keptAtSource')}` : ''}</Text>)}</> : null}
      {result?.status === 'needs-attention' ? <MainWindowActionButton action={{ label: tr('retry'), busy, disabled: busy || !online, onPress: () => void submit() }} /> : null}
      {result && result.status !== 'running' ? <MainWindowActionButton action={{ label: tr('open'), disabled: !result.canonicalSessionId, onPress: () => { onCreated({ collectionId: 'teammates', kind: 'bot', id: result.botId }); onClose(); } }} /> : preview ? <MainWindowActionButton action={{ label: tr('submit'), busy, disabled: busy || !online || !name.trim() || !avatar, onPress: () => void submit() }} /> : null}
    </ScrollView>
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  group: { borderColor: colors.border, borderWidth: 1, borderRadius: radius.container, paddingHorizontal: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  expand: { flex: 1, gap: spacing.xs, minHeight: 44, justifyContent: 'center' },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  count: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.container, paddingHorizontal: spacing.md, fontSize: typeScale.body, color: colors.textPrimary, backgroundColor: colors.surfaceElevated },
});
