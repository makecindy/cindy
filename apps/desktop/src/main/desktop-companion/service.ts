import fs from 'node:fs';
import path from 'node:path';

import {
  DESKTOP_COMPANION_REUSE_MS,
  DESKTOP_COMPANION_TICK_MS,
  type DesktopCompanionReuseItem,
  type DesktopCompanionSettings,
  type DesktopCompanionSnapshot,
  type DesktopCompanionStatus,
} from '../../shared/desktopCompanion.js';

import {
  buildFingerprint,
  characterModeFor,
  memoryKeyFromTopics,
  timeSlotAt,
} from './context.js';
import { buildDesktopCompanionPrompt, buildDesktopCompanionVideoPrompt } from './prompt.js';
import { pruneReusePool, type DesktopCompanionPersistedState } from './store.js';

export interface DesktopCompanionCollectedContext {
  taskTitle: string | null;
  memoryTopics: string[];
  city: string | null;
}

export interface GeneratedMedia {
  buffer: Buffer;
  mimeType: string;
}

export interface DesktopCompanionServiceDeps {
  now: () => number;
  isMac: () => boolean;
  shouldReduceMotion: () => boolean;
  readState: () => DesktopCompanionPersistedState;
  writeState: (state: DesktopCompanionPersistedState) => void;
  applyDir: () => string;
  characterRefPath: () => string | null;
  ownerKey: () => string;
  removeFile: (filePath: string) => void;
  sweepOrphans: (keep: ReadonlySet<string>) => void;
  collectContext: (locationEnabled: boolean) => Promise<DesktopCompanionCollectedContext>;
  peekMedia: () => { image: boolean; video: boolean };
  generateStill: (prompt: string, refPath: string | null) => Promise<GeneratedMedia>;
  generateVideo: (prompt: string, stillPath: string) => Promise<GeneratedMedia>;
  materialize: (media: GeneratedMedia, kind: 'still' | 'video') => string;
  setWallpaper: (stillPath: string) => Promise<void>;
  playVideo: (videoPath: string) => Promise<void>;
  stopVideo: () => Promise<void>;
  toPreviewSrc: (stillPath: string | null) => string | null;
}

