import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-maker-test'),
    isPackaged: false,
  },
}));

import { summarizeWsMessage } from '../VoiceInputSessionRecorder.js';

describe('VoiceInputSessionRecorder message summaries', () => {
  it('redacts custom ASR payload fields while retaining the event type', () => {
    expect(summarizeWsMessage({
      type: 'error',
      error: {
        message: 'wss://asr.example.test?token=upstream-secret',
      },
    }, true)).toEqual({
      redacted: true,
      type: 'error',
    });
  });

  it('preserves the existing compact summary for non-custom sessions', () => {
    expect(summarizeWsMessage({
      type: 'session.updated',
      model: 'gpt-realtime-whisper',
    })).toEqual({
      type: 'session.updated',
      model: 'gpt-realtime-whisper',
    });
  });
});
