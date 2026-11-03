import { requireOptionalNativeModule } from "expo-modules-core";
export const remotePresentation = requireOptionalNativeModule<{
  nativeVideo?: boolean;
  readClipboard?(): Promise<string>;
  writeClipboard?(json: string): Promise<void>;
  clipboardVersion?(): Promise<string>;
  syncClipboard?(json: string, version: string): Promise<string>;
  rotate?(landscape: boolean): Promise<void>;
  playback(enabled: boolean): Promise<void>;
}>("CindyRemotePresentation");
