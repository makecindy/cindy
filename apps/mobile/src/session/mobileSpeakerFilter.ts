import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import {
  buildSpeakerEnrollment,
  createOnnxSpeakerEnrollmentEngine,
  createOnnxSpeakerGateEngine,
  DEFAULT_SPEAKER_GATE_STRICTNESS,
  isSpeakerGateStrictness,
  pcm16ToFloat,
  SPEAKER_GATE_SAMPLE_RATE,
  SPEAKER_GATE_STRICTNESS_THRESHOLDS,
  SPEAKER_MODEL_ASSETS,
  SPEAKER_MODEL_TOTAL_BYTES,
  SpeakerGate,
  speakerModelAsset,
  speakerModelCdnPath,
  speakerModelLocalName,
  type SpeakerEnrollmentFailure,
  type SpeakerGateStrictness,
  type SpeakerModelAsset,
  type SpeakerOnnxRunner,
} from '@cindy/voice-input-core';

import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { deleteSecureItem, getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { ENDPOINT_MANIFEST_BASE_URL } from '@/config/env';
import {
  isSpeakerOnnxAvailable,
  loadSpeakerModels,
  nativeSpeakerOnnxRunner,
  sha256File,
} from '../../modules/cindy-speaker-onnx/src';
import { serializeSpeakerFilterStorage, speakerFilterPrefsKey as prefsKey, speakerProfileKey as profileKey } from './mobileSpeakerFilterStorage';
import { logMobileVoice } from './mobileVoiceDiagnostics';

/*
 * "Recognize my voice" on mobile. Same models, thresholds and gate as desktop;
 * inference runs through ONNX Runtime in the cindy-speaker-onnx module.
 *
 * Audio forwarding waits for saved preferences and the voiceprint before
 * choosing its gate; microphone capture may buffer locally meanwhile.
 * Model loading stays lazy; failures still pass through.
 *
 * The voiceprint is biometric data: it stays on this device, in the OS
 * keychain/keystore through SecureStore, one per account, and is never
 * synced, uploaded or logged.
 */

export type MobileSpeakerModelState = 'missing' | 'downloading' | 'ready' | 'failed';

export type MobileSpeakerFilterSnapshot = {
  /** False on binaries built before the native module existed. */
  supported: boolean;
  hydrated: boolean;
  enabled: boolean;
  strictness: SpeakerGateStrictness;
  strictnessCustomized: boolean;
  modelState: MobileSpeakerModelState;
  downloadedBytes: number;
  totalBytes: number;
  downloadError?: 'network' | 'disk' | 'checksum' | 'unavailable';
  enrolled: boolean;
  enrolledAt?: number;
};

export type MobileSpeakerEnrollResult =
  | { ok: true }
  | { ok: false; reason: SpeakerEnrollmentFailure | 'models_missing' | 'storage_unavailable' | 'failed'; clipIndex?: number };

type StoredPrefs = { version: 1; enabled: boolean; strictnessOverride?: SpeakerGateStrictness };
type StoredProfile = { version: 1; embedding: string; createdAt: number; modelSha256: string };
type Profile = { embedding: Float32Array; createdAt: number };

const MAX_EMBEDDING_DIM = 4096;
const DOWNLOAD_STALL_MS = 60_000;
const HYDRATION_START_TIMEOUT_MS = 1_500;

let snapshot: MobileSpeakerFilterSnapshot = initialSnapshot();
let profile: Profile | null = null;
let hydratedFor: string | null = null;
let hydrating: Promise<void> | null = null;
let hydrationOwner: MobileAuthOwnerGeneration | null = null;
let profileRevision = 0;
let prefsRevision = 0;
let savedPrefs: StoredPrefs = { version: 1, enabled: false };
let downloading: Promise<void> | null = null;
let downloadRevision = 0;
let downloadAbort: AbortController | null = null;
let modelsLoaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
let ownerSubscription: (() => void) | null = null;

function initialSnapshot(): MobileSpeakerFilterSnapshot {
  return {
    supported: isSpeakerOnnxAvailable(),
    hydrated: false,
    enabled: false,
    strictness: DEFAULT_SPEAKER_GATE_STRICTNESS,
    strictnessCustomized: false,
    modelState: 'missing',
    downloadedBytes: 0,
    totalBytes: SPEAKER_MODEL_TOTAL_BYTES,
    enrolled: false,
  };
}

function update(patch: Partial<MobileSpeakerFilterSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getMobileSpeakerFilterSnapshot(): MobileSpeakerFilterSnapshot {
  return snapshot;
}

export function subscribeMobileSpeakerFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function modelsDir(): string | null {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}voice-models/` : null;
}

function modelPath(asset: SpeakerModelAsset): string | null {
  const dir = modelsDir();
  return dir ? `${dir}${speakerModelLocalName(asset)}` : null;
}

/**
 * Loads this account's switch, voiceprint and model presence into memory.
 * Safe to call often; follows account switches by itself.
 */
export function hydrateMobileSpeakerFilter(): Promise<void> {
  ownerSubscription ??= subscribeMobileAuthOwner(() => {
    void hydrateMobileSpeakerFilter();
  });
  const owner = getMobileAuthOwner();
  if (!hydrationOwner || !isMobileAuthOwnerCurrent(hydrationOwner)) {
    hydrationOwner = owner;
    hydrating = null;
    profile = null;
    hydratedFor = null;
    savedPrefs = { version: 1, enabled: false };
    profileRevision += 1;
    snapshot = {
      ...initialSnapshot(),
      modelState: snapshot.modelState,
      downloadedBytes: snapshot.downloadedBytes,
      downloadError: snapshot.downloadError,
    };
    for (const listener of listeners) listener();
  }
  if (!owner.accountKey || owner.switching) {
    return Promise.resolve();
  }
  if (hydratedFor === owner.accountKey && snapshot.hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  const run = (async () => {
    const [[prefs, stored], models] = await Promise.all([
      serializeSpeakerFilterStorage(owner.accountKey, () => Promise.all([readPrefs(owner.accountKey), readProfile(owner.accountKey)])),
      modelsInstalled(),
    ]);
    if (!isMobileAuthOwnerCurrent(owner)) return;
    profile = stored;
    hydratedFor = owner.accountKey;
    savedPrefs = { version: 1, ...prefs };
    update({
      supported: isSpeakerOnnxAvailable(),
      hydrated: true,
      enabled: prefs.enabled,
      strictness: prefs.strictnessOverride ?? DEFAULT_SPEAKER_GATE_STRICTNESS,
      strictnessCustomized: prefs.strictnessOverride !== undefined,
      modelState: downloading ? 'downloading' : models ? 'ready' : snapshot.modelState === 'failed' ? 'failed' : 'missing',
      ...(models ? { downloadedBytes: SPEAKER_MODEL_TOTAL_BYTES } : {}),
      enrolled: Boolean(stored),
      enrolledAt: stored?.createdAt,
    });
  })()
    .catch((error) => {
      logMobileVoice('warn', 'speaker filter hydrate failed', { error: errorMessage(error) });
    })
    .finally(() => {
      if (hydrating === run) hydrating = null;
    });
  hydrating = run;
  return run;
}

async function readPrefs(accountKey: string): Promise<{ enabled: boolean; strictnessOverride?: SpeakerGateStrictness }> {
  // Storage failures must reach hydration so the next call retries. Only a
  // missing or invalid record should count as successfully loaded defaults.
  const raw = await AsyncStorage.getItem(prefsKey(accountKey));
  if (!raw) return { enabled: false };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    return {
      enabled: parsed.enabled === true,
      ...(isSpeakerGateStrictness(parsed.strictnessOverride) ? { strictnessOverride: parsed.strictnessOverride } : {}),
    };
  } catch {
    return { enabled: false };
  }
}

async function writePrefs(): Promise<void> {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey || hydratedFor !== owner.accountKey) return;
  const stored: StoredPrefs = {
    version: 1,
    enabled: snapshot.enabled,
    ...(snapshot.strictnessCustomized ? { strictnessOverride: snapshot.strictness } : {}),
  };
  await serializeSpeakerFilterStorage(owner.accountKey, async () => {
    if (!isMobileAuthOwnerCurrent(owner)) return;
    await AsyncStorage.setItem(prefsKey(owner.accountKey), JSON.stringify(stored));
    if (isMobileAuthOwnerCurrent(owner)) savedPrefs = stored;
  });
}

function restoreSavedPrefs(): void {
  // Overlapping optimistic edits can all fail. Only a completed write is a
  // rollback baseline, including the other setting stored in the same record.
  update({
    enabled: savedPrefs.enabled,
    strictness: savedPrefs.strictnessOverride ?? DEFAULT_SPEAKER_GATE_STRICTNESS,
    strictnessCustomized: savedPrefs.strictnessOverride !== undefined,
  });
}

async function readProfile(accountKey: string): Promise<Profile | null> {
  const raw = await getSecureItem(profileKey(accountKey));
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredProfile>;
    // A voiceprint from another embedding model cannot be compared: re-enroll.
    if (stored.version !== 1 || stored.modelSha256 !== speakerModelAsset('embedding').sha256) return null;
    if (typeof stored.embedding !== 'string') return null;
    const embedding = base64ToFloat32(stored.embedding);
    if (embedding.length === 0 || embedding.length > MAX_EMBEDDING_DIM || !embedding.every(Number.isFinite)) return null;
    return { embedding, createdAt: typeof stored.createdAt === 'number' ? stored.createdAt : 0 };
  } catch {
    return null;
  }
}

export async function setMobileSpeakerFilterEnabled(enabled: boolean): Promise<void> {
  const owner = getMobileAuthOwner();
  await hydrateMobileSpeakerFilter();
  if (!owner.accountKey || !isMobileAuthOwnerCurrent(owner)) return;
  if (hydratedFor !== owner.accountKey) throw new Error('speaker preferences not hydrated');
  const revision = ++prefsRevision;
  update({ enabled });
  try {
    await writePrefs();
  } catch (error) {
    if (isMobileAuthOwnerCurrent(owner) && revision === prefsRevision) restoreSavedPrefs();
    throw error;
  }
  if (!isMobileAuthOwnerCurrent(owner)) return;
  // The models are fetched the first time the user turns the filter on.
  if (snapshot.enabled && (snapshot.modelState === 'missing' || snapshot.modelState === 'failed')) {
    void downloadMobileSpeakerModels();
  }
}

/** `null` restores the version default. */
export async function setMobileSpeakerFilterStrictness(strictness: SpeakerGateStrictness | null): Promise<void> {
  const owner = getMobileAuthOwner();
  await hydrateMobileSpeakerFilter();
  if (!owner.accountKey || !isMobileAuthOwnerCurrent(owner)) return;
  if (hydratedFor !== owner.accountKey) throw new Error('speaker preferences not hydrated');
  const revision = ++prefsRevision;
  update(
    strictness === null
      ? { strictness: DEFAULT_SPEAKER_GATE_STRICTNESS, strictnessCustomized: false }
      : { strictness, strictnessCustomized: true },
  );
  try {
    await writePrefs();
  } catch (error) {
    if (isMobileAuthOwnerCurrent(owner) && revision === prefsRevision) restoreSavedPrefs();
    throw error;
  }
}

async function modelsInstalled(): Promise<boolean> {
  for (const asset of SPEAKER_MODEL_ASSETS) {
    const path = modelPath(asset);
    if (!path) return false;
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists || info.isDirectory || info.size !== asset.bytes) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Starts (or joins) the one-time model download. */
export function downloadMobileSpeakerModels(): Promise<void> {
  if (!snapshot.supported) return Promise.resolve();
  if (downloading) return downloading;
  downloadRevision += 1;
  const controller = new AbortController();
  downloadAbort = controller;
  update({ modelState: 'downloading', downloadedBytes: 0, downloadError: undefined });
  const run = downloadAll(controller.signal)
    .then(() => {
      update({ modelState: 'ready', downloadedBytes: SPEAKER_MODEL_TOTAL_BYTES, downloadError: undefined });
    })
    .catch((error: unknown) => {
      const kind = error instanceof ModelDownloadError ? error.kind : 'network';
      logMobileVoice('warn', 'speaker model download failed', { kind: kind ?? 'cancelled' });
      update({ modelState: kind ? 'failed' : 'missing', downloadedBytes: 0, downloadError: kind ?? undefined });
    })
    .finally(() => {
      if (downloading === run) {
        downloading = null;
        downloadAbort = null;
        downloadRevision += 1;
      }
    });
  downloading = run;
  return run;
}

export function cancelMobileSpeakerModelDownload(): void {
  downloadAbort?.abort();
}

class ModelDownloadError extends Error {
  /** null = cancelled by the user. */
  constructor(readonly kind: MobileSpeakerFilterSnapshot['downloadError'] | null) {
    super(kind ?? 'cancelled');
  }
}

async function downloadAll(signal: AbortSignal): Promise<void> {
  const dir = modelsDir();
  if (!dir || !/^https:\/\//i.test(ENDPOINT_MANIFEST_BASE_URL)) throw new ModelDownloadError('unavailable');
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    throw new ModelDownloadError('disk');
  }
  let completed = 0;
  for (const asset of SPEAKER_MODEL_ASSETS) {
    const target = modelPath(asset)!;
    if (signal.aborted) throw new ModelDownloadError(null);
    const existing = await FileSystem.getInfoAsync(target).catch(() => null);
    if (existing?.exists && !existing.isDirectory && existing.size === asset.bytes) {
      completed += asset.bytes;
      continue;
    }
    await downloadOne(asset, target, signal, (loaded) => {
      update({ downloadedBytes: completed + Math.min(loaded, asset.bytes) });
    });
    completed += asset.bytes;
    logMobileVoice('info', 'speaker model downloaded', { file: asset.fileName, bytes: asset.bytes });
  }
  await removeStaleModels(dir);
}

async function downloadOne(
  asset: SpeakerModelAsset,
  target: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<void> {
  if (signal.aborted) throw new ModelDownloadError(null);
  const partial = `${target}.part`;
  const url = `${ENDPOINT_MANIFEST_BASE_URL}/${speakerModelCdnPath(asset)}`;
  let lastProgressAt = Date.now();
  let lastNotified = 0;
  const task = FileSystem.createDownloadResumable(url, partial, {}, (event) => {
    if (signal.aborted) return;
    lastProgressAt = Date.now();
    if (lastProgressAt - lastNotified >= 250) {
      lastNotified = lastProgressAt;
      onProgress(event.totalBytesWritten);
    }
  });
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  let onAbort: (() => void) | undefined;
  let cancelling: Promise<unknown> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    const stop = (kind: ModelDownloadError['kind']) => {
      cancelling ??= task.cancelAsync().catch(() => undefined);
      reject(new ModelDownloadError(kind));
    };
    onAbort = () => stop(null);
    signal.addEventListener('abort', onAbort, { once: true });
    stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > DOWNLOAD_STALL_MS) stop('network');
    }, 5_000);
  });
  // Only the race observes this; once the download settled it may never fire.
  stopped.catch(() => undefined);
  try {
    const result = await Promise.race([task.downloadAsync(), stopped]);
    if (!result) throw new ModelDownloadError('network');
    if (result.status >= 400 && result.status < 500) throw new ModelDownloadError('unavailable');
    if (result.status !== 200) throw new ModelDownloadError('network');
    const info = await FileSystem.getInfoAsync(partial);
    if (!info.exists || info.size !== asset.bytes) throw new ModelDownloadError('checksum');
    // The file only becomes visible to the gate after its content hash matched.
    if ((await sha256File(partial)) !== asset.sha256) throw new ModelDownloadError('checksum');
    if (signal.aborted) throw new ModelDownloadError(null);
    await FileSystem.deleteAsync(target, { idempotent: true });
    await FileSystem.moveAsync({ from: partial, to: target });
  } catch (error) {
    // Wait for native I/O to stop before deleting its destination or retrying.
    await cancelling;
    await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => undefined);
    if (error instanceof ModelDownloadError) throw error;
    throw new ModelDownloadError(signal.aborted ? null : 'network');
  } finally {
    clearInterval(stallTimer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function removeStaleModels(dir: string): Promise<void> {
  const keep = new Set(SPEAKER_MODEL_ASSETS.map(speakerModelLocalName));
  try {
    for (const name of await FileSystem.readDirectoryAsync(dir)) {
      if (keep.has(name)) continue;
      await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => undefined);
    }
  } catch {
    // Retried on the next download.
  }
}

/** Runner that loads both models on first use and reuses them afterwards. */
const runner: SpeakerOnnxRunner = {
  async run(model, inputs) {
    await ensureModelsLoaded();
    return withInferenceTimeout(nativeSpeakerOnnxRunner.run(model, inputs));
  },
};

/** Enrollment also needs a deadline; the live gate's shorter deadline is not used there. */
async function withInferenceTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('speaker inference timed out')), 15_000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function ensureModelsLoaded(): Promise<void> {
  if (modelsLoaded) return modelsLoaded;
  const vad = modelPath(speakerModelAsset('vad'));
  const embedding = modelPath(speakerModelAsset('embedding'));
  if (!vad || !embedding) return Promise.reject(new Error('speaker models are not installed'));
  const loading = withInferenceTimeout(loadSpeakerModels({ vad, embedding })).catch(async (error: unknown) => {
    if (modelsLoaded === loading) {
      // The OS can purge cache after hydration. Repair on load failure without
      // adding filesystem I/O to every inference call or microphone startup.
      const revision = downloadRevision;
      const installed = await modelsInstalled();
      if (modelsLoaded === loading) {
        modelsLoaded = null;
        if (!installed && !downloading && revision === downloadRevision) {
          update({ modelState: 'missing', downloadedBytes: 0, downloadError: undefined });
          if (snapshot.enabled) void downloadMobileSpeakerModels();
        }
      }
    }
    throw error;
  });
  modelsLoaded = loading;
  return loading;
}

/** Loads the models ahead of the first chunk (call from voice prewarm). */
export function warmMobileSpeakerFilter(): void {
  void hydrateMobileSpeakerFilter().then(() => {
    if (snapshot.enabled && snapshot.enrolled && snapshot.modelState === 'ready') {
      ensureModelsLoaded().catch(() => undefined);
    }
  });
}

/**
 * The gate for one dictation run. Await saved state so the first run after
 * launch/account switch uses the user's setting. Bound storage stalls without
 * waiting for model download or native model loading before opening the mic.
 * `onFiltered` runs each time a stretch of speech is muted, so the screen can
 * tell the user why those words are missing.
 */
export async function createMobileSpeakerGate(onFiltered?: () => void): Promise<SpeakerGate | undefined> {
  const owner = getMobileAuthOwner();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hydrateMobileSpeakerFilter(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('speaker hydration timed out')), HYDRATION_START_TIMEOUT_MS);
      }),
    ]);
  } catch {
    logMobileVoice('warn', 'speaker gate passthrough', { reason: 'hydration_timeout' });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!isMobileAuthOwnerCurrent(owner)) return undefined;
  if (!snapshot.supported || !snapshot.enabled || hydratedFor !== owner.accountKey || !profile) return undefined;
  if (snapshot.modelState !== 'ready') {
    // The OS may have purged the cached models; bring them back for next time.
    if (snapshot.modelState === 'missing') void downloadMobileSpeakerModels();
    return undefined;
  }
  const thresholds = SPEAKER_GATE_STRICTNESS_THRESHOLDS[snapshot.strictness];
  let accepted = 0;
  let rejected = 0;
  return new SpeakerGate({
    engine: createOnnxSpeakerGateEngine(runner),
    enrolledEmbedding: profile.embedding,
    threshold: thresholds.threshold,
    continueThreshold: thresholds.continueThreshold,
    onDecision: (decision) => {
      // Counts and scores only; never audio or the voiceprint.
      if (decision.accepted) accepted += 1;
      else rejected += 1;
      logMobileVoice('debug', 'speaker gate decision', {
        accepted: decision.accepted,
        score: Math.round(decision.score * 100) / 100,
        speechMs: Math.round(((decision.endSample - decision.startSample) / SPEAKER_GATE_SAMPLE_RATE) * 1000),
        computeMs: Math.round(decision.computeMs),
        acceptedSoFar: accepted,
        rejectedSoFar: rejected,
      });
      if (!decision.accepted) onFiltered?.();
    },
    onPassthrough: (reason) => {
      logMobileVoice('warn', 'speaker gate passthrough', { reason });
    },
  });
}

/** Builds and stores this account's voiceprint from PCM16 16 kHz clips. */
export async function enrollMobileSpeaker(clips: ArrayBuffer[]): Promise<MobileSpeakerEnrollResult> {
  const owner = getMobileAuthOwner();
  await hydrateMobileSpeakerFilter();
  if (!isMobileAuthOwnerCurrent(owner)) return { ok: false, reason: 'failed' };
  if (!owner.accountKey) return { ok: false, reason: 'failed' };
  if (snapshot.modelState !== 'ready') return { ok: false, reason: 'models_missing' };
  const revision = ++profileRevision;
  const current = () => isMobileAuthOwnerCurrent(owner) && revision === profileRevision;
  try {
    const result = await buildSpeakerEnrollment(
      createOnnxSpeakerEnrollmentEngine(runner),
      clips.map((clip) => pcm16ToFloat(clip)),
    );
    if (!result.ok) {
      logMobileVoice('info', 'speaker enrollment rejected', {
        reason: result.reason,
        clipIndex: result.clipIndex,
        selfScore: result.selfScore === undefined ? undefined : Math.round(result.selfScore * 100) / 100,
      });
      return { ok: false, reason: result.reason, clipIndex: result.clipIndex };
    }
    if (!current()) return { ok: false, reason: 'failed' };
    const createdAt = Date.now();
    const stored: StoredProfile = {
      version: 1,
      embedding: float32ToBase64(result.embedding),
      createdAt,
      modelSha256: speakerModelAsset('embedding').sha256,
    };
    try {
      await serializeSpeakerFilterStorage(owner.accountKey, async () => {
        if (current()) await setSecureItem(profileKey(owner.accountKey), JSON.stringify(stored));
      });
    } catch {
      return { ok: false, reason: 'storage_unavailable' };
    }
    if (!current()) return { ok: false, reason: 'failed' };
    profile = { embedding: result.embedding, createdAt };
    update({ enrolled: true, enrolledAt: createdAt });
    logMobileVoice('info', 'speaker enrolled', { selfScore: Math.round(result.selfScore * 100) / 100 });
    return { ok: true };
  } catch (error) {
    logMobileVoice('warn', 'speaker enrollment failed', { error: errorMessage(error) });
    return { ok: false, reason: 'failed' };
  }
}

export async function deleteMobileSpeakerProfile(): Promise<void> {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey) return;
  const revision = ++profileRevision;
  await serializeSpeakerFilterStorage(owner.accountKey, () => deleteSecureItem(profileKey(owner.accountKey)));
  if (!isMobileAuthOwnerCurrent(owner)) return;
  if (revision !== profileRevision) return;
  profile = null;
  update({ enrolled: false, enrolledAt: undefined });
  logMobileVoice('info', 'speaker profile deleted');
}

function float32ToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __testing = {
  reset(): void {
    snapshot = initialSnapshot();
    profile = null;
    hydratedFor = null;
    hydrating = null;
    hydrationOwner = null;
    profileRevision = 0;
    prefsRevision = 0;
    savedPrefs = { version: 1, enabled: false };
    downloading = null;
    downloadRevision = 0;
    downloadAbort = null;
    modelsLoaded = null;
    ownerSubscription?.();
    ownerSubscription = null;
    listeners.clear();
  },
  profileKey,
  prefsKey,
};
