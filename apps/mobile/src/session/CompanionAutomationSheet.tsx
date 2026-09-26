import { iconSize } from '@/theme';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { ChevronRight, Clock3, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import type { RemoteResource } from '@cindy/device-link';
import { Text, TextInput } from '@/components/AppText';
import { useAuth } from '@/auth/AuthContext';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { getRemoteResource, invokeRemoteResourceAction } from '@/device-link/remoteResources';
import { CompanionChoice } from './CompanionChoice';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, radius, spacing, typeScale, lineHeight } from '@/theme/tokens';
import { CompanionSheet } from './CompanionSheet';
import { CompanionAutomationNativeView } from './CompanionAutomationNativeView';
import { useRoutineCronFields } from './useRoutineCronFields';
import { emptyRoutineDefinition, getRoutineActionId, parseRoutineDefinition, parseRoutineDetail, parseRoutineSummaries, routineDraftValid, type RoutineDefinition, type RoutineDetail, type RoutineSummary, type RoutineTrigger } from './companionRoutines';

function automationFailure(error: unknown, tr: (key: string) => string): string {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : '';
  const text = error instanceof Error ? error.message : String(error);
  if (code === 'unsupported' || code === 'CHANNEL_NOT_ALLOWED' || text.includes('CHANNEL_NOT_ALLOWED')) return tr('unsupported');
  if (code === 'DEVICE_OFFLINE' || code === 'NOT_CONNECTED' || text.includes('DEVICE_OFFLINE') || text.includes('NOT_CONNECTED')) return tr('offline');
  // A host validation sentence is the actionable reason. Raw codes and JSON stay behind the localized summary.
  if (text && !text.startsWith('[') && !text.startsWith('{') && !/^[A-Z0-9_]+$/.test(text)) return text;
  return tr('failed');
}

function unsupportedAutomationError(): Error {
  return Object.assign(new Error('unsupported'), { code: 'unsupported' });
}

