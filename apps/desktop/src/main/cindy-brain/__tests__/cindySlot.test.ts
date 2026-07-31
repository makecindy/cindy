/**
 * cindySlot.test.ts — cindy 槽代办单测(纯 DI,无 Electron)。
 * 覆盖:载荷校验、卡槽资格审(未声明 cindy 槽即拒)、happy path 记账链路、
 * 生成失败折叠为结构化拒绝、每意识在途单数闸门、模型白名单、
 * 改图(归属校验/指纹形状/张数上限)、寄存(#784:能力详单、魔数验型、
 * 单次上限、频控令牌桶、配额硬顶、撤回幂等、不进产物账)。
 */

import { describe, it, expect, vi } from 'vitest';

import { GhostCindySlot, type CindySlotDeps } from '../cindySlot';
import { sniffMediaMime } from '../../cindy-media/sniffMediaMime';
import {
  GHOST_CINDY_DEPOSIT_BURST,
  GHOST_CINDY_DEPOSIT_MAX_BYTES,
  GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
} from '../../../shared/ghost';
import type { InstalledGhost } from '../../../shared/ghost';

function fakeGhost(
  overrides: {
    enabled?: boolean;
    slots?: string[];
    model?: { image?: string[]; video?: string[]; media?: string[]; text?: string[] } | null;
  } = {},
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'art',
      name: '画图',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: overrides.slots ?? ['tool', 'cindy', 'panel'],
      tools: [{ name: 'gen_image', description: '生成图片' }],
      // null = 模拟老包缺详单;undefined = 默认全能力(image + video + media)。
      ...(overrides.model === null
        ? {}
        : {
            cindy:
              overrides.model ?? {
                image: ['generate', 'edit'],
                video: ['generate', 'edit'],
                media: ['deposit'],
              },
          }),
    },
    dir: '/fake/brain/art',
    enabled: overrides.enabled ?? true,
  } as InstalledGhost;
}

function makeSlot(overrides: Partial<CindySlotDeps> = {}): {
  slot: GhostCindySlot;
  generateImage: ReturnType<typeof vi.fn>;
  editImage: ReturnType<typeof vi.fn>;
  generateVideo: ReturnType<typeof vi.fn>;
  editVideo: ReturnType<typeof vi.fn>;
  resolveOwnedMedia: ReturnType<typeof vi.fn>;
  getOverride: ReturnType<typeof vi.fn>;
  getImageConfig: ReturnType<typeof vi.fn>;
  getVideoConfig: ReturnType<typeof vi.fn>;
  videoCapabilities: ReturnType<typeof vi.fn>;
  saveGhostMedia: ReturnType<typeof vi.fn>;
  sniffDepositMime: ReturnType<typeof vi.fn>;
  depositMedia: ReturnType<typeof vi.fn>;
  depositUsageBytes: ReturnType<typeof vi.fn>;
  releaseDeposit: ReturnType<typeof vi.fn>;
} {
  const generateImage = vi.fn(async () => ({
    buffer: new Uint8Array([1, 2, 3]),
    mimeType: 'image/png',
  }));
  const editImage = vi.fn(async () => ({
    buffer: new Uint8Array([4, 5, 6]),
    mimeType: 'image/png',
  }));
  const generateVideo = vi.fn(async () => ({
    buffer: new Uint8Array([7, 8, 9]),
    mimeType: 'video/mp4',
    videoParams: { durationSeconds: 4, resolution: '720p', ratio: '16:9', fps: 24 },
  }));
  const editVideo = vi.fn(async () => ({
    buffer: new Uint8Array([10, 11]),
    mimeType: 'video/mp4',
    videoParams: { durationSeconds: 4, resolution: '720p', ratio: '16:9', fps: 24 },
  }));
  // 按型号能力校验的数据源:仿 seedance 的支持集(时长 4/6/8/10,无 5 秒)。
  const videoCapabilities = vi.fn((model: string) =>
    model.startsWith('seedance')
      ? {
          durations: [4, 6, 8, 10],
          resolutions: ['480p', '720p', '1080p'],
          ratios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
          fps: [24],
        }
      : null,
  );
  const resolveOwnedMedia = vi.fn(async (_ghostId: string, hash: string) => `/disk/${hash}.png`);
  const getOverride = vi.fn((_ghostId: string, _capability: string) => null as string | null);
  const getImageConfig = vi.fn(() => ({
    models: [
    { id: 'gpt-image-2', label: 'GPT Image 2' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image' },
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
    ],
    defaults: { standard: 'gpt-image-2', draft: 'gemini-3.1-flash-image', best: 'gpt-image-2' },
  }));
  const getVideoConfig = vi.fn(() => ({
    models: [
      { id: 'seedance-fast', label: 'Seedance 快速' },
      { id: 'seedance-pro', label: 'Seedance Pro' },
    ],
    defaults: { standard: 'seedance-fast', draft: 'seedance-fast', best: 'seedance-pro' },
  }));
  const saveGhostMedia = vi.fn(async () => ({
    url: 'cindy-media://blobs/abc.png',
    hash: 'a'.repeat(64),
    ext: '.png',
  }));
  // 寄存三件套的缺省替身:真实魔数识别(不放水,类型判定的真行为要被测到),
  // 落仓/配额/撤回用可控假件。
  const sniffDepositMime = vi.fn((buffer: Uint8Array) => sniffMediaMime(buffer));
  const depositMedia = vi.fn(
    async (params: { buffer: Uint8Array; mimeType: string }) => ({
      url: 'cindy-media://blobs/dep.png',
      hash: 'd'.repeat(64),
      ext: '.png',
      bytes: params.buffer.byteLength,
      deduplicated: false,
    }),
  );
  const depositUsageBytes = vi.fn(async () => 0);
  const releaseDeposit = vi.fn(async () => true);
  const slot = new GhostCindySlot({
    getGhost: () => fakeGhost(),
    generateImage,
    editImage,
    generateVideo,
    editVideo,
    resolveOwnedMedia,
    getOverride,
    getImageConfig,
    getVideoConfig,
    videoCapabilities,
    saveGhostMedia,
    sniffDepositMime,
    depositMedia,
    depositUsageBytes,
    releaseDeposit,
    ...overrides,
  } as CindySlotDeps);
  return {
    slot,
    generateImage,
    editImage,
    generateVideo,
    editVideo,
    resolveOwnedMedia,
    getOverride,
    getImageConfig,
    getVideoConfig,
    videoCapabilities,
    saveGhostMedia,
    sniffDepositMime,
    depositMedia,
    depositUsageBytes,
    releaseDeposit,
  };
}

const REQ = { type: 'cindy-request', kind: 'gen_image', prompt: '一只猫' };
const HASH_S = '5'.repeat(64);
const EDIT_REQ = { type: 'cindy-request', kind: 'edit_image', prompt: '加顶帽子', hashes: [HASH_S] };

describe('载荷校验', () => {
  it('未知 kind / 空 prompt / 超长 prompt → 结构化拒绝', async () => {
    const { slot } = makeSlot();
    expect(await slot.handleModelRequest('art', { kind: 'gen_audio', prompt: 'x' })).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { kind: 'gen_image', prompt: '  ' })).toMatchObject({ ok: false });
    expect(
      await slot.handleModelRequest('art', { kind: 'gen_image', prompt: 'x'.repeat(4001) }),
    ).toMatchObject({ ok: false });
  });

  it('模型白名单:名单内放行并透传,名单外拒且不触发生成', async () => {
    const { slot, generateImage } = makeSlot();
    const ok = await slot.handleModelRequest('art', { ...REQ, model: 'gemini-3-pro-image' });
    expect(ok).toMatchObject({ ok: true });
    expect(generateImage).toHaveBeenCalledWith({ prompt: '一只猫', model: 'gemini-3-pro-image' });

    const bad = await slot.handleModelRequest('art', { ...REQ, model: 'dall-e-9' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('白名单');
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it('缺省模型 = gpt-image-2', async () => {
    const { slot, generateImage } = makeSlot();
    await slot.handleModelRequest('art', REQ);
    expect(generateImage).toHaveBeenCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });
  });

  it('档位双轨:tier 经主机表翻译;显式 model 优先于 tier;未知档位拒', async () => {
    const { slot, generateImage } = makeSlot();
    await slot.handleModelRequest('art', { ...REQ, tier: 'draft' });
    expect(generateImage).toHaveBeenLastCalledWith({
      prompt: '一只猫',
      model: 'gemini-3.1-flash-image',
    });
    await slot.handleModelRequest('art', { ...REQ, tier: 'best' });
    expect(generateImage).toHaveBeenLastCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });

    // 用户显式点名压过意识的档位意图。
    await slot.handleModelRequest('art', { ...REQ, tier: 'draft', model: 'gpt-image-2' });
    expect(generateImage).toHaveBeenLastCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });

    const bad = await slot.handleModelRequest('art', { ...REQ, tier: 'ultra' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('档位');
  });

  it('画幅意图:合法比例透传;不传时载荷无 aspectRatio 键;未知比例拒', async () => {
    const { slot, generateImage } = makeSlot();
    const ok = await slot.handleModelRequest('art', { ...REQ, aspectRatio: '3:2' });
    expect(ok).toMatchObject({ ok: true });
    expect(generateImage).toHaveBeenLastCalledWith({
      prompt: '一只猫',
      model: 'gpt-image-2',
      aspectRatio: '3:2',
    });

    // 不传 = 与老协议同形(连键都没有),后端走缺省 auto。
    await slot.handleModelRequest('art', REQ);
    expect(generateImage).toHaveBeenLastCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });

    const bad = await slot.handleModelRequest('art', { ...REQ, aspectRatio: '21:9' });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('画幅');
    expect(generateImage).toHaveBeenCalledTimes(2);
  });

  it('画幅意图图像类通吃:改图也收 aspectRatio;不传时载荷无该键', async () => {
    const { slot, editImage } = makeSlot();
    const ok = await slot.handleModelRequest('art', { ...EDIT_REQ, aspectRatio: '1:1' });
    expect(ok).toMatchObject({ ok: true });
    expect(editImage).toHaveBeenLastCalledWith({
      prompt: '加顶帽子',
      model: 'gpt-image-2',
      imagePaths: [`/disk/${HASH_S}.png`],
      aspectRatio: '1:1',
    });

    // 不传 = 与老协议同形(连键都没有),后端 auto = 跟随源图画幅。
    await slot.handleModelRequest('art', EDIT_REQ);
    expect(editImage).toHaveBeenLastCalledWith({
      prompt: '加顶帽子',
      model: 'gpt-image-2',
      imagePaths: [`/disk/${HASH_S}.png`],
    });
  });

  it('aspectRatio 不收视频:视频带图像画幅 → 明拒且不触发生成', async () => {
    const { slot, generateVideo } = makeSlot();
    const videoBad = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_video',
      prompt: '一只猫奔跑',
      aspectRatio: '2:3',
    });
    expect(videoBad).toMatchObject({ ok: false });
    expect((videoBad as { message: string }).message).toContain('ratio');
    expect(generateVideo).not.toHaveBeenCalled();
  });
});

