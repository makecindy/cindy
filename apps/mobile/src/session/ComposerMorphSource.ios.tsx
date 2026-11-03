import { requireNativeView, requireOptionalNativeModule } from 'expo';
import { useCallback, useRef, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type { ComposerMorphOrigin } from './composerGeometry';
import { rememberComposerGeometry } from './composerMorph';

type NativeProps = {
  actionDisabled: boolean; style?: StyleProp<ViewStyle>; children?: ReactNode;
  onAction(event: { nativeEvent: { origin?: ComposerMorphOrigin } }): void;
  onGeometry(event: { nativeEvent: ComposerMorphOrigin }): void;
};
const NativeSource = requireOptionalNativeModule('CindyComposerMorph')
  ? requireNativeView<NativeProps>('CindyComposerMorph', 'CindyComposerMorphSource') : null;

/**
 * Hosts the floating new-task button. Native takes the touch: the circle starts
 * stretching into the composer pill on touch-down, opens on touch-up inside and
 * springs back on a slide-off. `onAction` receives the handoff origin; the
 * button's own onPress stays for VoiceOver activation (no morph).
 */
export function ComposerMorphSource({ disabled, onAction, style, children }: {
  disabled: boolean; onAction(origin?: ComposerMorphOrigin): void; style?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  const action = useRef(onAction); action.current = onAction;
  const handleAction = useCallback((event: { nativeEvent: { origin?: ComposerMorphOrigin } }) => action.current(event.nativeEvent.origin), []);
  const handleGeometry = useCallback((event: { nativeEvent: ComposerMorphOrigin }) => rememberComposerGeometry(event.nativeEvent), []);
  if (!NativeSource) return <View style={style}>{children}</View>;
  return <NativeSource actionDisabled={disabled} onAction={handleAction} onGeometry={handleGeometry} style={style}>{children}</NativeSource>;
}
