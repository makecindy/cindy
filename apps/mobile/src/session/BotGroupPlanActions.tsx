import { View } from 'react-native';
import type { MainWindowAction } from '@/components/MobilePrimitives';
import { CompanionCardButton } from './CompanionCardButton';
import { spacing } from '@/theme';

export function BotGroupPlanActions({ actions }: { actions: readonly MainWindowAction[] }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.xs }}>
    {actions.map(action => <CompanionCardButton key={action.testID ?? action.label}
      label={action.label} primary={action.tone === 'primary'} busy={action.busy}
      disabled={action.disabled || !action.onPress} onPress={() => action.onPress?.()}
      accessibilityLabel={action.accessibilityLabel} testID={action.testID}
      style={{ flex: 0, minWidth: 44 }} />)}
  </View>;
}
