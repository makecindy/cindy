import { describe, expect, it, vi } from 'vitest';
import { invokeLegacyMedia, legacyMediaBody, legacyVideoReceipt } from '../legacyMediaInvocation.js';

const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
const schema = { properties: { prompt: {}, image: {}, aspect_ratio: {} }, required: ['prompt'] };
const prepared = { ok: true, invocation_id: 'existing-core-id', input_schema: schema };

describe('旧接口适配 Core media', () => {
  it('保留完整模型来源，使用 Server 输入说明，只提交一次并返回 Core 已入仓结果', async () => {
    const callCore = vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ ok: true, status: 'complete', xdt_image_urls: [url] });
    expect(await invokeLegacyMedia({
      kind: 'gen_image', prompt: '一只猫', model: 'openai/gpt-image-2',
      providerId: 'openai', aspectRatio: '3:2',
    }, { callCore, assertCurrent() {}, timeoutMs: 1000 })).toEqual({
      url, invocationId: 'existing-core-id',
    });
    expect(callCore.mock.calls.map(([request]) => request)).toEqual([
      { action: 'prepare', capability: 'image.generate', modelId: 'openai/gpt-image-2', providerId: 'openai' },
      { action: 'request', invocationId: 'existing-core-id', body: { prompt: '一只猫', aspect_ratio: '3:2' } },
    ]);
  });

  it('异步查询始终沿用原 invocation，不创建第二次付费提交', async () => {
    const videoUrl = url.replace('.png', '.mp4');
    const callCore = vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ ok: true, status: 'pending', recommended_poll_after_ms: 15 })
      .mockResolvedValueOnce({ ok: true, status: 'complete', xdt_video_urls: [videoUrl] });
    const wait = vi.fn(async () => {});
    expect(await invokeLegacyMedia({ kind: 'gen_video', prompt: '猫走路', model: 'video' }, {
      callCore, wait, assertCurrent() {}, timeoutMs: 1000,
    })).toMatchObject({ url: videoUrl });
    expect(wait).toHaveBeenCalledWith(15);
    expect(callCore.mock.calls.map(([request]) => request.action)).toEqual(['prepare', 'request', 'poll']);
    expect(callCore.mock.calls.at(-1)?.[0]).toEqual({ action: 'poll', invocationId: 'existing-core-id' });
  });

  it('输入无法表达必填参数时，付费提交之前拒绝', async () => {
    const callCore = vi.fn().mockResolvedValue({
      ...prepared, input_schema: { ...schema, required: ['prompt', 'unsupported_required_field'] },
    });
    await expect(invokeLegacyMedia({ kind: 'gen_image', model: 'image', prompt: '猫' }, {
      callCore, assertCurrent() {}, timeoutMs: 1000,
    })).rejects.toThrow('unsupported_required_field');
    expect(callCore).toHaveBeenCalledTimes(1);
  });

  it('读取 Guide 期间切换账号时，不提交生成', async () => {
    let changed = false;
    const callCore = vi.fn(async () => { changed = true; return prepared; });
    await expect(invokeLegacyMedia({ kind: 'gen_image', model: 'image', prompt: '猫' }, {
      callCore, timeoutMs: 1000,
      assertCurrent() { if (changed) throw new Error('owner changed'); },
    })).rejects.toThrow('owner changed');
    expect(callCore).toHaveBeenCalledTimes(1);
  });

  it('无法确认提交结果时，不重提、不退回旧执行器', async () => {
    const callCore = vi.fn().mockResolvedValueOnce(prepared).mockResolvedValueOnce({
      ok: false, message: '提交结果未知', retryable: false,
    });
    await expect(invokeLegacyMedia({ kind: 'gen_image', model: 'image', prompt: '猫' }, {
      callCore, assertCurrent() {}, timeoutMs: 1000,
    })).rejects.toThrow('提交结果未知');
    expect(callCore).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('保持首尾帧顺序、显式时长与音频关闭，兼容同时要求 prompt 的接口（%s）', promptField => {
    expect(legacyMediaBody({
      kind: 'edit_video', model: 'video', prompt: '镜头前进',
      images: ['first', 'last'], duration: 8, resolution: '720p', ratio: '16:9', audio: false,
    }, { properties: { content: {}, duration: {}, resolution: {}, ratio: {}, generate_audio: {}, ...(promptField ? { prompt: {} } : {}) } })).toEqual({
      ...(promptField ? { prompt: '镜头前进' } : {}),
      content: [
        { type: 'text', text: '镜头前进' },
        { type: 'image_url', image_url: { url: 'first' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'last' }, role: 'last_frame' },
      ],
      duration: 8, resolution: '720p', ratio: '16:9', generate_audio: false,
    });
  });

  it('沿用旧视频缺省时长，图生视频保留上游原图比例，不默认提交音频开关', () => {
    expect(legacyMediaBody({
      kind: 'edit_video', model: 'video', prompt: '移动', images: ['first'],
      videoDefaults: { duration: 6, resolution: '720p', ratio: '16:9', fps: 24, audioDefault: true },
    }, { properties: { prompt: {}, image: { type: 'object' }, duration: {}, resolution: {}, aspect_ratio: {} } })).toEqual({
      prompt: '移动', image: { url: 'first' }, duration: 6, resolution: '720p',
    });
  });

  it('旧结果回执优先采用上游实际参数，保留固定帧率和音轨默认事实', () => {
    expect(legacyVideoReceipt({ kind: 'gen_video', model: 'video', prompt: '移动', duration: 6 }, {
      duration: 6, resolution: '720p', ratio: '16:9', fps: 24, audioDefault: true,
    }, { video: { duration: 7, resolution: '1080p', aspect_ratio: '4:3' } })).toEqual({
      durationSeconds: 7, resolution: '1080p', ratio: '4:3', fps: 24, audio: true,
    });
  });

  it('旧视频回执保留 Seedance 实际帧率，优先于请求值与默认值', () => {
    expect(legacyVideoReceipt({ kind: 'gen_video', model: 'video', prompt: '移动', fps: 24 }, {
      duration: 6, resolution: '720p', ratio: '16:9', fps: 24,
    }, { framespersecond: 30 }).fps).toBe(30);
  });
});
