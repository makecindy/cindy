import type { SessionActionStripAction } from "./sessionOverview";

export interface SessionHeaderNativeBackProps {
  label: string;
  onPress(): void;
}

export interface SessionHeaderNativeTitleProps {
  onTagsPress?: () => void;
  tags?: import('@cindy/maker-shared').TaskTag[];
  title: string;
  pinned: boolean;
  syncing: boolean;
  syncingImmediately: boolean;
  notice: string | null;
}

export function SessionHeaderNativeTitle(_props: SessionHeaderNativeTitleProps) {
  return null;
}

export function SessionHeaderNativeBlur(_props: { height: number; edge?: 'top' | 'bottom'; inset?: number }) {
  return null;
}

export interface SessionHeaderNativeActionsProps {
  available: boolean;
  desktopLabel: string;
  filesLabel: string;
  moreLabel: string;
  files: SessionActionStripAction | undefined;
  onDetails(): void;
  onDesktop(): void;
  onAction(id: SessionActionStripAction["id"]): void;
}

// Only rendered by the iOS branch; keep SwiftUI imports out of Android/web bundles.
export function SessionHeaderNativeBack(_props: SessionHeaderNativeBackProps) {
  return null;
}
export function SessionHeaderNativeActions(
  _props: SessionHeaderNativeActionsProps,
) {
  return null;
}
