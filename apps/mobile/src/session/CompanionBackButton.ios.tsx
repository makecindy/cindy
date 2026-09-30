import { NativeChromeBackButton } from '@/platform/chrome/NativeChromeBackButton.ios';

/** Same native back control as the task header (system chevron, chrome size). */
export function CompanionBackButton({ label, onPress }: { label: string; onPress(): void }) {
  return <NativeChromeBackButton testID="companion.back" label={label} onPress={onPress} />;
}
