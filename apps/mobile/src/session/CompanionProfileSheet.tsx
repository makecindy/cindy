import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Brain, Camera, FileText, Hand, History, Info, Link2, Settings2, Sparkles } from 'lucide-react-native';
import { resolveRemoteText, type RemoteResource, type RemoteResourceRef, type RemoteText } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { RemoteCompanionAvatar } from '@/components/RemoteCompanionAvatar';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { readRemoteCollectionCache } from '@/device-link/remoteResourceAvailability';
import { CompanionSettingsRow as ContextSheetRow } from './CompanionSettingsRow';
import { CompanionChoice } from './CompanionChoice';
import { CompanionSheet } from './CompanionSheet';
import { fontWeight, iconSize, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { CompanionModelChain, CompanionModelPicker, readCompanionModelChain } from './CompanionModelChain';
import { CompanionCreateNativeView } from './CompanionCreateNativeView';
import { CompanionPortraitPicker, randomCompanionPortrait } from './CompanionPortraitPicker';
import { CompanionProfileNativeView } from './CompanionProfileNativeView';
import { CompanionProfileArtifacts } from './CompanionProfileArtifacts';
import { loadCompanionProfile, profileFormDirty, type CompanionProfileData, type ProfilePanel, type ProfileValues } from './companionProfileData';
import { CompanionMemoryPage } from './CompanionMemoryPage';
import { useCompanionMemory } from './useCompanionMemory';

// Same identity block as iOS: a 48pt avatar and the name, not a navigation target.
const AVATAR_SIZE = 48;
/** Same limits as iOS and the host editor (`botRemoteEditors.ts` rejects a longer skill body). */
const fieldMaxLength = (id: string) => id === 'name' || id === 'confirmName' ? 200 : id === 'body' ? 55000 : 12000;
/** Same identity rule as the host and Desktop `normalizeBotName`. */
const normalizeTeammateName = (name: string) => name.normalize('NFKC').trim().toLowerCase();

export interface CompanionProfileSheetProps {
  visible: boolean;
  onClose: () => void;
  onClosed?: () => void;
  resource: RemoteResource | null;
  collectionId: string;
  deviceId: string;
  deviceName: string;
  online: boolean;
  onDeleted?: () => void;
  onOpenSearch: () => void;
}
/** Identity-keyed content prevents previous-account drafts and reads from surviving a switch. */
export function CompanionProfileSheet(props: CompanionProfileSheetProps) {
  const { accountGeneration } = useAuth();
  const key = JSON.stringify([accountGeneration, props.deviceId, props.collectionId, props.resource?.ref.kind, props.resource?.ref.id]);
  return <CompanionProfileSheetContent key={key} {...props} />;
}

/** One navigation host, with real host reads, draft guards and in-surface confirmations. */
function CompanionProfileSheetContent(props: CompanionProfileSheetProps) {
  const { visible, resource, collectionId, deviceId, deviceName, online, onClose, onOpenSearch } = props;
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pendingTask = useRef<string | null>(null);
  const pendingDeleted = useRef(false);
  const { invoke, openLink } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [data, setData] = useState<CompanionProfileData | null>(null);
  const [page, setPage] = useState('home');
  const [modelStage, setModelStage] = useState<'profile' | 'closing-profile' | 'picker' | 'closing-picker'>('profile');
  const [modelIndex, setModelIndex] = useState(0);
  const [editor, setEditor] = useState<CompanionProfileData | null>(null);
  const [editorPanel, setEditorPanel] = useState<string | null>(null);
  const [editorResourceId, setEditorResourceId] = useState('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [values, setValues] = useState<ProfileValues>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [deleteFailure, setDeleteFailure] = useState(false);
  const [conflict, setConflict] = useState<{ page: string; next: CompanionProfileData } | null>(null);
  // A rename rejected because another teammate on this computer has the name (host NFKC check).
  const [nameTakenOnSave, setNameTakenOnSave] = useState(false);
  const [receipt, setReceipt] = useState<RemoteText | null>(null);
  const [confirmation, setConfirmation] = useState<ProfilePanel | null>(null);
  const [deleted, setDeleted] = useState(false);
  const draftBase = useRef<ProfileValues>({});
  const inFlight = useRef(false);
  const generation = useRef(0);
  const current = useRef('');
  const binding = `${accountGeneration}:${deviceId}:${collectionId}:${resource?.ref.kind}:${resource?.ref.id}:${visible}`;
  current.current = binding;
  useEffect(() => () => { current.current = ''; }, []);
  const panel = page === 'editor' ? editor?.panels.find(item => item.id === editorPanel) : data?.panels.find(item => item.id === page);
  const dirty = editing && profileFormDirty(panel ? { ...panel, values: draftBase.current } : undefined, values);
  const draftScope = useRef({ dirty, page, base: page === 'editor' ? editor : data });
  draftScope.current = { dirty, page, base: page === 'editor' ? editor : data };
  const label = (value: RemoteText) => resolveRemoteText(value, i18n.language);
  const name = label(data?.resource.display.title ?? resource?.display.title ?? '');
  // Saved memories are a host page of their own; hosts without it keep the upgrade note.
  const memoryList = data?.panels.find(item => item.id === 'memories')?.entries?.[0]?.resourceId;
  const memory = useCompanionMemory({ invoke, openLink, deviceId, deviceName, collectionId, resourceKind: resource?.ref.kind ?? 'bot',
    listResourceId: memoryList, online, active: page === 'memoryEntries', binding });
  const read = useCallback(async () => {
    if (!online || !resource) return null;
    await openLink(deviceId);
    return loadCompanionProfile(invoke, deviceId, { ...resource.ref, collectionId }, i18n.language);
  }, [online, resource?.ref.id, resource?.ref.kind, collectionId, deviceId, invoke, openLink, i18n.language]);
  const refresh = useCallback(async () => {
    const started = binding;
    const sequence = ++generation.current;
    setError(false);
    setDeleteFailure(false); setNameTakenOnSave(false);
    try {
      const next = await read();
      if (current.current === started && generation.current === sequence) {
        const draft = draftScope.current;
        if (next && draft.dirty && draft.page !== 'editor' && next.resource.revision !== draft.base?.resource.revision) {
          setConflict({ page: draft.page, next });
        } else setData(next);
      }
    } catch {
      if (current.current === started && generation.current === sequence) setError(true);
    }
  }, [binding, read]);
  useEffect(() => {
    setModelStage('profile'); setConflict(null); setEditor(null); setEditorPanel(null); setEditorLoading(false); setData(null); setPage('home'); setValues({}); setReceipt(null); setConfirmation(null); setDeleted(false); setError(false); setDeleteFailure(false); setNameTakenOnSave(false); setEditing(false); setBusy(false);
    return () => { generation.current++; };
  }, [binding]);
  useEffect(() => { if (visible && online) void refresh(); }, [visible, online, refresh]);

  const openEditor = async (resourceId: string) => {
    if (inFlight.current || !online || !resource) return;
    const started = binding; const sequence = ++generation.current;
    setConflict(null); setEditorResourceId(resourceId); setPage('editor'); setEditor(null); setEditorPanel(null); setEditorLoading(true); setEditing(false); setError(false); setDeleteFailure(false); setNameTakenOnSave(false);
    try {
      await openLink(deviceId);
      const next = await loadCompanionProfile(invoke, deviceId, { ...resource.ref, collectionId, id: resourceId }, i18n.language);
      if (current.current !== started || sequence !== generation.current) return;
      setEditor(next);
      if ((next.panels.length === 1 || next.panels.length === 2 && next.panels[1]?.id === 'remove') && next.panels[0]?.action) {
        setEditorPanel(next.panels[0].id); setValues(next.panels[0].values);
      }
    } catch { if (current.current === started) setError(true); }
    finally { if (current.current === started && sequence === generation.current) setEditorLoading(false); }
  };
  const open = (next: string) => {
    if (inFlight.current) return;
    if (next === 'memoryEntries') {
      void settleDraft(() => {
        setReceipt(null); setError(false); setDeleteFailure(false); setNameTakenOnSave(false); setConfirmation(null); setEditing(false); setPage(next);
      }); return;
    }
    if (next === 'avatar' || next === 'connections' || next === 'personalSkills') {
      void settleDraft(() => openEditor(`settings:${resource?.ref.id}/${next === 'personalSkills' ? 'skills' : next}`));
      return;
    }
    setConflict(null); setEditor(null); setEditorPanel(null); setPage(next); setReceipt(null); setError(false); setDeleteFailure(false); setNameTakenOnSave(false); setConfirmation(null); setEditing(false);
    setValues(data?.panels.find(item => item.id === next)?.values ?? {});
  };
  const submit = async (target: ProfilePanel, confirmed = false): Promise<boolean> => {
    if (!target.action || target.action.disabled || inFlight.current || !online || !resource || conflict?.page === page) return false;
    if (target.action.confirmation && !confirmed) { setConfirmation(target); return false; }
    inFlight.current = true; generation.current++; setBusy(true); setError(false); setDeleteFailure(false); setNameTakenOnSave(false); setReceipt(null);
    const started = binding;
    // A version conflict re-reads only after the submit lock is released; the readers refuse to run under it.
    let rereadAfterConflict = false;
    try {
      const response = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
        collectionId, resourceRef: page === 'editor' ? editor!.resource.ref : resource.ref, actionId: target.action.id,
        input: Object.fromEntries((target.action.fields ?? [])
          .filter(field => target.id === 'delete' || (values[field.id] ?? '') !== (draftBase.current[field.id] ?? ''))
          .map(field => [field.id, (editing ? values[field.id] : target.values[field.id]) ?? ''])),
      }, i18n.language);
      if (current.current !== started) return false;
      const toast = response.effects.find(effect => effect.kind === 'toast');
      if (toast?.kind === 'toast') setReceipt(toast.message);
      setConfirmation(null); setEditing(false);
      if (target.id === 'delete') { pendingDeleted.current = true; setDeleted(true); return true; }
      if (page === 'editor' && editor) {
        let ref = editor.resource.ref;
        if (target.id === 'remove' || ref.id.endsWith('/skills/new')) ref = { ...ref, id: ref.id.slice(0, ref.id.lastIndexOf('/')) };
        try {
          await openLink(deviceId);
          const next = await loadCompanionProfile(invoke, deviceId, ref, i18n.language);
          if (current.current !== started) return false;
          setEditorResourceId(ref.id); setEditor(next); const nextPanel = next.panels.find(item => item.id === target.id && item.action);
          setEditorPanel(nextPanel?.id ?? null); setValues(nextPanel?.values ?? {});
          const root = await read(); if (current.current === started) setData(root);
        } catch { if (current.current === started) setError(true); }
        return true;
      }
      // A returned receipt is authoritative; a subsequent read failure is not a failed mutation.
      try {
        const next = await read();
        if (current.current !== started) return false;
        setData(next); setValues(next?.panels.find(item => item.id === target.id)?.values ?? {});
      } catch { setError(true); }
      return true;
    } catch (cause) {
      if (current.current === started) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setConfirmation(null);
        if (target.id !== 'delete' && message.includes('ALREADY_EXISTS')) { setNameTakenOnSave(true); setError(true); }
        else if (target.id !== 'delete' && message.includes('PRECONDITION_FAILED')) {
          // The teammate changed meanwhile. Keep the draft; the re-read offers the latest version.
          rereadAfterConflict = true;
        } else { setError(true); setDeleteFailure(target.id === 'delete'); }
      }
      return false;
    } finally {
      inFlight.current = false;
      if (current.current === started) {
        setBusy(false);
        if (rereadAfterConflict) void (page === 'editor' ? retryEditor() : refresh());
      }
    }
  };
  const leave = async (close: boolean) => {
    if (inFlight.current) return;
    if (confirmation) { setConfirmation(null); return; }
    if (page === 'memoryEntries') {
      if (close) { if (await memory.flush()) onClose(); }
      else if (!(await memory.back())) open('memory');
      return;
    }
    await settleDraft(() => leavePage(close));
  };
  const leavePage = async (close: boolean) => {
    if (close) { onClose(); return; }
    if (page === 'editor' && editor) {
      if (editorPanel && editor.panels.filter(item => item.action && item.id !== 'remove').length > 1) { setEditorPanel(null); setEditing(false); return; }
      const parts = editor.resource.ref.id.split('/');
      if (parts.length > 2) { await openEditor(parts.slice(0, -1).join('/')); return; }
      open(parts[1] === 'skills' || parts[1] === 'connections' ? 'skills' : parts[1] === 'models' ? 'settings' : 'home');
    } else open('home');
  };
  const dismiss = () => { void leave(true); };
  const retryEditor = async () => {
    if (!resource || inFlight.current) return;
    if (!editor) { await openEditor(editorResourceId); return; }
    const started = binding;
    const sequence = ++generation.current;
    try {
      await openLink(deviceId);
      const next = await loadCompanionProfile(invoke, deviceId, editor.resource.ref, i18n.language);
      if (current.current !== started || generation.current !== sequence) return;
      if (dirty && next.resource.revision !== editor.resource.revision) {
        setConflict({ page: 'editor', next }); setError(false);
      } else { setEditor(next); setError(false); }
    } catch { if (current.current === started && generation.current === sequence) setError(true); }
  };
  // Leaving a page saves its dirty draft first. When the draft cannot be saved right now
  // (offline, a host-disabled action or an unresolved version conflict), ask whether to
  // discard it instead of silently keeping the user on a page they cannot leave.
  const settleDraft = async (proceed: () => void | Promise<void>) => {
    if (!dirty || !panel) { await proceed(); return; }
    if (online && resource && panel.action && !panel.action.disabled && conflict?.page !== page) {
      if (await submit(panel)) await proceed();
      return;
    }
    const started = binding;
    Alert.alert(t('devices.companions.automation.unsavedTitle'), t('devices.companions.automation.unsavedBody'), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companions.automation.discard'), style: 'destructive', onPress: () => {
        if (current.current !== started || inFlight.current) return;
        // Discarding a conflicted draft adopts the newer copy already read, as 「放弃编辑并重新加载」 does.
        if (conflict?.page === page) {
          if (page === 'editor') setEditor(conflict.next); else setData(conflict.next);
        }
        setEditing(false); setConflict(null); void proceed();
      } },
    ]);
  };
  const discardDraft = (reload: boolean) => {
    Alert.alert(t('devices.companions.automation.unsavedTitle'), t('devices.companions.automation.unsavedBody'), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companions.automation.discard'), style: 'destructive', onPress: () => {
        if (current.current !== binding || inFlight.current) return;
        if (reload && conflict?.page === page) {
          const nextPanel = conflict.next.panels.find(item => item.id === (page === 'editor' ? editorPanel : page));
          if (page === 'editor') setEditor(conflict.next); else setData(conflict.next);
          setValues(nextPanel?.values ?? {}); draftBase.current = nextPanel?.values ?? {};
          setEditing(false); setConflict(null); setError(false);
        } else { setEditing(false); onClose(); }
      } },
    ]);
  };
  const conversation = data?.resource.links.find(link => link.rel === 'conversation' && link.target.kind === 'session');
  const sessionId = conversation?.target.kind === 'session' ? conversation.target.sessionId : '';
  const actionPanel = (id: string) => data?.panels.find(item => item.id === id);
  const editorTitles: Record<string, string> = { avatar: 'avatar', models: 'models', skills: 'personalSkills', connections: 'connections' };
  const titleKey = page === 'home' ? 'settingsTitle' : page === 'editor' ? editorTitles[editorResourceId.split('/')[1]] ?? 'title' : page;
  const noteText = (text: string) => <Text selectable style={styles.note}>{text}</Text>;
  const note = (key: string) => noteText(t(`devices.companionProfile.${key}`, { deviceName }));
  const spinner = <ActivityIndicator accessibilityLabel={t('devices.resources.loading')} color={colors.textSecondary} style={styles.spinner} />;
  // Same entries, symbols and test IDs as the iOS rows; lucide glyphs follow Desktop for the same meaning.
  const row = (id: string, Icon: typeof Brain, onPress = () => open(id)) => <ContextSheetRow key={id} trailing="chevron" label={t(`devices.companionProfile.${id}`)}
    icon={<Icon size={iconSize.lg} color={colors.textSecondary} />} onPress={onPress} testID={`companionProfile.${id}`} />;

  const memoryPage = <CompanionMemoryPage memory={memory} online={online} botName={name} memoryEnabled={actionPanel('memory')?.values.memory !== false} />;
  const modelValues = editing ? values : panel?.values ?? {};
  const changeValues = (next: ProfileValues) => { if (!editing) draftBase.current = panel?.values ?? {}; setValues(next); setEditing(true); };
  const models = <CompanionModelChain deviceId={deviceId} values={modelValues} disabled={busy || !online || !panel?.action} onChange={changeValues}
    onPick={index => { setModelIndex(index); setModelStage('closing-profile'); }} />;
  const afterClosed = () => {
    if (modelStage === 'closing-profile') { setModelStage('picker'); return; }
    const taskId = pendingTask.current; pendingTask.current = null;
    const didDelete = pendingDeleted.current; pendingDeleted.current = false;
    props.onClosed?.();
    if (didDelete) { props.onDeleted?.(); return; }
    if (taskId) router.push({ pathname: '/sessions/[sessionId]', params: { sessionId: taskId, deviceId } });
  };
  const openArtifactTask = (taskId: string) => { pendingTask.current = taskId; onClose(); };
  // Home management confirmations (restart / resume / delete) start from empty fields so a
  // leftover form value with the same id is never submitted with them.
  const confirm = (target: ProfilePanel | null) => { setConfirmation(target); if (target && (target.id === 'delete' || page === 'home')) { setValues({}); setEditing(false); } };
  const selectEditorPanel = (item: ProfilePanel) => { setEditorPanel(item.id); setValues(item.values); setEditing(false); };
  const retry = () => { if (page === 'editor') void retryEditor(); else void refresh(); };
  const modelPicker = <CompanionModelPicker visible={visible && modelStage === 'picker'} deviceId={deviceId} route={readCompanionModelChain(modelValues.modelChain)[modelIndex]}
    onClose={() => setModelStage('closing-picker')} onClosed={() => setModelStage('profile')}
    onSelect={route => { const chain = readCompanionModelChain(modelValues.modelChain);
      if (chain.some((item, index) => index !== modelIndex && item.harness === route.harness && item.model === route.model && item.providerId === route.providerId)) return false;
      chain[modelIndex] = route; changeValues({ ...modelValues, modelChain: JSON.stringify(chain), followsDefault: false }); return true; }} />;

  if (Platform.OS === 'ios') return <>{modelPicker}<CompanionProfileNativeView models={models}
    visible={visible && modelStage === 'profile'} title={confirmation?.action?.confirmation ? label(confirmation.action.confirmation.title) : page === 'editor' && editor ? label(editor.resource.display.title) : t(`devices.companionProfile.${titleKey}`)}
    name={name} page={page} deviceId={deviceId} deviceName={deviceName} resource={resource} data={data} editor={editor} panel={panel}
    values={editing ? values : panel?.values ?? values} busy={busy || memory.busy} online={online} dirty={dirty || memory.dirty} loading={editorLoading}
    error={error} errorLabel={deleteFailure ? t('devices.companionProfile.deleteFailed') : nameTakenOnSave ? t('devices.companionProfile.nameTaken') : undefined} conflict={conflict?.page === page} receipt={receipt && !confirmation ? label(receipt) : null} confirmation={confirmation} deleted={deleted}
    artifacts={sessionId && resource ? <CompanionProfileArtifacts deviceId={deviceId} botId={resource.ref.id} sessionId={sessionId} online={online} onOpenTask={openArtifactTask} /> : note('artifactsRecovery')}
    memoryPage={memoryPage} hasMemoryEntries={!!memoryList}
    onClose={dismiss} onClosed={afterClosed} onBack={page !== 'home' || confirmation ? () => void leave(false) : undefined}
    onOpen={open}
    onChange={changeValues}
    onSubmit={(target, confirmed) => { void submit(target, confirmed); }}
    onConfirm={confirm}
    onRetry={retry} onDiscard={discardDraft}
    onEditor={id => void openEditor(id)} onEditorPanel={selectEditorPanel}
    onSearch={onOpenSearch} /></>;

  // Android mirrors the iOS page map, entry order and save rules; only the surface is platform-drawn.
  const save = (target: ProfilePanel, blocked: boolean) => <MainWindowActionButton action={{ label: t('devices.companionProfile.save'), busy,
    disabled: blocked || !online || !dirty || conflict?.page === page, onPress: () => void submit(target) }} />;
  const formPanel = (target: ProfilePanel | undefined) => target?.action ? <>
    {target.id === 'capability' && target.text ? noteText(target.text) : null}
    <CompanionProfileForm panel={target} values={editing ? values : target.values} onChange={changeValues} disabled={busy || !online || !!target.action.disabled} />
    {save(target, !!target.action.disabled)}
  </> : target?.text ? <Text selectable style={styles.body}>{target.text}</Text> : !data && online ? spinner : note('hostUpgrade');
  const actionRow = (item: ProfilePanel, onPress: () => void, destructive = false) => <ContextSheetRow key={item.id} icon={null} disabled={busy || !online}
    destructive={destructive} label={label(item.action!.label)} onPress={onPress} testID={`companionProfile.action.${item.id}`} />;
  const skills = actionPanel('skills'); const connections = actionPanel('connections');
  const management = data?.panels.filter(item => ['restart', 'resume', 'delete'].includes(item.id) && item.action) ?? [];
  const home = <>
    <View style={styles.identity} testID="companionProfile.identity">
      <RemoteCompanionAvatar avatar={data?.resource.display.avatar ?? resource?.display.avatar} deviceId={deviceId} name={name} online={online} size={AVATAR_SIZE} />
      <Text accessibilityRole="header" numberOfLines={2} style={styles.name}>{name}</Text>
    </View>
    <View style={styles.group}>{row('profile', Info)}{row('memory', Brain)}{row('models', Sparkles)}{row('skills', Settings2)}</View>
    <View style={styles.group}>{row('artifacts', FileText)}{row('search', History, onOpenSearch)}{row('permissions', Hand)}</View>
    {/* Host order, like iOS: restart / resume / delete are whatever the computer offers now. */}
    {management.length ? <View style={styles.group}>{management.map(item => actionRow(item, () => confirm(item), item.id === 'delete'))}</View> : null}
    {online && data && !actionPanel('profile') ? note('hostUpgrade') : null}
  </>;
  const editorView = panel ? <>
    {formPanel(panel)}
    {editor?.panels.filter(item => item.id === 'remove' && item.action).map(item => <View key={item.id} style={styles.group}>{actionRow(item, () => confirm(item), true)}</View>)}
  </> : editor ? <View style={styles.group}>{editor.panels.flatMap(item => item.entries?.length
    ? item.entries.map(entry => <ContextSheetRow key={`${item.id}:${entry.resourceId}`} icon={null} trailing="chevron" label={label(entry.title)} onPress={() => void openEditor(entry.resourceId)} />)
    : [item.action ? <ContextSheetRow key={item.id} icon={null} trailing="chevron" label={label(item.title ?? item.action.label)} onPress={() => selectEditorPanel(item)} />
      : <Text key={item.id} style={[styles.body, styles.groupText]}>{item.text || t('devices.companionProfile.emptyEditor')}</Text>])}</View> : null;

  return <>{modelPicker}<CompanionSheet visible={visible && modelStage === 'profile'} onClosed={afterClosed} onClose={dismiss}
      preventDismiss={dirty || busy || !!confirmation || memory.dirty || memory.busy}
      onBack={page !== 'home' || confirmation ? () => void leave(false) : undefined}
      title={confirmation?.action?.confirmation ? label(confirmation.action.confirmation.title) : page === 'editor' && editor ? label(editor.resource.display.title) : t(`devices.companionProfile.${titleKey}`)} testID="companionProfile">
    <View style={styles.content}>
      {!online ? note('offline') : null}
      {error ? <View accessibilityRole="alert">{note(deleteFailure ? 'deleteFailed' : nameTakenOnSave ? 'nameTaken' : 'readFailed')}<MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: busy || !online, onPress: retry }} />
        {dirty ? <MainWindowActionButton action={{ label: t('devices.companions.automation.discard'), tone: 'danger', disabled: busy, onPress: () => discardDraft(false) }} /> : null}
      </View> : null}
      {conflict?.page === page ? <View accessibilityRole="alert">{note('changed')}<MainWindowActionButton action={{ label: t('devices.companionProfile.discardAndReload'), tone: 'danger', disabled: busy, onPress: () => discardDraft(true) }} /></View> : null}
      {receipt && !confirmation ? <Text accessibilityLiveRegion="polite" style={styles.note}>{label(receipt)}</Text> : null}
      {deleted ? <MainWindowActionButton action={{ label: t('shared.closePanel'), onPress: onClose }} /> : confirmation?.action?.confirmation ? <>
        <Text selectable style={styles.body}>{label(confirmation.action.confirmation.body ?? confirmation.action.label)}</Text>
        {/* Any confirmed action may ask for input (delete's typed name is one case), as on iOS. */}
        {confirmation.action.fields?.length ? <CompanionProfileForm panel={confirmation} values={values} onChange={changeValues} disabled={busy || !online} /> : null}
        <MainWindowActionButton action={{ label: label(confirmation.action.confirmation.confirmLabel ?? confirmation.action.label), busy, disabled: !online || confirmation.id === 'delete' && values.confirmName !== name, tone: confirmation.action.tone === 'destructive' ? 'danger' : 'primary', onPress: () => void submit(confirmation, true) }} />
        <MainWindowActionButton action={{ label: t('devices.common.cancel'), disabled: busy, onPress: () => confirm(null) }} />
      </> : page === 'home' ? home : editorLoading ? spinner : page === 'editor' ? editorView
        : page === 'models' ? panel?.action ? <>{models}{save(panel, false)}</> : noteText(panel?.text || t('devices.companionProfile.hostUpgrade', { deviceName }))
        : page === 'settings' ? <View style={styles.group}>{row('permissions', Hand)}</View>
        : page === 'skills' ? <>
          {skills?.entries?.length ? <View style={styles.group}>{row('personalSkills', Settings2)}</View> : noteText(skills?.text || t('devices.companionProfile.skillsEmpty'))}
          {connections?.entries?.length ? <View style={styles.group}>{row('connections', Link2)}</View> : noteText(connections?.text || t('devices.companionProfile.emptyEditor'))}
        </>
        : page === 'artifacts' ? sessionId && resource ? <CompanionProfileArtifacts deviceId={deviceId} botId={resource.ref.id} sessionId={sessionId} online={online} onOpenTask={openArtifactTask} /> : note('artifactsRecovery')
        : page === 'memoryEntries' ? memoryPage : <>
          {page === 'profile' && actionPanel('avatar')?.entries?.length ? <View style={styles.group}>{row('avatar', Camera)}</View> : null}
          {formPanel(panel)}
          {(page === 'profile' || page === 'memory') && panel && !panel.action ? note('largeProfileRecovery') : null}
          {page === 'memory' && data ? memoryList ? <View style={styles.group}>{row('memoryEntries', Brain)}</View> : panel?.action ? note('hostUpgrade') : null : null}
        </>}
    </View>
  </CompanionSheet></>;
}

