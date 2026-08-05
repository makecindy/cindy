/**
 * voiceTranscribe.test.ts — 手机语音输入在被控桌面端的转写编排。
 *
 * 这里只测 device-link 信任边界内的编排:OSS 下载、大小校验、复用桌面
 * voice-input batch ASR、best-effort 清理。真实 ASR provider 由 voice-input
 * 自己的测试覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const downloadToBuffer = vi.hoisted(() => vi.fn());
const removeRemote = vi.hoisted(() => vi.fn());
vi.mock('../mediaTransfer.js', () => ({
  downloadToBuffer,
  removeRemote,
}));

const transcribeVoiceInputAudioFile = vi.hoisted(() => vi.fn());
vi.mock('../../voice-input/index.js', () => ({
  transcribeVoiceInputAudioFile,
}));

import { transcribeRemoteVoiceInput, __testing } from '../voiceTranscribe.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transcribeRemoteVoiceInput', () => {
  it('downloads the uploaded audio and transcribes with desktop voice-input config', async () => {
    const bytes = Buffer.from('voice-bytes');
    downloadToBuffer.mockResolvedValue({ bytes, contentType: 'audio/mp4' });
    transcribeVoiceInputAudioFile.mockResolvedValue({
      text: '手机语音文本',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    });

    const result = await transcribeRemoteVoiceInput({
      ossKey: 'cindy/device-link/user-1/voice.m4a',
      fileName: 'voice.m4a',
    });

    expect(downloadToBuffer).toHaveBeenCalledWith('cindy/device-link/user-1/voice.m4a');
    expect(transcribeVoiceInputAudioFile).toHaveBeenCalledWith({
      bytes,
      mimeType: 'audio/mp4',
      fileName: 'voice.m4a',
      sourceLanguage: undefined,
    });
    expect(result).toEqual({
      text: '手机语音文本',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
      audioBytes: bytes.byteLength,
    });
    expect(removeRemote).toHaveBeenCalledWith('cindy/device-link/user-1/voice.m4a');
  });

  it('lets request mime type override the downloaded content type', async () => {
    const bytes = Buffer.from('voice');
    downloadToBuffer.mockResolvedValue({ bytes, contentType: 'application/octet-stream' });
    transcribeVoiceInputAudioFile.mockResolvedValue({
      text: 'ok',
      provider: 'litellm-batch',
      model: 'elevenlabs/scribe_v2',
    });

    await transcribeRemoteVoiceInput({
      ossKey: 'k',
      mimeType: 'audio/wav',
      sourceLanguage: 'zh-CN',
    });

    expect(transcribeVoiceInputAudioFile).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'audio/wav',
      sourceLanguage: 'zh-CN',
    }));
  });

  it('rejects invalid requests before touching OSS', async () => {
    await expect(transcribeRemoteVoiceInput({})).rejects.toThrow('缺少 ossKey');
    await expect(transcribeRemoteVoiceInput(null)).rejects.toThrow('请求体必须为 object');
    expect(downloadToBuffer).not.toHaveBeenCalled();
  });

  it('cleans the uploaded object even when the recording is oversized', async () => {
    downloadToBuffer.mockResolvedValue({
      bytes: { byteLength: __testing.MAX_VOICE_AUDIO_BYTES + 1 },
      contentType: 'audio/mp4',
    });

    await expect(transcribeRemoteVoiceInput({ ossKey: 'huge-key' })).rejects.toThrow('语音录音超过上限');

    expect(transcribeVoiceInputAudioFile).not.toHaveBeenCalled();
    expect(removeRemote).toHaveBeenCalledWith('huge-key');
  });

  it('cleans the uploaded object when ASR fails', async () => {
    downloadToBuffer.mockResolvedValue({ bytes: Buffer.from('voice'), contentType: 'audio/mp4' });
    transcribeVoiceInputAudioFile.mockRejectedValue(new Error('asr down'));

    await expect(transcribeRemoteVoiceInput({ ossKey: 'voice-key' })).rejects.toThrow('asr down');

    expect(removeRemote).toHaveBeenCalledWith('voice-key');
  });
});
