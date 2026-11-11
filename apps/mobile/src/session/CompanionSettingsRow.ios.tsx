import { Host } from '@expo/ui';
import { ContextSheetRow } from './ContextSheet';
import type { ContextSheetRowProps } from './ContextSheet';
import { useTheme } from '@/theme';
export function CompanionSettingsRow(props: ContextSheetRowProps) {
  const { mode } = useTheme();
  return <Host colorScheme={mode} matchContents style={{ minHeight: 44 }}><ContextSheetRow {...props} /></Host>;
}
