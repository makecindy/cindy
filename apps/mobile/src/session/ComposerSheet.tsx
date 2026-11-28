import type { ReactNode } from "react";
export interface ComposerSheetProps {
  nativeContent?: boolean;
  /** Preserve the RN sheet path for content with its own ScrollView. */
  contentScrolls?: boolean;
  /** Use an ungrouped system list instead of the default form. */
  nativeList?: boolean;
  /** Set edit mode on the containing SwiftUI list so its reorder handles appear. */
  nativeEditMode?: boolean;
  /**
   * Open at the large detent only (iOS). For content that must be read to the end before acting: at the medium
   * detent an upward swipe expands the sheet instead of scrolling, so content below the fold reads as unreachable.
   * Default false keeps medium and large.
   */
  largeOnly?: boolean;
  /** Protect an unsaved or in-flight form; explicit Back/Save remains available. */
  preventDismiss?: boolean;
  nativeHeader?: ReactNode;
  /** Keep the native root list mounted while a secondary page is shown. */
  nativeRoot?: { active: boolean; header?: ReactNode; content: ReactNode; initialScrollTargetId?: string };
  visible: boolean;
  onClose(): void;
  onClosed?(): void;
  title: string;
  onBack?(): void;
  /** Dim the back arrow while its action would be ignored (for example a save in flight). */
  backDisabled?: boolean;
  backLabel?: string;
  /** Native action beside the title, opposite the back button. */
  headerTrailing?: ReactNode;
  children: ReactNode;
  aboveContent?: ReactNode;
  aboveContentTitle?: string;
  footer?: ReactNode;
  testID?: string;
  /** iOS `nativeContent` form only: extra modifiers for the scrolled form (for example a scroll-geometry observer). */
  nativeContentModifiers?: unknown[];
  /** iOS `nativeContent` form only: a view over the form's lower edge (for example a text-free fade). */
  nativeContentOverlay?: ReactNode;
}
export function ComposerSheet(_props: ComposerSheetProps) {
  return null;
}
