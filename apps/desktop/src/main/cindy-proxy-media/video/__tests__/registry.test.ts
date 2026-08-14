/**
 * registry.test.ts
 * ---------------------------------------------------------------------------
 * VideoProviderRegistry contract: alias resolution, duplicate detection,
 * union-of-params for tool-schema generation. This is the seam that keeps
 * the MCP tool layer vendor-agnostic — adding a new provider should be
 * purely additive (no changes to existing aliases / params).
 */

import { describe, it, expect } from 'vitest';
import { VideoProviderRegistry } from '../registry.js';
import type { VideoProvider } from '../types.js';

function makeFakeProvider(opts: {
  id: string;
  aliases: ReadonlyArray<{ alias: string; internalModel: string; summary?: string }>;
  durations?: number[];
  resolutions?: string[];
  ratios?: string[];
  fps?: number[];
  maxImagesByRefMode?: Partial<Record<'first_and_last_frame' | 'reference_image', number>>;
  expectedSeconds?: number;
  supportsAudio?: boolean;
}): VideoProvider {
  return {
    id: opts.id,
    capabilities: {
      modelAliases: opts.aliases.map((a) => ({
        alias: a.alias,
        internalModel: a.internalModel,
        summary: a.summary ?? '',
      })),
      supportedDurations: opts.durations ?? [4, 6],
      supportedResolutions: opts.resolutions ?? ['720p'],
      supportedRatios: opts.ratios ?? ['16:9'],
      supportedFps: opts.fps ?? [24],
      maxImagesByRefMode: opts.maxImagesByRefMode ?? {},
      supportsAudio: opts.supportsAudio ?? false,
      expectedSecondsByAlias: Object.fromEntries(
        opts.aliases.map((a) => [a.alias, opts.expectedSeconds ?? 60]),
      ),
      defaults: {
        duration: (opts.durations ?? [4, 6])[0],
        resolution: (opts.resolutions ?? ['720p'])[0],
        ratio: (opts.ratios ?? ['16:9'])[0],
        fps: (opts.fps ?? [24])[0],
      },
    },
    submit: async () => ({
      providerId: opts.id,
      taskId: 'fake',
      modelUsed: opts.aliases[0].internalModel,
      submittedAt: Date.now(),
    }),
    poll: async () => ({ state: 'running' }),
    download: async () => ({ buffer: Buffer.from(''), mimeType: 'video/mp4' }),
  };
}

describe('VideoProviderRegistry', () => {
  it('starts empty', () => {
    const r = new VideoProviderRegistry();
    expect(r.hasAny()).toBe(false);
    expect(r.hasAlias('missing')).toBe(false);
    expect(r.collectAllAliases()).toEqual([]);
  });

  it('register + resolveByAlias roundtrip', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({
        id: 'fakeprov',
        aliases: [{ alias: 'fast', internalModel: 'fp-fast' }],
      }),
    );
    expect(r.hasAny()).toBe(true);
    expect(r.hasAlias('fast')).toBe(true);
    const resolved = r.resolveByAlias('fast');
    expect(resolved.provider.id).toBe('fakeprov');
    expect(resolved.internalModel).toBe('fp-fast');
  });

  it('throws on unknown alias', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({
        id: 'p1',
        aliases: [{ alias: 'a', internalModel: 'm' }],
      }),
    );
    expect(() => r.resolveByAlias('z')).toThrow(/unknown video model alias/);
  });

  it('rejects duplicate provider id', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({ id: 'p', aliases: [{ alias: 'a', internalModel: 'm1' }] }),
    );
    expect(() =>
      r.register(
        makeFakeProvider({ id: 'p', aliases: [{ alias: 'b', internalModel: 'm2' }] }),
      ),
    ).toThrow(/duplicate provider id/);
  });

  it('rejects duplicate alias across providers', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({ id: 'p1', aliases: [{ alias: 'shared', internalModel: 'm1' }] }),
    );
    expect(() =>
      r.register(
        makeFakeProvider({ id: 'p2', aliases: [{ alias: 'shared', internalModel: 'm2' }] }),
      ),
    ).toThrow(/duplicate alias/);
  });

  it('extends a provider with newly discovered aliases without removing in-flight aliases', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({ id: 'xai-video', aliases: [{ alias: 'xai/old', internalModel: 'old' }] }),
    );
    r.registerOrExtend(
      makeFakeProvider({ id: 'xai-video', aliases: [{ alias: 'xai/new', internalModel: 'new' }] }),
    );

    expect(r.resolveByAlias('xai/old').internalModel).toBe('old');
    expect(r.resolveByAlias('xai/new').internalModel).toBe('new');
    expect(r.collectAllAliases().map((alias) => alias.alias)).toEqual(['xai/new']);
  });

  it('preserves registration order in collectAllAliases (first alias = default)', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({
        id: 'p1',
        aliases: [
          { alias: 'fast', internalModel: 'mf', summary: 'fast' },
          { alias: 'pro', internalModel: 'mp', summary: 'pro' },
        ],
      }),
    );
    r.register(
      makeFakeProvider({
        id: 'p2',
        aliases: [{ alias: 'kling', internalModel: 'k1' }],
      }),
    );
    const all = r.collectAllAliases();
    expect(all.map((a) => a.alias)).toEqual(['fast', 'pro', 'kling']);
  });

  it('collectUnionParams unions across providers and tracks the max image count', () => {
    const r = new VideoProviderRegistry();
    r.register(
      makeFakeProvider({
        id: 'a',
        aliases: [{ alias: 'a1', internalModel: 'A' }],
        durations: [4, 6],
        resolutions: ['480p', '720p'],
        ratios: ['16:9'],
        maxImagesByRefMode: { first_and_last_frame: 1 },
      }),
    );
    r.register(
      makeFakeProvider({
        id: 'b',
        aliases: [{ alias: 'b1', internalModel: 'B' }],
        durations: [6, 8, 10],
        resolutions: ['720p', '1080p'],
        ratios: ['16:9', '9:16'],
        maxImagesByRefMode: { first_and_last_frame: 2, reference_image: 9 },
      }),
    );
    const u = r.collectUnionParams();
    expect(u.durations).toEqual([4, 6, 8, 10]);
    expect(u.resolutions.sort()).toEqual(['1080p', '480p', '720p']);
    expect(u.ratios.sort()).toEqual(['16:9', '9:16']);
    expect(u.maxImagesUpperBoundByRefMode).toEqual({
      first_and_last_frame: 2,
      reference_image: 9,
    });
  });
});
