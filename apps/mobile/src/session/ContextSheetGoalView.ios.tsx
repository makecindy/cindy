import { useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DisclosureGroup, Picker, ProgressView, Text, TextField, useNativeState } from '@expo/ui/swift-ui';
import { accessibilityHint, accessibilityLabel, buttonStyle, contentShape, disabled as disable, font, foregroundStyle, frame, lineLimit, pickerStyle, shapes, tag } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/theme';
import type { MobileGoalLimitsInput } from '@cindy/maker-shared/device-link-contract';
import type { ContextSheetGoalViewProps, ContextSheetGoalCreateForm as GoalCreateForm } from './ContextSheetGoalView';
import { ComposerNativeSection as Section } from './ComposerNativeSection';
import { goalReasonText, goalStatusLabel } from './goalStatusLabel';
export { GOAL_STATUS_LABEL, goalReasonText, goalStatusLabel } from './goalStatusLabel';

export function ContextSheetGoalCreateForm({ busy, disabled = false, disabledHint, error, initial, onSetGoal, testID }: ComponentProps<typeof GoalCreateForm>) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const text = useNativeState(initial?.objective ?? '');
  const [objective, setObjective] = useState(initial?.objective ?? '');
  const [limits, setLimits] = useState<MobileGoalLimitsInput>(initial?.limits ?? { maxTurns: null, budgetTokens: null, noProgressLimit: 3 });
  const [limitsTouched, setLimitsTouched] = useState(initial?.limits != null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const patch = (value: Partial<MobileGoalLimitsInput>) => {
    setLimitsTouched(true);
    setLimits(current => ({ ...current, ...value }));
  };
  const submit = () => {
    const value = text.get().trim();
    if (!value || busy || disabled) return;
    // Untouched limits must defer to the remote machine's actual defaults.
    onSetGoal({ objective: value, ...(limitsTouched ? { limits } : {}) });
  };
  return <>
    <Section title={t('interaction.contextSheet.goalLabel')}>
      <TextField text={text} onTextChange={setObjective} axis="vertical"
        placeholder={t('interaction.contextSheet.goalPlaceholder')}
        testID="contextSheet.goalObjectiveInput"
        modifiers={[lineLimit({ min: 3, max: 6 }), disable(busy), accessibilityLabel(t('interaction.contextSheet.goalObjectiveAccessibility'))]} />
    </Section>
    <Section>
      <DisclosureGroup label={t('interaction.contextSheet.advancedSettings')}
        isExpanded={advancedOpen} onIsExpandedChange={setAdvancedOpen}
        testID="contextSheet.goalAdvancedToggle">
        <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{t('interaction.contextSheet.limitsHint')}</Text>
        <LimitPicker label={t('interaction.contextSheet.maxTurns')} value={limits.maxTurns} presets={[10, 20, 50, 100]} busy={busy} onChange={value => patch({ maxTurns: value })} testID="contextSheet.goalMaxTurnsOptions" />
        <LimitPicker label={t('interaction.contextSheet.tokenBudget')} value={limits.budgetTokens} presets={[500_000, 1_000_000, 2_000_000, 5_000_000]} busy={busy} onChange={value => patch({ budgetTokens: value })} format={formatTokenPreset} testID="contextSheet.goalBudgetOptions" />
        <LimitPicker label={t('interaction.contextSheet.noProgressLimit')} value={limits.noProgressLimit} presets={[2, 3, 5]} busy={busy} onChange={value => patch({ noProgressLimit: value })} testID="contextSheet.goalNoProgressOptions" />
      </DisclosureGroup>
    </Section>
    {error || (disabled && disabledHint) ? <Section><Text modifiers={[foregroundStyle(error ? colors.errorText : colors.textSecondary)]}>{error || disabledHint}</Text></Section> : null}
    <Section>
      <Button onPress={submit} testID="contextSheet.goalStartButton" modifiers={[
        buttonStyle('glassProminent'), frame({ maxWidth: Infinity, minHeight: 44 }),
        disable(busy || disabled || !objective.trim()),
        ...(disabled && disabledHint ? [accessibilityHint(disabledHint)] : []),
        accessibilityLabel(t('interaction.contextSheet.startGoal')),
      ]}>{busy ? <ProgressView /> : <Text>{t('interaction.contextSheet.startGoal')}</Text>}</Button>
    </Section>
  </>;
}

function LimitPicker({ label, value, presets, busy, onChange, format = String, testID }: {
  label: string; value: number | null; presets: number[]; busy: boolean;
  onChange(value: number | null): void; format?: (value: number) => string; testID: string;
}) {
  const { t } = useTranslation();
  const options = value != null && !presets.includes(value) ? [value, ...presets] : presets;
  return <Picker label={label} selection={value ?? 'unlimited'}
    onSelectionChange={(next: number | string) => onChange(typeof next === 'number' ? next : null)}
    modifiers={[pickerStyle('menu'), disable(busy)]} testID={testID}>
    {options.map(option => <Text key={option} modifiers={[tag(option)]}>{format(option)}</Text>)}
    <Text modifiers={[tag('unlimited')]}>{t('interaction.contextSheet.unlimited')}</Text>
  </Picker>;
}

export function ContextSheetGoalView(props: ContextSheetGoalViewProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { goal, busy, error } = props;
  if (!goal) return <ContextSheetGoalCreateForm {...props}
    initial={props.initial ?? (props.initialObjective ? { objective: props.initialObjective } : undefined)} />;
  const reason = goalReasonText(goal.lastReason);
  const turns = `${goal.turnsUsed}${goal.maxTurns !== null ? ` / ${goal.maxTurns}` : ''}`;
  const tokens = `${formatTokens(goal.tokensUsed)}${goal.budgetTokens !== null ? ` / ${formatTokens(goal.budgetTokens)}` : ''}`;
  const action = (label: string, onPress: () => void, testID: string, destructive = false) =>
    <Button onPress={onPress} testID={testID} modifiers={[
      buttonStyle('plain'), disable(busy),
      ...(destructive ? [foregroundStyle(colors.statusRecording)] : []),
    ]}><Text modifiers={[frame({ maxWidth: Infinity, minHeight: 44, alignment: 'leading' }), contentShape(shapes.rectangle())]}>{label}</Text></Button>;
  return <>
    <Section title={goalStatusLabel(goal.status, goal.lastReason)}>
      <Text testID="contextSheet.goalObjectiveText">{goal.objective}</Text>
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.textSecondary)]}>{t('interaction.contextSheet.goalMeta', { turns, tokens })}</Text>
      {reason ? <Text modifiers={[foregroundStyle(colors.textSecondary)]}>{reason}</Text> : null}
    </Section>
    {error ? <Section><Text modifiers={[foregroundStyle(colors.errorText)]}>{error}</Text></Section> : null}
    <Section>
      {goal.status === 'active' ? action(t('interaction.contextSheet.pause'), props.onPauseGoal, 'contextSheet.goalPauseButton') : null}
      {['paused', 'blocked', 'usageLimited'].includes(goal.status) ? action(t('interaction.contextSheet.resume'), props.onResumeGoal, 'contextSheet.goalResumeButton') : null}
      {action(t('interaction.contextSheet.clearGoal'), props.onClearGoal, 'contextSheet.goalClearButton', true)}
    </Section>
  </>;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatTokenPreset(value: number): string {
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}
