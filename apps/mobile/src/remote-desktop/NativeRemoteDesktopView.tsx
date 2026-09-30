import { requireNativeViewManager } from "expo-modules-core";
import { Platform, type ViewProps } from "react-native";
import type { Ref } from "react";
import { remotePresentation } from "../../modules/cindy-remote-presentation/src";

export interface NativeRemoteDesktopHandle {
  receive(message: Record<string, unknown>): Promise<void>;
  sendInput(message: Record<string, unknown>): Promise<boolean>;
}
type Props = ViewProps & {
  inlineVisible: boolean;
  ref?: Ref<NativeRemoteDesktopHandle>;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
};

// An OTA loaded by an older binary must continue using its WebView receiver.
export const NativeRemoteDesktopView =
  Platform.OS === "ios" && remotePresentation?.nativeVideo === true
    ? requireNativeViewManager<Props>("CindyRemotePresentation")
    : null;

export const nativeMediaCommands = new Set([
  "init",
  "stop",
  "videoSettings",
  "iceConfig",
  "answer",
  "ice",
  "fallback",
  "presentation",
  "pipPolicy",
  "restorePresentation",
  "resume",
  "nativeViewport",
]);
