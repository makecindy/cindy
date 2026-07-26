import { describe, expect, it } from 'vitest';

import { validateVoiceInputCustomAsrWebsocketUrl } from '../voiceInputCustomAsr.js';

describe('custom ASR WebSocket URL validation', () => {
  it.each(['sig', 'signature', 'password', 'X-Amz-Signature'])(
    'rejects credential query parameter %s',
    (key) => {
      expect(validateVoiceInputCustomAsrWebsocketUrl(`wss://asr.example.test/stream?${key}=secret`))
        .toContain('unsupported query parameters');
    },
  );

  it('allows known non-secret protocol and tenant routing query parameters', () => {
    expect(validateVoiceInputCustomAsrWebsocketUrl(
      'wss://asr.example.test/stream?model=qwen3-asr-flash-realtime&intent=transcription&tenant=one',
    )).toBeNull();
  });

  it('rejects unknown and signed URL query parameters', () => {
    expect(validateVoiceInputCustomAsrWebsocketUrl(
      'wss://asr.example.test/stream?X-Goog-Signature=secret',
    )).toContain('unsupported query parameters');
    expect(validateVoiceInputCustomAsrWebsocketUrl(
      'wss://asr.example.test/stream?custom-routing=value',
    )).toContain('unsupported query parameters');
  });

  it('allows loopback ws IPv6 literals', () => {
    expect(validateVoiceInputCustomAsrWebsocketUrl('ws://[::1]/stream')).toBeNull();
  });

  it('allows valid loopback IPv4 and rejects out-of-range octets', () => {
    expect(validateVoiceInputCustomAsrWebsocketUrl('ws://127.0.0.1/stream')).toBeNull();
    expect(validateVoiceInputCustomAsrWebsocketUrl('ws://127.255.255.255/stream')).toBeNull();
    expect(validateVoiceInputCustomAsrWebsocketUrl('ws://127.999.999.999/stream')).not.toBeNull();
  });
});
