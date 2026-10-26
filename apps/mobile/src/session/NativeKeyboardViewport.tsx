import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { Platform, View, type ViewProps } from 'react-native';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{ keyboardViewportAvailable?: boolean; composerViewportAvailable?: boolean }>('XdtIosActionSheet') : null;
export const nativeKeyboardViewportAvailable = native?.keyboardViewportAvailable === true;
export const nativeComposerViewportAvailable = native?.composerViewportAvailable === true;
export type KeyboardViewportTransition = { nativeEvent: { active: boolean; bottom: number } };
export type ViewportInsetChange = { nativeEvent: { bottom: number; offsetY: number; viewportHeight: number; contentHeight: number } };
type Props = ViewProps & {
  enabled: boolean;
  followLatest: boolean;
  composerSurfaceId?: string;
  composerContentPadding?: number;
  onViewportInsetChange?(event: ViewportInsetChange): void;
  onKeyboardTransition(event: KeyboardViewportTransition): void;
};
const NativeViewport = nativeKeyboardViewportAvailable
  ? requireNativeViewManager<Props>('XdtIosActionSheet', 'KeyboardViewport') : null;
const NativeComposer = nativeComposerViewportAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string }>('XdtIosActionSheet', 'ComposerViewportAnchor') : null;

/** The actual dock's frame is the reservation; no JS measurement round trip. */
export function NativeComposerViewportAnchor({ surfaceId, ...props }: ViewProps & { surfaceId: string }) {
  return NativeComposer ? <NativeComposer {...props} surfaceId={surfaceId} /> : <View {...props} />;
}

/** Stable wrapper: changing keyboard ownership must not remount the history. */
export function NativeKeyboardViewport({ enabled, followLatest, composerSurfaceId, composerContentPadding, onViewportInsetChange, onKeyboardTransition, ...props }: Props) {
  return NativeViewport
    ? <NativeViewport {...props} enabled={enabled} followLatest={followLatest} composerSurfaceId={composerSurfaceId} composerContentPadding={composerContentPadding}
        onViewportInsetChange={onViewportInsetChange} onKeyboardTransition={onKeyboardTransition} />
    : <View {...props} />;
}
