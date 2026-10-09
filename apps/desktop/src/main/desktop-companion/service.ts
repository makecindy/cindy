import {
  DESKTOP_COMPANION_REUSE_MS,
  DESKTOP_COMPANION_TICK_MS,
  type DesktopCompanionReuseItem,
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
  characterRefPath: () => string;
  ownerKey: () => string;
  removeFile: (filePath: string) => void;
  collectContext: (locationEnabled: boolean) => Promise<DesktopCompanionCollectedContext>;
  peekMedia: () => { image: boolean; video: boolean };
  generateStill: (prompt: string, refPath: string) => Promise<GeneratedMedia>;
  generateVideo: (prompt: string, stillPath: string, assertStillValid: () => void) => Promise<GeneratedMedia>;
  materialize: (media: GeneratedMedia, kind: 'still' | 'video', assertStillValid: () => void) => string | Promise<string>;
  exists: (source: string) => boolean;
  setWallpaper: (stillPath: string, assertStillValid: () => void) => Promise<void>;
  playVideo: (videoPath: string, assertStillValid: () => void) => Promise<void>;
  stopVideo: () => Promise<void>;
  toPreviewSrc: (stillPath: string | null) => string | null;
}

function wallpaperErrorCode(message: string | null): string | null {
  if (message === null) return null;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(message) ? message : 'UPDATE_FAILED';
}

