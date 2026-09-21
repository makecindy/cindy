import { View, type ViewProps } from 'react-native';

export interface ComposerFrameProps extends ViewProps {
  expanded: boolean;
  /** An ancestor already owns the surface; retain only the content layout. */
  unframed?: boolean;
}

export const nativeComposerFrameAvailable = false;

export function ComposerFrame({ expanded: _expanded, unframed: _unframed, ...props }: ComposerFrameProps) {
  return <View {...props} />;
}
