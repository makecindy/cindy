import { View, type ViewProps } from 'react-native';

export interface ComposerFrameProps extends ViewProps {
  expanded: boolean;
  /** An ancestor already owns the surface; retain only the content layout. */
  unframed?: boolean;
  entryTransitionId?: string;
  onEntryTransitionComplete?(): void;
  /** Changes when the compact pill opens; the native frame animates that growth. */
  expandToken?: string;
}

export const nativeComposerFrameAvailable = false;

export function ComposerFrame({ expanded: _expanded, unframed: _unframed, entryTransitionId: _entry, onEntryTransitionComplete: _complete, expandToken: _expand, ...props }: ComposerFrameProps) {
  return <View {...props} />;
}
