import type { TaskTagsExpandedState } from './TaskTags';

export interface NativeTagSwatchProps {
  color: string;
  checkColor: string;
  outlined: boolean;
  selected: boolean;
  size: number;
}

/** SwiftUI-only renderers; other platforms keep the React Native tag panel. */
export function NativeTagSwatch(_props: NativeTagSwatchProps) {
  return null;
}

export function NativeTaskTagsExpanded(_props: { state: TaskTagsExpandedState }) {
  return null;
}
