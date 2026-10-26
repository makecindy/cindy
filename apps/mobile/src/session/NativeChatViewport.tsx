import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { forwardRef, useImperativeHandle, useRef, type ComponentType, type RefAttributes } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration } from '@/theme/tokens';

const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<{ available?: boolean; manualFollowingAvailable?: boolean; composerViewportAvailable?: boolean; keyboardViewportAvailable?: boolean }>('CindyChatViewport') : null;
export const nativeChatViewportAvailable = native?.available === true;
export const nativeChatManualFollowAvailable = native?.manualFollowingAvailable === true;
export const nativeAndroidKeyboardViewportAvailable = native?.keyboardViewportAvailable === true;
export const nativeAndroidComposerViewportAvailable = native?.composerViewportAvailable === true;
export type NativeChatViewportHandle = { moveTo(offset: number, animate: boolean): void; cancelFollowing(): void };
type Props = ViewProps & { active: boolean; followLatest: boolean; autoFollow?: boolean; composerSurfaceId?: string; composerContentPadding?: number;
  onViewportInsetChange?: (event: import('./NativeKeyboardViewport').ViewportInsetChange) => void;
  getObservedInset?: () => number };
type NativeProps = Props & { reduceMotion: boolean; durationMs: number };
type NativeHandle = { moveTo(offset: number, animate: boolean, observedInset: number): void; cancelFollowing(): void };
const NativeViewport = nativeChatViewportAvailable
  ? requireNativeViewManager<NativeProps>('CindyChatViewport') as ComponentType<NativeProps & RefAttributes<NativeHandle>> : null;

/** Older installations keep their existing JS scroll ownership until a native update. */
export const NativeChatViewport = forwardRef<NativeChatViewportHandle, Props>(function NativeChatViewport({ active, followLatest, autoFollow = true, getObservedInset, ...props }, ref) {
  const reduced = useReduceMotionEnabled();
  const nativeRef = useRef<NativeHandle | null>(null);
  useImperativeHandle(ref, () => ({
    moveTo: (offset, animate) => { nativeRef.current?.moveTo(offset, animate, getObservedInset?.() ?? 0); },
    cancelFollowing: () => { nativeRef.current?.cancelFollowing(); },
  }), [getObservedInset]);
  return NativeViewport && (autoFollow || nativeChatManualFollowAvailable)
    ? <NativeViewport {...props} ref={nativeRef} active={active} followLatest={followLatest} autoFollow={autoFollow}
        reduceMotion={reduced !== false} durationMs={motionDuration.base} />
    : <View {...props} />;
});

const AndroidComposer = nativeAndroidComposerViewportAvailable
  ? requireNativeViewManager<ViewProps & { surfaceId: string; followKeyboard?: boolean }>('CindyChatViewport', 'ComposerAnchor') : null;
export function NativeAndroidComposerAnchor(props: ViewProps & { surfaceId: string; followKeyboard?: boolean }) {
  return AndroidComposer ? <AndroidComposer {...props} /> : <View {...props} />;
}