describe('视频画面参数', () => {
  const VIDEO_REQ = { type: 'cindy-request', kind: 'gen_video', prompt: '一只猫奔跑' };
  const EDIT_VIDEO_REQ = {
    type: 'cindy-request',
    kind: 'edit_video',
    prompt: '让它动起来',
    hashes: [HASH_S],
  };

  it('合法参数透传;不传时载荷与老协议同形;实际生效参数随结果回传', async () => {
    const { slot, generateVideo } = makeSlot();
    const ok = await slot.handleModelRequest('art', {
      ...VIDEO_REQ,
      ratio: '9:16',
      resolution: '1080p',
      duration: 8,
      fps: 24,
    });
    expect(ok).toMatchObject({ ok: true });
    expect(generateVideo).toHaveBeenLastCalledWith({
      prompt: '一只猫奔跑',
      model: 'seedance-fast',
      ratio: '9:16',
      resolution: '1080p',
      duration: 8,
      fps: 24,
    });

    // 一项都不传 = 老协议逐字节同形(连键都没有),后端走型号出厂默认。
    const bare = await slot.handleModelRequest('art', VIDEO_REQ);
    expect(generateVideo).toHaveBeenLastCalledWith({ prompt: '一只猫奔跑', model: 'seedance-fast' });
    // 回执照样带回来(注入实现给了就透传),意识据此判断参数是否兑现。
    expect(bare).toMatchObject({
      ok: true,
      videoParams: { durationSeconds: 4, resolution: '720p', ratio: '16:9', fps: 24 },
    });
  });

  it('部分传参:只展开传了的键,其余不出现在载荷里', async () => {
    const { slot, editVideo } = makeSlot();
    const ok = await slot.handleModelRequest('art', { ...EDIT_VIDEO_REQ, resolution: '480p' });
    expect(ok).toMatchObject({ ok: true });
    expect(editVideo).toHaveBeenLastCalledWith({
      prompt: '让它动起来',
      model: 'seedance-fast',
      imagePaths: [`/disk/${HASH_S}.png`],
      resolution: '480p',
    });
  });

  it('值域粗筛:未知比例/分辨率、非正整数时长与帧率一律拒且不触发生成', async () => {
    const { slot, generateVideo } = makeSlot();
    for (const bad of [
      { ratio: '21:9' },
      { resolution: '4k' },
      { duration: 0 },
      { duration: 4.5 },
      { duration: -1 },
      { duration: 999 },
      { duration: '8' },
      { fps: 0 },
      { fps: 1000 },
    ]) {
      const r = await slot.handleModelRequest('art', { ...VIDEO_REQ, ...bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('按型号二次校验:型号不支持的时长明拒,话术带该型号可用值', async () => {
    const { slot, generateVideo } = makeSlot();
    // 5 秒在协议层粗筛内,但仿 seedance 的支持集是 4/6/8/10。
    const bad = await slot.handleModelRequest('art', { ...VIDEO_REQ, duration: 5 });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('4 / 6 / 8 / 10');
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it('videoCapabilities 缺席(查无该型号)→ 跳过按型号校验,粗筛过了就放行', async () => {
    const { slot, generateVideo } = makeSlot({
      videoCapabilities: vi.fn(() => null) as unknown as CindySlotDeps['videoCapabilities'],
    });
    const ok = await slot.handleModelRequest('art', { ...VIDEO_REQ, duration: 5 });
    expect(ok).toMatchObject({ ok: true });
    expect(generateVideo).toHaveBeenLastCalledWith({
      prompt: '一只猫奔跑',
      model: 'seedance-fast',
      duration: 5,
    });
  });

  it('画面参数不收图像类:生图/改图带 resolution → 明拒且不触发生成', async () => {
    const { slot, generateImage, editImage } = makeSlot();
    const genBad = await slot.handleModelRequest('art', { ...REQ, resolution: '1080p' });
    expect(genBad).toMatchObject({ ok: false });
    expect((genBad as { message: string }).message).toContain('aspectRatio');
    expect(generateImage).not.toHaveBeenCalled();

    const editBad = await slot.handleModelRequest('art', { ...EDIT_REQ, duration: 4 });
    expect(editBad).toMatchObject({ ok: false });
    expect(editImage).not.toHaveBeenCalled();
  });
});

describe('目录空清单 = 能力暂不可用', () => {
  const EMPTY_CONFIG = { models: [], defaults: null };

  it('视频清单空 → gen_video 拒单且不触发生成;同意识的图像代办不受影响', async () => {
    const { slot, generateVideo, generateImage } = makeSlot({
      getVideoConfig: vi.fn(() => EMPTY_CONFIG) as unknown as CindySlotDeps['getVideoConfig'],
    });
    const bad = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_video',
      prompt: '一只猫奔跑',
    });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { message: string }).message).toContain('视频');
    expect(generateVideo).not.toHaveBeenCalled();

    // 图像清单还在 → 照常干活(降级只影响空的那个类目)。
    expect(await slot.handleModelRequest('art', REQ)).toMatchObject({ ok: true });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it('图像清单空 → gen_image / edit_image 都拒单,显式点名与档位也不能绕过', async () => {
    const { slot, generateImage, editImage } = makeSlot({
      getImageConfig: vi.fn(() => EMPTY_CONFIG) as unknown as CindySlotDeps['getImageConfig'],
    });
    expect(await slot.handleModelRequest('art', REQ)).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { ...REQ, model: 'gpt-image-2' })).toMatchObject({
      ok: false,
    });
    expect(await slot.handleModelRequest('art', { ...REQ, tier: 'best' })).toMatchObject({
      ok: false,
    });
    expect(await slot.handleModelRequest('art', EDIT_REQ)).toMatchObject({ ok: false });
    expect(generateImage).not.toHaveBeenCalled();
    expect(editImage).not.toHaveBeenCalled();
  });

  it('清单空时用户钉的旧覆盖也不生效(不拿不在册型号下单)', async () => {
    const { slot, generateImage } = makeSlot({
      getImageConfig: vi.fn(() => EMPTY_CONFIG) as unknown as CindySlotDeps['getImageConfig'],
      getOverride: vi.fn(() => 'gpt-image-2') as unknown as CindySlotDeps['getOverride'],
    });
    expect(await slot.handleModelRequest('art', REQ)).toMatchObject({ ok: false });
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe('意识专属后端覆盖(解析表第②层)', () => {
  it('覆盖压过档位;调用显式点名仍压过覆盖;下架型号的覆盖静默落回', async () => {
    const pinned = makeSlot({
      getOverride: vi.fn(() => 'gemini-3-pro-image') as unknown as CindySlotDeps['getOverride'],
    });
    // 覆盖 > tier
    await pinned.slot.handleModelRequest('art', { ...REQ, tier: 'draft' });
    expect(pinned.generateImage).toHaveBeenLastCalledWith({
      prompt: '一只猫',
      model: 'gemini-3-pro-image',
    });
    // 显式点名 > 覆盖
    await pinned.slot.handleModelRequest('art', { ...REQ, model: 'gpt-image-2' });
    expect(pinned.generateImage).toHaveBeenLastCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });

    // 钉的型号已不在白名单 → 忽略覆盖,落回默认,不拒单。
    const stale = makeSlot({
      getOverride: vi.fn(() => 'retired-model-9') as unknown as CindySlotDeps['getOverride'],
    });
    const r = await stale.slot.handleModelRequest('art', REQ);
    expect(r).toMatchObject({ ok: true });
    expect(stale.generateImage).toHaveBeenLastCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });
  });

  it('覆盖按能力键全名取(出图/改图/视频各自独立)', async () => {
    const { slot, getOverride } = makeSlot();
    await slot.handleModelRequest('art', REQ);
    expect(getOverride).toHaveBeenLastCalledWith('art', 'image.generate');
    await slot.handleModelRequest('art', EDIT_REQ);
    expect(getOverride).toHaveBeenLastCalledWith('art', 'image.edit');
    await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'gen_video', prompt: '一只猫奔跑' });
    expect(getOverride).toHaveBeenLastCalledWith('art', 'video.generate');
  });
});

describe('视频代办(gen_video / edit_video)', () => {
  const VREQ = { type: 'cindy-request', kind: 'gen_video', prompt: '一只猫奔跑' };

  it('gen_video happy path:走视频白名单默认款,产物同一条落仓链路', async () => {
    const { slot, generateVideo, saveGhostMedia } = makeSlot();
    const r = await slot.handleModelRequest('art', VREQ);
    expect(r).toMatchObject({ ok: true, model: 'seedance-fast', modelLabel: 'Seedance 快速' });
    expect(generateVideo).toHaveBeenCalledWith({ prompt: '一只猫奔跑', model: 'seedance-fast' });
    expect(saveGhostMedia).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'video/mp4' }));
  });

  it('tier 档位查视频翻译表(best → seedance-pro);白名单外点名拒', async () => {
    const { slot, generateVideo } = makeSlot();
    await slot.handleModelRequest('art', { ...VREQ, tier: 'best' });
    expect(generateVideo).toHaveBeenLastCalledWith({ prompt: '一只猫奔跑', model: 'seedance-pro' });
    // 图像白名单里的型号点给视频代办 → 拒(两类目白名单独立)。
    const bad = await slot.handleModelRequest('art', { ...VREQ, model: 'gpt-image-2' });
    expect(bad).toMatchObject({ ok: false });
  });

  it('edit_video:参考图归属校验后按路径注入;上限 2 张,超限拒', async () => {
    const { slot, editVideo, resolveOwnedMedia } = makeSlot();
    const r = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'edit_video',
      prompt: '让它动起来',
      hashes: [HASH_S],
    });
    expect(r).toMatchObject({ ok: true });
    expect(resolveOwnedMedia).toHaveBeenCalledWith('art', HASH_S);
    expect(editVideo).toHaveBeenCalledWith({
      prompt: '让它动起来',
      model: 'seedance-fast',
      imagePaths: [`/disk/${HASH_S}.png`],
    });
    const over = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'edit_video',
      prompt: 'x',
      hashes: Array(3).fill(HASH_S),
    });
    expect(over).toMatchObject({ ok: false });
    expect((over as { message: string }).message).toContain('上限 2');
  });

  it('详单只有 image → 视频代办拒且提示补声明(类目粒度资格审)', async () => {
    const { slot, generateVideo } = makeSlot({
      getGhost: () => fakeGhost({ model: { image: ['generate', 'edit'] } }),
    });
    const r = await slot.handleModelRequest('art', VREQ);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('cindy.video');
    expect(generateVideo).not.toHaveBeenCalled();
  });
});

