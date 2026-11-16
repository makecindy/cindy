import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WechatTransport } from '@cindy/wechat-ilink';

const mocks = vi.hoisted(() => ({
  decodeWechatSilkToWav: vi.fn(),
  ingestMedia: vi.fn(),
  resolveSafe: vi.fn(),
}));

vi.mock('../silkDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../silkDecoder')>();
  return { ...actual, decodeWechatSilkToWav: mocks.decodeWechatSilkToWav };
});

vi.mock('../../../cindy-media/blobStore.desktop', () => ({
  resolveSafe: mocks.resolveSafe,
}));

vi.mock('../../../cindy-media/ingest', () => ({
  ingestMedia: mocks.ingestMedia,
}));

import { __testing, stageWechatTaskMedia } from '../mediaStaging';
import { pcmS16leToWav, WavOutputLimitError } from '../silkWav';

describe('WeChat media staging validation', () => {
  beforeEach(() => {
    mocks.decodeWechatSilkToWav.mockReset();
    mocks.ingestMedia.mockReset();
    mocks.resolveSafe.mockReset();
  });

  it('detects supported image bytes instead of trusting platform metadata', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(__testing.detectWechatMedia({ kind: 'image' }, png)).toEqual({
      attachmentKind: 'image',
      fileName: 'wechat-image.png',
      mimeType: 'image/png',
      storage: 'cindy-media',
    });
    expect(__testing.detectWechatMedia({ kind: 'image' }, Buffer.from('not-image'))).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果：detectWechatMedia 决定语音附件的 MIME 与入库分支；
  //   #10899 前按 encode_type 硬编码，真实微信语音（编码值不在白名单）全部被拒。
  // - Bug／规则依据：#10899。
  // - 现有覆盖缺口：旧用例断言“声明编码必须匹配字节”，正是被移除的错误契约。
  // - 最小失败输入：无 voiceEncoding 或超范围编码 + 真实容器魔数字节。
  // - tier：unit。
  it('detects voice containers by bytes regardless of the wire encode_type', () => {
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 8 }, Buffer.from('OggSvoice')),
    ).toMatchObject({ mimeType: 'audio/ogg' });
    expect(__testing.detectWechatMedia({ kind: 'voice' }, Buffer.from('OggSvoice'))).toMatchObject(
      { mimeType: 'audio/ogg' },
    );
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 6 }, Buffer.from('RIFF0000WAVEdata')),
    ).toMatchObject({ mimeType: 'audio/wav' });
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 99 }, Buffer.from('RIFF0000WAVEdata')),
    ).toMatchObject({ mimeType: 'audio/wav' });
    expect(__testing.detectWechatMedia({ kind: 'voice' }, Buffer.from('not-audio'))).toBeNull();
  });

  it('sanitizes platform filenames before creating owner-scoped paths', () => {
    expect(__testing.sanitizeAttachmentName('../../secret?.pdf', 'fallback.bin')).toBe(
      '.._.._secret_.pdf',
    );
    expect(__testing.sanitizeAttachmentName('... ', 'fallback.bin')).toBe('fallback.bin');
  });

  it('wraps worker-decoded mono PCM in a valid 24 kHz WAV container', () => {
    const wav = Buffer.from(pcmS16leToWav(Buffer.from([1, 0, 2, 0]), 24_000));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
  });

  it('rejects oversized PCM before allocating its WAV output', () => {
    expect(() => pcmS16leToWav(Buffer.from([1, 0]), 24_000, 45)).toThrow(
      WavOutputLimitError,
    );
  });

  it('records a staged media blob before exposing its attachment', async () => {
    const hash = 'a'.repeat(64);
    mocks.ingestMedia.mockResolvedValueOnce({
      hash,
      ext: '.png',
      mimeType: 'image/png',
      bytes: 8,
      url: `cindy-media://blobs/${hash}.png`,
      deduplicated: false,
      refIds: [],
    });
    mocks.resolveSafe.mockReturnValueOnce({ absPath: 'C:\\media\\wechat-image.png' });

    const result = await stageWechatTaskMedia(
      stageArgs({
        media: [{ kind: 'image' }],
        downloadMedia: vi
          .fn()
          .mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      }),
    );

    expect(mocks.ingestMedia).toHaveBeenCalledWith({
      buffer: expect.any(Uint8Array),
      mimeType: 'image/png',
      isCache: false,
      refs: [],
    });
    expect(mocks.ingestMedia.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveSafe.mock.invocationCallOrder[0]!,
    );
    expect(result.mediaRefs).toHaveLength(1);
  });

  // 测试价值
  // - 生产入口与可观察结果：真实微信语音（SILK 字节、encode_type 不在旧白名单）经
  //   stageWechatTaskMedia 应产出 audio/wav 附件；#10899 前整条消息被标
  //   voice:unsupported-format，音频从未交给模型。
  // - Bug／规则依据：#10899。
  // - 现有覆盖缺口：旧用例只在 voiceEncoding===6 时才走解码，且无端到端 staging 断言。
  // - 最小失败输入：media=[{kind:'voice'}]（无 voiceEncoding）+ #!SILK 魔数字节下载。
  // - tier：unit（解码器 mock，字节识别与检测走真实实现）。
  it('stages wire SILK voice as a wav attachment regardless of encode_type', async () => {
    const wav = Buffer.from(pcmS16leToWav(Buffer.from([1, 0, 2, 0]), 24_000));
    mocks.decodeWechatSilkToWav.mockResolvedValueOnce(wav);
    const hash = 'b'.repeat(64);
    mocks.ingestMedia.mockResolvedValueOnce({
      hash,
      ext: '.wav',
      mimeType: 'audio/wav',
      bytes: wav.byteLength,
      url: `cindy-media://blobs/${hash}.wav`,
      deduplicated: false,
      refIds: [],
    });
    mocks.resolveSafe.mockReturnValueOnce({ absPath: '/media/wechat-voice.wav' });

    const result = await stageWechatTaskMedia(
      stageArgs({
        media: [{ kind: 'voice' }],
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('#!SILK_V3\u0000frames')),
      }),
    );

    expect(mocks.decodeWechatSilkToWav).toHaveBeenCalledTimes(1);
    expect(result.unsupportedMedia).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({ mimeType: 'audio/wav', storage: 'cindy-media' }),
    ]);
    expect(result.mediaBlobs).toEqual([expect.objectContaining({ mimeType: 'audio/wav' })]);
  });

  it('distinguishes download, decode, and staging failures', async () => {
    const downloadFailed = await stageWechatTaskMedia(
      stageArgs({
        media: [{ kind: 'image' }],
        downloadMedia: vi.fn().mockRejectedValue(new Error('network unavailable')),
      }),
    );
    expect(downloadFailed.unsupportedMedia).toEqual(['image:download-failed']);

    mocks.decodeWechatSilkToWav.mockRejectedValueOnce(
      new Error('WECHAT_SILK_DECODE_FAILED'),
    );
    const decodeFailed = await stageWechatTaskMedia(
      stageArgs({
        media: [{ kind: 'voice', voiceEncoding: 6 }],
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('#!SILK_V3\u0000frames')),
      }),
    );
    expect(decodeFailed.unsupportedMedia).toEqual(['voice:decode-failed']);

    mocks.ingestMedia.mockRejectedValueOnce(new Error('disk full'));
    const stagingFailed = await stageWechatTaskMedia(
      stageArgs({
        media: [{ kind: 'image' }],
        downloadMedia: vi
          .fn()
          .mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      }),
    );
    expect(stagingFailed.unsupportedMedia).toEqual(['image:staging-failed']);
  });
});

function stageArgs({
  media,
  downloadMedia,
}: {
  media: Parameters<typeof stageWechatTaskMedia>[0]['media'];
  downloadMedia: ReturnType<typeof vi.fn>;
}): Parameters<typeof stageWechatTaskMedia>[0] {
  return {
    bindingEpoch: 'binding-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    media,
    transport: { downloadMedia } as unknown as WechatTransport,
    signal: new AbortController().signal,
    now: 100,
  };
}
