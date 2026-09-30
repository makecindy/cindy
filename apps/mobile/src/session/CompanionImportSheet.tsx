import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { parseRemoteActionInvokeRequest, REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION, type RemoteResourceRef } from '@cindy/device-link';
import { COMPANION_IMPORT_CHUNK_PRIMITIVE, companionImportSubmissions, companionImportReasonKey, companionImportErrorCode, compactCompanionImportSelection, areCompanionImportEntriesSelected, toggleCompanionImportEntries, companionImportCategories, remoteCompanionImportApi, type CompanionImportPreview, type CompanionImportResult, type CompanionImportSelection, type CompanionImportSource } from '@cindy/maker-shared/companion-import';
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
    async id => { await openLink(deviceId); return invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [{ ref: { collectionId: 'companion-import', kind: 'import', id }, client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['companion-import', COMPANION_IMPORT_CHUNK_PRIMITIVE], locale: i18n.language } }]); },
    (sourceId, selection) => invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId: 'companion-import', resourceRef: { collectionId: 'companion-import', kind: 'import', id: `preview:${sourceId}` }, actionId: 'import', input: { ...selection } }, i18n.language),
  ), [deviceId, deviceName, invoke, openLink, i18n.language]);
  const [sources, setSources] = useState<CompanionImportSource[]>();
  const [preview, setPreview] = useState<CompanionImportPreview>();
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string>('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [takeover, setTakeover] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState(false);
  const [detailPage, setDetailPage] = useState(0);
  const [result, setResult] = useState<CompanionImportResult>();
  useEffect(() => setDetailPage(0), [result]);
  const alive = useRef(true); const lock = useRef(false);
  const intent = useRef<CompanionImportSelection | undefined>(undefined);
  useEffect(() => { alive.current = true; void api.sources().then(value => { if (alive.current) setSources(value); }).catch(cause => { if (alive.current) setError(companionImportErrorCode(cause) ?? 'IMPORT_ITEM_FAILED'); }); return () => { alive.current = false; }; }, [api]);
  const act = async (fn: () => Promise<void>) => {
    if (lock.current || !online) return;
    lock.current = true; setBusy(true); setError(undefined);
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
      if (alive.current) setError(companionImportErrorCode(cause) ?? 'IMPORT_ITEM_FAILED');
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
      const selection = { requestId: randomUUID(), previewId: preview.id, name: name.trim(), avatarImageBase64: avatar, ...compactCompanionImportSelection(preview, selected), takeover, deferSetup: true };
      // Validate the complete action with the host's wire parser before freezing
      // this request. Oversized inputs must remain editable, never retry forever.
      for (const part of companionImportSubmissions(selection, preview.selectionChunks)) if (!parseRemoteActionInvokeRequest({
        client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['companion-import'], locale: i18n.language },
        collectionId: 'companion-import', actionId: 'import',
        resourceRef: { collectionId: 'companion-import', kind: 'import', id: `preview:${preview.source.id}` },
        input: part,
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
  const selectedSet = new Set(selected);
  const locked = busy || !!intent.current || !online;
  const saved = !!result?.saved || result?.status === 'complete';
  const outstanding = result?.checks.filter(check => check.status === 'needs-attention') ?? [];
  const savedIds = new Set(result?.savedEntryIds);
  const incomplete = result?.savedEntryIds ? selected.some(id => !savedIds.has(id)) : outstanding.some(check => check.message === 'IMPORT_ITEM_FAILED');
  const finished = result && result.status !== 'running';
  const openedRequest = useRef<string | undefined>(undefined);
  const enterChat = !!finished && saved && !incomplete && !!result?.canonicalSessionId;
  useEffect(() => {
    if (!enterChat || !result || openedRequest.current === result.requestId) return;
    openedRequest.current = result.requestId;
    onCreated({ collectionId: 'teammates', kind: 'bot', id: result.botId }); onClose();
  }, [enterChat, result, onCreated, onClose]);
  const entries = preview?.entries.filter(entry => entry.category === expanded) ?? [];
  const filtered = entries.filter(entry => `${entry.name} ${entry.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <CompanionSheet visible={visible && !enterChat} title={tr('title')} onClose={() => { if (!busy || result) onClose(); }} onClosed={onClosed} preventDismiss={busy && !result}>
    {!enterChat ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {!online || error ? <Text accessibilityRole="alert" style={styles.note}>{!online ? t('devices.companionProfile.offline', { deviceName }) : tr(companionImportReasonKey(error))}</Text> : null}
      {finished && saved ? <>
        <Text style={styles.label}>{tr(incomplete ? 'partial' : 'complete')}</Text>
        {companionImportCategories.map(category => {
          const ids = new Set(preview?.entries.filter(entry => entry.category === category).map(entry => entry.id));
          const count = result.savedEntryIds ? result.savedEntryIds.filter(id => ids.has(id)).length : result.checks.filter(check => ids.has(check.entryId) && check.status !== 'needs-attention').length;
          return ids.size ? <View key={category} style={styles.row}><Text style={[styles.label, styles.expand]}>{tr(category)}</Text><Text style={styles.count}>{count} / {selected.filter(id => ids.has(id)).length}</Text></View> : null;
        })}
        {outstanding.length ? <>
          <MainWindowActionButton action={{ label: `${tr('details')} · ${outstanding.length}`, onPress: () => { setDetails(!details); setDetailPage(0); } }} />
          {details ? <>
            {outstanding.slice(detailPage * 20, (detailPage + 1) * 20).map(check => <View key={check.entryId}>
              <Text style={styles.label}>{preview?.entries.find(entry => entry.id === check.entryId)?.name ?? tr('itemAttention')}</Text>
              <Text style={styles.note}>{tr(check.progress?.saved ? 'partlySaved' : savedIds.has(check.entryId) ? 'savedNeedsSetup' : 'notSaved')} · {tr(companionImportReasonKey(check.message))}</Text>
              {check.progress ? <Text style={styles.count}>{check.progress.saved} / {check.progress.total}</Text> : null}
            </View>)}
            {outstanding.length > 20 ? <View style={styles.row}><MainWindowActionButton action={{ label: tr('previous'), disabled: detailPage === 0, onPress: () => setDetailPage(detailPage - 1) }} /><Text style={styles.count}>{detailPage + 1} / {Math.ceil(outstanding.length / 20)}</Text><MainWindowActionButton action={{ label: tr('next'), disabled: (detailPage + 1) * 20 >= outstanding.length, onPress: () => setDetailPage(detailPage + 1) }} /></View> : null}
          </> : null}
        </> : null}
      </> : result?.status === 'running' ? <><Text style={styles.label}>{tr('running')}</Text><Text style={styles.count}>{result.checks.length} / {selected.length}</Text></> : !preview ? <>
        {sources?.map(source => <MainWindowActionButton key={source.id} action={{ label: `${source.name} · ${source.kind === 'hermes' ? 'Hermes' : 'OpenClaw'}`, disabled: busy || !online, onPress: () => void choose(source.id) }} />)}
        {error && !sources ? <MainWindowActionButton action={{ label: tr('retry'), disabled: busy || !online, onPress: () => void act(async () => { const value = await api.sources(); if (alive.current) setSources(value); }) }} /> : null}
        {sources?.length === 0 ? <Text style={styles.note}>{tr('empty')}</Text> : null}
      </> : expanded ? <>
        <MainWindowActionButton action={{ label: tr('back'), onPress: () => setExpanded('') }} />
        <View style={styles.row}><Text style={[styles.label, styles.expand]}>{tr(expanded)}</Text><Switch accessibilityLabel={tr('selectAll')} disabled={locked} value={areCompanionImportEntriesSelected(entries, selected)} onValueChange={checked => toggle(entries.map(entry => entry.id), checked)} /></View>
        <TextInput accessibilityLabel={tr('search')} placeholder={tr('search')} value={query} onChangeText={value => { setQuery(value); setPage(0); }} style={styles.input} />
        {filtered.slice(page * 20, (page + 1) * 20).map(entry => <View key={entry.id} style={styles.row}><View style={styles.expand}><Text style={styles.label}>{entry.name}</Text>{entry.description ? <Text numberOfLines={2} style={styles.note}>{entry.description}</Text> : null}{entry.enabled === false ? <Text style={styles.note}>{tr('paused')}</Text> : null}</View><Switch accessibilityLabel={entry.name} value={selectedSet.has(entry.id)} disabled={locked} onValueChange={value => toggle([entry.id], value)} /></View>)}
        {filtered.length > 20 ? <View style={styles.row}><MainWindowActionButton action={{ label: tr('previous'), disabled: page === 0, onPress: () => setPage(page - 1) }} /><Text style={styles.count}>{page + 1} / {Math.ceil(filtered.length / 20)}</Text><MainWindowActionButton action={{ label: tr('next'), disabled: (page + 1) * 20 >= filtered.length, onPress: () => setPage(page + 1) }} /></View> : null}
      </> : <>
        <Text style={styles.label}>{t('devices.companionProfile.name')}</Text>
        <TextInput accessibilityLabel={t('devices.companionProfile.name')} maxLength={200} value={name} onChangeText={setName} editable={!locked} style={styles.input} />
        <CompanionPortraitPicker value={avatar} onChange={setAvatar} disabled={locked} />
        {companionImportCategories.map(category => {
          const group = preview.entries.filter(entry => entry.category === category);
          if (!group.length) return null;
          const count = group.filter(entry => selectedSet.has(entry.id)).length;
          return <View key={category} style={styles.row}><Pressable accessibilityRole="button" style={styles.expand} disabled={locked} onPress={() => { setExpanded(category); setQuery(''); setPage(0); }}><Text style={styles.label}>{tr(category)}</Text><Text style={styles.count}>{count} / {group.length}</Text></Pressable><Switch accessibilityLabel={tr(category)} value={areCompanionImportEntriesSelected(group, selected)} disabled={locked} onValueChange={value => toggle(group.map(entry => entry.id), value)} /></View>;
        })}
        {preview.entries.some(entry => entry.category === 'automations' && selectedSet.has(entry.id)) ? <View style={styles.row}><Text style={[styles.note, styles.expand]}>{tr('takeover')}</Text><Switch accessibilityLabel={tr('takeover')} value={takeover} disabled={locked} onValueChange={setTakeover} /></View> : null}
      </>}
      {finished && (!saved || incomplete) ? <MainWindowActionButton action={{ label: tr('retry'), busy, disabled: busy || !online, onPress: () => void submit() }} /> : null}
      {finished ? <MainWindowActionButton action={{ label: tr('open'), disabled: !result.canonicalSessionId, onPress: () => { onCreated({ collectionId: 'teammates', kind: 'bot', id: result.botId }); onClose(); } }} /> : preview && !expanded ? <MainWindowActionButton action={{ label: tr('submit'), busy, disabled: busy || !online || !name.trim() || !avatar, onPress: () => void submit() }} /> : null}
    </ScrollView> : null}
  </CompanionSheet>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  expand: { flex: 1, gap: spacing.xs, minHeight: 44, justifyContent: 'center' },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium, color: colors.textPrimary },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textSecondary },
  count: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, color: colors.textTertiary },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.container, paddingHorizontal: spacing.md, fontSize: typeScale.body, fontWeight: fontWeight.regular, color: colors.textPrimary, backgroundColor: colors.surfaceElevated },
});
