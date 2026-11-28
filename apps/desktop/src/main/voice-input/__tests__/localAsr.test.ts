/**
 * Unit tests for on-device offline ASR (sherpa-onnx):
 * - Auto-detection of SenseVoice, Paraformer, Whisper, Transducer, and nested archive directories
 * - Device-local config persistence and auto-discovery
 * - LocalSherpaAsrProvider offline incremental partial + final stable transcription lifecycle
 *
 * Tier: unit (< 100ms, uses temp dir + injected decode engine, zero network or model download).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsrEvent } from '@cindy/voice-input-core';

import { inspectLocalAsrModelDir, LocalAsrModelStore } from '../local-asr/localAsrModelStore.js';
import { LocalSherpaAsrProvider } from '../local-asr/LocalSherpaAsrProvider.js';
import type { LocalAsrDecodeEngine } from '../local-asr/localAsrEngineHost.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('inspectLocalAsrModelDir', () => {
  it('detects SenseVoice from tokens.txt markers even when folder name is generic', () => {
    const dir = makeTempDir('cindy-asr-sv-');
    fs.writeFileSync(path.join(dir, 'tokens.txt'), '<|zh|> 0\n<|en|> 1\n<|NEUTRAL|> 2\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'fp32');
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), 'int8');

    const spec = inspectLocalAsrModelDir(dir);
    expect(spec).toEqual({
      kind: 'sensevoice',
      modelDir: dir,
      tokens: path.join(dir, 'tokens.txt'),
      model: path.join(dir, 'model.int8.onnx'),
    });
  });

  it('detects Paraformer single-model directories', () => {
    const dir = makeTempDir('cindy-asr-paraformer-');
    fs.writeFileSync(path.join(dir, 'tokens.txt'), '<blank> 0\n你好 1\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'model.int8.onnx'), 'int8');

    const spec = inspectLocalAsrModelDir(dir);
    expect(spec?.kind).toBe('paraformer');
  });

  it('detects Whisper encoder + decoder directories', () => {
    const dir = makeTempDir('cindy-asr-whisper-');
    fs.writeFileSync(path.join(dir, 'tiny-tokens.txt'), 'a 0\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'tiny-encoder.int8.onnx'), 'enc');
    fs.writeFileSync(path.join(dir, 'tiny-decoder.int8.onnx'), 'dec');

    const spec = inspectLocalAsrModelDir(dir);
    expect(spec).toEqual({
      kind: 'whisper',
      modelDir: dir,
      tokens: path.join(dir, 'tiny-tokens.txt'),
      encoder: path.join(dir, 'tiny-encoder.int8.onnx'),
      decoder: path.join(dir, 'tiny-decoder.int8.onnx'),
    });
  });

  it('detects Transducer encoder + decoder + joiner inside a one-level nested archive folder', () => {
    const parent = makeTempDir('cindy-asr-nested-');
    const nested = path.join(parent, 'sherpa-onnx-zipformer');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'tokens.txt'), 'a 0\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'encoder-epoch-99.onnx'), 'enc');
    fs.writeFileSync(path.join(nested, 'decoder-epoch-99.onnx'), 'dec');
    fs.writeFileSync(path.join(nested, 'joiner-epoch-99.onnx'), 'joi');

    const spec = inspectLocalAsrModelDir(parent);
    expect(spec).toEqual({
      kind: 'transducer',
      modelDir: nested,
      tokens: path.join(nested, 'tokens.txt'),
      encoder: path.join(nested, 'encoder-epoch-99.onnx'),
      decoder: path.join(nested, 'decoder-epoch-99.onnx'),
      joiner: path.join(nested, 'joiner-epoch-99.onnx'),
    });
  });

  it('returns null for directories missing tokens.txt or onnx weights', () => {
    const dir = makeTempDir('cindy-asr-invalid-');
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a model');
    expect(inspectLocalAsrModelDir(dir)).toBeNull();
  });
});

describe('LocalAsrModelStore', () => {
  it('persists configured directory and falls back to auto-discovery after clear', () => {
    const userData = makeTempDir('cindy-asr-ud-');
    const customDir = makeTempDir('cindy-asr-custom-');
    fs.writeFileSync(path.join(customDir, 'tokens.txt'), '<|zh|> 0\n', 'utf8');
    fs.writeFileSync(path.join(customDir, 'model.int8.onnx'), 'sv');

    const store = new LocalAsrModelStore(() => userData);
    expect(store.resolveModel().spec).toBeNull();

    store.saveConfiguredDir(customDir);
    expect(store.resolveModel()).toMatchObject({
      configuredDir: customDir,
      invalidConfiguredDir: false,
      spec: { kind: 'sensevoice', modelDir: customDir },
    });

    store.clearConfiguredDir();
    expect(store.resolveModel().configuredDir).toBeNull();
  });
});

describe('LocalSherpaAsrProvider', () => {
  it('bounds preview decoding and reports the recording limit instead of returning truncated speech', async () => {
    vi.useFakeTimers();
    try {
      const transcribe = vi.fn(async () => 'preview');
      const provider = new LocalSherpaAsrProvider({
        engine: { warm: vi.fn(async () => undefined), transcribe },
        sampleRate: 10,
        minPartialAudioMs: 0,
        partialIntervalMs: 700,
      });
      const events: AsrEvent[] = [];
      provider.onEvent((event) => events.push(event));
      await provider.start();
      provider.appendAudio(new Int16Array(90).buffer);
      await vi.advanceTimersByTimeAsync(700);
      expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ length: 80 }), 10, undefined);

      provider.appendAudio(new Int16Array(1_710).buffer);
      provider.appendAudio(new Int16Array(1).buffer);
      expect(events.some((event) => event.type === 'error')).toBe(true);
      await provider.flushAudio();
      expect(events.some((event) => event.type === 'stable')).toBe(false);
      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('warms offline engine on start and emits stable transcript on flushAudio without cloud credentials', async () => {
    const warm = vi.fn(async () => undefined);
    const transcribe = vi.fn(async (samples: Float32Array) => (samples.length > 0 ? '离线语音测试' : ''));
    const engine: LocalAsrDecodeEngine = { warm, transcribe };
    const provider = new LocalSherpaAsrProvider({
      engine,
      language: 'zh',
      partialIntervalMs: 0,
    });
    const events: AsrEvent[] = [];
    provider.onEvent((event) => events.push(event));

    await provider.start();
    expect(warm).toHaveBeenCalledWith('zh');
    expect(events[0]?.type).toBe('connected');

    // Feed 100ms of 16kHz PCM16 audio (3200 bytes)
    const pcm = new Int16Array(1600);
    pcm.fill(1000);
    provider.appendAudio(pcm.buffer);

    await provider.flushAudio();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'stable')).toMatchObject({
      type: 'stable',
      text: '离线语音测试',
    });

    await provider.stop();
    expect(events[events.length - 1]?.type).toBe('disconnected');
  });
});
