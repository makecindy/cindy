import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountVaultKey } from '@cindy/auth-client';
import { buildSpeakerEnrollment, SPEAKER_MODEL_ASSETS, SpeakerGate, speakerModelAsset, speakerModelLocalName } from '@cindy/voice-input-core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { loadSpeakerModels, nativeSpeakerOnnxRunner } from '../../modules/cindy-speaker-onnx/src';

vi.mock('@cindy/voice-input-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/voice-input-core')>();
  return { ...actual, buildSpeakerEnrollment: vi.fn(actual.buildSpeakerEnrollment) };
});

const asyncStore = new Map<string, string>();
const secureStore = new Map<string, string>();
const files = new Map<string, number>();
const sha = { value: '' };

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => asyncStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      asyncStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      asyncStore.delete(key);
    }),
  },
}));
vi.mock('@/auth/secureStorage', () => ({
  getSecureItem: vi.fn(async (key: string) => secureStore.get(key) ?? null),
  setSecureItem: vi.fn(async (key: string, value: string) => {
    secureStore.set(key, value);
  }),
  deleteSecureItem: vi.fn(async (key: string) => {
    secureStore.delete(key);
  }),
}));
vi.mock('@/config/env', () => ({ ENDPOINT_MANIFEST_BASE_URL: 'https://cdn.example.com' }));
vi.mock('@/session/mobileVoiceDiagnostics', () => ({ logMobileVoice: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: vi.fn(async (path: string) =>
    files.has(path) ? { exists: true, isDirectory: false, size: files.get(path) } : { exists: false }),
  makeDirectoryAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => [...files.keys()].map((path) => path.slice('file:///cache/voice-models/'.length))),
  deleteAsync: vi.fn(async (path: string) => {
    files.delete(path);
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    files.set(to, files.get(from) ?? 0);
    files.delete(from);
  }),
  createDownloadResumable: vi.fn((url: string, target: string) => ({
    downloadAsync: async () => {
      const asset = SPEAKER_MODEL_ASSETS.find((candidate) => url.includes(candidate.sha256))!;
      files.set(target, asset.bytes);
      return { status: 200, uri: target };
    },
    cancelAsync: async () => undefined,
  })),
}));
vi.mock('../../modules/cindy-speaker-onnx/src', () => ({
  isSpeakerOnnxAvailable: () => true,
  loadSpeakerModels: vi.fn(async () => undefined),
  sha256File: vi.fn(async (path: string) => {
    if (sha.value) return sha.value;
    return SPEAKER_MODEL_ASSETS.find((asset) => path.includes(speakerModelLocalName(asset)))!.sha256;
  }),
  nativeSpeakerOnnxRunner: { run: vi.fn() },
}));

const { setMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
const service = await import('@/session/mobileSpeakerFilter');

function installModels(): void {
  for (const asset of SPEAKER_MODEL_ASSETS) {
    files.set(`file:///cache/voice-models/${speakerModelLocalName(asset)}`, asset.bytes);
  }
}

function storeProfile(accountKey: string, modelSha256 = speakerModelAsset('embedding').sha256): void {
  const bytes = new Uint8Array(Float32Array.of(0.6, 0.8).buffer);
  secureStore.set(
    service.__testing.profileKey(accountKey),
    JSON.stringify({ version: 1, embedding: btoa(String.fromCharCode(...bytes)), createdAt: 42, modelSha256 }),
  );
}

async function signIn(id: string): Promise<string> {
  setMobileAuthOwner(id, 'global');
  await service.hydrateMobileSpeakerFilter();
  const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
  return getMobileAuthOwner().accountKey;
}

beforeEach(() => {
  vi.clearAllMocks();
  service.__testing.reset();
  asyncStore.clear();
  secureStore.clear();
  files.clear();
  sha.value = '';
  setMobileAuthOwner(null);
});

describe('mobile speaker filter', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['load', 'run'] as const)('bounds stalled native %s during enrollment', async (operation) => {
    installModels();
    await signIn('user-a');
    if (operation === 'load') vi.mocked(loadSpeakerModels).mockImplementationOnce(() => new Promise(() => {}));
    else vi.mocked(nativeSpeakerOnnxRunner.run).mockImplementationOnce(() => new Promise(() => {}));
    vi.useFakeTimers();
    const pending = service.enrollMobileSpeaker([new ArrayBuffer(32_000)]);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
    expect(setSecureItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the saved preference when local storage rejects a change', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(service.setMobileSpeakerFilterEnabled(true)).rejects.toThrow('disk full');
    expect(service.getMobileSpeakerFilterSnapshot().enabled).toBe(false);
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
    await expect(service.setMobileSpeakerFilterStrictness('strict')).rejects.toThrow('disk full');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ strictness: 'standard', strictnessCustomized: false });
  });

  it.each(['enabled', 'strictness', 'mixed'] as const)('restores committed preferences after overlapping %s writes fail', async (kind) => {
    installModels();
    const key = await signIn('user-a');
    await service.setMobileSpeakerFilterStrictness('relaxed');
    const saved = asyncStore.get(service.__testing.prefsKey(key));
    let rejectFirst!: (error: Error) => void;
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockRejectedValueOnce(new Error('second write failed'));
    const first = kind === 'strictness'
      ? service.setMobileSpeakerFilterStrictness('strict')
      : service.setMobileSpeakerFilterEnabled(true);
    const firstFailure = expect(first).rejects.toThrow('first write failed');
    await vi.waitFor(() => expect(rejectFirst).toBeTypeOf('function'));
    const second = kind === 'enabled'
      ? service.setMobileSpeakerFilterEnabled(false)
      : service.setMobileSpeakerFilterStrictness(null);
    const secondFailure = expect(second).rejects.toThrow('second write failed');
    await vi.waitFor(() => expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject(
      kind === 'enabled' ? { enabled: false } : { strictnessCustomized: false },
    ));
    rejectFirst(new Error('first write failed'));
    await Promise.all([firstFailure, secondFailure]);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({
      enabled: false, strictness: 'relaxed', strictnessCustomized: true,
    });
    expect(asyncStore.get(service.__testing.prefsKey(key))).toBe(saved);
  });

  it('rolls back to an overlapping successful write when the following write fails', async () => {
    installModels();
    const key = await signIn('user-a');
    let finishFirst!: () => void;
    vi.mocked(AsyncStorage.setItem)
      .mockImplementationOnce(async (name, value) => {
        await new Promise<void>((resolve) => { finishFirst = resolve; });
        asyncStore.set(name, value);
      })
      .mockRejectedValueOnce(new Error('second write failed'));
    const first = service.setMobileSpeakerFilterEnabled(true);
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    const secondFailure = expect(service.setMobileSpeakerFilterStrictness('strict')).rejects.toThrow('second write failed');
    await vi.waitFor(() => expect(service.getMobileSpeakerFilterSnapshot().strictness).toBe('strict'));
    finishFirst();
    await Promise.all([first, secondFailure]);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({
      enabled: true, strictness: 'standard', strictnessCustomized: false,
    });
    expect(JSON.parse(asyncStore.get(service.__testing.prefsKey(key))!)).toEqual({ version: 1, enabled: true });
  });

  it('does not use a late write from the previous account as the new rollback baseline', async () => {
    installModels();
    await signIn('user-a');
    let finishFirst!: () => void;
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (name, value) => {
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      asyncStore.set(name, value);
    });
    const first = service.setMobileSpeakerFilterStrictness('strict');
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    await signIn('user-b');
    await service.setMobileSpeakerFilterStrictness('relaxed');
    finishFirst();
    await first;
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('write failed'));
    await expect(service.setMobileSpeakerFilterEnabled(true)).rejects.toThrow('write failed');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({
      enabled: false, strictness: 'relaxed', strictnessCustomized: true,
    });
  });

  it('redownloads purged cache after a native load failure and can load again', async () => {
    installModels();
    const key = await signIn('user-a');
    storeProfile(key);
    service.__testing.reset();
    await signIn('user-a');
    await service.setMobileSpeakerFilterEnabled(true);
    files.clear();
    vi.mocked(loadSpeakerModels).mockRejectedValueOnce(new Error('model file missing'));
    const states: string[] = [];
    const unsubscribe = service.subscribeMobileSpeakerFilter(() => states.push(service.getMobileSpeakerFilterSnapshot().modelState));
    try {
      service.warmMobileSpeakerFilter();
      await vi.waitFor(() => expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('ready'));
      expect(states).toContain('missing');
      expect(states).toContain('downloading');
      for (const asset of SPEAKER_MODEL_ASSETS) {
        expect(files.get('file:///cache/voice-models/' + speakerModelLocalName(asset))).toBe(asset.bytes);
      }
      service.warmMobileSpeakerFilter();
      await vi.waitFor(() => expect(loadSpeakerModels).toHaveBeenCalledTimes(2));
      expect(await service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
    } finally {
      unsubscribe();
    }
  });

  it('retries a native load error without redownloading intact model files', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(loadSpeakerModels).mockRejectedValueOnce(new Error('native load failed'));
    await expect(service.enrollMobileSpeaker([new ArrayBuffer(32_000)])).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('ready');
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    await service.enrollMobileSpeaker([new ArrayBuffer(32_000)]);
    expect(loadSpeakerModels).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a completed download with a stale cache check', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(loadSpeakerModels).mockRejectedValueOnce(new Error('model file missing'));
    let finishCheck!: (info: FileSystem.FileInfo) => void;
    vi.mocked(FileSystem.getInfoAsync).mockImplementationOnce(() => new Promise((resolve) => { finishCheck = resolve; }));
    const pending = service.enrollMobileSpeaker([new ArrayBuffer(32_000)]);
    await vi.waitFor(() => expect(finishCheck).toBeTypeOf('function'));
    files.clear();
    await service.downloadMobileSpeakerModels();
    expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(2);
    finishCheck({ exists: false, isDirectory: false, uri: 'file:///cache/voice-models/missing' });
    await pending;
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('ready');
  });

  it('loads the new owner even when the previous owner hydration is still pending', async () => {
    let release!: (value: string | null) => void;
    vi.mocked(getSecureItem).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    setMobileAuthOwner('user-a', 'global');
    const old = service.hydrateMobileSpeakerFilter();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setMobileAuthOwner('user-b', 'global');
    const current = service.hydrateMobileSpeakerFilter();
    release(null);
    await Promise.all([old, current]);
    expect(service.getMobileSpeakerFilterSnapshot().hydrated).toBe(true);
    await service.setMobileSpeakerFilterStrictness('strict');
    expect(vi.mocked(AsyncStorage.setItem)).toHaveBeenCalledWith(
      expect.stringContaining('user-b'), expect.stringContaining('strict'),
    );
  });

  it('does not publish an old enrollment into the next account after secure storage completes', async () => {
    installModels();
    await signIn('user-a');
    vi.mocked(buildSpeakerEnrollment).mockResolvedValueOnce({ ok: true, embedding: Float32Array.of(1, 0), selfScore: 1, speechSec: 9 });
    let release!: () => void;
    vi.mocked(setSecureItem).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = service.enrollMobileSpeaker([]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await signIn('user-b');
    release();
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });

  it('keeps sign-out cleanup ordered after an in-flight secure write', async () => {
    installModels();
    const key = await signIn('user-a');
    vi.mocked(buildSpeakerEnrollment).mockResolvedValueOnce({ ok: true, embedding: Float32Array.of(1, 0), selfScore: 1, speechSec: 9 });
    let release!: () => void;
    vi.mocked(setSecureItem).mockImplementationOnce(async (name, value) => {
      await new Promise<void>((resolve) => { release = resolve; });
      secureStore.set(name, value);
    });
    const pending = service.enrollMobileSpeaker([]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setMobileAuthOwner(null);
    const { clearMobileSpeakerFilterForAccount } = await import('@/session/mobileSpeakerFilterStorage');
    const cleanup = clearMobileSpeakerFilterForAccount(key);
    await Promise.resolve();
    release();
    await Promise.all([pending, cleanup]);
    expect(secureStore.has(service.__testing.profileKey(key))).toBe(false);
  });

  it('honors cancellation before the first download task is created', async () => {
    await signIn('user-a');
    const download = service.downloadMobileSpeakerModels();
    service.cancelMobileSpeakerModelDownload();
    await download;
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('missing');
  });

  it('defaults to off and builds no gate', async () => {
    await signIn('user-a');
    const state = service.getMobileSpeakerFilterSnapshot();
    expect(state).toMatchObject({ hydrated: true, enabled: false, strictness: 'standard', enrolled: false });
    expect(await service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('builds a gate only when on, enrolled and the models are on disk', async () => {
    installModels();
    setMobileAuthOwner('user-a', 'global');
    const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
    storeProfile(getMobileAuthOwner().accountKey);
    await service.hydrateMobileSpeakerFilter();
    expect(await service.createMobileSpeakerGate()).toBeUndefined();

    await service.setMobileSpeakerFilterEnabled(true);
    expect(await service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
  });

  it.each(['cold start', 'account switch'] as const)('waits for saved state on the first recording after %s', async scenario => {
    installModels();
    if (scenario === 'account switch') await signIn('user-b');
    const key = accountVaultKey('global', 'user-a');
    storeProfile(key);
    asyncStore.set(service.__testing.prefsKey(key), JSON.stringify({ version: 1, enabled: true }));
    const read = vi.mocked(getSecureItem).getMockImplementation()!;
    let release!: () => void;
    vi.mocked(getSecureItem).mockImplementationOnce(async name => {
      await new Promise<void>(resolve => { release = resolve; });
      return read(name);
    });
    setMobileAuthOwner('user-a', 'global');
    const gate = service.createMobileSpeakerGate();
    let completed = false;
    void gate.then(() => { completed = true; });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(completed).toBe(false);
    expect(service.getMobileSpeakerFilterSnapshot().enabled).toBe(false);
    release();
    expect(await gate).toBeInstanceOf(SpeakerGate);
    expect(loadSpeakerModels).not.toHaveBeenCalled(); // State only; native load stays lazy.
  });

  it.each(['preferences', 'voiceprint'] as const)('retries a transient %s read on the next recording', async source => {
    installModels();
    const key = accountVaultKey('global', 'user-a');
    storeProfile(key);
    const prefsKey = service.__testing.prefsKey(key);
    asyncStore.set(prefsKey, JSON.stringify({ version: 1, enabled: true, strictnessOverride: 'strict' }));
    const storage = vi.mocked(source === 'preferences' ? AsyncStorage.getItem : getSecureItem);
    const read = storage.getMockImplementation()!;
    const failedKey = source === 'preferences' ? prefsKey : service.__testing.profileKey(key);
    storage.mockImplementation(async name => {
      if (name === failedKey) throw new Error('storage temporarily unavailable');
      return read(name);
    });
    try {
      setMobileAuthOwner('user-a', 'global');
      expect(await service.createMobileSpeakerGate()).toBeUndefined();
      expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ hydrated: false, enabled: false, enrolled: false });
    } finally {
      storage.mockImplementation(read);
    }

    // No process reset or account switch: the next recording must read again.
    expect(await service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({
      hydrated: true, enabled: true, enrolled: true, strictness: 'strict', strictnessCustomized: true,
    });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(setSecureItem).not.toHaveBeenCalled();
    expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'strictness'] as const)('rejects changes to %s until saved state can be read', async setting => {
    installModels();
    const key = accountVaultKey('global', 'user-a');
    const prefsKey = service.__testing.prefsKey(key);
    const saved = JSON.stringify({ version: 1, enabled: true, strictnessOverride: 'strict' });
    asyncStore.set(prefsKey, saved);
    const read = vi.mocked(AsyncStorage.getItem).getMockImplementation()!;
    vi.mocked(AsyncStorage.getItem).mockImplementation(async name => {
      if (name === prefsKey) throw new Error('storage temporarily unavailable');
      return read(name);
    });
    const edit = () => setting === 'enabled'
      ? service.setMobileSpeakerFilterEnabled(false)
      : service.setMobileSpeakerFilterStrictness('relaxed');
    try {
      setMobileAuthOwner('user-a', 'global');
      await expect(edit()).rejects.toThrow();
      expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ hydrated: false, enabled: false, strictnessCustomized: false });
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      expect(asyncStore.get(prefsKey)).toBe(saved);
    } finally {
      vi.mocked(AsyncStorage.getItem).mockImplementation(read);
    }

    await edit();
    expect(JSON.parse(asyncStore.get(prefsKey)!)).toEqual({
      version: 1,
      enabled: setting !== 'enabled',
      strictnessOverride: setting === 'enabled' ? 'strict' : 'relaxed',
    });
  });

  it.each(['{', 'null'])('uses defaults for unreadable JSON (%s) without retrying storage', async raw => {
    const key = accountVaultKey('global', 'user-a');
    asyncStore.set(service.__testing.prefsKey(key), raw);
    secureStore.set(service.__testing.profileKey(key), raw);
    await signIn('user-a');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ hydrated: true, enabled: false, enrolled: false });
    vi.mocked(AsyncStorage.getItem).mockClear();
    vi.mocked(getSecureItem).mockClear();
    await service.hydrateMobileSpeakerFilter();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(getSecureItem).not.toHaveBeenCalled();
  });

  it('does not give an old startup the next account\'s gate', async () => {
    installModels();
    for (const key of [accountVaultKey('global', 'user-a'), accountVaultKey('global', 'user-b')]) {
      storeProfile(key);
      asyncStore.set(service.__testing.prefsKey(key), JSON.stringify({ version: 1, enabled: true }));
    }
    let release!: (value: string | null) => void;
    vi.mocked(getSecureItem).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    setMobileAuthOwner('user-a', 'global');
    const oldGate = service.createMobileSpeakerGate();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setMobileAuthOwner('user-b', 'global');
    expect(await service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
    release(secureStore.get(service.__testing.profileKey(accountVaultKey('global', 'user-a')))!);
    expect(await oldGate).toBeUndefined();
  });

  it('bounds a stalled keychain read and uses the recovered state on the next run', async () => {
    installModels();
    const key = accountVaultKey('global', 'user-a');
    storeProfile(key);
    asyncStore.set(service.__testing.prefsKey(key), JSON.stringify({ version: 1, enabled: true }));
    let release!: (value: string | null) => void;
    vi.mocked(getSecureItem).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    setMobileAuthOwner('user-a', 'global');
    vi.useFakeTimers();
    const gate = service.createMobileSpeakerGate();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await gate).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    release(secureStore.get(service.__testing.profileKey(key))!);
    expect(await service.createMobileSpeakerGate()).toBeInstanceOf(SpeakerGate);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a voiceprint made by another model', async () => {
    installModels();
    setMobileAuthOwner('user-a', 'global');
    const { getMobileAuthOwner } = await import('@/auth/authOwnerGeneration');
    storeProfile(getMobileAuthOwner().accountKey, 'f'.repeat(64));
    await service.hydrateMobileSpeakerFilter();
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });

  it('keeps switch, strictness and voiceprint per account', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    service.__testing.reset();
    await signIn('user-a');
    await service.setMobileSpeakerFilterEnabled(true);
    await service.setMobileSpeakerFilterStrictness('strict');
    expect(JSON.parse(asyncStore.get(service.__testing.prefsKey(a))!)).toEqual({
      version: 1,
      enabled: true,
      strictnessOverride: 'strict',
    });

    await signIn('user-b');
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ enabled: false, strictness: 'standard', enrolled: false });
    expect(await service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('restoring the default strictness drops the override', async () => {
    const a = await signIn('user-a');
    await service.setMobileSpeakerFilterStrictness('relaxed');
    await service.setMobileSpeakerFilterStrictness(null);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ strictness: 'standard', strictnessCustomized: false });
    expect(JSON.parse(asyncStore.get(service.__testing.prefsKey(a))!).strictnessOverride).toBeUndefined();
  });

  it('hashes the account into the secure-store key', async () => {
    const key = service.__testing.profileKey('global:membership/with:odd chars');
    expect(key).toMatch(/^xdt\.voiceSpeakerProfile\.v1\.[0-9a-f]{32}$/);
  });

  it('downloads both models on first enable and verifies their hash', async () => {
    await signIn('user-a');
    await service.setMobileSpeakerFilterEnabled(true);
    await service.downloadMobileSpeakerModels();
    expect(service.getMobileSpeakerFilterSnapshot().modelState).toBe('ready');
    for (const asset of SPEAKER_MODEL_ASSETS) {
      expect(files.get(`file:///cache/voice-models/${speakerModelLocalName(asset)}`)).toBe(asset.bytes);
    }
  });

  it('rejects a download whose hash does not match and keeps nothing', async () => {
    await signIn('user-a');
    sha.value = '0'.repeat(64);
    await service.downloadMobileSpeakerModels();
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ modelState: 'failed', downloadError: 'checksum' });
    expect([...files.keys()]).toEqual([]);
  });

  it('sign-out clears that account\'s voiceprint and settings but keeps the models', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    await service.setMobileSpeakerFilterEnabled(true);
    const other = 'global:someone-else';
    storeProfile(other);

    const { clearMobileSpeakerFilterForAccount } = await import('@/session/mobileSpeakerFilterStorage');
    setMobileAuthOwner(null);
    await clearMobileSpeakerFilterForAccount(a);

    expect(secureStore.has(service.__testing.profileKey(a))).toBe(false);
    expect(asyncStore.has(service.__testing.prefsKey(a))).toBe(false);
    expect(secureStore.has(service.__testing.profileKey(other))).toBe(true);
    expect(files.size).toBe(SPEAKER_MODEL_ASSETS.length);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ enabled: false, enrolled: false });
    expect(await service.createMobileSpeakerGate()).toBeUndefined();
  });

  it('does not restore a logged-out voiceprint on sign-in until cleanup succeeds', async () => {
    installModels();
    const key = await signIn('user-a');
    storeProfile(key);
    await service.setMobileSpeakerFilterEnabled(true);
    setMobileAuthOwner(null);
    const { clearMobileSpeakerFilterForAccount } = await import('@/session/mobileSpeakerFilterStorage');
    vi.mocked(deleteSecureItem)
      .mockRejectedValueOnce(new Error('keychain unavailable'))
      .mockRejectedValueOnce(new Error('keychain still unavailable'));
    await expect(clearMobileSpeakerFilterForAccount(key)).rejects.toThrow('cleanup pending');
    await signIn('user-a');
    expect(secureStore.has(service.__testing.profileKey(key))).toBe(true);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ hydrated: false, enabled: false, enrolled: false });
    await service.hydrateMobileSpeakerFilter();
    expect(secureStore.has(service.__testing.profileKey(key))).toBe(false);
    expect(service.getMobileSpeakerFilterSnapshot()).toMatchObject({ hydrated: true, enabled: false, enrolled: false });
  });

  it('deletes the voiceprint', async () => {
    installModels();
    const a = await signIn('user-a');
    storeProfile(a);
    service.__testing.reset();
    await signIn('user-a');
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(true);
    await service.deleteMobileSpeakerProfile();
    expect(secureStore.has(service.__testing.profileKey(a))).toBe(false);
    expect(service.getMobileSpeakerFilterSnapshot().enrolled).toBe(false);
  });
});
