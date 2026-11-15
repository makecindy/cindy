import type { ReactNode } from "react";
import type { CommonViewModifierProps } from '@expo/ui/swift-ui';
export interface ComposerNativeRowProps extends CommonViewModifierProps {
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
