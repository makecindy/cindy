import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WechatTransport } from '@cindy/wechat-ilink';

const mocks = vi.hoisted(() => ({
  decodeWechatSilkToWav: vi.fn(),
  ingestMedia: vi.fn(),
  resolveSafe: vi.fn(),
}));

vi.mock('../silkDecoder', () => ({
  decodeWechatSilkToWav: mocks.decodeWechatSilkToWav,
}));

vi.mock('../../../cindy-media/blobStore', () => ({
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

  it('requires the declared voice encoding to match the downloaded bytes', () => {
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 8 }, Buffer.from('OggSvoice')),
    ).toMatchObject({ mimeType: 'audio/ogg' });
    expect(
      __testing.detectWechatMedia({ kind: 'voice', voiceEncoding: 7 }, Buffer.from('OggSvoice')),
    ).toBeNull();
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
        downloadMedia: vi.fn().mockResolvedValue(Buffer.from('silk')),
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