export function CompanionAutomationSheet({ visible, onClose, collectionId, botId, deviceId, deviceName, online }: {
  visible: boolean; onClose(): void; collectionId: string; botId: string; deviceId: string; deviceName: string; online: boolean;
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: string) => t(`devices.companions.automation.${key}`);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { accountGeneration } = useAuth();
  const { invoke, openLink, onRemoteResourceChanged, connectionEpoch, subscribe, unsubscribe } = useDeviceLink();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [resource, setResource] = useState<RemoteResource | null>(null);
  const [items, setItems] = useState<RoutineSummary[]>([]);
  const [detail, setDetail] = useState<RoutineDetail | null>(null);
  const [draft, setDraft] = useState<RoutineDefinition | null>(null);
  const [initialDraft, setInitialDraft] = useState('');
  const initialDraftRef = useRef(initialDraft); initialDraftRef.current = initialDraft;
  const detailRef = useRef(detail); detailRef.current = detail;
  const draftRef = useRef(draft); draftRef.current = draft;
  const [draftGeneration, setDraftGeneration] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(randomUUID());
  const seq = useRef(0);
  const inFlight = useRef(false);
  const pendingDelete = useRef(false);
  const operationGeneration = useRef(0);
  const dirty = draft !== null && JSON.stringify(draft) !== initialDraft;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const identity = `${accountGeneration}:${deviceId}:${collectionId}:${botId}`;
  const current = useRef({ identity, visible, selected, online }); current.current = { identity, visible, selected, online };
  const valid = (scope: string, page: string | null) => current.current.visible && current.current.identity === scope && current.current.selected === page;
  const open = useCallback((id: string | null) => {
    pendingDelete.current = false;
    setDraft(null); setInitialDraft(''); dirtyRef.current = false; setDetail(null); setResource(null); setError(null); setSelected(id);
    if (id === 'new') requestId.current = randomUUID();
  }, []);
  const load = useCallback(async (actionError?: string) => {
    if (!visible || !botId || !valid(identity, selected)) return;
    // An action may settle after connectivity changed; preserve its reason even offline.
    if (actionError) setError(actionError);
    if (!current.current.online) { setLoading(false); return; }
    const generation = ++seq.current;
    const scope = identity;
    setLoading(true); setError(actionError ?? null);
    try {
      await openLink(deviceId);
      const result = await getRemoteResource(invoke, { deviceId, deviceName }, { collectionId, kind: 'routine', id: `bot:${botId}${selected ? `/${selected}` : ''}` }, i18n.language, ['routine-list', 'routine-detail']);
      if (!valid(scope, selected) || generation !== seq.current) return;
      const block = result.blocks?.find((item) => item.primitive === (selected ? 'routine-detail' : 'routine-list'));
      if (!block) throw new Error(t('devices.companions.automation.unsupported'));
      if (selected) {
        const next = parseRoutineDetail(block.data);
        const versionChanged = dirtyRef.current && detailRef.current && next.revision !== detailRef.current.revision;
        if (versionChanged) {
          // A lost save acknowledgement is settled only by identical authoritative content.
          // Different remote edits must never grant stale drafts overwrite authority.
          if (!next.input || JSON.stringify(next.input) !== JSON.stringify(parseRoutineDefinition(draftRef.current))) {
            setResource(null);
            const changed = t('devices.companions.automation.changed');
            setError(actionError ? `${actionError}\n${changed}` : changed);
            return;
          }
          setInitialDraft(JSON.stringify(draftRef.current)); dirtyRef.current = false;
        }
        setDetail(next);
        if (!dirtyRef.current && !versionChanged) {
          const value = next.input ?? (selected === 'new' ? emptyRoutineDefinition() : null);
          const serialized = JSON.stringify(value);
          if (serialized !== initialDraftRef.current) {
            setDraft(value); setInitialDraft(serialized); setDraftGeneration((value) => value + 1);
          }
        }
      } else setItems(parseRoutineSummaries(block.data));
      pendingDelete.current = false;
      setResource(result);
    } catch (e) {
      if (valid(scope, selected) && generation === seq.current) {
        // A lost delete response may leave no detail to refresh. Only a confirmed
        // missing resource settles that intent; transient failures remain retryable.
        const missing = (e as { code?: unknown } | null)?.code === 'NOT_FOUND'
          || e instanceof Error && e.message.startsWith('[NOT_FOUND]');
        if (pendingDelete.current && !dirtyRef.current && missing) {
          open(null);
          return;
        }
        const unsupported = t('devices.companions.automation.unsupported');
        const readError = e instanceof Error && e.message === unsupported ? unsupported : t('devices.resources.loadFailed');
        setError(actionError ? `${actionError}\n${readError}` : readError);
      }
    }
    finally { if (valid(scope, selected) && generation === seq.current) setLoading(false); }
  }, [visible, online, botId, identity, invoke, openLink, deviceId, deviceName, collectionId, selected, i18n.language, t, open]);
  useEffect(() => {
    setSelected(null); setResource(null); setItems([]); setDetail(null); setDraft(null); setInitialDraft(''); setError(null);
    requestId.current = randomUUID();
    pendingDelete.current = false;
    operationGeneration.current++; inFlight.current = false; setBusy(false);
    return () => { seq.current++; };
  }, [visible, identity]);
  useEffect(() => { void load(); return () => { seq.current++; }; }, [load, connectionEpoch]);
  useEffect(() => {
    if (!visible) return;
    const off = onRemoteResourceChanged((hostId, event) => {
      if (hostId === deviceId && (event.collectionId === collectionId || event.collectionId === 'routines') && !dirtyRef.current && !inFlight.current) void load();
    });
    const foreground = AppState.addEventListener('change', (state) => { if (state === 'active' && !inFlight.current) void load(); });
    const release = online ? startFocusedTopicSubscription({ deviceId, owner: `companion-routines:${botId}`, subscribe, unsubscribe, topic: 'sessions' }) : undefined;
    return () => { off(); foreground.remove(); release?.(); };
  }, [visible, online, onRemoteResourceChanged, collectionId, deviceId, botId, load, subscribe, unsubscribe]);
  const leave = (action: () => void) => {
    if (inFlight.current) return;
    if (!dirty) { action(); return; }
    Alert.alert(tr('unsavedTitle'), tr('unsavedBody'), [
      { text: tr('continueEditing'), style: 'cancel' },
      { text: tr('discard'), style: 'destructive', onPress: () => { if (valid(identity, selected)) action(); } },
    ]);
  };
  const act = async (actionId: string) => {
    const capabilityId = getRoutineActionId(resource, actionId);
    if (!valid(identity, selected) || inFlight.current || loading || !online || !resource || !capabilityId) return;
    if (actionId === 'routine-create' || actionId === 'routine-save' || actionId === 'routine-run' && dirty) {
      if (!draft || !routineDraftValid(draft)) { setError(tr('invalid')); return; }
    }
    const scope = identity, page = selected;
    const operation = ++operationGeneration.current;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      let runResource = resource;
      let runRevision = detail?.revision ?? 0;
      if (actionId === 'routine-run' && dirty) {
        const saveId = getRoutineActionId(resource, 'routine-save');
        if (!saveId) throw unsupportedAutomationError();
        await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, { collectionId, resourceRef: resource.ref, actionId: saveId,
          input: { revision: runRevision, definition: draft } }, i18n.language);
        if (!valid(scope, page)) return;
        // A successful save stays successful even if the subsequent run/read fails.
        setInitialDraft(JSON.stringify(draft)); dirtyRef.current = false;
        runResource = await getRemoteResource(invoke, { deviceId, deviceName }, resource.ref, i18n.language, ['routine-list', 'routine-detail']);
        if (!valid(scope, page)) return;
        const block = runResource.blocks?.find(block => block.primitive === 'routine-detail');
        const next = parseRoutineDetail(block?.data);
        setResource(runResource); setDetail(next); runRevision = next.revision;
      }
      const nextCapability = getRoutineActionId(runResource, actionId);
      if (!nextCapability) throw unsupportedAutomationError();
      await invokeRemoteResourceAction(invoke, { deviceId, deviceName }, {
        collectionId, resourceRef: runResource.ref, actionId: nextCapability,
        input: { revision: runRevision, requestId: requestId.current,
          ...((actionId === 'routine-create' || actionId === 'routine-save') ? { definition: draft } : {}) },
      }, i18n.language);
      if (!valid(scope, page)) return;
      if (actionId === 'routine-run') { await load(); }
      else open(null);
    } catch (e) {
      if (valid(scope, page)) {
        // The host consumes opaque actions even when validation or the response fails.
        // Reconcile by reading, never replay a write or renew a creation request ID.
        setResource(null);
        pendingDelete.current = actionId === 'routine-delete';
        await load(automationFailure(e, tr));
      }
    }
    finally { if (operationGeneration.current === operation) { inFlight.current = false; if (current.current.identity === scope) setBusy(false); } }
  };
  const button = (label: string, onPress: () => void, destructive = false, disabled = false) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || busy }} disabled={disabled || busy} onPress={onPress} style={[styles.row, (disabled || busy) && styles.disabled]}>
      <Text style={[styles.label, destructive && { color: colors.destructive }]}>{label}</Text>
    </Pressable>
  );
  const triggerText = (trigger: Record<string, unknown>) => trigger.kind === 'interval'
    ? t('devices.companions.automation.everyMinutes', { count: Number(trigger.intervalMs) / 60_000 })
    : trigger.kind === 'cron' ? `${trigger.expression} · ${trigger.timezone}` : `${trigger.sourceId} · ${trigger.eventType}`;
  const row = (item: RoutineSummary) => (
    <Pressable key={item.id} accessibilityRole="button" onPress={() => open(item.id)} style={styles.row} testID={`companion.automation.${item.id}`}>
      <Clock3 size={iconSize.lg} color={colors.textSecondary} />
      <View style={styles.flex}><Text numberOfLines={1} style={styles.label}>{item.name}</Text>
        <Text numberOfLines={1} style={styles.secondary}>{item.activity ? tr(item.activity) : !item.enabled ? tr('paused') : item.triggers.map(triggerText).join(' · ')}</Text></View>
      <ChevronRight size={iconSize.sm} color={colors.textTertiary} />
    </Pressable>
  );
  const field = (label: string, value: string, onChangeText: (value: string) => void, multiline = false) => (
    <View style={styles.field}><Text style={styles.secondary}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={onChangeText} editable={!busy} multiline={multiline} style={[styles.input, multiline && styles.multiline]} /></View>
  );
  const updateTrigger = (index: number, value: RoutineTrigger) => setDraft((d) => d && ({ ...d, triggers: d.triggers.map((item, i) => i === index ? value : item) }));
  const choose = (label: string, value: string, options: { value: string; label: string }[], onChange: (value: string) => void) =>
    <CompanionChoice {...{ label, value, options, onChange }} disabled={busy || !online} />;
  const confirmDelete = () => Alert.alert(tr('deleteTitle'), tr('deleteBody'), [{ text: tr('cancel'), style: 'cancel' }, { text: tr('delete'), style: 'destructive', onPress: () => void act('routine-delete') }]);
  if (Platform.OS === 'ios') return <CompanionAutomationNativeView
    {...{ visible, online, busy, loading, dirty, error, selected, draftGeneration, resource, items, detail, draft }}
    onChange={setDraft} onClose={() => leave(onClose)} onBack={() => leave(() => open(null))}
    onOpen={open} onRetry={() => void load()} onAct={action => void act(action)} onDelete={confirmDelete} />;
  return <CompanionSheet visible={visible} onClose={() => leave(onClose)} preventDismiss={dirty || busy}
      title={selected ? draft?.name || tr('new') : t('devices.companionProfile.automation')}
      onBack={selected ? () => leave(() => open(null)) : undefined} testID="companion.automationSheet"
      footer={selected && detail?.editable ? button(tr('save'), () => void act(selected === 'new' ? 'routine-create' : 'routine-save'), false, !online || !dirty || loading || !getRoutineActionId(resource, selected === 'new' ? 'routine-create' : 'routine-save')) : undefined}>
      {!online ? <Text style={styles.error}>{tr('offline')}</Text> : null}
      {error ? <View style={styles.field}><Text selectable style={styles.error}>{error}</Text>{button(tr('retry'), () => void load(), false, !online)}</View> : null}
      {loading ? <ActivityIndicator color={colors.textSecondary} style={styles.field} /> : null}
      {!selected ? <>
        {items.some((r) => r.activity) ? <View style={styles.group}><Text style={styles.heading}>{tr('inProgress')}</Text>{items.filter((r) => r.activity).map(row)}</View> : null}
        {items.some((r) => !r.activity) ? <View style={styles.group}><Text style={styles.heading}>{tr('scheduled')}</Text>{items.filter((r) => !r.activity).map(row)}</View> : null}
        {online && !loading && !error && items.length === 0 ? <Text style={styles.empty}>{tr('empty')}</Text> : null}
        {getRoutineActionId(resource, 'routine-create') ? <Pressable accessibilityRole="button" onPress={() => open('new')} style={styles.row} testID="companion.newAutomation"><Plus size={iconSize.lg} color={colors.textPrimary} /><Text style={styles.label}>{tr('new')}</Text></Pressable> : null}
      </> : detail ? <>
        {draft && detail.editable ? <>
          {field(tr('name'), draft.name, (name) => setDraft({ ...draft, name }))}
          <View style={styles.row}><Text style={[styles.label, styles.flex]}>{tr('enabled')}</Text><Switch accessibilityLabel={tr('enabled')} disabled={busy} value={draft.enabled} onValueChange={(enabled) => setDraft({ ...draft, enabled })} trackColor={{ true: colors.textSecondary }} /></View>
          {field(tr('instructions'), draft.prompt, (prompt) => setDraft({ ...draft, prompt }), true)}
          {detail?.supportsPreRunCheck ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: advancedOpen }} onPress={() => setAdvancedOpen(!advancedOpen)} style={styles.row}><Text style={styles.label}>{tr('advanced')}</Text></Pressable> : null}
          {detail?.supportsPreRunCheck && advancedOpen ? <View style={styles.group}>
            <View style={styles.row}><Text style={[styles.label, styles.flex]}>{tr('quiet')}</Text><Switch accessibilityLabel={tr('quiet')} disabled={busy} value={draft.silentWhenIdle ?? false} onValueChange={(silentWhenIdle) => setDraft({ ...draft, silentWhenIdle })} trackColor={{ true: colors.textSecondary }} /></View>
            <Text style={styles.secondary}>{tr('quietHint')}</Text>
            {field(tr('checkCommand'), draft.preRunHook?.command ?? '', (command) => setDraft({ ...draft, preRunHook: command ? { ...draft.preRunHook, command } : null }), true)}
            <Text style={styles.secondary}>{tr('checkHint')}</Text>
            {draft.preRunHook ? field(tr('timeoutMs'), draft.preRunHook.timeoutMs === undefined ? '' : String(draft.preRunHook.timeoutMs), (value) => setDraft({ ...draft, preRunHook: { ...draft.preRunHook!, timeoutMs: value ? Number(value) : undefined } })) : null}
          </View> : null}
          <Text style={styles.heading}>{tr('triggers')}</Text>
          {draft.triggers.map((trigger, index) => <View key={`${draftGeneration}:${trigger.id}`} style={styles.group}>
            {choose(tr('triggerType'), trigger.kind, ['cron', 'interval', 'event'].map((value) => ({ value, label: tr(value) })), (kind) => updateTrigger(index, kind === 'interval' ? { id: trigger.id, kind, intervalMs: 3_600_000 } : kind === 'event' ? { id: trigger.id, kind, sourceId: '', eventType: '', filters: [] } : { id: trigger.id, kind: 'cron', expression: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }))}
            {trigger.kind === 'cron' ? <RoutineCronFields trigger={trigger} onChange={(value) => updateTrigger(index, value)} disabled={busy} /> : trigger.kind === 'interval' ? <NumberField key={trigger.id} label={tr('minutes')} value={trigger.intervalMs / 60_000} onChange={(value) => updateTrigger(index, { ...trigger, intervalMs: value * 60_000 })} disabled={busy} /> : <>
              {choose(tr('source'), trigger.sourceId, detail.sources.map((s) => ({ value: s.id, label: s.name })), (sourceId) => updateTrigger(index, { ...trigger, sourceId, eventType: '', filters: [] }))}
              {choose(tr('event'), trigger.eventType, (detail.sources.find((s) => s.id === trigger.sourceId)?.events ?? []).map((e) => ({ value: e.type, label: e.name })), (eventType) => updateTrigger(index, { ...trigger, eventType, filters: [] }))}
              {trigger.filters.map((filter, fi) => <View key={fi} style={styles.group}>
                {field(tr('filterField'), filter.field, (value) => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, n) => n === fi ? { ...f, field: value } : f) }))}
                {choose(tr('operator'), filter.operator, ['equals','contains','not-equals'].map((value) => ({ value, label: tr(value) })), (value) => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, n) => n === fi ? { ...f, operator: value as typeof f.operator } : f) }))}
                {field(tr('filterValue'), filter.value, (value) => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, n) => n === fi ? { ...f, value } : f) }))}
                {button(tr('removeFilter'), () => updateTrigger(index, { ...trigger, filters: trigger.filters.filter((_, n) => n !== fi) }))}
              </View>)}
              {trigger.filters.length < 16 ? button(tr('addFilter'), () => updateTrigger(index, { ...trigger, filters: [...trigger.filters, { field: '', operator: 'equals', value: '' }] })) : null}
            </>}
            {button(tr('removeTrigger'), () => setDraft({ ...draft, triggers: draft.triggers.filter((_, i) => i !== index) }), false, draft.triggers.length <= 1)}
          </View>)}
          {draft.triggers.length < 32 ? button(tr('addTrigger'), () => setDraft({ ...draft, triggers: [...draft.triggers, { id: randomUUID(), kind: 'interval', intervalMs: 3_600_000 }] })) : null}
        </> : <Text style={styles.empty}>{tr('largeDefinition')}</Text>}
        {selected !== 'new' ? <View style={styles.group}>
          {getRoutineActionId(resource, 'routine-run') ? button(tr(dirty ? 'saveAndRun' : 'run'), () => void act('routine-run'), false, loading || !online || detail.history.some((r) => r.status === 'running' || r.status === 'queued')) : null}
          <Text style={styles.heading}>{tr('history')}</Text>
          {detail.history.length ? detail.history.map((run) => <View key={run.id} style={styles.field}><Text style={styles.label}>{tr(run.status)}</Text><Text style={styles.secondary}>{new Date(run.createdAt).toLocaleString(i18n.language)}</Text>{run.resultText ? <Text selectable style={styles.label}>{run.resultText}</Text> : null}{run.error ? <Text selectable style={styles.error}>{run.error}</Text> : null}</View>) : <Text style={styles.empty}>{tr('noRuns')}</Text>}
          {getRoutineActionId(resource, 'routine-delete') ? button(tr('delete'), confirmDelete, true, loading || dirty || !online) : null}
        </View> : null}
      </> : null}
  </CompanionSheet>;
}
function RoutineCronFields({ trigger, onChange, disabled }: {
  trigger: Extract<RoutineTrigger, { kind: 'cron' }>; onChange(trigger: Extract<RoutineTrigger, { kind: 'cron' }>): void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`devices.companions.automation.${key}`);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { preset, hour, minute, day, changePreset, changeHour, changeMinute, changeDay } = useRoutineCronFields(trigger, onChange);
  const select = (label: string, value: string, options: { id: string; title: string }[], action: (id: string) => void) =>
    <CompanionChoice label={label} value={value} options={options.map(option => ({ value: option.id, label: option.title }))} onChange={action} disabled={disabled} />;
  return <>
    {select(tr('repeat'), preset, ['hourly','daily','weekdays','weekly','monthly','custom'].map((id) => ({ id, title: tr(id) })), changePreset)}
    {preset === 'monthly' ? select(tr('monthDay'), day, Array.from({ length: 31 }, (_, i) => ({ id: String(i + 1), title: String(i + 1) })), changeDay) : null}
    {preset === 'weekly' ? select(tr('weekday'), day, Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: tr(`day${i}`) })), changeDay) : null}
    {preset !== 'custom' ? <View style={styles.row}>
      <Text style={[styles.label, styles.flex]}>{tr('time')}</Text>
      {preset !== 'hourly' ? <><TextInput accessibilityLabel={tr('hour')} keyboardType="number-pad" maxLength={2} value={hour} editable={!disabled} onChangeText={changeHour} style={[styles.input, styles.clockInput]} /><Text style={styles.label}>:</Text></> : null}
      <TextInput accessibilityLabel={tr('minute')} keyboardType="number-pad" maxLength={2} value={minute} editable={!disabled} onChangeText={changeMinute} style={[styles.input, styles.clockInput]} />
    </View> : <View style={styles.field}><Text style={styles.secondary}>{tr('cronExpression')}</Text><TextInput accessibilityLabel={tr('cronExpression')} value={trigger.expression} editable={!disabled} onChangeText={(expression) => onChange({ ...trigger, expression })} style={styles.input} /></View>}
    <View style={styles.field}><Text style={styles.secondary}>{tr('timezone')}</Text><TextInput accessibilityLabel={tr('timezone')} value={trigger.timezone} editable={!disabled} onChangeText={(timezone) => onChange({ ...trigger, timezone })} autoCapitalize="none" style={styles.input} /></View>
  </>;
}
function NumberField({ label, value, onChange, disabled }: { label: string; value: number; onChange(value: number): void; disabled: boolean }) {
  const [text, setText] = useState(String(value));
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.field}><Text style={styles.secondary}>{label}</Text><TextInput accessibilityLabel={label} keyboardType="numeric" editable={!disabled} value={text} onChangeText={(next) => { setText(next); onChange(Number(next)); }} style={styles.input} /></View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  flex: { flex: 1 }, row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  label: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textPrimary }, secondary: { fontSize: typeScale.caption, lineHeight: lineHeight.caption, color: colors.textSecondary },
  heading: { fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, color: colors.textTertiary, margin: spacing.md },
  field: { gap: spacing.sm, marginHorizontal: spacing.md, marginVertical: spacing.sm },
  group: { marginVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  input: { minHeight: 44, padding: spacing.md, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.pill, fontSize: typeScale.body },
  clockInput: { width: 64, textAlign: 'center' },
  multiline: { minHeight: 112, textAlignVertical: 'top', borderRadius: radius.control }, empty: { margin: spacing.lg, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, color: colors.textSecondary },
  error: { color: colors.statusError, fontSize: typeScale.footnote, lineHeight: lineHeight.caption }, disabled: { opacity: 0.45 },
});
