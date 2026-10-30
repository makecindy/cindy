import type { ReactNode } from "react";

export interface SessionDetailsNativeProps {
  visible: boolean;
  title: string;
  backLabel: string;
  onClose(): void;
  onClosed?: () => void;
  onBack?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  contentPaddingTop?: number;
}

export interface SessionDetailsAction {
  label: string;
  testID: string;
  disabled?: boolean;
  danger?: boolean;
  onPress(): void;
}

export function SessionDetailsNative(_props: SessionDetailsNativeProps) {
  return null;
}
export function SessionDetailsNativeHeading(
  _props: Pick<SessionDetailsNativeProps, 'title' | 'backLabel' | 'onBack'>,
) {
  return null;
}
export function SessionDetailsNativeActions(_props: {
  actions: SessionDetailsAction[];
}) {
  return null;
}