describe('能力粒度资格审(model 详单)', () => {
  it('详单只有 generate → 出图放行,改图拒', async () => {
    const { slot, editImage } = makeSlot({ getGhost: () => fakeGhost({ model: { image: ['generate'] } }) });
    expect(await slot.handleModelRequest('art', REQ)).toMatchObject({ ok: true });
    const r = await slot.handleModelRequest('art', EDIT_REQ);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('edit');
    expect(editImage).not.toHaveBeenCalled();
  });

  it('老包缺详单 = 零能力,一切代办拒且提示更新声明', async () => {
    const { slot, generateImage } = makeSlot({ getGhost: () => fakeGhost({ model: null }) });
    const r = await slot.handleModelRequest('art', REQ);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('更新');
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe('资格审', () => {
  it('未装入 / 沉睡 → 拒', async () => {
    const gone = makeSlot({ getGhost: () => null });
    expect(await gone.slot.handleModelRequest('art', REQ)).toMatchObject({ ok: false });
    const asleep = makeSlot({ getGhost: () => fakeGhost({ enabled: false }) });
    expect(await asleep.slot.handleModelRequest('art', REQ)).toMatchObject({ ok: false });
  });

  it('身份卡未声明 cindy 卡槽 → 结构上无此器官,拒', async () => {
    const { slot, generateImage } = makeSlot({ getGhost: () => fakeGhost({ slots: ['tool', 'panel'] }) });
    const r = await slot.handleModelRequest('art', REQ);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('cindy');
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe('代办链路', () => {
  it('happy path:生成 → 落仓记账 → 只回字符串(指纹/地址)', async () => {
    const { slot, generateImage, saveGhostMedia } = makeSlot();
    const r = await slot.handleModelRequest('art', REQ);
    expect(r).toEqual({
      ok: true,
      url: 'cindy-media://blobs/abc.png',
      hash: 'a'.repeat(64),
      ext: '.png',
      // 实际选型随结果回传(主机权威信息,意识 note/用户可见)。
      model: 'gpt-image-2',
      modelLabel: 'GPT Image 2',
    });
    expect(generateImage).toHaveBeenCalledWith({ prompt: '一只猫', model: 'gpt-image-2' });
    expect(saveGhostMedia).toHaveBeenCalledWith(
      expect.objectContaining({ ghostId: 'art', mimeType: 'image/png' }),
    );
  });

  it('图片代办附带像素宽高(字节头可解析时);探测不出则缺省', async () => {
    // 最小 PNG 头(1024×1536):签名 + IHDR。
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.set([0x00, 0x00, 0x00, 0x0d], 8);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(png.buffer).setUint32(16, 1024);
    new DataView(png.buffer).setUint32(20, 1536);
    const withDims = makeSlot({
      generateImage: vi.fn(async () => ({ buffer: png, mimeType: 'image/png' })),
    } as unknown as Partial<CindySlotDeps>);
    const r = await withDims.slot.handleModelRequest('art', REQ);
    expect(r).toMatchObject({ ok: true, width: 1024, height: 1536 });

    // 默认 mock buffer 不是合法图片头 → 缺省(happy path 用例的 toEqual 同时守住这点)。
    const { slot } = makeSlot();
    const r2 = await slot.handleModelRequest('art', REQ);
    expect(r2).not.toHaveProperty('width');
  });

  it('生成失败 → 折叠为 { ok:false },不抛穿', async () => {
    const failing = makeSlot({
      generateImage: vi.fn(async () => Promise.reject(new Error('网关 500'))),
    } as unknown as Partial<CindySlotDeps>);
    const r = await failing.slot.handleModelRequest('art', REQ);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('网关 500');
  });

  it('默认不限并发:未配置上限时多单同时进行都放行', async () => {
    const pending: Array<(v: { buffer: Uint8Array; mimeType: string }) => void> = [];
    const { slot } = makeSlot({
      generateImage: vi.fn(
        () => new Promise<{ buffer: Uint8Array; mimeType: string }>((res) => pending.push(res)),
      ) as unknown as CindySlotDeps['generateImage'],
    });

    const first = slot.handleModelRequest('art', REQ);
    const second = slot.handleModelRequest('art', REQ);
    // 两单都进了生成阶段(没有谁被闸门拒掉)。
    expect(pending).toHaveLength(2);
    for (const release of pending) release({ buffer: new Uint8Array([1]), mimeType: 'image/png' });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('配置了上限才闸:达到上限拒单,完成后闸门复位', async () => {
    let release: (v: { buffer: Uint8Array; mimeType: string }) => void = () => {};
    const gate = new Promise<{ buffer: Uint8Array; mimeType: string }>((res) => (release = res));
    const { slot } = makeSlot({
      generateImage: vi.fn(() => gate) as unknown as CindySlotDeps['generateImage'],
      getInflightLimit: vi.fn(() => 1) as unknown as CindySlotDeps['getInflightLimit'],
    });

    const first = slot.handleModelRequest('art', REQ);
    const second = await slot.handleModelRequest('art', REQ);
    expect(second).toMatchObject({ ok: false });
    expect((second as { message: string }).message).toContain('上限');

    release({ buffer: new Uint8Array([1]), mimeType: 'image/png' });
    await expect(first).resolves.toMatchObject({ ok: true });

    // 闸门复位后可再下单。
    const third = await slot.handleModelRequest('art', REQ);
    expect(third).toMatchObject({ ok: true });
  });

  it('上限按配置值放行:limit=2 时第三单才被拒', async () => {
    const pending: Array<(v: { buffer: Uint8Array; mimeType: string }) => void> = [];
    const { slot } = makeSlot({
      generateImage: vi.fn(
        () => new Promise<{ buffer: Uint8Array; mimeType: string }>((res) => pending.push(res)),
      ) as unknown as CindySlotDeps['generateImage'],
      getInflightLimit: vi.fn(() => 2) as unknown as CindySlotDeps['getInflightLimit'],
    });

    const first = slot.handleModelRequest('art', REQ);
    const second = slot.handleModelRequest('art', REQ);
    const third = await slot.handleModelRequest('art', REQ);
    expect(pending).toHaveLength(2);
    expect(third).toMatchObject({ ok: false });
    expect((third as { message: string }).message).toContain('2 单');

    for (const release of pending) release({ buffer: new Uint8Array([1]), mimeType: 'image/png' });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });
});

describe('callId 归因', () => {
  it('带 callId 的单:start/done 日志都归因到它', async () => {
    const info = vi.fn();
    const { slot } = makeSlot({ log: { info, warn: vi.fn() } } as unknown as Partial<CindySlotDeps>);
    expect(await slot.handleModelRequest('art', { ...REQ, callId: 'call-42' })).toMatchObject({ ok: true });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('start'), expect.objectContaining({ callId: 'call-42' }));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('done'), expect.objectContaining({ callId: 'call-42' }));
  });

  it('不带 callId(面板交互等自发代办):照常放行,日志记 unattributed', async () => {
    const info = vi.fn();
    const { slot } = makeSlot({ log: { info, warn: vi.fn() } } as unknown as Partial<CindySlotDeps>);
    expect(await slot.handleModelRequest('art', REQ)).toMatchObject({ ok: true });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('start'),
      expect.objectContaining({ callId: 'unattributed' }),
    );
  });

  it('失败单同样归因(warn 带 callId)', async () => {
    const warn = vi.fn();
    const failing = makeSlot({
      generateImage: vi.fn(async () => Promise.reject(new Error('网关 500'))),
      log: { info: vi.fn(), warn },
    } as unknown as Partial<CindySlotDeps>);
    await failing.slot.handleModelRequest('art', { ...REQ, callId: 'call-7' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.objectContaining({ callId: 'call-7' }));
  });

  it('乱填的 callId(非字符串/空串/超长)→ 拒单,不触发生成', async () => {
    const { slot, generateImage } = makeSlot();
    expect(await slot.handleModelRequest('art', { ...REQ, callId: 42 })).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { ...REQ, callId: '' })).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { ...REQ, callId: 'x'.repeat(129) })).toMatchObject({ ok: false });
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe('改图代办(edit_image)', () => {
  it('happy path:归属解析 → 改图 → 落仓记账,源图路径不外泄', async () => {
    const { slot, editImage, resolveOwnedMedia, saveGhostMedia } = makeSlot();
    const r = await slot.handleModelRequest('art', EDIT_REQ);
    expect(r).toMatchObject({ ok: true, hash: 'a'.repeat(64) });
    expect(resolveOwnedMedia).toHaveBeenCalledWith('art', HASH_S);
    expect(editImage).toHaveBeenCalledWith({
      prompt: '加顶帽子',
      model: 'gpt-image-2',
      imagePaths: [`/disk/${HASH_S}.png`],
    });
    expect(saveGhostMedia).toHaveBeenCalledWith(expect.objectContaining({ ghostId: 'art' }));
    // 返回体里只有产物字符串,没有任何磁盘路径。
    expect(JSON.stringify(r)).not.toContain('/disk/');
  });

  it('缺 hashes / 空数组 / 指纹形状不合法 / 超上限 → 拒且不触发改图', async () => {
    const { slot, editImage } = makeSlot();
    expect(await slot.handleModelRequest('art', { ...EDIT_REQ, hashes: undefined })).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { ...EDIT_REQ, hashes: [] })).toMatchObject({ ok: false });
    expect(await slot.handleModelRequest('art', { ...EDIT_REQ, hashes: ['not-a-hash'] })).toMatchObject({ ok: false });
    expect(
      await slot.handleModelRequest('art', { ...EDIT_REQ, hashes: Array(5).fill(HASH_S) }),
    ).toMatchObject({ ok: false });
    expect(editImage).not.toHaveBeenCalled();
  });

  it('任一源图不在本意识名下 → 整单拒(统一话术)', async () => {
    const { slot, editImage } = makeSlot({
      resolveOwnedMedia: vi.fn(async (_g: string, hash: string) =>
        hash === HASH_S ? `/disk/${hash}.png` : null,
      ) as unknown as CindySlotDeps['resolveOwnedMedia'],
    });
    const r = await slot.handleModelRequest('art', {
      ...EDIT_REQ,
      hashes: [HASH_S, 'e'.repeat(64)],
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('名下');
    expect(editImage).not.toHaveBeenCalled();
  });
});

describe('管子续命挂钩(同步视频代办 hold/release)', () => {
  it('署名视频代办 hold 预算 = expected×3;完成后 release', async () => {
    const holdPipeCall = vi.fn();
    const releasePipeCall = vi.fn();
    const { slot } = makeSlot({
      holdPipeCall,
      releasePipeCall,
      videoExpectedSeconds: vi.fn(() => 300),
    } as Partial<CindySlotDeps>);
    const r = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_video',
      prompt: '一只猫奔跑',
      callId: 'call-9',
    });
    expect(r).toMatchObject({ ok: true });
    expect(holdPipeCall).toHaveBeenCalledWith('art', 'call-9', 900_000);
    expect(releasePipeCall).toHaveBeenCalledWith('art', 'call-9');
  });

  it('生成失败同样 release;未署名(无 callId)与图片代办不 hold', async () => {
    const holdPipeCall = vi.fn();
    const releasePipeCall = vi.fn();
    const { slot } = makeSlot({
      holdPipeCall,
      releasePipeCall,
      generateVideo: vi.fn(async () => {
        throw new Error('通道爆炸');
      }),
    } as Partial<CindySlotDeps>);
    const failed = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_video',
      prompt: 'x',
      callId: 'call-f',
    });
    expect(failed).toMatchObject({ ok: false });
    expect(holdPipeCall).toHaveBeenCalledWith('art', 'call-f', 120 * 3 * 1000); // 未注入 expected → 缺省 120s
    expect(releasePipeCall).toHaveBeenCalledWith('art', 'call-f');

    holdPipeCall.mockClear();
    await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'gen_video', prompt: 'x' });
    expect(holdPipeCall).not.toHaveBeenCalled(); // 未署名单不 hold

    await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'gen_image', prompt: 'x', callId: 'c' });
    expect(holdPipeCall).not.toHaveBeenCalled(); // 图片代办不 hold
  });
});

