import { requireOptionalNativeModule } from 'expo-modules-core';

import type { OnnxTensor, SpeakerOnnxRunner } from '@cindy/voice-input-core';

type NativeOutput = { dims: number[]; base64: string };

type NativeSpeakerOnnxModule = {
  loadModels(vadPath: string, embeddingPath: string): Promise<void>;
  unloadModels(): Promise<void>;
  run(model: string, names: string[], dims: number[][], packed: Uint8Array): Promise<Record<string, NativeOutput>>;
  sha256File(path: string): Promise<string>;
};

const native = requireOptionalNativeModule<NativeSpeakerOnnxModule>('CindySpeakerOnnx');

/** False in builds made before this module existed (e.g. an OTA on an old binary). */
export function isSpeakerOnnxAvailable(): boolean {
  return native !== null;
}

function requireNative(): NativeSpeakerOnnxModule {
  if (!native) throw new Error('CindySpeakerOnnx native module is not available in this build');
  return native;
}

export function loadSpeakerModels(paths: { vad: string; embedding: string }): Promise<void> {
  return requireNative().loadModels(stripFileScheme(paths.vad), stripFileScheme(paths.embedding));
}

export function unloadSpeakerModels(): Promise<void> {
  return native ? native.unloadModels() : Promise.resolve();
}

export function sha256File(path: string): Promise<string> {
  return requireNative().sha256File(stripFileScheme(path));
}

/** The shared engine's model runner, backed by ONNX Runtime on the device. */
export const nativeSpeakerOnnxRunner: SpeakerOnnxRunner = {
  async run(model, inputs) {
    const names = Object.keys(inputs);
    const dims = names.map((name) => inputs[name].dims);
    const outputs = await requireNative().run(model, names, dims, packFloat32(names.map((name) => inputs[name].data)));
    const result: Record<string, OnnxTensor> = {};
    for (const [name, output] of Object.entries(outputs)) {
      result[name] = { dims: output.dims, data: base64ToFloat32(output.base64) };
    }
    return result;
  },
};

/** Concatenates float32 arrays as little-endian bytes (all RN targets are little-endian). */
export function packFloat32(arrays: Float32Array[]): Uint8Array {
  const total = arrays.reduce((sum, array) => sum + array.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
  }
  return out;
}

export function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

function stripFileScheme(path: string): string {
  return path.startsWith('file://') ? decodeURIComponent(path.slice('file://'.length)) : path;
}
