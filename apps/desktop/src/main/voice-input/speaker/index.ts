import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';

import {
  buildSpeakerEnrollment,
  pcm16ToFloat,
  SPEAKER_GATE_SAMPLE_RATE,
  SPEAKER_GATE_STRICTNESS_THRESHOLDS,
  SpeakerGate,
  type SpeakerGateStrictness,
} from '@cindy/voice-input-core';

import { createLogger } from '../../logger.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../../appSessionState.js';
import { getClientEndpoint } from '../../clientEndpointsService.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../../security/trustedAppRenderer.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import {
  VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT,
  VOICE_SPEAKER_ENROLLMENT_MAX_CLIP_SEC,
  VOICE_SPEAKER_FILTER_CHANNELS,
  type VoiceSpeakerEnrollResult,
  type VoiceSpeakerFilterStatus,
} from '../../../shared/voiceSpeakerFilter';
import { SpeakerEngineHost } from './speakerEngineHost.js';
import { SpeakerModelStore } from './speakerModelStore.js';
import { SpeakerProfileStorageUnavailableError, SpeakerProfileStore } from './speakerProfileStore.js';

const log = createLogger('voice-speaker');

/** Platforms sherpa-onnx-node ships a prebuilt addon for and Cindy packages. */
const SUPPORTED_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']);
const PROFILE_FILE_NAME = 'voice-speaker-profile.json';
const MODEL_DIR_NAME = 'voice-models';

export type SpeakerGateSettings = {
  speakerFilterEnabled: boolean;
  speakerFilterStrictness: SpeakerGateStrictness;
};

/**
 * "Recognize my voice" for desktop dictation: downloads the models on demand,
 * keeps this account's voiceprint, and builds the gate for a dictation run.
 * Every failure here leaves dictation working exactly as without the filter.
 */
class SpeakerFilterService {
  readonly supported = SUPPORTED_PLATFORMS.has(`${process.platform}-${process.arch}`);
  private readonly models = new SpeakerModelStore({
    // Models carry no personal data and are shared by every account on this device.
    dir: () => path.join(app.getPath('userData'), MODEL_DIR_NAME),
    cdnBaseUrl: () => {
      try {
        return getClientEndpoint('cdnBaseUrl');
      } catch {
        return '';
      }
    },
    onChange: () => this.broadcastStatus(),
    logger: log,
  });
  private readonly profiles = new SpeakerProfileStore(
    () => ownerScopedUserDataPath(PROFILE_FILE_NAME),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (cipher) => safeStorage.decryptString(cipher),
    },
  );
  private readonly engine = new SpeakerEngineHost(() => this.models.getModelPaths());
  private enrolling = false;
  private profileRevision = 0;

  getStatus(): VoiceSpeakerFilterStatus {
    if (!this.supported) {
      return { supported: false, modelState: 'missing', downloadedBytes: 0, totalBytes: 0, enrolled: false };
    }
    const profile = this.profiles.read();
    return {
      supported: true,
      ...this.models.getState(),
      enrolled: Boolean(profile),
      ...(profile?.createdAt ? { enrolledAt: profile.createdAt } : {}),
    };
  }

  /**
   * The gate for one dictation run, or undefined when the filter is off or
   * not ready. Warms the worker so the first chunk is not held by model load.
   */
  createGate(settings: SpeakerGateSettings): SpeakerGate | undefined {
    if (!settings.speakerFilterEnabled || !this.supported) return undefined;
    if (!this.models.getModelPaths()) return undefined;
    const profile = this.profiles.read();
    if (!profile) return undefined;
    void this.engine.warm().catch((error) => {
      log.warn('speaker engine warm failed', { error: errorMessage(error) });
    });
    const thresholds = SPEAKER_GATE_STRICTNESS_THRESHOLDS[settings.speakerFilterStrictness];
    let accepted = 0;
    let rejected = 0;
    return new SpeakerGate({
      engine: this.engine.createGateEngine(),
      enrolledEmbedding: profile.embedding,
      threshold: thresholds.threshold,
      continueThreshold: thresholds.continueThreshold,
      onDecision: (decision) => {
        // Counts and scores only; never audio or the voiceprint itself.
        if (decision.accepted) accepted += 1;
        else rejected += 1;
        log.debug('speaker gate decision', {
          accepted: decision.accepted,
          score: Math.round(decision.score * 100) / 100,
          speechMs: Math.round(((decision.endSample - decision.startSample) / SPEAKER_GATE_SAMPLE_RATE) * 1000),
          computeMs: Math.round(decision.computeMs),
          acceptedSoFar: accepted,
          rejectedSoFar: rejected,
        });
      },
      onPassthrough: (reason) => {
        log.warn('speaker gate passthrough', { reason });
      },
    });
  }

  downloadModels(): void {
    if (!this.supported) return;
    void this.models.ensureDownloaded().catch(() => {
      // State and a classified error are already recorded and broadcast.
    });
  }

  cancelDownload(): void {
    this.models.cancelDownload();
  }

  async enroll(clips: ArrayBuffer[]): Promise<VoiceSpeakerEnrollResult> {
    if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) return { ok: false, reason: 'failed' };
    if (!this.supported || !this.models.getModelPaths()) return { ok: false, reason: 'models_missing' };
    if (this.enrolling) return { ok: false, reason: 'failed' };
    const owner = activeOwnerScopeKey();
    const revision = ++this.profileRevision;
    this.enrolling = true;
    try {
      const result = await buildSpeakerEnrollment(
        this.engine.createEnrollmentEngine(),
        clips.map((clip) => pcm16ToFloat(clip)),
      );
      if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey() || revision !== this.profileRevision) {
        return { ok: false, reason: 'failed' };
      }
      if (!result.ok) {
        log.info('speaker enrollment rejected', {
          reason: result.reason,
          clipIndex: result.clipIndex,
          speechSec: result.speechSec === undefined ? undefined : Math.round(result.speechSec * 10) / 10,
          selfScore: result.selfScore === undefined ? undefined : Math.round(result.selfScore * 100) / 100,
        });
        return { ok: false, reason: result.reason, clipIndex: result.clipIndex };
      }
      this.profiles.write(result.embedding);
      log.info('speaker enrolled', {
        speechSec: Math.round(result.speechSec * 10) / 10,
        selfScore: Math.round(result.selfScore * 100) / 100,
      });
      const status = this.getStatus();
      this.broadcastStatus(status);
      return { ok: true, status };
    } catch (error) {
      if (error instanceof SpeakerProfileStorageUnavailableError) {
        return { ok: false, reason: 'storage_unavailable' };
      }
      log.warn('speaker enrollment failed', { error: errorMessage(error) });
      return { ok: false, reason: 'failed' };
    } finally {
      this.enrolling = false;
    }
  }

  deleteProfile(): VoiceSpeakerFilterStatus {
    this.profileRevision += 1;
    this.profiles.delete();
    log.info('speaker profile deleted');
    const status = this.getStatus();
    this.broadcastStatus(status);
    return status;
  }

  shutdown(): void {
    this.models.cancelDownload();
    this.engine.shutdown('quit');
  }

  broadcastStatus(status = this.getStatus()): void {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!isTrustedAppRendererWindow(window)) return;
      window.webContents.send(VOICE_SPEAKER_FILTER_CHANNELS.statusChanged, status);
    });
  }
}

