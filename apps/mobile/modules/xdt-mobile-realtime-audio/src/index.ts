import {
  requireNativeModule,
  type EventSubscription,
} from 'expo-modules-core';

export type XdtMobileAudioChunkEvent = {
  base64Pcm16: string;
  capturedAt: number;
  chunkIndex: number;
  sampleRate: number;
  durationMs: number;
};

export type XdtMobileAudioErrorEvent = {
  message: string;
};

export type XdtMobileRealtimeAudioModule = {
  start(options?: { sampleRate?: number; bufferSize?: number }): Promise<{
    inputPortTypes: string[];
    inputSampleRate: number;
    inputChannels: number;
  } | void>;
  stop(): Promise<void>;
  prewarm(): Promise<void>;
};

type XdtMobileRealtimeAudioEvents = {
  onAudioChunk: (event: XdtMobileAudioChunkEvent) => void;
  onAudioError: (event: XdtMobileAudioErrorEvent) => void;
};

type NativeEventSource<TEvents extends Record<string, (event: never) => void>> = {
  addListener<EventName extends keyof TEvents>(
    eventName: EventName,
    listener: TEvents[EventName],
  ): EventSubscription;
};

type XdtMobileRealtimeAudioNativeModule =
  & XdtMobileRealtimeAudioModule
  & NativeEventSource<XdtMobileRealtimeAudioEvents>;

const nativeModule = requireNativeModule<XdtMobileRealtimeAudioNativeModule>('XdtMobileRealtimeAudio');

export function addAudioChunkListener(listener: (event: XdtMobileAudioChunkEvent) => void) {
  return nativeModule.addListener('onAudioChunk', listener);
}

export function addAudioErrorListener(listener: (event: XdtMobileAudioErrorEvent) => void) {
  return nativeModule.addListener('onAudioError', listener);
}

export async function startRealtimeAudio(options?: { sampleRate?: number; bufferSize?: number }): Promise<void> {
  await nativeModule.start(options);
}

export async function stopRealtimeAudio(): Promise<void> {
  await nativeModule.stop();
}

export async function prewarmRealtimeAudio(): Promise<void> {
  await nativeModule.prewarm();
}
