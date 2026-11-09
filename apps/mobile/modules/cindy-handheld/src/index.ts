import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

export type HandheldVoiceKeyPhase = 'start' | 'end' | 'cancel' | 'tap';

export type HandheldDisplay = {
  id: number;
  name: string;
  width: number;
  height: number;
  density: number;
  isDefault: boolean;
  isCurrent: boolean;
  isPresentation: boolean;
};

export type HandheldNativeConfig = {
  enabled: boolean;
  voiceKeyCode: number;
  holdMs?: number;
  focusColor?: string;
};

type CindyHandheldNative = {
  available?: boolean;
  configure(config: HandheldNativeConfig): Promise<void>;
  setCapturing(value: boolean): Promise<void>;
  getDisplays(): HandheldDisplay[];
  getCurrentDisplayId(): Promise<number>;
  moveToDisplay(displayId: number): Promise<boolean>;
  getGamepads(): string[];
  addListener(event: 'onVoiceKey', listener: (event: { phase: HandheldVoiceKeyPhase }) => void): EventSubscription;
  addListener(event: 'onKeyCaptured', listener: (event: { keyCode: number; name: string }) => void): EventSubscription;
};

/** Android-only; older binaries and other platforms get null and hide handheld mode. */
export const cindyHandheld = requireOptionalNativeModule<CindyHandheldNative>('CindyHandheld');
