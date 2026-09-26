import fs from 'node:fs/promises';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
import type { MediaCapability } from '@cindy/model-providers';

interface MockPreparedGuide extends Record<string, unknown> {
  modelId: string;
  capability: string;
  revision: string;
}

interface MockTransitionInput {
  id: string;
  owner: string;
  from: string;
  to: string;
  taskId?: string;
  responseJson?: string;
  expectedSnapshot?: { taskId?: string; responseJson?: string };
}

const mocks = vi.hoisted(() => ({
  localMode: false,
  currentUserId: 'media-user-0',
  ownerGeneration: 1,
  models: vi.fn(),
  executableModels: vi.fn(),
  providerModel: vi.fn(),
  providerInvoke: vi.fn(),
  providerVideo: vi.fn(),
  log: vi.fn(),
  guide: vi.fn(),
  outboundFetch: vi.fn(),
  guardedOutboundFetch: vi.fn(),
  release: vi.fn(async () => undefined),
  confirm: vi.fn(async (_input: { reasons: string[] }) => true),
  ingestMedia: vi.fn(),
  readBlob: vi.fn(),
  resolveBlob: vi.fn(),
  resolveLegacyImage: vi.fn(),
  resolveLegacyVideo: vi.fn(),
  db: {
    owner: 'media-user-0',
    drizzle: { owner: 'media-user-0' },
  },
  dbOwnerId: 'media-user-0',
  transitionDbs: [] as unknown[],
  failTransitionTo: null as string | null,
  recover: vi.fn<(owner: string, db: unknown) => Promise<number>>(async () => 0),
  prune: vi.fn(async () => undefined),
  rows: new Map<string, Record<string, unknown>>(),
  failRequestLog: false,
}));