let service: SpeakerFilterService | null = null;

export function getSpeakerFilterService(): SpeakerFilterService {
  service ??= new SpeakerFilterService();
  return service;
}

let ipcRegistered = false;

export function registerVoiceSpeakerFilterIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const channels = VOICE_SPEAKER_FILTER_CHANNELS;

  ipcMain.handle(channels.getStatus, (event): VoiceSpeakerFilterStatus => {
    assertTrustedAppRendererEvent(event);
    return getSpeakerFilterService().getStatus();
  });
  ipcMain.handle(channels.downloadModels, (event): VoiceSpeakerFilterStatus => {
    assertTrustedAppRendererEvent(event);
    const speaker = getSpeakerFilterService();
    speaker.downloadModels();
    return speaker.getStatus();
  });
  ipcMain.handle(channels.cancelDownload, (event): VoiceSpeakerFilterStatus => {
    assertTrustedAppRendererEvent(event);
    const speaker = getSpeakerFilterService();
    speaker.cancelDownload();
    return speaker.getStatus();
  });
  ipcMain.handle(channels.enroll, async (event, payload: unknown): Promise<VoiceSpeakerEnrollResult> => {
    assertTrustedAppRendererEvent(event);
    const clips = parseEnrollmentClips(payload);
    if (!clips) return { ok: false, reason: 'failed' };
    return getSpeakerFilterService().enroll(clips);
  });
  ipcMain.handle(channels.deleteProfile, (event): VoiceSpeakerFilterStatus => {
    assertTrustedAppRendererEvent(event);
    try {
      return getSpeakerFilterService().deleteProfile();
    } catch {
      return throwIpcError('INTERNAL', 'Unable to delete voiceprint');
    }
  });

  app.once('before-quit', () => service?.shutdown());
}

const MAX_CLIP_BYTES = VOICE_SPEAKER_ENROLLMENT_MAX_CLIP_SEC * SPEAKER_GATE_SAMPLE_RATE * 2;

/** Exactly the expected number of PCM16 clips, each within the size limit. */
export function parseEnrollmentClips(payload: unknown): ArrayBuffer[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const clips = (payload as { clips?: unknown }).clips;
  if (!Array.isArray(clips) || clips.length !== VOICE_SPEAKER_ENROLLMENT_CLIP_COUNT) return null;
  const out: ArrayBuffer[] = [];
  for (const clip of clips) {
    const bytes = toArrayBuffer(clip);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_CLIP_BYTES || bytes.byteLength % 2 !== 0) {
      return null;
    }
    out.push(bytes);
  }
  return out;
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
