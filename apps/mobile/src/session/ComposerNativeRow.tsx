import type { ReactNode } from "react";
export interface ComposerNativeRowProps {
  leading?: ReactNode;
  accessory?: ReactNode;
  optionsIcon?: ReactNode;
  selectionIcon?: ReactNode;
  title: string;
  titleAccessory?: ReactNode;
  subtitleContent?: ReactNode;
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