export class DesktopCompanionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** 代际计数：stop()/start() 各自自增，使在途旧代次在下一个检查点失效。 */
  private generation = 0;
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
      supported: true,
      systemSupported: this.deps.isMac(),
      generation: this.generation,
      enabled: state.settings.enabled,
      locationEnabled: state.settings.locationEnabled,
      systemEnabled: state.settings.systemEnabled,
      status: this.status,
      lastTopic: state.lastTopic,
      lastUpdatedAt: state.lastUpdatedAt,
      lastError: wallpaperErrorCode(state.lastError),
      previewSrc: this.deps.toPreviewSrc(state.lastStillPath),
      imageReady: media.image,
      videoReady: media.video,
    };
  }

  start(): void {
    this.generation += 1;
    this.stopTimer();
    this.status = 'idle';
    this.emit();
    const state = this.deps.readState();
    if (!state.settings.enabled) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, DESKTOP_COMPANION_TICK_MS);
  }

  stop(): void {
    this.generation += 1;
    this.stopTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.deps.stopVideo();
    this.status = 'idle';
    this.emit();
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
    if (state.settings.enabled) {
      this.stop();
      this.start();
    }
    this.emit();
    return this.snapshot();
  }

  async setSystemEnabled(systemEnabled: boolean): Promise<DesktopCompanionSnapshot> {
    const state = this.deps.readState();
    state.settings.systemEnabled = systemEnabled;
    this.deps.writeState(state);
    this.stop();
    if (state.settings.enabled) this.start();
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
    const gen = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation && this.deps.readState().settings.enabled) void this.tick();
    }, delayMs);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async tick(): Promise<void> {
    const gen = this.generation;
    // 串行化：同代次排队；代次已 bump 的旧 run 会在首个检查点快速失效返回，
    // 让新代次的 run 顺位执行。禁止在 run 结束时自动补跑，避免与外部
    // stop/start 的代次自增互相放大形成死循环（review #4706 复审）。
    const run = this.chain.then(() => this.runTick(gen));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async runTick(gen: number): Promise<void> {
    const state = this.deps.readState();
    if (!state.settings.enabled) return;
    const owner = this.deps.ownerKey();
    // 生成跨越多次 await：代次、owner 或开关任一变化都视作本次作废，
    // 不得再写状态、设壁纸或播视频（review #4706 Issue 1/2 + 复审补充）。
    const abort = (): boolean =>
      gen !== this.generation ||
      this.deps.ownerKey() !== owner ||
      !this.deps.readState().settings.enabled;
    const assertStillValid = (): void => {
      if (abort()) throw new Error('ACCOUNT_CHANGED');
    };
    const media = this.deps.peekMedia();
    if (!media.image) {
      if (gen !== this.generation) return;
      this.status = 'idle';
      state.lastError = 'NO_IMAGE_MODEL';
      this.deps.writeState(state);
      this.emit();
      this.scheduleRetry(30_000);
      return;
    }

    try {
      if (gen !== this.generation) return;
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
      state.reusePool = pruneReusePool(state.reusePool, now, (source) => this.exists(source));
      this.removeDroppedPoolFiles(previousPool, state.reusePool);

      if (state.lastFingerprint === fingerprint && state.lastStillPath && this.exists(state.lastStillPath)) {
        if (this.deps.isMac() && state.settings.systemEnabled) await this.deps.setWallpaper(state.lastStillPath, assertStillValid);
        if (abort()) return;
        if (this.deps.isMac() && state.settings.systemEnabled && state.lastVideoPath && this.exists(state.lastVideoPath) && !this.deps.shouldReduceMotion()) {
          await this.deps.playVideo(state.lastVideoPath, assertStillValid);
        }
        if (abort()) return;
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
      const stillPath = await this.deps.materialize(still, 'still', assertStillValid);
      if (abort()) return;
      const previousStill = state.lastStillPath;
      const previousVideo = state.lastVideoPath;
      const previousPoolBeforePublish = state.reusePool;
      const item: DesktopCompanionReuseItem = {
        fingerprint, stillPath, videoPath: null, topic,
        expiresAt: now + DESKTOP_COMPANION_REUSE_MS,
      };
      state.reusePool = [item, ...state.reusePool.filter((entry) => entry.fingerprint !== fingerprint)].slice(0, 8);
      state.lastFingerprint = fingerprint;
      state.lastStillPath = stillPath;
      state.lastVideoPath = null;
      state.lastTopic = topic;
      state.lastUpdatedAt = now;
      state.lastError = null;
      this.deps.writeState(state);
      this.removeDroppedPoolFiles(previousPoolBeforePublish, state.reusePool, [previousStill, previousVideo]);
      this.emit();
      if (this.deps.isMac() && state.settings.systemEnabled) await this.deps.setWallpaper(stillPath, assertStillValid);
      if (abort()) return;

      let videoPath: string | null = null;
      if (this.deps.isMac() && state.settings.systemEnabled && media.video && !this.deps.shouldReduceMotion()) {
          const video = await this.deps.generateVideo(buildDesktopCompanionVideoPrompt(topic), stillPath, assertStillValid);
          if (abort()) {
            await this.deps.stopVideo();
            return;
          }
          videoPath = await this.deps.materialize(video, 'video', assertStillValid);
          if (abort()) return;
          item.videoPath = videoPath;
          state.lastVideoPath = videoPath;
          this.deps.writeState(state);
          await this.deps.playVideo(videoPath, assertStillValid);
      } else {
        await this.deps.stopVideo();
      }
      if (abort()) return;

      item.videoPath = videoPath;
      state.lastVideoPath = videoPath;
      this.status = 'ready';
      this.deps.writeState(state);
      this.emit();
    } catch (error) {
      if (abort()) return;
      const stateAfter = this.deps.readState();
      this.status = 'error';
      stateAfter.lastError = wallpaperErrorCode(error instanceof Error ? error.message : String(error));
      this.deps.writeState(stateAfter);
      this.emit();
    }
  }

  private removeDroppedPoolFiles(
    previousPool: DesktopCompanionReuseItem[],
    nextPool: DesktopCompanionReuseItem[],
    previousMedia: Array<string | null> = [],
  ): void {
    const current = this.deps.readState();
    const kept = new Set([
      ...nextPool.flatMap((entry) => [entry.stillPath, entry.videoPath]),
      current.lastStillPath, current.lastVideoPath,
    ]);
    const previous = new Set([
      ...previousPool.flatMap((entry) => [entry.stillPath, entry.videoPath]),
      ...previousMedia,
    ]);
    for (const source of previous) {
      if (source && !kept.has(source)) this.deps.removeFile(source);
    }
  }

  private async applyExisting(
    state: DesktopCompanionPersistedState,
    reuse: DesktopCompanionReuseItem,
    now: number,
    abort: () => boolean,
  ): Promise<void> {
    const assertStillValid = () => { if (abort()) throw new Error('ACCOUNT_CHANGED'); };
    if (this.deps.isMac() && state.settings.systemEnabled) await this.deps.setWallpaper(reuse.stillPath, assertStillValid);
    if (abort()) return;
    if (this.deps.isMac() && state.settings.systemEnabled && reuse.videoPath && this.exists(reuse.videoPath) && !this.deps.shouldReduceMotion()) {
      await this.deps.playVideo(reuse.videoPath, assertStillValid);
    } else {
      await this.deps.stopVideo();
    }
    if (abort()) return;
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

  private exists(source: string): boolean {
    return this.deps.exists(source);
  }
}