/** Collection-level creation entry. Parent navigation consumes the confirmed resource ref. */
export function CompanionCreateSheet(props: { visible: boolean; onClose: () => void; onClosed?: () => void; deviceId: string; deviceName: string; collectionId: string; online: boolean; onCreated: (ref: RemoteResourceRef) => void }) {
  const { accountGeneration } = useAuth();
  return <CompanionCreateSheetContent key={`${accountGeneration}:${props.deviceId}:${props.collectionId}`} {...props} />;
}
function CompanionCreateSheetContent({ visible, onClose, onClosed, deviceId, deviceName, collectionId, online, onCreated }: Parameters<typeof CompanionCreateSheet>[0]) {
  const { invoke, openLink } = useDeviceLink();
  const { t, i18n } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [data, setData] = useState<CompanionProfileData | null>(null);
  const [values, setValues] = useState<ProfileValues>({ name: '', avatarImageBase64: '' });
  const [loading, setLoading] = useState(false);
  const [portraitChanged, setPortraitChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [nameTaken, setNameTaken] = useState(false);
  // The host may already hold the sent teammate under this request; a retry must resend exactly it.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const inFlight = useRef(false);
  const current = useRef(0);
  // Intent identity survives an ambiguous ACK, capability reload and reconnect.
  // The account-keyed component and an explicit new opening are reset boundaries.
  const requestId = useRef<string | null>(null);
  const ref = { collectionId, kind: 'bot', id: 'create' };
  // Desktop BotRosterView: names must be distinguishable before submitting (NFKC, trimmed, case-insensitive).
  // The host still rejects collisions with teammates this list does not show.
  const { user, accountGeneration } = useAuth();
  const takenNames = useMemo(() => new Set(readRemoteCollectionCache(`${user?.id ?? ''}:${accountGeneration}`, collectionId)
    .filter(row => row.host.deviceId === deviceId && row.item.ref.kind === 'bot')
    .map(row => normalizeTeammateName(resolveRemoteText(row.item.display.title, i18n.language)))),
  // Re-read whenever the sheet opens; the roster cache is not reactive.
  [accountGeneration, collectionId, deviceId, i18n.language, user?.id, visible]);
  const typedName = typeof values.name === 'string' ? values.name : '';
  const duplicate = !!typedName.trim() && takenNames.has(normalizeTeammateName(typedName));
  // A one-use create action is consumed by a failed attempt; re-read it without clearing the form or the notice.
  const reload = async (keepError = false) => {
    const sequence = ++current.current; if (!keepError) setError(false); setLoading(true);
    try {
      await openLink(deviceId);
      const next = await loadCompanionProfile(invoke, deviceId, ref, i18n.language);
      if (current.current === sequence) setData(next);
    } catch { if (current.current === sequence) setError(true); }
    finally { if (current.current === sequence) setLoading(false); }
  };
  useEffect(() => {
    if (visible) { requestId.current = null; setPortraitChanged(false); setNameTaken(false); setUnconfirmed(false); setValues({ name: '', avatarImageBase64: randomCompanionPortrait() }); }
  }, [visible]);
  useEffect(() => {
    setData(null); setError(false);
    if (visible && online) void reload();
    return () => { current.current++; };
  }, [visible, online, deviceId, collectionId]);
  const dirty = !!String(values.name ?? '').trim() || portraitChanged;
  const change = (next: ProfileValues) => { if (unconfirmed) return; if (next.avatarImageBase64 !== values.avatarImageBase64) setPortraitChanged(true); setValues(next); };
  const close = () => {
    if (inFlight.current) return;
    if (!dirty) { onClose(); return; }
    Alert.alert(t('devices.companions.automation.unsavedTitle'), t('devices.companions.automation.unsavedBody'), [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.companions.automation.discard'), style: 'destructive', onPress: () => { if (!inFlight.current) onClose(); } },
    ]);
  };
  const submit = async () => {
    const panel = data?.panels[0];
    if (!panel?.action || panel.action.disabled || inFlight.current || !online || duplicate) return;
    inFlight.current = true; setBusy(true); setError(false); setNameTaken(false);
    const sequence = current.current;
    try {
      requestId.current ??= randomUUID();
      const response = await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId, resourceRef: ref, actionId: panel.action.id, input: { ...values, requestId: requestId.current } }, i18n.language);
      if (current.current !== sequence) return;
      const navigation = response.effects.find(effect => effect.kind === 'navigate' && effect.target.kind === 'resource');
      if (navigation?.kind !== 'navigate' || navigation.target.kind !== 'resource') throw new Error('Creation receipt missing');
      onCreated(navigation.target.ref); onClose();
    } catch (cause) {
      if (current.current === sequence) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const collision = message.includes('ALREADY_EXISTS');
        // Only a host rejection proves nothing was created; then edits get a fresh request.
        const rejected = collision || message.includes('INVALID_PARAMS');
        setNameTaken(collision); setError(true); setUnconfirmed(!rejected);
        if (rejected) requestId.current = null;
        void reload(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (Platform.OS === 'ios') return <CompanionCreateNativeView deviceName={deviceName} nameTaken={nameTaken} duplicate={duplicate} locked={unconfirmed} visible={visible} onClose={close} onClosed={onClosed} panel={data?.panels[0]} values={values} onChange={change} onSubmit={() => void submit()} onRetry={() => void reload()} online={online} busy={busy} loading={loading} error={error} dirty={dirty} />;
  const panel = data?.panels[0];
  const notice = !online ? t('devices.companionProfile.offline', { deviceName }) : error || duplicate ? t(duplicate || nameTaken ? 'devices.companionProfile.nameTaken' : 'devices.companionProfile.createFailed') : null;
  // Same gate as iOS: a live, enabled host action, a name and a portrait.
  const blocked = busy || !online || !panel?.action || !!panel.action.disabled || typeof values.name !== 'string' || !values.name.trim() || !values.avatarImageBase64 || duplicate;
  return <CompanionSheet visible={visible} onClose={close} onClosed={onClosed} preventDismiss={dirty || busy} title={t('devices.companionProfile.create')}>
    <View style={styles.content}>
      {notice ? <Text accessibilityRole={online ? 'alert' : undefined} style={styles.note}>{notice}</Text> : null}
      {loading ? <ActivityIndicator accessibilityLabel={t('devices.resources.loading')} color={colors.textSecondary} style={styles.spinner} /> : null}
      {panel ? <CompanionProfileForm panel={panel} values={values} onChange={change} disabled={busy || !online || unconfirmed} /> : null}
      {!panel && online && !loading ? <MainWindowActionButton action={{ label: t('devices.resources.retry'), disabled: busy, onPress: () => void reload() }} /> : null}
      <MainWindowActionButton action={{ label: t('devices.companionProfile.create'), busy, disabled: blocked, onPress: () => void submit() }} />
      {/* The explicit exit while a draft blocks dismissal; `close` still asks before discarding. */}
      <MainWindowActionButton action={{ label: t('devices.common.cancel'), disabled: busy, onPress: close }} />
    </View>
  </CompanionSheet>;
}

/**
 * Host-described fields, laid out like the iOS form: a select or toggle is one inline row
 * (label · value), text and pictures take a heading. Selects open the system menu.
 */
function CompanionProfileForm({ panel, values, onChange, disabled }: { panel: ProfilePanel; values: ProfileValues; onChange: (values: ProfileValues) => void; disabled: boolean }) {
  const { i18n } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return <>{panel.action?.fields?.map(field => {
    const label = resolveRemoteText(field.label, i18n.language);
    const tuningSlot = panel.id === 'models' ? /^(?:effort|fast)([0-4])$/.exec(field.id)?.[1] : undefined;
    const fieldDisabled = disabled || (panel.id === 'models' && field.id !== 'followsDefault' && values.followsDefault === true)
      || (tuningSlot !== undefined && !values[`route${tuningSlot}`]);
    const options = field.options ?? [];
    const optionDisabled = (option: { value: string }) => fieldDisabled
      || (panel.id === 'models' && field.id.startsWith('route') && !!option.value && Object.entries(values).some(([key, value]) => key.startsWith('route') && key !== field.id && value === option.value));
    const change = (value: string | boolean) => {
      if (fieldDisabled) return;
      const next = { ...values, [field.id]: value };
      const routeSlot = panel.id === 'models' ? /^route([0-4])$/.exec(field.id)?.[1] : undefined;
      if (routeSlot !== undefined) {
        const slot = Number(routeSlot);
        if (!value) {
          for (let i = slot; i < 5; i++) {
            next[`route${i}`] = values[`route${i + 1}`] ?? '';
            next[`effort${i}`] = values[`effort${i + 1}`] ?? '';
            next[`fast${i}`] = values[`fast${i + 1}`] ?? false;
          }
        } else { next[`effort${slot}`] = ''; next[`fast${slot}`] = false; }
      }
      onChange(next);
    };
    if (field.kind === 'toggle') return <View key={field.id} style={styles.inline}>
      <Text style={[styles.heading, styles.flex]}>{label}</Text>
      <Switch accessibilityLabel={label} value={values[field.id] === true} onValueChange={change} disabled={fieldDisabled} trackColor={{ false: colors.border, true: colors.cta }} />
    </View>;
    if (field.kind === 'select') return <CompanionChoice key={field.id} label={label} value={typeof values[field.id] === 'string' ? values[field.id] as string : ''} disabled={fieldDisabled}
      options={options.map(option => ({ value: option.value, label: resolveRemoteText(option.label, i18n.language), disabled: optionDisabled(option) }))} onChange={change} />;
    return <View key={field.id} style={styles.field}>
      <Text style={styles.heading}>{label}</Text>
      {field.id === 'avatarImageBase64' ? <CompanionPortraitPicker value={String(values[field.id] ?? '')} onChange={change} disabled={disabled} /> : field.id === 'portrait' && panel.portraits ? <View style={styles.choices}>{panel.portraits.map(portrait => <Pressable key={portrait.value} accessibilityRole="button" accessibilityLabel={`${label} ${Number(portrait.value) + 1}`} accessibilityState={{ selected: values[field.id] === portrait.value, disabled }} disabled={disabled} onPress={() => change(portrait.value)} style={[styles.portrait, values[field.id] === portrait.value && { borderColor: colors.textPrimary }]}><Image source={{ uri: portrait.uri }} style={styles.portraitImage} /></Pressable>)}</View>
        : <TextInput accessibilityLabel={label} editable={!disabled} multiline={field.kind === 'multiline'} maxLength={fieldMaxLength(field.id)} onChangeText={change} value={typeof values[field.id] === 'string' ? values[field.id] as string : ''} placeholderTextColor={colors.textPlaceholder} style={[styles.input, field.kind === 'multiline' && styles.multiline]} />}
    </View>;
  })}</>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64 },
  name: { flex: 1, fontSize: typeScale.subtitle, lineHeight: lineHeight.subtitle, color: colors.textPrimary, fontWeight: fontWeight.medium },
  note: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, color: colors.textSecondary },
  body: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary },
  heading: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary, fontWeight: fontWeight.medium },
  group: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden', paddingHorizontal: spacing.lg },
  groupText: { paddingVertical: spacing.md },
  spinner: { paddingVertical: spacing.md },
  field: { gap: spacing.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  flex: { flex: 1 },
  input: { minHeight: 44, borderRadius: radius.pill, borderColor: colors.border, borderWidth: 1, padding: spacing.md, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, fontSize: typeScale.body },
  multiline: { minHeight: 120, borderRadius: radius.control, textAlignVertical: 'top' },
  portrait: { padding: spacing.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  portraitImage: { width: 56, height: 56, borderRadius: radius.pill },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
