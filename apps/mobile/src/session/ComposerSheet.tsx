import type { ReactNode } from "react";
export interface ComposerSheetProps {
  nativeContent?: boolean;
  /** Protect an unsaved or in-flight form; explicit Back/Save remains available. */
  preventDismiss?: boolean;
  nativeHeader?: ReactNode;
  visible: boolean;
  onClose(): void;
  onClosed?(): void;
  title: string;
  onBack?(): void;
  backLabel?: string;
  children: ReactNode;
  aboveContent?: ReactNode;
  aboveContentTitle?: string;
  footer?: ReactNode;
  testID?: string;
}
export function ComposerSheet(_props: ComposerSheetProps) {
  return null;
}
