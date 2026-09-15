import type { ReactNode } from "react";
export interface ComposerSheetProps {
  nativeContent?: boolean;
  visible: boolean;
  onClose(): void;
  onClosed?(): void;
  title: string;
  onBack?(): void;
  backLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
}
export function ComposerSheet(_props: ComposerSheetProps) {
  return null;
}