describe('异步任务(mode:submit / query_job)', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const SUBMIT_REQ = {
    type: 'cindy-request',
    kind: 'gen_video',
    prompt: '一只猫奔跑',
    mode: 'submit',
    callId: 'call-a',
  };

  it('submit 受理即返回 running + jobId;完成后 query 取件,记账带归因号', async () => {
    const d = deferred<{ buffer: Uint8Array; mimeType: string }>();
    const { slot, saveGhostMedia } = makeSlot({
      generateVideo: vi.fn(() => d.promise),
      videoExpectedSeconds: vi.fn(() => 300),
    } as Partial<CindySlotDeps>);

    const r = await slot.handleModelRequest('art', SUBMIT_REQ);
    expect(r).toMatchObject({ ok: true, status: 'running', expectedSeconds: 300 });
    const jobId = (r as { jobId: string }).jobId;
    expect(jobId.length).toBeGreaterThan(10);

    const q1 = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
    expect(q1).toMatchObject({ ok: true, status: 'running' });

    d.resolve({ buffer: new Uint8Array([7, 8, 9]), mimeType: 'video/mp4' });
    await vi.waitFor(async () => {
      const q = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
      expect(q).toMatchObject({ ok: true, status: 'done', url: 'cindy-media://blobs/abc.png' });
    });
    expect(saveGhostMedia).toHaveBeenCalledWith(expect.objectContaining({ ghostId: 'art', callId: 'call-a' }));
    // 完成结果 TTL 内可反复查(幂等)。
    const again = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
    expect(again).toMatchObject({ ok: true, status: 'done' });
  });

  it('别的意识查不到我的任务(统一话术不泄露存在性)', async () => {
    const d = deferred<{ buffer: Uint8Array; mimeType: string }>();
    const { slot } = makeSlot({ generateVideo: vi.fn(() => d.promise) } as Partial<CindySlotDeps>);
    const r = await slot.handleModelRequest('art', SUBMIT_REQ);
    const jobId = (r as { jobId: string }).jobId;

    const q = await slot.handleModelRequest('other', { type: 'cindy-request', kind: 'query_job', jobId });
    expect(q).toMatchObject({ ok: false });
    expect((q as { message: string }).message).toContain('查无此任务');
    d.resolve({ buffer: new Uint8Array([1]), mimeType: 'video/mp4' });
  });

  it('后台生成失败 → query 返回结构化失败(人话动词 + 原因)', async () => {
    const d = deferred<{ buffer: Uint8Array; mimeType: string }>();
    const { slot } = makeSlot({ generateVideo: vi.fn(() => d.promise) } as Partial<CindySlotDeps>);
    const r = await slot.handleModelRequest('art', SUBMIT_REQ);
    const jobId = (r as { jobId: string }).jobId;

    d.reject(new Error('通道爆炸'));
    await vi.waitFor(async () => {
      const q = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
      expect(q).toMatchObject({ ok: false });
      expect((q as { message: string }).message).toContain('生成视频失败:通道爆炸');
    });
  });

  it('后台在途上限:第 3 单拒;完成一单后放行', async () => {
    const d1 = deferred<{ buffer: Uint8Array; mimeType: string }>();
    const d2 = deferred<{ buffer: Uint8Array; mimeType: string }>();
    const gen = vi
      .fn<() => Promise<{ buffer: Uint8Array; mimeType: string }>>()
      .mockImplementationOnce(() => d1.promise)
      .mockImplementationOnce(() => d2.promise);
    const { slot } = makeSlot({ generateVideo: gen } as Partial<CindySlotDeps>);

    expect(await slot.handleModelRequest('art', SUBMIT_REQ)).toMatchObject({ ok: true });
    expect(await slot.handleModelRequest('art', SUBMIT_REQ)).toMatchObject({ ok: true });
    const third = await slot.handleModelRequest('art', SUBMIT_REQ);
    expect(third).toMatchObject({ ok: false });
    expect((third as { message: string }).message).toContain('上限');

    d1.resolve({ buffer: new Uint8Array([1]), mimeType: 'video/mp4' });
    await vi.waitFor(async () => {
      expect(await slot.handleModelRequest('art', SUBMIT_REQ)).toMatchObject({ ok: true });
    });
    d2.resolve({ buffer: new Uint8Array([2]), mimeType: 'video/mp4' });
  });

  it('图像代办不支持 submit;mode 乱值拒;jobId 形状不合法拒', async () => {
    const { slot, generateImage } = makeSlot();
    const img = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_image',
      prompt: 'x',
      mode: 'submit',
    });
    expect(img).toMatchObject({ ok: false });
    expect((img as { message: string }).message).toContain('视频类');
    expect(generateImage).not.toHaveBeenCalled();

    expect(
      await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'gen_video', prompt: 'x', mode: 'async' }),
    ).toMatchObject({ ok: false });
    expect(
      await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId: '' }),
    ).toMatchObject({ ok: false });
    expect(
      await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId: 'x'.repeat(65) }),
    ).toMatchObject({ ok: false });
  });

  it('完成态记录按意识限额淘汰最旧(快速失败循环不无限堆表)', async () => {
    const { slot } = makeSlot({
      generateVideo: vi.fn(async () => {
        throw new Error('立即失败');
      }),
    } as Partial<CindySlotDeps>);

    const jobIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await slot.handleModelRequest('art', SUBMIT_REQ);
      expect(r).toMatchObject({ ok: true, status: 'running' });
      jobIds.push((r as { jobId: string }).jobId);
      // 让后台链落定(失败出 running 态),下一单才不会被在途闸拦。
      await vi.waitFor(async () => {
        const q = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId: jobIds[i] });
        expect(q).toMatchObject({ ok: false });
      });
    }

    // 最早的记录已被限额淘汰(话术与过期一致:查无此任务)。
    const oldest = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId: jobIds[0] });
    expect((oldest as { message: string }).message).toContain('查无此任务');
    // 最近完成的仍在保留窗内可查(失败原因原样返回)。
    const latest = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId: jobIds[19] });
    expect((latest as { message: string }).message).toContain('立即失败');
  });

  it('完成结果过 TTL 清理 → 查无此任务', async () => {
    vi.useFakeTimers();
    try {
      const d = deferred<{ buffer: Uint8Array; mimeType: string }>();
      const { slot } = makeSlot({ generateVideo: vi.fn(() => d.promise) } as Partial<CindySlotDeps>);
      const r = await slot.handleModelRequest('art', SUBMIT_REQ);
      const jobId = (r as { jobId: string }).jobId;

      d.resolve({ buffer: new Uint8Array([1]), mimeType: 'video/mp4' });
      await vi.advanceTimersByTimeAsync(0); // flush 后台链 microtasks
      const done = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
      expect(done).toMatchObject({ ok: true, status: 'done' });

      vi.advanceTimersByTime(31 * 60_000);
      const gone = await slot.handleModelRequest('art', { type: 'cindy-request', kind: 'query_job', jobId });
      expect(gone).toMatchObject({ ok: false });
      expect((gone as { message: string }).message).toContain('查无此任务');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 寄存通道(deposit_media / release_media,#784)。
 * 重点是三道硬闸(类型 / 单次上限 / 配额)与两条"刻意的不"(不认自报类型、
 * 不进产物账),以及撤回的归属收敛与幂等。
 */
describe('寄存(deposit_media / release_media)', () => {
  /** 最小合法 PNG 头(魔数识别只看前 8 字节)。 */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const depositReq = (data: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'cindy-request',
    kind: 'deposit_media',
    data,
    ...extra,
  });
  const releaseReq = (hash: unknown) => ({ type: 'cindy-request', kind: 'release_media', hash });

  it('happy path:字节 → 指纹,mime 由主机判定,配额口径随结果回传', async () => {
    const { slot, depositMedia } = makeSlot();
    const r = await slot.handleModelRequest('art', depositReq(b64(PNG), { label: '拖入的参考图' }));
    expect(r).toMatchObject({
      ok: true,
      url: 'cindy-media://blobs/dep.png',
      hash: 'd'.repeat(64),
      ext: '.png',
      bytes: PNG.byteLength,
      deduplicated: false,
      quotaLimitBytes: GHOST_CINDY_DEPOSIT_QUOTA_BYTES,
    });
    expect(depositMedia).toHaveBeenCalledWith(
      expect.objectContaining({ ghostId: 'art', mimeType: 'image/png', label: '拖入的参考图' }),
    );
  });

  it('寄存的指纹随即可当 edit_image 源图', async () => {
    const HASH_D = 'd'.repeat(64);
    // 归属账本认寄存物(生产由 ledger.ghostCanRead 的 ghost-deposit 分支保证)。
    const { slot, editImage } = makeSlot({
      resolveOwnedMedia: vi.fn(async (_g: string, hash: string) =>
        hash === HASH_D ? `/disk/${hash}.png` : null,
      ),
    } as Partial<CindySlotDeps>);
    const dep = await slot.handleModelRequest('art', depositReq(b64(PNG)));
    const r = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'edit_image',
      prompt: '背景换成雪山',
      hashes: [(dep as { hash: string }).hash],
    });
    expect(r).toMatchObject({ ok: true });
    expect(editImage).toHaveBeenCalledWith(
      expect.objectContaining({ imagePaths: [`/disk/${HASH_D}.png`] }),
    );
  });

  it('资格审:详单缺 media.deposit / 缺 cindy 槽 / 意识停用 → 拒', async () => {
    const noMedia = makeSlot({
      getGhost: () => fakeGhost({ model: { image: ['generate', 'edit'] } }),
    } as Partial<CindySlotDeps>);
    const r1 = await noMedia.slot.handleModelRequest('art', depositReq(b64(PNG)));
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { message: string }).message).toContain('cindy.media');
    expect(noMedia.depositMedia).not.toHaveBeenCalled();

    const noSlot = makeSlot({
      getGhost: () => fakeGhost({ slots: ['tool'], model: null }),
    } as Partial<CindySlotDeps>);
    expect(await noSlot.slot.handleModelRequest('art', depositReq(b64(PNG)))).toMatchObject({
      ok: false,
    });

    const disabled = makeSlot({
      getGhost: () => fakeGhost({ enabled: false }),
    } as Partial<CindySlotDeps>);
    expect(await disabled.slot.handleModelRequest('art', depositReq(b64(PNG)))).toMatchObject({
      ok: false,
    });
  });

  it('类型只认字节:非媒体内容拒收,额外塞的自报 mime 不作数', async () => {
    const { slot, depositMedia } = makeSlot();
    const json = new TextEncoder().encode('{"not":"media"}');
    const r = await slot.handleModelRequest('art', depositReq(b64(json), { mimeType: 'image/png' }));
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('受支持的媒体类型');
    expect(depositMedia).not.toHaveBeenCalled();
  });

  it('载荷形状:非字符串 / 空 / 非法 base64 / data: 前缀 → 拒', async () => {
    const { slot, depositMedia } = makeSlot();
    for (const bad of [undefined, '', 123, {}]) {
      expect(await slot.handleModelRequest('art', depositReq(bad))).toMatchObject({ ok: false });
    }
    // 冒号不在允许字符集内:明确拒绝,而不是让 Buffer.from 静默丢字符。
    const withPrefix = await slot.handleModelRequest(
      'art',
      depositReq(`data:image/png;base64,${b64(PNG)}`),
    );
    expect((withPrefix as { message: string }).message).toContain('base64');
    expect(depositMedia).not.toHaveBeenCalled();
  });

  it('单次上限:超限在解码前就拒(不为超长串分配解码缓冲)', async () => {
    const { slot, sniffDepositMime, depositMedia } = makeSlot();
    // 只造字符数、不造真字节:上限判定必须早于 base64 校验与解码。
    // 刚好越过字符闸(4/3 膨胀率 + padding)即可,不用造两倍——上限已是
    // 50MB 量级,乘 2 会让每次跑测试白分配上百 MB。
    const huge = 'A'.repeat(Math.ceil((GHOST_CINDY_DEPOSIT_MAX_BYTES * 4) / 3) + 1024);
    const r = await slot.handleModelRequest('art', depositReq(huge));
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('单次寄存上限');
    expect(sniffDepositMime).not.toHaveBeenCalled();
    expect(depositMedia).not.toHaveBeenCalled();
  });

  it('配额是硬顶:已用 + 本次超限即拒,不落仓', async () => {
    const { slot, depositMedia } = makeSlot({
      depositUsageBytes: vi.fn(async () => GHOST_CINDY_DEPOSIT_QUOTA_BYTES),
    } as Partial<CindySlotDeps>);
    const r = await slot.handleModelRequest('art', depositReq(b64(PNG)));
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('release_media');
    expect(depositMedia).not.toHaveBeenCalled();
  });

  it('频控:突发额度用尽后拒,且不再去打扰配额查询与落仓', async () => {
    const { slot, depositUsageBytes, depositMedia } = makeSlot();
    for (let i = 0; i < GHOST_CINDY_DEPOSIT_BURST; i++) {
      expect(await slot.handleModelRequest('art', depositReq(b64(PNG)))).toMatchObject({ ok: true });
    }
    const throttled = await slot.handleModelRequest('art', depositReq(b64(PNG)));
    expect(throttled).toMatchObject({ ok: false });
    expect((throttled as { message: string }).message).toContain('过于频繁');
    // 每单成功读两次配额(落仓前的硬顶预判 + 落仓后回读真实占用);被频控
    // 拦下的那单一次都不读,也不落仓 —— 频控闸在配额之前正是为了这个。
    expect(depositUsageBytes).toHaveBeenCalledTimes(GHOST_CINDY_DEPOSIT_BURST * 2);
    expect(depositMedia).toHaveBeenCalledTimes(GHOST_CINDY_DEPOSIT_BURST);
  });

  it('落仓抛错折叠成结构化拒绝', async () => {
    const { slot } = makeSlot({
      depositMedia: vi.fn(async () => {
        throw new Error('磁盘满');
      }),
    } as Partial<CindySlotDeps>);
    const r = await slot.handleModelRequest('art', depositReq(b64(PNG)));
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toContain('磁盘满');
  });

  it('注入实现意外抛错也不穿透("永不 reject"是对沙箱的硬承诺)', async () => {
    const boom = () => {
      throw new Error('嗅探炸了');
    };
    const dep = makeSlot({ sniffDepositMime: vi.fn(boom) } as unknown as Partial<CindySlotDeps>);
    const r1 = await dep.slot.handleModelRequest('art', depositReq(b64(PNG)));
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { message: string }).message).toContain('嗅探炸了');

    const rel = makeSlot({ releaseDeposit: vi.fn(boom) } as unknown as Partial<CindySlotDeps>);
    expect(await rel.slot.handleModelRequest('art', releaseReq('d'.repeat(64)))).toMatchObject({
      ok: false,
    });
  });

  it('能力未接线(主机没注入寄存三件套)→ fail closed', async () => {
    const slot = new GhostCindySlot({
      getGhost: () => fakeGhost(),
      generateImage: vi.fn(),
      editImage: vi.fn(),
      generateVideo: vi.fn(),
      editVideo: vi.fn(),
      resolveOwnedMedia: vi.fn(),
      getOverride: vi.fn(() => null),
      getImageConfig: vi.fn(() => ({ models: [], defaults: null })),
      getVideoConfig: vi.fn(() => ({ models: [], defaults: null })),
      saveGhostMedia: vi.fn(),
    } as unknown as CindySlotDeps);
    expect(await slot.handleModelRequest('art', depositReq(b64(PNG)))).toMatchObject({ ok: false });
  });

  it('release_media:指纹形状校验 + 归属由主机拼 + 幂等', async () => {
    const { slot, releaseDeposit } = makeSlot();
    expect(await slot.handleModelRequest('art', releaseReq('nope'))).toMatchObject({ ok: false });
    expect(releaseDeposit).not.toHaveBeenCalled();

    const HASH = 'd'.repeat(64);
    expect(await slot.handleModelRequest('art', releaseReq(HASH))).toMatchObject({
      ok: true,
      released: true,
    });
    // 删除条件由主机拼(refKind + 本意识 id),沙箱递不进 refKind / 别人的 id。
    expect(releaseDeposit).toHaveBeenCalledWith({ ghostId: 'art', hash: HASH });

    const { slot: slot2 } = makeSlot({
      releaseDeposit: vi.fn(async () => false),
    } as Partial<CindySlotDeps>);
    expect(await slot2.handleModelRequest('art', releaseReq(HASH))).toMatchObject({
      ok: true,
      released: false,
    });
  });

  it('release_media 同样过资格审(详单缺 deposit → 拒)', async () => {
    const { slot, releaseDeposit } = makeSlot({
      getGhost: () => fakeGhost({ model: { image: ['generate'] } }),
    } as Partial<CindySlotDeps>);
    expect(await slot.handleModelRequest('art', releaseReq('d'.repeat(64)))).toMatchObject({
      ok: false,
    });
    expect(releaseDeposit).not.toHaveBeenCalled();
  });
});

