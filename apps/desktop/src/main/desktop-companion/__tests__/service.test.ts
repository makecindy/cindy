import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DESKTOP_COMPANION_SETTINGS } from '../../../shared/desktopCompanion.js';
import { buildFingerprint } from '../context.js';
import { DesktopCompanionService, materializeToApplyDir } from '../service.js';
import { normalizePersistedState, type DesktopCompanionPersistedState } from '../store.js';

interface TestHarness {
  dir: string;
  state: DesktopCompanionPersistedState;
  wallpapers: string[];
  removed: string[];
  generated: string[];
  service: DesktopCompanionService;
}

function makeHarness(options?: {
  enabled?: boolean;
  pool?: DesktopCompanionPersistedState['reusePool'];
  onGenerateStill?: () => void;
  onCollectContext?: () => void;
  ownerKey?: () => string;
  peekMedia?: () => { image: boolean; video: boolean };
}): TestHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-desktop-companion-'));
  const state = normalizePersistedState({
    settings: {
      ...DEFAULT_DESKTOP_COMPANION_SETTINGS,
      enabled: options?.enabled ?? true,
    },
    reusePool: options?.pool ?? [],
  });
  const wallpapers: string[] = [];
  const removed: string[] = [];
  const generated: string[] = [];
  const harness: TestHarness = {
    dir,
    state,
    wallpapers,
    removed,
    generated,
    service: new DesktopCompanionService({
      now: () => Date.now(),
      isMac: () => true,
      shouldReduceMotion: () => true,
      readState: () => state,
      writeState: (next) => {
        Object.assign(state, next);
      },
      applyDir: () => dir,
      characterRefPath: () => null,
      ownerKey: options?.ownerKey ?? (() => 'owner-a'),
      removeFile: (filePath) => {
        removed.push(filePath);
      },
      sweepOrphans: () => undefined,
      collectContext: async () => {
        options?.onCollectContext?.();
        return { taskTitle: null, memoryTopics: [], city: null };
      },
      peekMedia: options?.peekMedia ?? (() => ({ image: true, video: false })),
      generateStill: async () => {
        options?.onGenerateStill?.();
        const buffer = Buffer.from('still-' + Date.now());
        const filePath = materializeToApplyDir(dir, { buffer, mimeType: 'image/png' }, 'still');
        generated.push(filePath);
        return { buffer, mimeType: 'image/png' };
      },
      generateVideo: async () => ({ buffer: Buffer.from('video'), mimeType: 'video/mp4' }),
      materialize: (media, kind) => materializeToApplyDir(dir, media, kind),
      setWallpaper: async (filePath) => {
        wallpapers.push(filePath);
      },
      playVideo: async () => undefined,
      stopVideo: async () => undefined,
      toPreviewSrc: (filePath) => filePath,
    }),
  };
  return harness;
}

describe('desktop companion service', () => {
  it('reuses a still whose fingerprint matches the current context', async () => {
    const hour = new Date().getHours();
    const timeSlot = hour >= 6 && hour < 11 ? 'morning' : hour >= 11 && hour < 16 ? 'noon' : hour >= 16 && hour < 19 ? 'dusk' : 'night';
    const fingerprint = buildFingerprint({ timeSlot, city: null, taskTitle: null, mode: 'companion', memoryKey: '' });
    const stillPath = path.join(mkdtempSync(path.join(tmpdir(), 'cindy-dc-')), 'still.jpg');
    writeFileSync(stillPath, 'still');
    const harness = makeHarness({
      pool: [
        { fingerprint, stillPath, videoPath: null, topic: 'idle night', expiresAt: Date.now() + 60_000 },
      ],
    });

    await harness.service.refresh();
    expect(harness.wallpapers).toEqual([stillPath]);
    expect(harness.generated).toHaveLength(0);
    expect(harness.service.snapshot().status).toBe('ready');
  });

  it('generates a new scene when no pool item matches the fingerprint', async () => {
    const staleStill = path.join(mkdtempSync(path.join(tmpdir(), 'cindy-dc-')), 'morning.jpg');
    writeFileSync(staleStill, 'morning');
    const harness = makeHarness({
      pool: [
        {
          fingerprint: 'never||companion|',
          stillPath: staleStill,
          videoPath: null,
          topic: 'morning',
          expiresAt: Date.now() + 60_000,
        },
      ],
    });

    await harness.service.refresh();
    expect(harness.generated).toHaveLength(1);
    expect(harness.wallpapers).toHaveLength(1);
    expect(harness.state.lastStillPath).toBe(harness.wallpapers[0]);
  });

  it('drops side effects when the user disables during generation', async () => {
    const harness = makeHarness({
      onGenerateStill: () => {
        harness.state.settings.enabled = false;
      },
    });

    await harness.service.refresh();
    expect(harness.wallpapers).toHaveLength(0);
    expect(harness.state.lastStillPath).toBeNull();
    expect(harness.state.lastError).toBeNull();
  });

  it('stops applying and writing when the owner switches mid-run', async () => {
    const harness = makeHarness({
      ownerKey: () => 'owner-a',
      onCollectContext: () => {},
    });
    let owner = 'owner-a';
    const ownerService = new DesktopCompanionService({
      now: () => Date.now(),
      isMac: () => true,
      shouldReduceMotion: () => true,
      readState: () => harness.state,
      writeState: (next) => {
        Object.assign(harness.state, next);
      },
      applyDir: () => harness.dir,
      characterRefPath: () => null,
      ownerKey: () => owner,
      removeFile: () => undefined,
      sweepOrphans: () => undefined,
      collectContext: async () => {
        owner = 'owner-b';
        return { taskTitle: 'x', memoryTopics: [], city: null };
      },
      peekMedia: () => ({ image: true, video: false }),
      generateStill: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/png' }),
      generateVideo: async () => ({ buffer: Buffer.from('v'), mimeType: 'video/mp4' }),
      materialize: (media, kind) => materializeToApplyDir(harness.dir, media, kind),
      setWallpaper: async (filePath) => {
        harness.wallpapers.push(filePath);
      },
      playVideo: async () => undefined,
      stopVideo: async () => undefined,
      toPreviewSrc: () => null,
    });

    await ownerService.refresh();
    expect(harness.wallpapers).toHaveLength(0);
    expect(harness.state.lastUpdatedAt).toBeNull();
  });

  it('records NO_IMAGE_MODEL as a retryable idle state', async () => {
    const harness = makeHarness({ peekMedia: () => ({ image: false, video: false }) });

    await harness.service.refresh();
    expect(harness.state.lastError).toBe('NO_IMAGE_MODEL');
    expect(harness.service.snapshot().status).toBe('idle');
  });

  it('deletes files of pruned pool entries', async () => {
    const oldStill = path.join(mkdtempSync(path.join(tmpdir(), 'cindy-dc-')), 'old.jpg');
    writeFileSync(oldStill, 'old');
    const harness = makeHarness({
      pool: [
        {
          fingerprint: 'old',
          stillPath: oldStill,
          videoPath: null,
          topic: 'old',
          expiresAt: Date.now() - 1,
        },
      ],
    });

    await harness.service.refresh();
    expect(harness.removed).toContain(oldStill);
  });
});
