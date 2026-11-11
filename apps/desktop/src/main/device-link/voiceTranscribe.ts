/**
 * voiceTranscribe.ts — 被控端处理手机录音转写(device-link:voice:transcribe)。
 *
 * 手机端只负责录音并把音频上传到 device-link OSS 中转区;真正的 ASR provider、
 * API key 和模型选择都留在被控桌面端,与桌面语音输入同一信任边界。
 */
import {
  downloadToBuffer,
  removeRemote,
} from './mediaTransfer.desktop.js';
import {
  transcribeVoiceInputAudioFile,
  type VoiceInputAudioFileTranscriptionResult,
} from '../voice-input/index.js';

const MAX_VOICE_AUDIO_BYTES = 64 * 1024 * 1024;

export type DeviceLinkVoiceTranscribeResult = VoiceInputAudioFileTranscriptionResult & {
  audioBytes: number;
};

export async function transcribeRemoteVoiceInput(arg: unknown): Promise<DeviceLinkVoiceTranscribeResult> {
  const req = normalizeVoiceTranscribeRequest(arg);
  const downloaded = await downloadToBuffer(req.ossKey);
  try {
    if (downloaded.bytes.byteLength > MAX_VOICE_AUDIO_BYTES) {
      throw new Error(`语音录音超过上限 ${Math.round(MAX_VOICE_AUDIO_BYTES / 1024 / 1024)}MB`);
    }
    const result = await transcribeVoiceInputAudioFile({
      bytes: downloaded.bytes,
      mimeType: req.mimeType ?? downloaded.contentType ?? undefined,
      fileName: req.fileName,
      sourceLanguage: req.sourceLanguage,
    });
    return {
      ...result,
      audioBytes: downloaded.bytes.byteLength,
    };
  } finally {
    void removeRemote(req.ossKey);
  }
}

function normalizeVoiceTranscribeRequest(value: unknown): {
  ossKey: string;
  mimeType?: string;
  fileName?: string;
  sourceLanguage?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('voice:transcribe 请求体必须为 object');
  }
  const record = value as Record<string, unknown>;
  const ossKey = readString(record.ossKey);
  if (!ossKey) throw new Error('voice:transcribe 缺少 ossKey');
  return {
    ossKey,
    mimeType: readString(record.mimeType) ?? undefined,
    fileName: readString(record.fileName) ?? undefined,
    sourceLanguage: readString(record.sourceLanguage) ?? undefined,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const __testing = { normalizeVoiceTranscribeRequest, MAX_VOICE_AUDIO_BYTES };