vi.mock('../../authManager.js', () => ({
  getCurrentUserId: () => mocks.currentUserId,
  getActiveAuthRealm: () => 'cn',
  getAuthState: () => ({
    mode: mocks.localMode ? 'local' : 'cloud',
    user: !mocks.localMode && mocks.currentUserId ? { id: mocks.currentUserId } : null,
    dataOwnerId: mocks.localMode ? mocks.dbOwnerId : mocks.currentUserId,
    ownerGeneration: mocks.ownerGeneration,
  }),
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: !mocks.localMode }),
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => 'https://gateway.example.com',
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => 'test-api-key' }),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => mocks.db,
  getCurrentDbClientUserId: () => mocks.dbOwnerId,
}));
vi.mock('../mediaRequestLog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mediaRequestLog.js')>();
  return {
    ...actual,
    mediaRequestParamsForLog: (value: unknown) => {
      // 只在记录请求 body 时抛错，模拟组装/日志阶段（出站之前）的异常。
      if (mocks.failRequestLog && typeof value === 'object') {
        throw new RangeError('Maximum call stack size exceeded');
      }
      return actual.mediaRequestParamsForLog(value);
    },
  };
});
vi.mock('../../maker-host/outbound-fetch.js', () => ({
  outboundFetch: mocks.outboundFetch,
  guardedOutboundFetch: mocks.guardedOutboundFetch,
}));
vi.mock('../../model-access/mediaModels.js', () => ({
  listAvailableMediaModels: mocks.models,
  listExecutableMediaModels: mocks.executableModels,
  fetchMediaInvocationGuide: mocks.guide,
  MediaGuideCompatibilityError: class MediaGuideCompatibilityError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly detail?: string,
    ) {
      super(message);
    }
  },
  MediaModelCatalogError: class MediaModelCatalogError extends Error {
    constructor(
      message: string,
      readonly detail?: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../providerMediaRuntime.js', () => ({
  resolveProviderMediaModel: mocks.providerModel,
  invokeProviderMedia: mocks.providerInvoke,
  resolveProviderVideo: mocks.providerVideo,
}));
vi.mock('../ingest.js', () => ({ ingestMedia: mocks.ingestMedia }));
vi.mock('../blobStore.js', () => ({
  readFile: mocks.readBlob,
  parseBlobUrl: (url: string) => {
    const match = /^cindy-media:\/\/blobs\/([0-9a-f]{64})(\.[a-z0-9]+)$/.exec(url);
    return match ? { hash: match[1], ext: match[2] } : null;
  },
  resolveSafe: mocks.resolveBlob,
  supportedMime: (mime: string) =>
    ['image/png', 'video/mp4', 'audio/mpeg'].includes(mime),
}));
vi.mock('../../imageCacheStore.js', () => ({ resolveSafe: mocks.resolveLegacyImage }));
vi.mock('../../videoCacheStore.js', () => ({ resolveSafe: mocks.resolveLegacyVideo }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: mocks.log, info: mocks.log, debug: mocks.log, error: mocks.log }),
}));
vi.mock('../../serverApiClient.js', () => ({
  ServerApiError: class ServerApiError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('../mediaInvocationStore.js', () => ({
  recoverInterruptedMediaInvocations: mocks.recover,
  pruneMediaInvocations: mocks.prune,
  countMediaInvocations: async () =>
    [...mocks.rows.values()].filter((row) =>
      ['prepared', 'submitting', 'pending'].includes(String(row.state)),
    ).length,
  createMediaInvocation: async ({
    id,
    owner,
    guide,
    createdAt,
  }: {
    id: string;
    owner: string;
    guide: MockPreparedGuide;
    createdAt: number;
  }) => {
    mocks.rows.set(id, {
      id,
      owner,
      modelId: guide.modelId,
      capability: guide.capability,
      guideRevision: guide.revision,
      guide,
      state: 'prepared',
      createdAt,
      updatedAt: createdAt,
    });
  },
  getMediaInvocation: async (id: string, owner: string) => {
    const row = mocks.rows.get(id);
    return row?.owner === owner ? JSON.parse(JSON.stringify(row)) : null;
  },
  transitionMediaInvocation: async (
    { id, owner, from, to, taskId, responseJson, expectedSnapshot }: MockTransitionInput,
    db: unknown,
  ) => {
    mocks.transitionDbs.push(db);
    if (mocks.failTransitionTo === to) throw new Error(`transition to ${to} failed`);
    const row = mocks.rows.get(id);
    if (!row || row.owner !== owner || row.state !== from) return false;
    if (expectedSnapshot && (row.taskId !== expectedSnapshot.taskId || row.responseJson !== expectedSnapshot.responseJson)) return false;
    row.state = to;
    row.updatedAt = Date.now();
    if (taskId) row.taskId = taskId;
    if (responseJson) row.responseJson = responseJson;
    return true;
  },
}));

import { callCindyMedia as invokeMedia } from '../invocationService.js';
import { createXaiVideoProvider } from '../../cindy-proxy-media/video/providers/xai.js';
import { parsePreparedMediaInvocationGuide } from '../../../shared/mediaInvocation.js';
import { VIDEO_IMAGE_MAX_BYTES } from '../providerVideoImage.js';

// This harness supplies a real Host approval boundary. Individual cases replace
// its decision; production never receives approval flags through tool arguments.
const callCindyMedia: typeof invokeMedia = (request, context = {
  assertActive: () => undefined,
  confirm: mocks.confirm,
  approvals: new Set<string>(),
}) => invokeMedia(request, context);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x10,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

function operation(response: Record<string, unknown>, path = '/images/generations') {
  return {
    capability: 'image.generate',
    request: {
      method: 'POST',
      path,
      bodyEncoding: 'json',
      bodyModelPath: ['model'],
      timeoutMs: 5_000,
      maxRequestBytes: 1_048_576,
      maxResponseBytes: 1_048_576,
    },
    response,
    instructions: '按协议组装请求',
    exampleBody: { prompt: 'hello' },
    inputSchema: { type: 'object' },
    officialDocs: 'https://docs.example.com/images',
  };
}

function resolvedGuide(op: Record<string, unknown>) {
  return {
    modelId: 'image-model',
    guide: {
      schemaVersion: 1,
      guideId: 'images-v1',
      revision: '2026-08-13.1',
      connection: { providerId: 'xd' },
      operations: [op],
    },
  };
}

async function prepare(capability: MediaCapability = 'image.generate'): Promise<string> {
  const result = await callCindyMedia({
    action: 'prepare',
    modelId: 'image-model',
    capability,
  });
  expect(result).toMatchObject({ ok: true, status: 'prepared', model_id: 'image-model' });
  return result.invocation_id as string;
}

describe('Cindy Core media invocation state and security boundary', () => {
  beforeEach(() => {
    mocks.failRequestLog = false;
    mocks.confirm.mockReset().mockResolvedValue(true);
    mocks.currentUserId = `media-user-${crypto.randomUUID()}`;
    mocks.localMode = false;
    mocks.ownerGeneration += 1;
    mocks.dbOwnerId = mocks.currentUserId;
    mocks.db = {
      owner: mocks.currentUserId,
      drizzle: { owner: mocks.currentUserId },
    };
    mocks.transitionDbs.length = 0;
    mocks.failTransitionTo = null;
    mocks.rows.clear();
    mocks.models.mockReset().mockResolvedValue([
      { id: 'image-model', name: 'Image Model', providerId: 'xd', mode: 'image_generation' },
    ]);
    mocks.executableModels.mockReset().mockResolvedValue({
      models: [
        { id: 'image-model', name: 'Image Model', providerId: 'xd', mode: 'image_generation' },
      ],
      unavailable: [],
      candidateCount: 1,
    });
    mocks.providerModel.mockReset();
    mocks.providerInvoke.mockReset();
    mocks.providerVideo.mockReset();
    mocks.log.mockClear();
    mocks.guide.mockReset();
    mocks.outboundFetch.mockReset();
    mocks.release.mockClear();
    // Preserve the existing upstream/download response sequences while checking
    // that every result request enters the guarded adapter and dispatch gate.
    mocks.guardedOutboundFetch
      .mockReset()
      .mockImplementation(
        async (url: string, init: RequestInit, beforeDispatch: () => void | Promise<void>) => {
          await beforeDispatch();
          return { response: await mocks.outboundFetch(url, init), release: mocks.release };
        },
      );

    mocks.ingestMedia.mockReset().mockResolvedValue({
      url: `cindy-media://blobs/${'a'.repeat(64)}.png`,
    });
    mocks.readBlob.mockReset();
    mocks.resolveBlob.mockReset().mockReturnValue({
      absPath: process.execPath,
      mimeType: 'image/png',
      hash: 'a'.repeat(64),
    });
    mocks.resolveLegacyImage.mockReset().mockReturnValue({
      absPath: process.execPath,
      mimeType: 'image/jpeg',
    });
    mocks.resolveLegacyVideo.mockReset().mockReturnValue({
      absPath: process.execPath,
      mimeType: 'video/mp4',
    });
    mocks.recover.mockClear();
    mocks.prune.mockClear();
  });

  describe('local subscription video bridge (offline)', () => {
    const model = { id: 'xai/grok-imagine-video', name: 'Grok video', providerId: 'xai',
      mode: 'video_generation' as const, modalities: { input: ['text', 'image'], output: ['video'] } };
    let epoch: number;
    let loginId: string;
    let ownerEpoch: string;
    let providerFetch: ReturnType<typeof vi.fn>;
    let provider: ReturnType<typeof createXaiVideoProvider>;
    let videoPng: Buffer;
    let videoJpeg: Buffer;
    beforeAll(async () => {
      const pixels = { create: { width: 1280, height: 720, channels: 3 as const, background: '#b04469' } };
      videoPng = await sharp(pixels).png().toBuffer();
      videoJpeg = await sharp(pixels).jpeg().toBuffer();
    });

    beforeEach(() => {
      epoch = 1; loginId = 'test-login-nonce'; ownerEpoch = 'owner:1';
      providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ request_id: 'video-task-1' })));
      provider = createXaiVideoProvider({
        modelAliases: [model.id, 'xai/grok-imagine-video-1.5'],
        hasOAuthLogin: () => true, getAccessToken: async () => 'mock-oauth-only',
        getCredentialGeneration: () => epoch, getCredentialSessionId: () => loginId,
        getOwnerScopeKey: () => ownerEpoch, isOwnerBoundaryPending: () => false,
        fetchImplementation: providerFetch as typeof fetch,
      });
      mocks.models.mockResolvedValue([model]);
      mocks.providerModel.mockReturnValue(model);
      mocks.providerVideo.mockReturnValue(provider);
      mocks.ingestMedia.mockResolvedValue({ url: `cindy-media://blobs/${'b'.repeat(64)}.mp4` });
    });
    const prepareVideo = async (capability: 'video.generate' | 'video.image_to_video' = 'video.generate', modelId = model.id) => {
      const result = await callCindyMedia({ action: 'prepare', providerId: 'xai', modelId, capability });
      expect(result).toMatchObject({ ok: true, provider_id: 'xai', capability });
      const row = mocks.rows.get(result.invocation_id as string)!;
      expect(parsePreparedMediaInvocationGuide(JSON.parse(JSON.stringify(row.guide))).ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain('mock-oauth');
      expect(JSON.stringify(result)).not.toContain('test-login-nonce');
      expect(mocks.guide).not.toHaveBeenCalled();
      return result.invocation_id as string;
    };
    const request = (id: string, body: Record<string, unknown> = { prompt: 'dash' }) =>
      callCindyMedia({ action: 'request', invocationId: id, body });
    const poll = (id: string) => callCindyMedia({ action: 'poll', invocationId: id });
    const succeed = () => {
      providerFetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'done', video: { url: 'https://cdn.x.ai/result.mp4' } })));
      mocks.outboundFetch.mockImplementation(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }));
    };

    it('prepares native schema, submits once, polls and delivers managed video', async () => {
      const id = await prepareVideo();
      expect(await request(id)).toMatchObject({ ok: true, status: 'pending', task_id: 'video-task-1' });
      expect(mocks.rows.get(id)?.responseJson).toBeUndefined();
      expect(JSON.stringify(mocks.rows.get(id))).not.toContain('mock-oauth-only');
      succeed();
      expect(await poll(id)).toMatchObject({ ok: true, status: 'complete' });
      expect(await request(id)).toMatchObject({ ok: true, status: 'complete' });
      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(mocks.providerInvoke).not.toHaveBeenCalled();
      expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
    });
    it.each([{ duration: 99 }, { duration: null }, { audio: true }, { resolution: '4k' }, { fps: 60 }, { endpoint: 'https://evil.invalid' }])('rejects unsupported parameters before dispatch: %j', async (extra) => {
      const id = await prepareVideo();
      expect(await request(id, { prompt: 'dash', ...extra })).toMatchObject({ ok: false, errorCode: 'REQUEST_INVALID' });
      expect(providerFetch).not.toHaveBeenCalled();
    });
    it('requires a supported reference count and resolves a managed image', async () => {
      const id = await prepareVideo('video.image_to_video');
      expect(await request(id)).toMatchObject({ ok: false });
      expect(await request(id, { prompt: 'dash', image: ['a', 'b'] })).toMatchObject({ ok: false });
      mocks.readBlob.mockResolvedValue({ buffer: videoPng, mimeType: 'image/png' });
      expect(await request(id, { prompt: 'dash', image: `cindy-media://blobs/${'a'.repeat(64)}.png` })).toMatchObject({ status: 'pending' });
      const body = JSON.parse(providerFetch.mock.calls[0][1].body);
      expect(body.image.url).toMatch(/^data:image\/png/);
      expect(body).not.toHaveProperty('aspect_ratio');
    });

    const dataUrl = (bytes: Buffer, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
    const imageBody = (image: string) => ({ prompt: 'dash', duration: 5, resolution: '720p', ratio: '16:9', fps: 24, image });
    const assertInputNotRecorded = (image: string) => {
      expect(JSON.stringify([...mocks.rows.values()]).includes(image)).toBe(false);
      expect(JSON.stringify(mocks.log.mock.calls).includes(image)).toBe(false);
    };
    const submitRealImage = async (bytes: Buffer, mime: string) => {
      const selected = { ...model, id: 'xai/grok-imagine-video-1.5' };
      mocks.models.mockResolvedValue([selected]); mocks.providerModel.mockReturnValue(selected);
      const id = await prepareVideo('video.image_to_video', selected.id);
      const image = dataUrl(bytes, mime), submit = vi.spyOn(provider, 'submit');
      expect(await request(id, imageBody(image))).toMatchObject({ status: 'pending' });
      expect(submit.mock.calls.length).toBe(1);
      const sent = JSON.parse(providerFetch.mock.calls[0][1].body);
      // Compare booleans so a failing assertion never dumps image bytes/base64.
      expect(sent.image.url === image).toBe(true);
      expect(sent.model).toBe('grok-imagine-video-1.5');
      assertInputNotRecorded(image);
    };
    it.each(['png', 'jpeg'])('accepts a fully decoded %s data URL through prepare → actual resolver → Provider', async (format) => {
      await submitRealImage(format === 'png' ? videoPng : videoJpeg, `image/${format}`);
    });
    it('accepts a generated reference above 3 MiB without base64 parser stack growth', async () => {
      const pixels = Buffer.alloc(1280 * 720 * 4);
      let seed = 123456789;
      for (let i = 0; i < pixels.length; i++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        pixels[i] = seed & 255;
      }
      const bytes = await sharp(pixels, { raw: { width: 1280, height: 720, channels: 4 } }).png().toBuffer();
      expect(bytes.length > 3 * 1024 * 1024).toBe(true);
      await submitRealImage(bytes, 'image/png');
    });

    function mutatedPng(kind: string): Buffer {
      const bytes = Buffer.from(videoPng);
      if (kind === 'dimension' || kind === 'pixels') {
        bytes.writeUInt32BE(kind === 'dimension' ? 8193 : 5000, 16);
        bytes.writeUInt32BE(kind === 'dimension' ? 1 : 5000, 20);
        bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
      } else {
        let offset = 8;
        while (bytes.toString('ascii', offset + 4, offset + 8) !== 'IDAT') offset += bytes.readUInt32BE(offset) + 12;
        bytes[offset + 8] ^= 0xff;
        if (kind === 'compressedPixels') {
          const end = offset + bytes.readUInt32BE(offset) + 12;
          bytes.writeUInt32BE(crc32(bytes.subarray(offset + 4, end - 4)), end - 4);
        }
      }
      return bytes;
    }
    function brokenJpegPixels(): Buffer {
      let offset = 2;
      while (videoJpeg[offset + 1] !== 0xda) offset += videoJpeg.readUInt16BE(offset + 2) + 2;
      const scan = offset + videoJpeg.readUInt16BE(offset + 2) + 2;
      return Buffer.concat([videoJpeg.subarray(0, scan + 1), Buffer.from([0xff, 0xd9])]);
    }
    it.each(['alphabet', 'padding', 'oversize', 'fakeMime', 'svg', 'headerOnly', 'pngTruncated', 'crc', 'compressedPixels', 'dimension', 'pixels', 'jpegTruncated', 'jpegPixels', 'http', 'file'])('rejects %s before submitting and retains prepared state', async (kind) => {
      const values: Record<string, () => string> = {
        alphabet: () => 'data:image/png;base64,AA$=', padding: () => dataUrl(videoPng) + '=',
        oversize: () => 'data:image/png;base64,' + 'A'.repeat(Math.ceil(VIDEO_IMAGE_MAX_BYTES / 3) * 4 + 4),
        fakeMime: () => dataUrl(videoPng, 'image/jpeg'), svg: () => dataUrl(Buffer.from('<svg/>'), 'image/svg+xml'),
        headerOnly: () => dataUrl(PNG), pngTruncated: () => dataUrl(videoPng.subarray(0, -12)),
        crc: () => dataUrl(mutatedPng('crc')), compressedPixels: () => dataUrl(mutatedPng('compressedPixels')),
        dimension: () => dataUrl(mutatedPng('dimension')), pixels: () => dataUrl(mutatedPng('pixels')),
        jpegTruncated: () => dataUrl(videoJpeg.subarray(0, -2), 'image/jpeg'), jpegPixels: () => dataUrl(brokenJpegPixels(), 'image/jpeg'),
        http: () => 'https://example.invalid/private.png', file: () => 'C:\\private\\image.png',
      };
      const id = await prepareVideo('video.image_to_video'), image = values[kind](), submit = vi.spyOn(provider, 'submit');
      const result = await request(id, imageBody(image));
      expect(result).toMatchObject({ ok: false, errorCode: 'MEDIA_INPUT_INVALID' });
      expect(submit.mock.calls.length).toBe(0); expect(providerFetch.mock.calls.length).toBe(0);
      expect(mocks.outboundFetch.mock.calls.length).toBe(0); expect(mocks.rows.get(id)?.state).toBe('prepared');
      expect(JSON.stringify(result).includes(image)).toBe(false); assertInputNotRecorded(image);
    });
    it('rejects damaged managed image bytes through the same full decoder', async () => {
      const id = await prepareVideo('video.image_to_video'), submit = vi.spyOn(provider, 'submit');
      mocks.readBlob.mockResolvedValue({ buffer: PNG, mimeType: 'image/png' });
      expect(await request(id, imageBody(`cindy-media://blobs/${'a'.repeat(64)}.png`))).toMatchObject({ errorCode: 'MEDIA_INPUT_INVALID' });
      expect(submit.mock.calls.length).toBe(0);
    });
    it('reports decoder saturation as retryable without consuming the third prepared invocation', async () => {
      const ids = await Promise.all([prepareVideo('video.image_to_video'), prepareVideo('video.image_to_video'), prepareVideo('video.image_to_video')]);
      providerFetch.mockImplementation(async () => new Response(JSON.stringify({ request_id: 'video-task-1' })));
      const image = dataUrl(videoPng), submit = vi.spyOn(provider, 'submit');
      const results = await Promise.all(ids.map((id) => request(id, imageBody(image))));
      expect(results[2]).toMatchObject({ errorCode: 'MEDIA_INPUT_BUSY', retryable: true });
      expect(mocks.rows.get(ids[2])?.state).toBe('prepared');
      expect(submit.mock.calls.length).toBe(2);
      assertInputNotRecorded(image);
    });
    it('keeps inline requests one-shot on reentry and unknown submission outcomes', async () => {
      const id = await prepareVideo('video.image_to_video'), image = dataUrl(videoPng);
      const submit = vi.spyOn(provider, 'submit');
      expect(await request(id, imageBody(image))).toMatchObject({ status: 'pending' });
      providerFetch.mockImplementation(async () => new Response(JSON.stringify({ status: 'pending' })));
      expect(await request(id, imageBody(image))).toMatchObject({ status: 'pending' });
      expect(submit.mock.calls.length).toBe(1); assertInputNotRecorded(image);
      const second = await prepareVideo('video.image_to_video');
      providerFetch.mockRejectedValue(new Error('unknown network outcome'));
      expect(await request(second, imageBody(image))).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(await request(second, imageBody(image))).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(submit.mock.calls.length).toBe(2); assertInputNotRecorded(image);
    });
    it('concurrent request and repeated pending request never resubmit', async () => {
      const id = await prepareVideo();
      let release!: () => void;
      providerFetch.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response(JSON.stringify({ request_id: 'video-task-1' }));
      });
      const first = request(id);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      expect(await request(id)).toMatchObject({ ok: false });
      release();
      expect(await first).toMatchObject({ status: 'pending' });
      providerFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'pending' })));
      expect(await request(id)).toMatchObject({ status: 'pending' });
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    });
    it('unknown submission and failed handle persistence never resubmit', async () => {
      const id = await prepareVideo();
      providerFetch.mockRejectedValue(new Error('socket lost after send'));
      expect(await request(id)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN', outcomeKnown: false });
      expect(await request(id)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(providerFetch).toHaveBeenCalledTimes(1);
      const second = await prepareVideo();
      providerFetch.mockResolvedValue(new Response(JSON.stringify({ request_id: 'task-2' })));
      mocks.failTransitionTo = 'pending';
      expect(await request(second)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(await request(second)).toMatchObject({ errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });
    it('restores serialized pending tasks with new process epochs but rejects a new login', async () => {
      const id = await prepareVideo();
      await request(id);
      mocks.rows.set(id, JSON.parse(JSON.stringify(mocks.rows.get(id))));
      epoch = 71; ownerEpoch = 'owner:44';
      succeed();
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      const second = await prepareVideo();
      loginId = 'another-login';
      expect(await request(second)).toMatchObject({ errorCode: 'ACCOUNT_CHANGED' });
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });
    it('blocks disabled new submission, but permits readonly polling of an existing task', async () => {
      const id = await prepareVideo();
      mocks.providerModel.mockReturnValue(null);
      expect(await request(id)).toMatchObject({ errorCode: 'MODEL_NOT_AVAILABLE' });
      expect(providerFetch).not.toHaveBeenCalled();
      mocks.providerModel.mockReturnValue(model);
      await request(id);
      mocks.providerModel.mockReturnValue(null);
      succeed();
      expect(await poll(id)).toMatchObject({ status: 'complete' });
    });
    it('keeps successful response on ingest failure and retries delivery after restart', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.ingestMedia.mockRejectedValue(new Error('disk unavailable'));
      expect(await poll(id)).toMatchObject({ ok: false });
      expect(mocks.rows.get(id)?.responseJson).toContain('videoUrl');
      epoch = 51; ownerEpoch = 'owner:2';
      mocks.ingestMedia.mockResolvedValue({ url: `cindy-media://blobs/${'b'.repeat(64)}.mp4` });
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(providerFetch).toHaveBeenCalledTimes(2);
    });
    it('transient poll failure leaves the handle available without new submission', async () => {
      const id = await prepareVideo(); await request(id);
      providerFetch.mockRejectedValue(new Error('network down'));
      expect(await poll(id)).toMatchObject({ errorCode: 'POLL_UNAVAILABLE', retryable: true });
      expect(mocks.rows.get(id)?.state).toBe('pending');
      succeed(); expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    });
    it('recovers the saved successful video after transport failure, exposing only safe diagnostics', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      const savedHandle = mocks.rows.get(id)?.taskId;
      const error = new TypeError('private signed URL must not escape');
      Object.assign(error, { cause: { code: 'ECONNRESET' } });
      mocks.outboundFetch.mockRejectedValue(error);
      const failed = await poll(id);
      expect(failed).toMatchObject({ errorCode: 'MEDIA_DOWNLOAD_FAILED', retryable: true, result_retained: true,
        delivery_error: { stage: 'connect', hostname: 'cdn.x.ai', networkCode: 'ECONNRESET' } });
      expect(JSON.stringify(failed).includes('private signed URL')).toBe(false);
      expect(mocks.rows.get(id)?.state).toBe('pending');
      expect(mocks.rows.get(id)?.responseJson).toContain('videoUrl');
      expect(mocks.rows.get(id)?.taskId).toBe(savedHandle);
      expect(mocks.guardedOutboundFetch.mock.calls.every(([, init, , policy]) =>
        !new Headers(init.headers).has('authorization') && policy.providerDownload === 'xai-video' && policy.allowPrivateNetwork === false)).toBe(true);
      mocks.outboundFetch.mockImplementation(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }));
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(mocks.ingestMedia.mock.calls.length).toBe(1);
      expect(providerFetch.mock.calls.length).toBe(2); // submit + original status GET, delivery retries do neither.
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it.each(['mime', 'size'])('retains the original result and refuses invalid video %s before ingest', async (kind) => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.outboundFetch.mockImplementation(async () => kind === 'mime'
        ? new Response('<html>not a video</html>', { headers: { 'content-type': 'video/mp4' } })
        : new Response(MP4, { headers: { 'content-type': 'video/mp4', 'content-length': String(256 * 1024 * 1024 + 1) } }));
      expect(await poll(id)).toMatchObject({ retryable: false, result_retained: true, delivery_error: { stage: 'validation' } });
      expect(mocks.ingestMedia.mock.calls.length).toBe(0);
      expect(mocks.rows.get(id)?.responseJson).toContain('videoUrl');
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it('distinguishes ingest failure from download failure and retries only the original delivery', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.ingestMedia.mockRejectedValue(Object.assign(new Error('private storage path'), { code: 'EACCES' }));
      expect(await poll(id)).toMatchObject({ errorCode: 'MEDIA_INGEST_FAILED', retryable: false,
        delivery_error: { stage: 'ingest', networkCode: 'EACCES' }, result_retained: true });
      mocks.ingestMedia.mockResolvedValue({ url: `cindy-media://blobs/${'b'.repeat(64)}.mp4` });
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      const writes = mocks.ingestMedia.mock.calls.length;
      await poll(id);
      expect(mocks.ingestMedia.mock.calls.length).toBe(writes);
      expect(providerFetch.mock.calls.length).toBe(2);
    });
    it('keeps a completed upstream response when the final invocation ledger update fails', async () => {
      const id = await prepareVideo(); await request(id); succeed(); mocks.failTransitionTo = 'complete';
      expect(await poll(id)).toMatchObject({ errorCode: 'MEDIA_LEDGER_PENDING', retryable: true, delivery_error: { stage: 'ledger' } });
      expect(mocks.rows.get(id)?.responseJson).toContain('videoUrl');
      mocks.failTransitionTo = null;
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it.each(['complete', 'newer-response'])('does not replace a concurrent %s when finishing native delivery', async (race) => {
      const id = await prepareVideo(); await request(id); succeed();
      let newer = '';
      mocks.ingestMedia.mockImplementationOnce(async () => {
        const current = mocks.rows.get(id)!;
        newer = race === 'complete' ? JSON.stringify({ xdt_video_urls: ['cindy-media://blobs/already.mp4'] })
          : JSON.stringify({ ...JSON.parse(current.responseJson as string), meta: { revision: 'newer' } });
        current.responseJson = newer;
        current.state = race === 'complete' ? 'complete' : 'pending';
        return { url: `cindy-media://blobs/${'b'.repeat(64)}.mp4` };
      });
      expect(await poll(id)).toMatchObject(race === 'complete'
        ? { status: 'complete', xdt_video_urls: ['cindy-media://blobs/already.mp4'] }
        : { errorCode: 'MEDIA_LEDGER_PENDING', retryable: true });
      expect(mocks.rows.get(id)?.responseJson).toBe(newer);
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it('does not relabel a saved successful generation as failed when the original task later expires', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.outboundFetch.mockResolvedValue(new Response('', { status: 403 }));
      await poll(id);
      const saved = mocks.rows.get(id)?.responseJson;
      providerFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'expired' })));
      expect(await poll(id)).toMatchObject({ errorCode: 'UPSTREAM_RESULT_UNAVAILABLE', retryable: false, result_retained: true });
      expect(mocks.rows.get(id)?.responseJson).toBe(saved);
      expect(mocks.rows.get(id)?.state).toBe('pending');
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it('stops automatic retries after one original-task refresh still returns an HTTP rejection', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.outboundFetch.mockImplementation(async () => new Response('', { status: 403 }));
      expect(await poll(id)).toMatchObject({ retryable: true, delivery_error: { httpStatus: 403 } });
      const saved = mocks.rows.get(id)?.responseJson;
      expect(await poll(id)).toMatchObject({ retryable: false, url_refresh_attempted: true,
        result_retained: true, delivery_error: { stage: 'http', httpStatus: 403 } });
      expect(mocks.rows.get(id)?.responseJson).toBe(saved);
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST').length).toBe(1);
    });
    it('distinguishes definite rejection and true task failure from unknown outcomes', async () => {
      const id = await prepareVideo();
      providerFetch.mockResolvedValue(new Response('{}', { status: 422 }));
      expect(await request(id)).toMatchObject({ errorCode: 'UPSTREAM_REJECTED', outcomeKnown: true });
      expect(mocks.rows.get(id)?.state).toBe('failed');
      const second = await prepareVideo();
      providerFetch.mockResolvedValue(new Response(JSON.stringify({ request_id: 'task-2' })));
      await request(second);
      providerFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'failed' })));
      expect(await poll(second)).toMatchObject({ errorCode: 'UPSTREAM_TASK_FAILED' });
      expect(mocks.rows.get(second)?.state).toBe('failed');
    });
    it('rejects credential epoch changes during readonly polling without losing the handle', async () => {
      const id = await prepareVideo(); await request(id);
      providerFetch.mockImplementation(async () => { epoch += 1; return new Response(JSON.stringify({ status: 'pending' })); });
      expect(await poll(id)).toMatchObject({ errorCode: 'ACCOUNT_CHANGED' });
      expect(mocks.rows.get(id)?.state).toBe('pending');
      expect(mocks.ingestMedia).not.toHaveBeenCalled();
    });
    it('preserves a task rejected by the poll endpoint without claiming terminal failure or automatic retry', async () => {
      const id = await prepareVideo(); await request(id);
      providerFetch.mockResolvedValue(new Response('{}', { status: 404 }));
      expect(await poll(id)).toMatchObject({ errorCode: 'UPSTREAM_POLL_REJECTED', retryable: false });
      expect(mocks.rows.get(id)?.state).toBe('pending');
    });
    it('refreshes an expired result URL by polling the same handle, never POSTing again', async () => {
      const id = await prepareVideo(); await request(id); succeed();
      mocks.outboundFetch.mockResolvedValue(new Response('', { status: 403 }));
      expect(await poll(id)).toMatchObject({ ok: false });
      const original = mocks.rows.get(id)?.responseJson;
      expect(original).toBeTruthy();
      mocks.outboundFetch.mockResolvedValueOnce(new Response('', { status: 403 }))
        .mockImplementation(async () => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }));
      expect(await poll(id)).toMatchObject({ status: 'complete' });
      expect(providerFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      expect(providerFetch).toHaveBeenCalledTimes(3);
    });
  });

  it('把当前及历史受管媒体地址解析为本机文件路径', async () => {
    const cases = [
      [`cindy-media://blobs/${'a'.repeat(64)}.png`, 'image/png'],
      ['xdt-image://session-1/image.jpg', 'image/jpeg'],
      ['xdt-video://lizi-art-media-videos/video.mp4', 'video/mp4'],
    ] as const;

    for (const [url, mimeType] of cases) {
      await expect(callCindyMedia({ action: 'resolve_local_path', url })).resolves.toEqual({
        ok: true,
        url,
        local_path: process.execPath,
        mime_type: mimeType,
      });
    }
    await expect(
      callCindyMedia({ action: 'resolve_local_path', url: 'xdt-audio://local/?path=/tmp/a.mp3' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_INPUT' });
  });

  it('按 modelId 取 Guide、覆盖 body.model，并以一次性 invocation 完成同步结果入仓', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const invocationId = await prepare();
    const result = await callCindyMedia({
      action: 'request',
      invocationId,
      body: { prompt: 'cat', model: 'agent-must-not-control-this' },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'complete',
    });
    expect(String(result.hint)).toContain('只嵌入展示一次');
    expect(result).not.toHaveProperty('_xdt_render_image');
    const [, init] = mocks.outboundFetch.mock.calls[0];
    expect(mocks.outboundFetch.mock.calls[0][0]).toBe(
      'https://gateway.example.com/images/generations',
    );
    expect(JSON.parse(init.body)).toEqual({ prompt: 'cat', model: 'image-model' });
    expect(init.headers.Authorization).toBe('Bearer test-api-key');
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'again' } }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'complete',
      xdt_image_urls: [`cindy-media://blobs/${'a'.repeat(64)}.png`],
    });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
    expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('materializes large base64 images with %i trailing padding characters', async (padding) => {
    const op = operation({
      mode: 'sync',
      media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
    });
    op.request.maxResponseBytes = 32 * 1024 * 1024;
    mocks.guide.mockResolvedValue(resolvedGuide(op));
    // Only the decoder and MIME probe are under test; ingestion is mocked.
    const bytes = Buffer.alloc(6 * 1024 * 1024 - padding);
    PNG.copy(bytes);
    const encoded = bytes.toString('base64');
    mocks.outboundFetch.mockResolvedValue(new Response(JSON.stringify({
      data: padding === 0 ? encoded : `data:image/png;base64,\n${encoded}\n`,
    }), { status: 200 }));

    const invocationId = await prepare();
    await expect(callCindyMedia({
      action: 'request', invocationId, body: { prompt: 'large image' },
    })).resolves.toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
    expect(mocks.ingestMedia.mock.calls[0][0].buffer.equals(bytes)).toBe(true);
  });

  it.each(['A', 'AAA', 'AAAA=', 'A===', 'AA=A', '====', 'AA-_', 'AAA!'])('rejects malformed base64 %s before ingestion', async (encoded) => {
    mocks.guide.mockResolvedValue(resolvedGuide(operation({
      mode: 'sync',
      media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
    })));
    mocks.outboundFetch.mockResolvedValue(new Response(JSON.stringify({ data: encoded }), { status: 200 }));
    const invocationId = await prepare();
    await expect(callCindyMedia({
      action: 'request', invocationId, body: { prompt: 'image' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'MEDIA_RESULT_INVALID' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('Guide 查询键无前缀时仍持久化并提交完整 Gateway modelId', async () => {
    const fullModelId = 'openai/gpt-image-2';
    mocks.models.mockResolvedValue([
      { id: fullModelId, name: 'GPT Image 2', providerId: 'xd', mode: 'image_generation' },
    ]);
    mocks.guide.mockResolvedValue({
      ...resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
      modelId: 'gpt-image-2',
    });
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: fullModelId,
      capability: 'image.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } });

    expect(prepared).toMatchObject({ ok: true, model_id: fullModelId });
    expect(mocks.guide).toHaveBeenCalledWith(fullModelId);
    expect(mocks.rows.get(invocationId)?.modelId).toBe(fullModelId);
    const [, init] = mocks.outboundFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ model: fullModelId });
  });

  it.each([
    [false, 'openai'], [true, 'openai'], [true, 'openai-independent'],
  ] as const)('同名媒体模型按 providerId 精确准备并调用第三方来源 (local=%s, provider=%s)', async (localMode, providerId) => {
    mocks.localMode = localMode;
    const providerModel = {
      id: `${providerId}/gpt-image-2`,
      name: 'GPT Image 2',
      providerId,
      mode: 'image_generation',
      modalities: { input: ['text', 'image'], output: ['image'] },
      officialDocs: 'https://platform.openai.com/docs/guides/image-generation',
    };
    mocks.models.mockResolvedValue([
      { ...providerModel, providerId: 'xd' },
      providerModel,
    ]);
    mocks.providerModel.mockReturnValue(providerModel);
    mocks.providerInvoke.mockResolvedValue({ buffer: PNG, mimeType: 'image/png' });

    const prepared = await callCindyMedia({
      action: 'prepare',
      providerId,
      modelId: providerModel.id,
      capability: 'image.generate',
    });

    expect(prepared).toMatchObject({
      ok: true,
      status: 'prepared',
      provider_id: providerId,
      model_id: providerModel.id,
    });
    expect(mocks.guide).not.toHaveBeenCalled();

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: prepared.invocation_id as string,
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'complete',
      xdt_image_urls: [`cindy-media://blobs/${'a'.repeat(64)}.png`],
    });
    expect(mocks.providerInvoke).toHaveBeenCalledWith({
      providerId,
      modelId: providerModel.id,
      capability: 'image.generate',
      prompt: 'cat',
      imagePaths: [],
      signal: expect.any(AbortSignal),
    });
    expect(mocks.rows.get(prepared.invocation_id as string)?.owner).toBe(
      localMode ? `local:${mocks.dbOwnerId}` : `cn:${mocks.currentUserId}`,
    );
    mocks.localMode = !localMode;
    mocks.ownerGeneration += 1;
    await expect(callCindyMedia({ action: 'poll', invocationId: prepared.invocation_id as string }))
      .resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_NOT_FOUND' });
    expect(mocks.providerInvoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['openai', 'account/gpt-image-2.5-sunburst', { size: '1760x3824', quality: 'max' }, { size: '1760x3824', quality: 'max' }],
    ['gemini', 'gemini/gemini-3-pro-image', { aspect_ratio: '16:9', resolution: '4k' }, { aspectRatio: '16:9', resolution: '4K' }],
    ['xai', 'xai/grok-imagine-image', { aspect_ratio: '9:19.5', resolution: '2K' }, { aspectRatio: '9:19.5', resolution: '2k' }],
  ] as const)('carries %s image parameters from prepare to dispatch', async (imageProtocol, id, body, expected) => {
    const model = { id, name: id, providerId: 'custom-account', mode: 'image_generation', imageProtocol,
      modalities: { input: ['text'], output: ['image'] } };
    mocks.models.mockResolvedValue([model]);
    mocks.providerModel.mockReturnValue(model);
    mocks.providerInvoke.mockResolvedValue({ buffer: PNG, mimeType: 'image/png' });
    const prepared = await callCindyMedia({ action: 'prepare', providerId: model.providerId, modelId: id, capability: 'image.generate' });
    expect(prepared.ok).toBe(true);
    for (const key of Object.keys(body)) expect((prepared.input_schema as Record<string, unknown>).properties).toHaveProperty(key);
    const result = await callCindyMedia({ action: 'request', invocationId: prepared.invocation_id as string, body: { prompt: 'image', ...body } });
    expect(result.ok).toBe(true);
    expect(mocks.providerInvoke).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it('invalid native size remains editable before claiming a paid invocation', async () => {
    const model = { id: 'openai/gpt-image-2.5-sunburst', name: 'Sunburst', providerId: 'openai', imageProtocol: 'openai',
      mode: 'image_generation', modalities: { input: ['text'], output: ['image'] } };
    mocks.models.mockResolvedValue([model]);
    mocks.providerModel.mockReturnValue(model);
    mocks.providerInvoke.mockResolvedValue({ buffer: PNG, mimeType: 'image/png' });
    const prepared = await callCindyMedia({ action: 'prepare', providerId: 'openai', modelId: model.id, capability: 'image.generate' });
    const invocationId = prepared.invocation_id as string;
    expect(await callCindyMedia({ action: 'request', invocationId, body: { prompt: 'p', size: '1320x2868' } })).toMatchObject({ ok: false, errorCode: 'REQUEST_INVALID' });
    expect(mocks.providerInvoke).not.toHaveBeenCalled();
    expect(mocks.rows.get(invocationId)?.state).toBe('prepared');
    expect(await callCindyMedia({ action: 'request', invocationId, body: { prompt: 'p', size: '1760x3824', quality: 'max' } })).toMatchObject({ ok: true });
    expect(mocks.providerInvoke).toHaveBeenCalledTimes(1);
  });

  it('validates Gateway GPT Image geometry without a paid round trip', async () => {
    const id = 'openai/gpt-image-2.5-sunburst';
    mocks.models.mockResolvedValue([{ id, name: 'Sunburst', providerId: 'xd', mode: 'image_generation' }]);
    const guide = resolvedGuide(operation({ mode: 'sync', media: [{ path: ['data'], encoding: 'base64', kind: 'image' }] }));
    guide.modelId = id;
    mocks.guide.mockResolvedValue(guide);
    const prepared = await callCindyMedia({ action: 'prepare', providerId: 'xd', modelId: id, capability: 'image.generate' });
    expect(await callCindyMedia({ action: 'request', invocationId: prepared.invocation_id as string, body: { prompt: 'p', size: '1320x2868' } })).toMatchObject({ ok: false, errorCode: 'REQUEST_INVALID' });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('本机准备期间同 owner 代次变化时不保存调用', async () => {
    mocks.localMode = true;
    mocks.models.mockImplementationOnce(async () => {
      mocks.ownerGeneration += 1;
      return [];
    });
    await expect(callCindyMedia({ action: 'prepare', providerId: 'openai', modelId: 'openai/gpt-image-2', capability: 'image.generate' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.rows.size).toBe(0);
    expect(mocks.providerInvoke).not.toHaveBeenCalled();
  });

  it('本机模式不向 Cindy 网关申请 Guide', async () => {
    mocks.localMode = true;
    await expect(callCindyMedia({ action: 'prepare', providerId: 'xd', modelId: 'image-model', capability: 'image.generate' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'CONNECTION_UNAVAILABLE' });
    expect(mocks.guide).not.toHaveBeenCalled();
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('旧调用未传 providerId 时裸 ID 唯一升级且同名来源优先 Cindy AI', async () => {
    const model = {
      id: 'openai/gpt-image-2',
      name: 'GPT Image 2',
      providerId: 'openai',
      mode: 'image_generation',
      modalities: { input: ['text', 'image'], output: ['image'] },
      officialDocs: 'https://platform.openai.com/docs/guides/image-generation',
    };
    mocks.models.mockResolvedValue([{ ...model, providerId: 'xd' }, model]);
    mocks.guide.mockResolvedValue(
      resolvedGuide(operation({ mode: 'sync', media: [] })),
    );

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'gpt-image-2',
      capability: 'image.generate',
    });
    expect(prepared).toMatchObject({
      ok: true,
      provider_id: 'xd',
      model_id: model.id,
    });
    expect(mocks.guide).toHaveBeenCalledWith(model.id);
    expect(mocks.providerModel).not.toHaveBeenCalled();
  });

  it('终态历史不占用在途 invocation 上限', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    for (let index = 0; index < 128; index += 1) {
      mocks.rows.set(`complete-${index}`, { state: 'complete' });
    }

    await expect(
      callCindyMedia({
        action: 'prepare',
        modelId: 'image-model',
        capability: 'image.generate',
      }),
    ).resolves.toMatchObject({ ok: true, status: 'prepared' });
  });

  it('按 Guide 把受管图片机械组装为 multipart 文件请求', async () => {
    const op = operation(
      {
        mode: 'sync',
        media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
      },
      '/v1/images/edits',
    );
    const multipartOp = {
      ...op,
      capability: 'image.generate',
      request: {
        ...op.request,
        bodyEncoding: 'multipart',
        multipartFiles: [
          { bodyField: 'image', formField: 'image[]', kind: 'image', maxItems: 16 },
        ],
      },
    };
    mocks.guide.mockResolvedValue(resolvedGuide(multipartOp));
    mocks.readBlob.mockResolvedValue({ buffer: PNG, mimeType: 'image/png' });
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), { status: 200 }),
    );

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: {
          prompt: 'add snow',
          image: `cindy-media://blobs/${'b'.repeat(64)}.png`,
        },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });

    const [, init] = mocks.outboundFetch.mock.calls[0];
    expect(init.headers).not.toHaveProperty('Content-Type');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('image-model');
    expect(form.get('prompt')).toBe('add snow');
    expect(form.get('image[]')).toBeInstanceOf(Blob);
  });

  it.each([
    ['image.generate', 'image'],
    ['video.image_to_video', 'image'],
  ] as const)('%s：受管大图（base64 ≥ 2^22 字符）的 multipart 组装与发出回归（#5081）', async (capability, kind) => {
    const op = operation(
      {
        mode: 'sync',
        media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
      },
      '/v1/images/edits',
    );
    mocks.guide.mockResolvedValue(
      resolvedGuide({
        ...op,
        capability,
        request: {
          ...op.request,
          bodyEncoding: 'multipart',
          maxRequestBytes: 8 * 1024 * 1024,
          multipartFiles: [{ bodyField: 'image', formField: 'image', kind, maxItems: 1 }],
        },
      }),
    );
    // 8 字节 PNG 签名 + 3.2MiB 填充 → base64 约 4.47M 字符，覆盖 #5081 报告的阈值之上。
    const largePng = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(3.2 * 1024 * 1024, 7)]);
    mocks.readBlob.mockResolvedValue({ buffer: largePng, mimeType: 'image/png' });
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), { status: 200 }),
    );

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(capability),
        body: { prompt: 'animate', image: `cindy-media://blobs/${'b'.repeat(64)}.png` },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });

    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
    const [, init] = mocks.outboundFetch.mock.calls[0];
    const file = (init.body as FormData).get('image');
    expect(file).toBeInstanceOf(Blob);
    expect((file as Blob).size).toBe(largePng.byteLength);
  });

  it('请求在本地组装阶段抛错时归类为 REQUEST_BUILD_FAILED，可重试且不标记结果未知（#5081）', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.failRequestLog = true;

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'REQUEST_BUILD_FAILED',
      retryable: true,
      outcomeKnown: true,
    });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
    // 请求从未出站：invocation 回到 prepared，同一 invocation_id 再次 request 可正常发出。
    expect(mocks.rows.get(invocationId)?.state).toBe('prepared');
    mocks.failRequestLog = false;
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), { status: 200 }),
    );
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('同步生成成功后下载暂时失败时复用已保存响应，不会再次付费 POST', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['cdn.example.com'],
            },
          ],
        }),
      ),
    );
    mocks.outboundFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'https://cdn.example.com/generated.png' }), {
          status: 200,
        }),
      )
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      );

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
      retryable: false,
    });
    expect(mocks.rows.get(invocationId)).toMatchObject({
      state: 'pending',
      responseJson: JSON.stringify({ data: 'https://cdn.example.com/generated.png' }),
    });

    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'ignored-on-retry' } }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(5);
    expect(mocks.outboundFetch.mock.calls[0][0]).toBe(
      'https://gateway.example.com/images/generations',
    );
    expect(mocks.outboundFetch.mock.calls[1][0]).toBe('https://cdn.example.com/generated.png');
    expect(mocks.outboundFetch.mock.calls[2][0]).toBe('https://cdn.example.com/generated.png');
  });

  it('结果下载期间账号切换时不向新账号入库，并允许原账号恢复结果', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['cdn.example.com'],
            },
          ],
        }),
      ),
    );
    const originalUserId = mocks.currentUserId;
    const originalDb = mocks.db;
    mocks.outboundFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'https://cdn.example.com/generated.png' }), {
          status: 200,
        }),
      )
      .mockImplementationOnce(async () => {
        mocks.currentUserId = `other-user-${crypto.randomUUID()}`;
        mocks.ownerGeneration += 1;
        mocks.dbOwnerId = mocks.currentUserId;
        mocks.db = {
          owner: mocks.currentUserId,
          drizzle: { owner: mocks.currentUserId },
        };
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      })
      .mockResolvedValueOnce(
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      );

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
    expect(mocks.rows.get(invocationId)?.state).toBe('pending');

    mocks.currentUserId = originalUserId;
    mocks.ownerGeneration += 1;
    mocks.dbOwnerId = originalUserId;
    mocks.db = originalDb;
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'ignored-on-retry' } }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(3);
    expect(mocks.transitionDbs.every((db) => db === originalDb)).toBe(true);
  });

  it('结果入库期间账号切换时沿用原账号 DB，并在写入闸处停止', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), { status: 200 }),
    );
    const originalDb = mocks.db;
    mocks.ingestMedia.mockImplementationOnce(async (
      params: { assertStillValid(): void },
      db: unknown,
    ) => {
      expect(db).toBe(originalDb.drizzle);
      mocks.currentUserId = `other-user-${crypto.randomUUID()}`;
      mocks.ownerGeneration += 1;
      mocks.dbOwnerId = mocks.currentUserId;
      mocks.db = {
        owner: mocks.currentUserId,
        drizzle: { owner: mocks.currentUserId },
      };
      params.assertStillValid();
      throw new Error('unreachable');
    });

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.rows.get(invocationId)?.state).toBe('pending');
    expect(mocks.transitionDbs.every((db) => db === originalDb)).toBe(true);
    expect(mocks.ingestMedia).toHaveBeenCalledOnce();
  });

  it.each([
    ['sync', 2], ['sync', 3], ['async', 2], ['async', 3],
  ] as const)('%s 入库失败 %i 次时仅重试已有字节，不再下载或审批', async (mode, failures) => {
    const media = [{ path: ['data'], encoding: 'url', kind: 'image', allowedUrlHosts: ['known.example.com'] }];
    mocks.guide.mockResolvedValue(resolvedGuide(operation(mode === 'sync'
      ? { mode, media }
      : { mode, taskIdPath: ['task_id'], poll: {
          method: 'GET', path: '/tasks/{taskId}', statusPath: ['status'],
          successValues: ['succeeded'], failureValues: ['failed'], recommendedIntervalMs: 10,
          timeoutMs: 5_000, maxResponseBytes: 1_048_576, media,
        } })));
    const payload = { status: 'succeeded', data: 'https://new.example.com/generated.png' };
    if (mode === 'async') {
      mocks.outboundFetch.mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'storage-retry' })));
    }
    mocks.outboundFetch.mockResolvedValueOnce(new Response(JSON.stringify(payload)))
      .mockResolvedValueOnce(new Response(PNG));
    for (let index = 0; index < failures; index += 1) {
      mocks.ingestMedia.mockRejectedValueOnce(new Error('temporary database failure'));
    }
    const invocationId = await prepare();
    let result = await callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } });
    if (mode === 'async') result = await callCindyMedia({ action: 'poll', invocationId });
    if (failures === 2) {
      expect(result).toMatchObject({ ok: true, status: 'complete' });
    } else {
      expect(result).toMatchObject({ ok: false, errorCode: 'MEDIA_MATERIALIZATION_FAILED', retryable: false });
      expect(mocks.rows.get(invocationId)).toMatchObject({ state: 'pending', responseJson: JSON.stringify(payload) });
    }
    expect(mocks.ingestMedia).toHaveBeenCalledTimes(3);
    const firstFile = mocks.ingestMedia.mock.calls[0][0].filePath;
    expect(firstFile).toEqual(expect.any(String));
    expect(mocks.ingestMedia.mock.calls.every(([input]) => input.filePath === firstFile && !input.buffer)).toBe(true);
    await expect(fs.stat(firstFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.guardedOutboundFetch).toHaveBeenCalledOnce();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.outboundFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it.each(['missing', 'invalid', 'expired', 'storage'])(
    '刷新结果 %s 失败时保留原成功响应', async (failure) => {
      mocks.guide.mockResolvedValue(resolvedGuide(operation({
        mode: 'async', taskIdPath: ['task_id'], poll: {
          method: 'GET', path: '/tasks/{taskId}', statusPath: ['status'],
          successValues: ['succeeded'], failureValues: ['failed'], recommendedIntervalMs: 10,
          timeoutMs: 5_000, maxResponseBytes: 1_048_576,
          media: [{ path: ['data'], encoding: 'url', kind: 'image', allowedUrlHosts: ['cdn.example.com'] }],
        },
      })));
      const original = { status: 'succeeded', data: 'https://cdn.example.com/original.png', task_id: 'preserved-task' };
      const refreshed = { status: 'succeeded', ...(failure === 'missing' ? {} : { data: 'https://cdn.example.com/refreshed.png' }) };
      mocks.outboundFetch.mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'preserved-task' })))
        .mockResolvedValueOnce(new Response(JSON.stringify(original)))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(refreshed)))
        .mockResolvedValueOnce(failure === 'expired' ? new Response(null, { status: 403 })
          : new Response(failure === 'invalid' ? 'not an image' : PNG));
      if (failure === 'storage') mocks.ingestMedia.mockRejectedValue(new Error('storage unavailable'));
      const invocationId = await prepare();
      await callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } });
      expect(await callCindyMedia({ action: 'poll', invocationId })).toMatchObject({ ok: false, retryable: false });
      expect(mocks.rows.get(invocationId)).toMatchObject({ state: 'pending', responseJson: JSON.stringify(original) });
      expect(mocks.outboundFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
      expect(mocks.outboundFetch.mock.calls.filter(([url]) => url === 'https://gateway.example.com/tasks/preserved-task')).toHaveLength(2);
    },
  );

  it('Guide 缺少目标 operation 时在 prepare 返回稳定的能力不支持错误', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide({
        ...operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
        capability: 'image.edit',
      }),
    );

    await expect(
      callCindyMedia({
        action: 'prepare',
        modelId: 'image-model',
        capability: 'image.generate',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_SUPPORTED' });
    expect(mocks.rows.size).toBe(0);
  });

  it('付费提交网络结果未知后禁止再次 POST', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockRejectedValue(new TypeError('network unavailable'));

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SUBMISSION_OUTCOME_UNKNOWN' });
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.rows.get(invocationId)?.state).toBe('unknown');
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('付费提交收到 2xx 非法 JSON 时保留 unknown，禁止再次 POST', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(new Response('{invalid-json', { status: 200 }));

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SUBMISSION_OUTCOME_UNKNOWN',
      outcomeKnown: false,
    });
    expect(mocks.rows.get(invocationId)?.state).toBe('unknown');
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('建连失败发生在派发前时恢复 prepared，不把 invocation 卡在 submitting', async () => {
    const resolved = resolvedGuide(
      operation({
        mode: 'sync',
        media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
      }),
    );
    resolved.guide.connection.providerId = 'unsupported';
    mocks.guide.mockResolvedValue(resolved);

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'CONNECTION_NOT_SUPPORTED',
      outcomeKnown: true,
      retryable: false,
    });
    expect(mocks.rows.get(invocationId)?.state).toBe('prepared');
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('上游成功后响应持久化抛错时保留 unknown，禁止自动重提', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: PNG.toString('base64') }), { status: 200 }),
    );
    mocks.failTransitionTo = 'pending';

    const invocationId = await prepare();
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'SUBMISSION_OUTCOME_UNKNOWN',
      outcomeKnown: false,
    });
    expect(mocks.rows.get(invocationId)?.state).toBe('unknown');
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);
  });

  it('付费提交准备参数期间账号切换时不发出上游请求', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    const invocationId = await prepare();
    mocks.models.mockImplementationOnce(async () => {
      mocks.currentUserId = `other-user-${crypto.randomUUID()}`;
      mocks.ownerGeneration += 1;
      mocks.dbOwnerId = mocks.currentUserId;
      mocks.db = {
        owner: mocks.currentUserId,
        drizzle: { owner: mocks.currentUserId },
      };
      return [
        { id: 'image-model', name: 'Image Model', providerId: 'xd', mode: 'image_generation' },
      ];
    });

    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
    expect(mocks.rows.get(invocationId)?.state).toBe('prepared');
  });

  it('进程中断遗留的 submitting 在恢复时转为 unknown，不会补发 POST', async () => {
    const op = operation({
      mode: 'sync',
      media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
    });
    const resolved = resolvedGuide(op);
    const invocationId = crypto.randomUUID();
    const now = Date.now();
    mocks.rows.set(invocationId, {
      id: invocationId,
      owner: `cn:${mocks.currentUserId}`,
      modelId: resolved.modelId,
      capability: op.capability,
      guideRevision: resolved.guide.revision,
      guide: {
        modelId: resolved.modelId,
        schemaVersion: resolved.guide.schemaVersion,
        guideId: resolved.guide.guideId,
        revision: resolved.guide.revision,
        connection: resolved.guide.connection,
        ...op,
      },
      state: 'submitting',
      createdAt: now,
      updatedAt: now,
    });
    mocks.recover.mockImplementationOnce(async (owner: string) => {
      let recovered = 0;
      for (const row of mocks.rows.values()) {
        if (row.owner === owner && row.state === 'submitting') {
          row.state = 'unknown';
          recovered += 1;
        }
      }
      return recovered;
    });

    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { prompt: 'cat' } }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INVOCATION_ALREADY_USED' });
    expect(mocks.recover).toHaveBeenCalledWith(`cn:${mocks.currentUserId}`, mocks.db);
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('不接受 Guide/Content-Type 冒充的图片字节', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image', mediaType: 'image/png' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: Buffer.from('not-an-image').toString('base64') }), {
        status: 200,
      }),
    );

    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'MEDIA_RESULT_INVALID' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('响应超过 Guide 上限时拒绝入仓', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1_048_577) },
      }),
    );

    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'RESPONSE_TOO_LARGE' });
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('上游错误文本进入 Agent 前脱敏 URL、凭据和长值', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [{ path: ['data'], encoding: 'base64', kind: 'image' }],
        }),
      ),
    );
    const opaque = 'A'.repeat(120);
    mocks.outboundFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          message: `bad https://cdn.example.com/x?signature=secret Bearer token-1234567890123456 ${opaque}`,
        }),
        { status: 400 },
      ),
    );

    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'UPSTREAM_REJECTED' });
    expect(result.message).not.toContain('signature=secret');
    expect(result.message).not.toContain('token-1234567890123456');
    expect(result.message).not.toContain(opaque);
  });

  it('受限网络未获批准时不下载，批准新 CDN 后不携带网关凭据', async () => {
    const urlOperation = operation({
      mode: 'sync',
      media: [
        {
          path: ['data'],
          encoding: 'url',
          kind: 'image',
          allowedUrlHosts: ['cdn.example.com'],
        },
      ],
    });
    mocks.guide.mockResolvedValue(resolvedGuide(urlOperation));
    mocks.outboundFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 'https://127.0.0.1/private.png' }), { status: 200 }),
    );

    mocks.confirm.mockImplementation(async ({ reasons }) => !reasons.includes('network'));
    mocks.guardedOutboundFetch.mockRejectedValueOnce(new SsrFBlockedError('blocked private IP'));
    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MEDIA_DOWNLOAD_DENIED' });
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(1);

    mocks.outboundFetch
      .mockReset()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: 'https://new-cdn.example.com/generated.png?signature=opaque' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
      );
    await expect(
      callCindyMedia({
        action: 'request',
        invocationId: await prepare(),
        body: { prompt: 'cat' },
      }),
    ).resolves.toMatchObject({ ok: true, status: 'complete' });
    const [, downloadInit] = mocks.outboundFetch.mock.calls[1];
    expect(downloadInit.redirect).toBe('manual');
    expect(mocks.guardedOutboundFetch).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(downloadInit.headers).toBeUndefined();
  });

  it.each(['video.generate', 'video.image_to_video'] as const)(
    '%s 经人工批准后下载未登记的供应商 CDN 结果',
    async (capability) => {
      const asyncOperation = {
        ...operation(
          {
            mode: 'async',
            taskIdPath: ['task_id'],
            poll: {
              method: 'GET',
              path: '/video/tasks/{taskId}',
              statusPath: ['status'],
              successValues: ['succeeded'],
              failureValues: ['failed'],
              recommendedIntervalMs: 10,
              timeoutMs: 5_000,
              maxResponseBytes: 1_048_576,
              media: [
                {
                  path: ['video', 'download_url'],
                  encoding: 'url',
                  kind: 'video',
                  allowedUrlHosts: ['cdn.example.com'],
                },
              ],
            },
          },
          '/video/tasks',
        ),
        capability,
      };
      mocks.models.mockResolvedValue([
        {
          id: 'minimax/minimax-h3',
          name: 'MiniMax H3',
          providerId: 'xd',
          mode: 'video_generation',
        },
      ]);
      mocks.guide.mockResolvedValue({
        ...resolvedGuide(asyncOperation),
        modelId: 'minimax-h3',
      });
      mocks.outboundFetch
        .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 'succeeded',
              video: {
                download_url:
                  'https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/generated.mp4',
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } }),
        );
      mocks.ingestMedia.mockResolvedValue({
        url: `cindy-media://blobs/${'e'.repeat(64)}.mp4`,
      });

      const prepared = await callCindyMedia({
        action: 'prepare',
        modelId: 'minimax/minimax-h3',
        capability,
      });
      const invocationId = prepared.invocation_id as string;
      await expect(
        callCindyMedia({ action: 'request', invocationId, body: { content: [] } }),
      ).resolves.toMatchObject({ ok: true, status: 'pending' });
      await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
        ok: true,
        status: 'complete',
        xdt_video_urls: [`cindy-media://blobs/${'e'.repeat(64)}.mp4`],
      });
      expect(mocks.outboundFetch.mock.calls[2][0]).toBe(
        'https://algeng-video-infer.oss-cn-shanghai.aliyuncs.com/generated.mp4',
      );
    },
  );

  it('逐跳校验重定向并释放响应，变更来源才再次审批', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['old.example.com'],
            },
          ],
        }),
      ),
    );
    const cancelRedirect = vi.fn();
    mocks.outboundFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'https://new.example.com/start' })),
      )
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: cancelRedirect }), {
          status: 302,
          headers: { location: '/next' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: 'https://cdn.example.com/end' } }),
      )
      .mockResolvedValueOnce(new Response(PNG));
    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: {},
    });
    expect(result).toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.guardedOutboundFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://new.example.com/start',
      'https://new.example.com/next',
      'https://cdn.example.com/end',
    ]);
    const signals = mocks.guardedOutboundFetch.mock.calls.map(([, init]) => init.signal);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(
      mocks.guardedOutboundFetch.mock.calls.every(([, init]) => init.headers === undefined),
    ).toBe(true);
    expect(cancelRedirect).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledTimes(3);
  });

  it.each([
    'http://cdn.example.com/x',
    'https://user:pass@cdn.example.com/x',
    'https://cdn.example.com:8443/x',
  ])('重定向权限变化且用户拒绝时停止 %s', async (location) => {
    mocks.confirm.mockImplementation(async ({ reasons }) => reasons.every((reason) => reason === 'source'));
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['old.example.com'],
            },
          ],
        }),
      ),
    );
    mocks.outboundFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'https://cdn.example.com/start' })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    await expect(
      callCindyMedia({ action: 'request', invocationId: await prepare(), body: {} }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MEDIA_DOWNLOAD_DENIED' });
    expect(mocks.guardedOutboundFetch).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('服务端循环跳转返回下载错误，不增加审批', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['old.example.com'],
            },
          ],
        }),
      ),
    );
    mocks.outboundFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: 'https://cdn.example.com/start' })),
      )
      .mockImplementation(
        async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
      );
    await expect(
      callCindyMedia({ action: 'request', invocationId: await prepare(), body: {} }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'MEDIA_DOWNLOAD_REDIRECT_LOOP' });
    expect(mocks.guardedOutboundFetch).toHaveBeenCalledTimes(2);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it('超过原图片大小限制的 URL 结果直接分块落盘入库，只审批来源一次', async () => {
    mocks.guide.mockResolvedValue(resolvedGuide(operation({
      mode: 'sync',
      media: [{ path: ['data'], encoding: 'url', kind: 'image', allowedUrlHosts: ['old.example.com'] }],
    })));
    const chunk = Buffer.alloc(64 * 1024);
    PNG.copy(chunk);
    let remaining = 33 * 16;
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: 'https://cdn.example.com/large' })))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        pull(controller) {
          if (remaining-- > 0) controller.enqueue(chunk);
          else controller.close();
        },
      })));
    mocks.ingestMedia.mockImplementationOnce(async ({ filePath, buffer, mimeType }) => {
      expect(buffer).toBeUndefined();
      expect(mimeType).toBe('image/png');
      expect((await fs.stat(filePath)).size).toBe(33 * 1024 * 1024);
      return { url: 'cindy-media://blobs/' + 'a'.repeat(64) + '.png' };
    });
    await expect(callCindyMedia({ action: 'request', invocationId: await prepare(), body: {} }))
      .resolves.toMatchObject({ ok: true, status: 'complete' });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.confirm.mock.calls[0][0].reasons).toEqual(['source']);
    expect(mocks.release).toHaveBeenCalledOnce();
    await expect(fs.stat(mocks.ingestMedia.mock.calls[0][0].filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('DNS 等待期间切号会在 dispatch 前拒绝领取', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation({
          mode: 'sync',
          media: [
            {
              path: ['data'],
              encoding: 'url',
              kind: 'image',
              allowedUrlHosts: ['old.example.com'],
            },
          ],
        }),
      ),
    );
    mocks.outboundFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 'https://cdn.example.com/x' })),
    );
    mocks.guardedOutboundFetch.mockImplementationOnce(async (_url, _init, beforeDispatch) => {
      mocks.ownerGeneration++;
      await beforeDispatch();
      throw new Error('must not dispatch');
    });
    await expect(
      callCindyMedia({ action: 'request', invocationId: await prepare(), body: {} }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'ACCOUNT_CHANGED' });
    expect(mocks.outboundFetch).toHaveBeenCalledOnce();
    expect(mocks.ingestMedia).not.toHaveBeenCalled();
  });

  it('即使持久快照异常包含反斜杠路径，也在发网前拒绝跨 Gateway origin', async () => {
    mocks.guide.mockResolvedValue(
      resolvedGuide(
        operation(
          { mode: 'sync', media: [{ path: ['data'], encoding: 'base64', kind: 'image' }] },
          '/\\evil.example.com/steal',
        ),
      ),
    );
    const result = await callCindyMedia({
      action: 'request',
      invocationId: await prepare(),
      body: { prompt: 'cat' },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'GUIDE_INVALID' });
    expect(mocks.outboundFetch).not.toHaveBeenCalled();
  });

  it('异步提交持久化 task id，poll 可跨调用恢复并下载视频', async () => {
    const asyncOperation = {
      ...operation({
        mode: 'async',
        taskIdPath: ['task_id'],
        poll: {
          method: 'GET',
          path: '/video/tasks/{taskId}',
          statusPath: ['status'],
          successValues: ['succeeded'],
          failureValues: ['failed'],
          recommendedIntervalMs: 10,
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          media: [{ path: ['video'], encoding: 'base64', kind: 'video' }],
        },
      }, '/video/tasks'),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', providerId: 'xd', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'succeeded', video: MP4.toString('base64') }),
          { status: 200 },
        ),
      );
    mocks.ingestMedia.mockResolvedValue({
      url: `cindy-media://blobs/${'b'.repeat(64)}.mp4`,
    });

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await expect(
      callCindyMedia({ action: 'request', invocationId, body: { content: [] } }),
    ).resolves.toMatchObject({ ok: true, status: 'pending' });
    const completed = await callCindyMedia({ action: 'poll', invocationId });
    expect(completed).toMatchObject({
      ok: true,
      status: 'complete',
      xdt_video_urls: [`cindy-media://blobs/${'b'.repeat(64)}.mp4`],
    });
    expect(completed).not.toHaveProperty('_xdt_render_image');
    expect(mocks.outboundFetch.mock.calls[1][0]).toBe(
      'https://gateway.example.com/video/tasks/task-1',
    );
  });

  it('异步成功响应先持久化，临时下载失败后不再查询上游任务并可重放完成结果', async () => {
    const asyncOperation = {
      ...operation({
        mode: 'async',
        taskIdPath: ['task_id'],
        poll: {
          method: 'GET',
          path: '/video/tasks/{taskId}',
          statusPath: ['status'],
          successValues: ['succeeded'],
          failureValues: ['failed'],
          recommendedIntervalMs: 10,
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          media: [
            {
              path: ['video'],
              encoding: 'url',
              kind: 'video',
              allowedUrlHosts: ['cdn.example.com'],
            },
          ],
        },
      }, '/video/tasks'),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', providerId: 'xd', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    const successPayload = {
      status: 'succeeded',
      video: 'https://cdn.example.com/generated.mp4',
    };
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-retry' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(successPayload), { status: 200 }))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(
        new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } }),
      );
    mocks.ingestMedia.mockResolvedValue({
      url: `cindy-media://blobs/${'d'.repeat(64)}.mp4`,
    });

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await callCindyMedia({ action: 'request', invocationId, body: { content: [] } });

    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MEDIA_DOWNLOAD_FAILED',
      retryable: false,
    });
    expect(mocks.rows.get(invocationId)).toMatchObject({
      state: 'pending',
      responseJson: JSON.stringify(successPayload),
    });

    mocks.rows.get(invocationId)!.updatedAt = 1;
    const completed = {
      ok: true,
      status: 'complete',
      xdt_video_urls: [`cindy-media://blobs/${'d'.repeat(64)}.mp4`],
    };
    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject(completed);
    expect(Number(mocks.rows.get(invocationId)!.updatedAt)).toBeGreaterThan(1);
    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject(completed);
    expect(mocks.outboundFetch).toHaveBeenCalledTimes(6);
    expect(mocks.outboundFetch.mock.calls[1][0]).toBe(
      'https://gateway.example.com/video/tasks/task-retry',
    );
    expect(mocks.ingestMedia).toHaveBeenCalledTimes(1);
  });

  it('异步结果异常保留成功响应，不诱导自动重复 poll', async () => {
    const asyncOperation = {
      ...operation({
        mode: 'async',
        taskIdPath: ['task_id'],
        poll: {
          method: 'GET',
          path: '/video/tasks/{taskId}',
          statusPath: ['status'],
          successValues: ['succeeded'],
          failureValues: ['failed'],
          recommendedIntervalMs: 10,
          timeoutMs: 5_000,
          maxResponseBytes: 1_048_576,
          media: [{ path: ['video'], encoding: 'base64', kind: 'video' }],
        },
      }, '/video/tasks'),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', providerId: 'xd', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-2' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 }),
      );

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await callCindyMedia({ action: 'request', invocationId, body: { content: [] } });

    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MEDIA_RESULT_MISSING',
      retryable: false,
    });
    expect(mocks.rows.get(invocationId)?.state).toBe('pending');
    await expect(callCindyMedia({ action: 'poll', invocationId })).resolves.toMatchObject({
      ok: false,
      errorCode: 'MEDIA_RESULT_MISSING',
    });
  });

  it.each(['none', 'network', 'timeout', 'server', 'exhausted', 'rejected'])(
    '下载地址失效后客户端刷新原任务地址（%s），不重复生成', async (failure) => {
    const asyncOperation = {
      ...operation(
        {
          mode: 'async',
          taskIdPath: ['task_id'],
          poll: {
            method: 'GET',
            path: '/video/tasks/{taskId}',
            statusPath: ['status'],
            successValues: ['succeeded'],
            failureValues: ['failed'],
            recommendedIntervalMs: 10,
            timeoutMs: 5_000,
            maxResponseBytes: 1_048_576,
            media: [
              {
                path: ['video'],
                encoding: 'url',
                kind: 'video',
                allowedUrlHosts: ['cdn.example.com'],
              },
            ],
          },
        },
        '/video/tasks',
      ),
      capability: 'video.generate',
    };
    mocks.models.mockResolvedValue([
      { id: 'image-model', name: 'Video Model', providerId: 'xd', mode: 'video_generation' },
    ]);
    mocks.guide.mockResolvedValue(resolvedGuide(asyncOperation));
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-3' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'succeeded', video: 'https://cdn.example.com/expired.mp4' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const failures = failure === 'none' ? 0 : failure === 'exhausted' ? 3 : failure === 'rejected' ? 1 : 2;
    for (let index = 0; index < failures; index += 1) {
      if (failure === 'server' || failure === 'rejected') {
        mocks.outboundFetch.mockResolvedValueOnce(new Response('{}', { status: failure === 'server' ? 503 : 401 }));
      } else {
        const error = new Error('temporary refresh failure');
        if (failure === 'timeout') error.name = 'AbortError';
        mocks.outboundFetch.mockRejectedValueOnce(error);
      }
    }
    mocks.outboundFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'succeeded', video: 'https://cdn.example.com/refreshed.mp4' })))
      .mockResolvedValueOnce(new Response(MP4, { headers: { 'content-type': 'video/mp4' } }));

    const prepared = await callCindyMedia({
      action: 'prepare',
      modelId: 'image-model',
      capability: 'video.generate',
    });
    const invocationId = prepared.invocation_id as string;
    await callCindyMedia({ action: 'request', invocationId, body: { content: [] } });

    const result = await callCindyMedia({ action: 'poll', invocationId });
    if (failure === 'exhausted' || failure === 'rejected') {
      expect(result).toMatchObject({
        ok: false, retryable: false,
        errorCode: failure === 'rejected' ? 'UPSTREAM_REJECTED' : 'POLL_UNAVAILABLE',
      });
      expect(mocks.rows.get(invocationId)).toMatchObject({
        state: 'pending',
        responseJson: JSON.stringify({ status: 'succeeded', video: 'https://cdn.example.com/expired.mp4' }),
      });
      expect(mocks.outboundFetch).toHaveBeenCalledTimes(3 + failures);
    } else {
      expect(result).toMatchObject({ ok: true, status: 'complete' });
      expect(mocks.rows.get(invocationId)?.state).toBe('complete');
      expect(mocks.outboundFetch).toHaveBeenCalledTimes(5 + failures);
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.outboundFetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
});
