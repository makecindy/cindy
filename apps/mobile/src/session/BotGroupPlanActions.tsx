import type { MainWindowAction } from '@/components/MobilePrimitives';
import { CompanionCardActions, CompanionCardButton } from './CompanionCardButton';
import { spacing } from '@/theme';

export function BotGroupPlanActions({ actions, onStacked }: { actions: readonly MainWindowAction[]; onStacked?(): void }) {
  return <CompanionCardActions onStacked={onStacked}
    style={{ marginTop: 0, minHeight: 44, paddingVertical: 3, gap: spacing.xs, maxWidth: '100%', flexWrap: 'nowrap' }}>
    {actions.map(action => <CompanionCardButton key={action.testID ?? action.label}
      label={action.label} primary={action.tone === 'primary'} busy={action.busy}
      disabled={action.disabled || !action.onPress} onPress={() => action.onPress?.()}
      accessibilityLabel={action.accessibilityLabel} testID={action.testID}
      style={{ flex: 0, flexShrink: 1, minWidth: 44, maxWidth: '100%' }} />)}
  </CompanionCardActions>;
}