export class DesktopCompanionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private status: DesktopCompanionStatus = 'idle';
  private listeners = new Set<(snapshot: DesktopCompanionSnapshot) => void>();

  constructor(private readonly deps: DesktopCompanionServiceDeps) {}

  subscribe(listener: (snapshot: DesktopCompanionSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DesktopCompanionSnapshot {
    const state = this.deps.readState();
    const media = this.deps.peekMedia();
    return {
      supported: this.deps.isMac(),
      enabled: state.settings.enabled,
      locationEnabled: state.settings.locationEnabled,
      status: this.status,
      lastTopic: state.lastTopic,
      lastUpdatedAt: state.lastUpdatedAt,
      lastError: state.lastError,
      previewSrc: this.deps.toPreviewSrc(state.lastStillPath),
      imageReady: media.image,
      videoReady: media.video,
    };
  }

  start(): void {
    this.stopTimer();
    if (!this.deps.isMac()) return;
    const state = this.deps.readState();
    if (!state.settings.enabled) return;
    this.sweepOrphans(state);
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, DESKTOP_COMPANION_TICK_MS);
  }

  stop(): void {
    this.stopTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.deps.stopVideo();
  }

  async setEnabled(enabled: boolean): Promise<DesktopCompanionSnapshot> {
    const state = this.deps.readState();
    state.settings.enabled = enabled;
    this.deps.writeState(state);
    if (enabled) this.start();
    else {
      this.stop();
      this.status = 'idle';
      this.emit();
    }
    return this.snapshot();
  }

  async setLocationEnabled(locationEnabled: boolean): Promise<DesktopCompanionSnapshot> {
    const state = this.deps.readState();
    state.settings.locationEnabled = locationEnabled;
    this.deps.writeState(state);
    if (state.settings.enabled) void this.tick();
    this.emit();
    return this.snapshot();
  }

  async refresh(): Promise<DesktopCompanionSnapshot> {
    await this.tick();
    return this.snapshot();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private scheduleRetry(delayMs: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.deps.readState().settings.enabled) void this.tick();
    }, delayMs);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runTick().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runTick(): Promise<void> {
    if (!this.deps.isMac()) return;
    const state = this.deps.readState();
    if (!state.settings.enabled) return;
    const owner = this.deps.ownerKey();
    // 生成跨越多次 await：owner 或开关任一变化都视作本次作废，
    // 不得再写状态、设壁纸或播视频（review #4706 Issue 1/2）。
    const abort = (): boolean =>
      this.deps.ownerKey() !== owner || !this.deps.readState().settings.enabled;
    const media = this.deps.peekMedia();
    if (!media.image) {
      this.status = 'idle';
      state.lastError = 'NO_IMAGE_MODEL';
      this.deps.writeState(state);
      this.emit();
      this.scheduleRetry(30_000);
      return;
    }

    try {
      this.status = 'generating';
      this.emit();
      const collected = await this.deps.collectContext(state.settings.locationEnabled);
      if (abort()) return;
      const now = this.deps.now();
      const timeSlot = timeSlotAt(new Date(now));
      const hasTask = Boolean(collected.taskTitle);
      const mode = characterModeFor(hasTask);
      const memoryKey = memoryKeyFromTopics(collected.memoryTopics);
      const fingerprint = buildFingerprint({
        timeSlot,
        city: collected.city,
        taskTitle: collected.taskTitle,
        mode,
        memoryKey,
      });

      const previousPool = state.reusePool;
      state.reusePool = pruneReusePool(state.reusePool, now, (filePath) => fs.existsSync(filePath));
      this.removeDroppedPoolFiles(previousPool, state.reusePool);

      if (state.lastFingerprint === fingerprint && state.lastStillPath && fs.existsSync(state.lastStillPath)) {
        await this.deps.setWallpaper(state.lastStillPath);
        if (abort()) return;
        if (state.lastVideoPath && fs.existsSync(state.lastVideoPath) && !this.deps.shouldReduceMotion()) {
          await this.deps.playVideo(state.lastVideoPath);
        }
        this.status = 'ready';
        state.lastError = null;
        this.deps.writeState(state);
        this.emit();
        return;
      }

      // 只复用与当前上下文指纹一致的条目（review #4706 Issue 3）。
      if (!hasTask) {
        const reuse = state.reusePool.find((entry) => entry.fingerprint === fingerprint);
        if (reuse) {
          await this.applyExisting(state, reuse, now, abort);
          return;
        }
      }

      const { prompt, topic } = buildDesktopCompanionPrompt({
        timeSlot,
        city: collected.city,
        taskTitle: collected.taskTitle,
        memoryTopics: collected.memoryTopics,
        mode,
      });
      const still = await this.deps.generateStill(prompt, this.deps.characterRefPath());
      if (abort()) return;
      const stillPath = this.deps.materialize(still, 'still');
      await this.deps.setWallpaper(stillPath);
      if (abort()) return;

      let videoPath: string | null = null;
      let lastError: string | null = null;
      if (media.video && !this.deps.shouldReduceMotion()) {
        try {
          const video = await this.deps.generateVideo(buildDesktopCompanionVideoPrompt(topic), stillPath);
          if (abort()) {
            await this.deps.stopVideo();
            return;
          }
          videoPath = this.deps.materialize(video, 'video');
          await this.deps.playVideo(videoPath);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          await this.deps.stopVideo();
        }
      } else {
        await this.deps.stopVideo();
      }
      if (abort()) return;

      const item: DesktopCompanionReuseItem = {
        fingerprint,
        stillPath,
        videoPath,
        topic,
        expiresAt: now + DESKTOP_COMPANION_REUSE_MS,
      };
      state.reusePool = [item, ...state.reusePool.filter((entry) => entry.fingerprint !== fingerprint)].slice(0, 8);
      state.lastFingerprint = fingerprint;
      state.lastStillPath = stillPath;
      state.lastVideoPath = videoPath;
      state.lastTopic = topic;
      state.lastUpdatedAt = now;
      state.lastError = lastError;
      this.status = 'ready';
      this.deps.writeState(state);
      this.emit();
    } catch (error) {
      if (this.deps.ownerKey() !== owner) return;
      const stateAfter = this.deps.readState();
      this.status = 'error';
      stateAfter.lastError = error instanceof Error ? error.message : String(error);
      this.deps.writeState(stateAfter);
      this.emit();
    }
  }

  private removeDroppedPoolFiles(
    previousPool: DesktopCompanionReuseItem[],
    nextPool: DesktopCompanionReuseItem[],
  ): void {
    const kept = new Set(nextPool.map((entry) => entry.stillPath));
    for (const entry of previousPool) {
      if (kept.has(entry.stillPath)) continue;
      this.deps.removeFile(entry.stillPath);
      if (entry.videoPath) this.deps.removeFile(entry.videoPath);
    }
  }

  private sweepOrphans(state: DesktopCompanionPersistedState): void {
    const keep = new Set<string>();
    for (const entry of state.reusePool) {
      keep.add(entry.stillPath);
      if (entry.videoPath) keep.add(entry.videoPath);
    }
    if (state.lastStillPath) keep.add(state.lastStillPath);
    if (state.lastVideoPath) keep.add(state.lastVideoPath);
    this.deps.sweepOrphans(keep);
  }

  private async applyExisting(
    state: DesktopCompanionPersistedState,
    reuse: DesktopCompanionReuseItem,
    now: number,
    abort: () => boolean,
  ): Promise<void> {
    await this.deps.setWallpaper(reuse.stillPath);
    if (abort()) return;
    if (reuse.videoPath && fs.existsSync(reuse.videoPath) && !this.deps.shouldReduceMotion()) {
      await this.deps.playVideo(reuse.videoPath);
    } else {
      await this.deps.stopVideo();
    }
    state.lastFingerprint = reuse.fingerprint;
    state.lastStillPath = reuse.stillPath;
    state.lastVideoPath = reuse.videoPath;
    state.lastTopic = reuse.topic;
    state.lastUpdatedAt = now;
    state.lastError = null;
    this.status = 'ready';
    this.deps.writeState(state);
    this.emit();
  }
}

export function materializeToApplyDir(
  applyDir: string,
  media: GeneratedMedia,
  kind: 'still' | 'video',
): string {
  fs.mkdirSync(applyDir, { recursive: true });
  const ext = kind === 'video' ? extensionForVideo(media.mimeType) : extensionForImage(media.mimeType);
  const filePath = path.join(applyDir, kind + '_' + Date.now() + ext);
  fs.writeFileSync(filePath, media.buffer);
  return filePath;
}

function extensionForImage(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function extensionForVideo(mime: string): string {
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime')) return '.mov';
  return '.mp4';
}

export function patchSettings(
  state: DesktopCompanionPersistedState,
  patch: Partial<DesktopCompanionSettings>,
): DesktopCompanionPersistedState {
  return {
    ...state,
    settings: { ...state.settings, ...patch },
  };
}
