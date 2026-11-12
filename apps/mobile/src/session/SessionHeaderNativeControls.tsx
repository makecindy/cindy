import type { SessionActionStripAction } from "./sessionOverview";

export interface SessionHeaderNativeBackProps {
  label: string;
  onPress(): void;
}

export interface SessionHeaderNativeTitleProps {
  onTagsPress?: () => void;
  /** 双击标题:直接打开重命名;不可重命名时不传。 */
  onTitleDoubleTap?: () => void;
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

export function SessionHeaderNativeBlur(_props: { height: number; edge?: 'top' | 'bottom'; inset?: number; fadeInside?: number }) {
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
  /** 只保留「更多」(协同 Worker 任务不提供远程桌面 / 文件入口)。 */
  detailsOnly?: boolean;
  /**
   * 第二个位置:电脑侧边栏里第一个手机能打开的入口(如本任务的模拟器)。缺省时为文件,
   * 文件此时仍在「更多」的「打开」分区里。
   */
  screen?: { label: string; onPress(): void };
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
