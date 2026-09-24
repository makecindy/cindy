import { Fragment, useState } from 'react';
import { Button, DisclosureGroup, HStack, Image, Picker, ProgressView, Spacer, Text, TextField, Toggle, VStack, useNativeState } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, contentShape, disabled, font, foregroundStyle, frame, keyboardType, lineLimit, pickerStyle, shapes, tag, textInputAutocapitalization, textSelection } from '@expo/ui/swift-ui/modifiers';
import { useTranslation } from 'react-i18next';
import { randomUUID } from 'expo-crypto';
import { iconSize, spacing, useTheme } from '@/theme';
import { ComposerSheet } from './ComposerSheet';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { getRoutineActionId, type RoutineTrigger } from './companionRoutines';
import { useRoutineCronFields } from './useRoutineCronFields';
import type { CompanionAutomationNativeViewProps } from './CompanionAutomationNativeView';

/** Native owns editing/composition. A new remote draft remounts fields via draftGeneration. */
function Field({ label, value, onChange, busy, multiline = false, numeric = false, clock = false, literal = false }: {
  label: string; value: string; onChange(value: string): void; busy: boolean;
  multiline?: boolean; numeric?: boolean; clock?: boolean; literal?: boolean;
}) {
  const text = useNativeState(value);
  return <TextField text={text} onTextChange={onChange} axis={multiline ? 'vertical' : 'horizontal'}
    testID={`companion.automation.field.${label}`} modifiers={[
      accessibilityLabel(label), disabled(busy), frame({ minHeight: 44, ...(clock ? { width: 64 } : {}) }),
      ...(multiline ? [lineLimit({ min: 3, max: 8 })] : []),
      ...(numeric ? [keyboardType('numeric')] : []),
      ...(literal ? [textInputAutocapitalization('never')] : []),
    ]} />;
}

function Action({ label, onPress, blocked = false, destructive = false, symbol, testID }: {
  label: string; onPress(): void; blocked?: boolean; destructive?: boolean; symbol?: 'plus' | 'clock'; testID?: string;
}) {
  const { colors } = useTheme();
  return <Button onPress={onPress} testID={testID} modifiers={[buttonStyle('plain'), disabled(blocked), frame({ minHeight: 44 }),
    ...(destructive ? [foregroundStyle(colors.destructive)] : [])]}>
    <HStack spacing={spacing.md} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}>
      {symbol ? <Image systemName={symbol} size={iconSize.action} /> : null}<Text>{label}</Text><Spacer />
    </HStack>
  </Button>;
}

function Choice({ label, value, options, onChange, blocked }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void; blocked: boolean;
}) {
  return <Picker label={label} selection={value} onSelectionChange={value => onChange(String(value))}
    modifiers={[pickerStyle('menu'), disabled(blocked), frame({ minHeight: 44 })]}>
    {options.map(option => <Text key={option.value} modifiers={[tag(option.value)]}>{option.label}</Text>)}
  </Picker>;
}

function CronFields({ trigger, onChange, busy }: { trigger: Extract<RoutineTrigger, { kind: 'cron' }>; onChange(trigger: Extract<RoutineTrigger, { kind: 'cron' }>): void; busy: boolean }) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`devices.companions.automation.${key}`);
  const cron = useRoutineCronFields(trigger, onChange);
  return <>
    <Choice label={tr('repeat')} value={cron.preset} options={['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'].map(value => ({ value, label: tr(value) }))} onChange={cron.changePreset} blocked={busy} />
    {cron.preset === 'monthly' ? <Choice label={tr('monthDay')} value={cron.day} options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} onChange={cron.changeDay} blocked={busy} /> : null}
    {cron.preset === 'weekly' ? <Choice label={tr('weekday')} value={cron.day} options={Array.from({ length: 7 }, (_, i) => ({ value: String(i), label: tr(`day${i}`) }))} onChange={cron.changeDay} blocked={busy} /> : null}
    {cron.preset === 'custom' ? <FieldRow label={tr('cronExpression')} value={trigger.expression} onChange={expression => onChange({ ...trigger, expression })} busy={busy} literal /> :
      <HStack spacing={spacing.sm}><Text>{tr('time')}</Text><Spacer />
        {cron.preset !== 'hourly' ? <><Field label={tr('hour')} value={cron.hour} onChange={cron.changeHour} busy={busy} numeric clock /><Text>:</Text></> : null}
        <Field label={tr('minute')} value={cron.minute} onChange={cron.changeMinute} busy={busy} numeric clock />
      </HStack>}
    <FieldRow label={tr('timezone')} value={trigger.timezone} onChange={timezone => onChange({ ...trigger, timezone })} busy={busy} literal />
  </>;
}

function FieldRow(props: Parameters<typeof Field>[0]) {
  const { colors } = useTheme();
  return <VStack alignment="leading" spacing={spacing.sm}>
    <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.textSecondary)]}>{props.label}</Text><Field {...props} />
  </VStack>;
}