describe('快问快答(oneshot_text)', () => {
  const ONESHOT = { type: 'cindy-request', kind: 'oneshot_text', prompt: '总结一下' };
  const withText = (deps: Partial<CindySlotDeps> = {}) =>
    makeSlot({
      getGhost: () =>
        fakeGhost({ model: { image: ['generate'], text: ['oneshot'] } }),
      oneshotText: vi.fn(async () => ({ ok: true as const, text: '好的', model: 'chain/mini' })),
      ...deps,
    });

  it('未声明 text.oneshot → PERMISSION_DENIED,不触发链路', async () => {
    const oneshotText = vi.fn();
    const { slot } = makeSlot({ oneshotText });
    const r = await slot.handleModelRequest('art', ONESHOT);
    expect(r).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(oneshotText).not.toHaveBeenCalled();
  });

  it('载荷校验:空 prompt / 超长 prompt / 非法 maxTokens / 非法 expectJson → INVALID_PARAMS', async () => {
    const { slot } = withText();
    expect(
      await slot.handleModelRequest('art', { ...ONESHOT, prompt: '  ' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(
      await slot.handleModelRequest('art', { ...ONESHOT, prompt: 'x'.repeat(32_769) }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(
      await slot.handleModelRequest('art', { ...ONESHOT, maxTokens: 0 }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(
      await slot.handleModelRequest('art', { ...ONESHOT, maxTokens: 99999 }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(
      await slot.handleModelRequest('art', { ...ONESHOT, expectJson: 'yes' }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
  });

  it('能力未接线(deps 缺 oneshotText)→ 结构化拒绝,fail closed', async () => {
    const { slot } = makeSlot({
      getGhost: () => fakeGhost({ model: { text: ['oneshot'] } }),
      oneshotText: undefined,
    });
    expect(await slot.handleModelRequest('art', ONESHOT)).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
  });

  it('happy path:文字随返回递回,带实际选型;缺省 maxTokens=1024', async () => {
    const oneshotText = vi.fn(async () => ({ ok: true as const, text: '答案', model: 'chain/mini' }));
    const { slot } = withText({ oneshotText });
    const r = await slot.handleModelRequest('art', ONESHOT);
    expect(r).toMatchObject({ ok: true, text: '答案', model: 'chain/mini' });
    expect(oneshotText).toHaveBeenCalledWith({
      prompt: '总结一下',
      maxTokens: 1024,
      timeoutMs: 60_000,
    });
  });

  it('链路失败三档映射:no_candidate → NO_CANDIDATE,timeout → TIMEOUT,failed → INTERNAL', async () => {
    for (const [reason, errorCode] of [
      ['no_candidate', 'NO_CANDIDATE'],
      ['timeout', 'TIMEOUT'],
      ['failed', 'INTERNAL'],
    ] as const) {
      const { slot } = withText({
        oneshotText: vi.fn(async () => ({ ok: false as const, reason, message: '不行' })),
      });
      expect(await slot.handleModelRequest('art', ONESHOT)).toMatchObject({
        ok: false,
        errorCode,
        message: '不行',
      });
    }
  });

  it('expectJson:剥围栏后可解析 → 返回清洗后的 JSON 文本;不可解析 → BAD_MODEL_OUTPUT', async () => {
    const good = withText({
      oneshotText: vi.fn(async () => ({
        ok: true as const,
        text: '```json\n{"a":1}\n```',
      })),
    });
    expect(await good.slot.handleModelRequest('art', { ...ONESHOT, expectJson: true })).toMatchObject(
      { ok: true, text: '{"a":1}' },
    );
    const bad = withText({
      oneshotText: vi.fn(async () => ({ ok: true as const, text: '这不是 JSON' })),
    });
    expect(await bad.slot.handleModelRequest('art', { ...ONESHOT, expectJson: true })).toMatchObject(
      { ok: false, errorCode: 'BAD_MODEL_OUTPUT' },
    );
  });

  it('expectJson 时提示里追加 JSON 要求(确定性拼接,不甩给链路)', async () => {
    const oneshotText = vi.fn(async (_params: { prompt: string; maxTokens: number; timeoutMs: number }) => ({
      ok: true as const,
      text: '{}',
    }));
    const { slot } = withText({ oneshotText });
    await slot.handleModelRequest('art', { ...ONESHOT, expectJson: true });
    expect(oneshotText.mock.calls[0]?.[0]?.prompt).toContain('只输出 JSON');
  });

  it('在途并发闸与媒体代办共用:达到上限即 RATE_LIMITED', async () => {
    let release: (() => void) | null = null;
    const oneshotText = vi.fn(
      () =>
        new Promise<{ ok: true; text: string }>((resolve) => {
          release = () => resolve({ ok: true, text: 'ok' });
        }),
    );
    const { slot } = withText({ oneshotText, getInflightLimit: () => 1 });
    const first = slot.handleModelRequest('art', ONESHOT);
    await Promise.resolve();
    expect(await slot.handleModelRequest('art', ONESHOT)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    release!();
    expect(await first).toMatchObject({ ok: true });
  });

  it('注入实现抛错 → 折叠为 INTERNAL,不向沙箱穿透异常', async () => {
    const { slot } = withText({
      oneshotText: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect(await slot.handleModelRequest('art', ONESHOT)).toMatchObject({
      ok: false,
      errorCode: 'INTERNAL',
    });
  });
});

/**
 * 更新重启前的阻断探针要问「Cindy slot 现在有没有在干活」。两半状态各自独立记账
 * (异步 jobs / 同步 inflight),只查一半就会漏一半 —— 而漏掉的后果是 forceQuit()
 * 连 Ghost Node runtime 一起销毁,正在生成的付费结果直接丢掉。
 */
describe('anyInflightWork（更新重启阻断探针）', () => {
  it('空闲时为 false', () => {
    const { slot } = makeSlot();
    expect(slot.anyInflightWork()).toBe(false);
  });

  it('同步代办在途期间为 true，结算后回到 false', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { slot } = makeSlot({
      generateImage: vi.fn(async () => {
        // 请求已计入 inflight、但还没结算的那一刻。
        expect(slot.anyInflightWork()).toBe(true);
        await gate;
        return { buffer: new Uint8Array([1]), mimeType: 'image/png' };
      }),
    } as unknown as Partial<CindySlotDeps>);

    const pending = slot.handleModelRequest('art', REQ);
    release();
    await pending;
    expect(slot.anyInflightWork()).toBe(false);
  });

  // 寄存 / 撤回寄存在进入代办链之前就 return 了，走不到 inflight 记账；被打断会卡在
  // blob 落盘与账本挂引用之间，所以单独记 mediaOps。
  it('寄存在途期间为 true，结算后回到 false', async () => {
    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let seenDuring: boolean | null = null;
    const { slot } = makeSlot({
      depositMedia: vi.fn(async () => {
        seenDuring = slot.anyInflightWork();
        await gate;
        return { hash: 'a'.repeat(64), bytes: PNG_BYTES.length, usedBytes: 10, quotaBytes: 100 };
      }),
    } as unknown as Partial<CindySlotDeps>);

    const pending = slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'deposit_media',
      data: Buffer.from(PNG_BYTES).toString('base64'),
    });
    release();
    await pending;
    expect(seenDuring).toBe(true);
    expect(slot.anyInflightWork()).toBe(false);
  });

  it('寄存抛错也会释放在途计数（finally）', async () => {
    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const { slot } = makeSlot({
      depositMedia: vi.fn(async () => { throw new Error('disk is full'); }),
    } as unknown as Partial<CindySlotDeps>);

    const r = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'deposit_media',
      data: Buffer.from(PNG_BYTES).toString('base64'),
    });
    expect(r).toMatchObject({ ok: false });
    // 计数泄漏会让重启入口从此永久卡在「有任务在跑」。
    expect(slot.anyInflightWork()).toBe(false);
  });

  // 异步提交只对视频类开放（图像代办秒级完成，走同步等待）。
  it('异步视频代办（mode:submit）受理后为 true', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { slot } = makeSlot({
      generateVideo: vi.fn(async () => {
        await gate;
        return {
          buffer: new Uint8Array([1]),
          mimeType: 'video/mp4',
          videoParams: { durationSeconds: 4, resolution: '720p', ratio: '16:9', fps: 24 },
        };
      }),
    } as unknown as Partial<CindySlotDeps>);

    const res = await slot.handleModelRequest('art', {
      type: 'cindy-request',
      kind: 'gen_video',
      prompt: '一只猫奔跑',
      mode: 'submit',
    });
    expect(res).toMatchObject({ ok: true, status: 'running' });
    // 受理即返回，job 仍在途 —— 此时没有任何 turn 级信号还亮着。
    expect(slot.anyInflightWork()).toBe(true);
    release();
  });
});
