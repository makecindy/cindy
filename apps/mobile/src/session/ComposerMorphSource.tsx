import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { ComposerMorphOrigin } from './composerGeometry';

/** Non-iOS: no native morph; the button's own onPress opens the page. */
export function ComposerMorphSource({ style, children }: {
  disabled: boolean; onAction(origin?: ComposerMorphOrigin): void; style?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  return <View style={style}>{children}</View>;
}