export function CompanionAutomationNativeView(p: CompanionAutomationNativeViewProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const tr = (key: string) => t(`devices.companions.automation.${key}`);
  const note = (text: string, error = false) => <Section><Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(error ? colors.statusError : colors.textSecondary), textSelection(error)]}>{text}</Text></Section>;
  const updateTrigger = (index: number, value: RoutineTrigger) => p.onChange(draft => draft && ({ ...draft, triggers: draft.triggers.map((item, i) => i === index ? value : item) }));
  const triggerText = (trigger: Record<string, unknown>) => trigger.kind === 'interval'
    ? t('devices.companions.automation.everyMinutes', { count: Number(trigger.intervalMs) / 60_000 })
    : trigger.kind === 'cron' ? `${trigger.expression} · ${trigger.timezone}` : `${trigger.sourceId} · ${trigger.eventType}`;
  const list = (active: boolean) => p.items.filter(item => Boolean(item.activity) === active).map(item =>
    <Button key={item.id} onPress={() => p.onOpen(item.id)} testID={`companion.automation.${item.id}`} modifiers={[buttonStyle('plain')]}>
      <HStack spacing={spacing.md} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), contentShape(shapes.rectangle())]}>
        <Image systemName="clock" size={iconSize.action} modifiers={[foregroundStyle(colors.textSecondary)]} />
        <VStack alignment="leading" spacing={spacing.xs}><Text modifiers={[lineLimit(1)]}>{item.name}</Text>
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{item.activity ? tr(item.activity) : !item.enabled ? tr('paused') : item.triggers.map(triggerText).join(' · ')}</Text>
        </VStack><Spacer /><Image systemName="chevron.right" size={iconSize.xs} />
      </HStack>
    </Button>);
  const { draft, detail } = p;
  return <ComposerSheet visible={p.visible} onClose={p.onClose} onBack={p.selected ? p.onBack : undefined}
    nativeContent preventDismiss={p.dirty || p.busy} testID="companion.automationSheet"
    title={p.selected ? draft?.name || tr('new') : t('devices.companionProfile.automation')}>
    {!p.online ? note(tr('offline')) : null}
    {p.error ? <>{note(p.error, true)}<Section><Action label={tr('retry')} onPress={p.onRetry} blocked={p.busy || !p.online} /></Section></> : null}
    {p.loading ? <Section><ProgressView /></Section> : null}
    {!p.selected ? <>
      {p.items.some(item => item.activity) ? <Section title={tr('inProgress')}>{list(true)}</Section> : null}
      {p.items.some(item => !item.activity) ? <Section title={tr('scheduled')}>{list(false)}</Section> : null}
      {p.online && !p.loading && !p.error && p.items.length === 0 ? note(tr('empty')) : null}
      {getRoutineActionId(p.resource, 'routine-create') ? <Section><Action label={tr('new')} symbol="plus" onPress={() => p.onOpen('new')} testID="companion.newAutomation" /></Section> : null}
    </> : detail ? <>
      {draft && detail.editable ? <Fragment key={`${p.selected}:${p.draftGeneration}`}>
        <Section title={tr('name')}><Field label={tr('name')} value={draft.name} onChange={name => p.onChange(d => d && ({ ...d, name }))} busy={p.busy} />
          <Toggle label={tr('enabled')} isOn={draft.enabled} onIsOnChange={enabled => p.onChange(d => d && ({ ...d, enabled }))} modifiers={[disabled(p.busy)]} />
        </Section>
        <Section title={tr('instructions')}><Field label={tr('instructions')} value={draft.prompt} onChange={prompt => p.onChange(d => d && ({ ...d, prompt }))} busy={p.busy} multiline /></Section>
        {p.detail?.supportsPreRunCheck ? <Section><DisclosureGroup label={tr('advanced')} isExpanded={advancedOpen} onIsExpandedChange={setAdvancedOpen}>
          <Toggle label={tr('quiet')} isOn={draft.silentWhenIdle ?? false} onIsOnChange={silentWhenIdle => p.onChange(d => d && ({ ...d, silentWhenIdle }))} modifiers={[disabled(p.busy)]} />
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{tr('quietHint')}</Text>
          <FieldRow label={tr('checkCommand')} value={draft.preRunHook?.command ?? ''} onChange={command => p.onChange(d => d && ({ ...d, preRunHook: command ? { ...d.preRunHook, command } : null }))} busy={p.busy} multiline literal />
          <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{tr('checkHint')}</Text>
          {draft.preRunHook ? <FieldRow label={tr('timeoutMs')} value={draft.preRunHook.timeoutMs === undefined ? '' : String(draft.preRunHook.timeoutMs)} onChange={value => p.onChange(d => d && ({ ...d, preRunHook: { ...d.preRunHook!, timeoutMs: value ? Number(value) : undefined } }))} busy={p.busy} numeric /> : null}
        </DisclosureGroup></Section> : null}
        {draft.triggers.map((trigger, index) => <Section key={trigger.id} title={tr('triggers')}>
          <Choice label={tr('triggerType')} value={trigger.kind} options={['cron', 'interval', 'event'].map(value => ({ value, label: tr(value) }))} blocked={p.busy || !p.online}
            onChange={kind => updateTrigger(index, kind === 'interval' ? { id: trigger.id, kind, intervalMs: 3_600_000 } : kind === 'event' ? { id: trigger.id, kind, sourceId: '', eventType: '', filters: [] } : { id: trigger.id, kind: 'cron', expression: '0 9 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })} />
          {trigger.kind === 'cron' ? <CronFields trigger={trigger} onChange={value => updateTrigger(index, value)} busy={p.busy} /> : trigger.kind === 'interval' ?
            <FieldRow label={tr('minutes')} value={String(trigger.intervalMs / 60_000)} onChange={value => updateTrigger(index, { ...trigger, intervalMs: Number(value) * 60_000 })} busy={p.busy} numeric /> : <>
              <Choice label={tr('source')} value={trigger.sourceId} options={detail.sources.map(s => ({ value: s.id, label: s.name }))} blocked={p.busy || !p.online} onChange={sourceId => updateTrigger(index, { ...trigger, sourceId, eventType: '', filters: [] })} />
              <Choice label={tr('event')} value={trigger.eventType} options={(detail.sources.find(s => s.id === trigger.sourceId)?.events ?? []).map(e => ({ value: e.type, label: e.name }))} blocked={p.busy || !p.online} onChange={eventType => updateTrigger(index, { ...trigger, eventType, filters: [] })} />
              {trigger.filters.map((filter, fi) => <Fragment key={`${trigger.filters.length}:${fi}`}>
                <FieldRow label={tr('filterField')} value={filter.field} onChange={field => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, i) => i === fi ? { ...f, field } : f) })} busy={p.busy} />
                <Choice label={tr('operator')} value={filter.operator} options={['equals', 'contains', 'not-equals'].map(value => ({ value, label: tr(value) }))} blocked={p.busy || !p.online} onChange={operator => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, i) => i === fi ? { ...f, operator: operator as typeof f.operator } : f) })} />
                <FieldRow label={tr('filterValue')} value={filter.value} onChange={value => updateTrigger(index, { ...trigger, filters: trigger.filters.map((f, i) => i === fi ? { ...f, value } : f) })} busy={p.busy} />
                <Action label={tr('removeFilter')} onPress={() => updateTrigger(index, { ...trigger, filters: trigger.filters.filter((_, i) => i !== fi) })} blocked={p.busy} />
              </Fragment>)}
              {trigger.filters.length < 16 ? <Action label={tr('addFilter')} onPress={() => updateTrigger(index, { ...trigger, filters: [...trigger.filters, { field: '', operator: 'equals', value: '' }] })} blocked={p.busy} /> : null}
            </>}
          <Action label={tr('removeTrigger')} onPress={() => p.onChange(d => d && ({ ...d, triggers: d.triggers.filter((_, i) => i !== index) }))} blocked={p.busy || draft.triggers.length <= 1} />
        </Section>)}
        {draft.triggers.length < 32 ? <Section><Action label={tr('addTrigger')} onPress={() => p.onChange(d => d && ({ ...d, triggers: [...d.triggers, { id: randomUUID(), kind: 'interval', intervalMs: 3_600_000 }] }))} blocked={p.busy} /></Section> : null}
      </Fragment> : note(tr('largeDefinition'))}
      {detail.editable ? <Section><Action label={tr('save')} onPress={() => p.onAct(p.selected === 'new' ? 'routine-create' : 'routine-save')} blocked={p.busy || p.loading || !p.online || !p.dirty || !getRoutineActionId(p.resource, p.selected === 'new' ? 'routine-create' : 'routine-save')} testID="companion.automation.save" /></Section> : null}
      {p.selected !== 'new' ? <>
        {getRoutineActionId(p.resource, 'routine-run') ? <Section><Action label={tr(p.dirty ? 'saveAndRun' : 'run')} onPress={() => p.onAct('routine-run')} blocked={p.busy || p.loading || !p.online || detail.history.some(r => r.status === 'running' || r.status === 'queued')} /></Section> : null}
        <Section title={tr('history')}>{detail.history.length ? detail.history.map(run => <VStack key={run.id} alignment="leading" spacing={spacing.sm}>
          <Text>{tr(run.status)}</Text><Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.textSecondary)]}>{new Date(run.createdAt).toLocaleString(i18n.language)}</Text>
          {run.resultText ? <Text modifiers={[textSelection(true)]}>{run.resultText}</Text> : null}{run.error ? <Text modifiers={[foregroundStyle(colors.statusError), textSelection(true)]}>{run.error}</Text> : null}
        </VStack>) : <Text modifiers={[foregroundStyle(colors.textSecondary)]}>{tr('noRuns')}</Text>}</Section>
        {getRoutineActionId(p.resource, 'routine-delete') ? <Section><Action label={tr('delete')} onPress={p.onDelete} blocked={p.busy || p.loading || p.dirty || !p.online} destructive /></Section> : null}
      </> : null}
    </> : null}
  </ComposerSheet>;
}
