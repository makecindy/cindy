export interface ComposerNativeRowProps {
  title: string;
  subtitle?: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
  onOptions?(): void;
  optionsLabel?: string;
  testID?: string;
}
export function ComposerNativeRow(_props: ComposerNativeRowProps) {
  return null;
}
