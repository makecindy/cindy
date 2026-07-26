import { describe, expect, it } from 'vitest';

import { validateVoiceInputCustomAsrWebsocketUrl } from '../voiceInputCustomAsr.js';

describe('custom ASR WebSocket URL validation', () => {
  it.each(['sig', 'signature', 'password', 'X-Amz-Signature'])(
    'rejects credential query parameter %s',
    (key) => {
      expect(validateVoiceInputCustomAsrWebsocketUrl(`wss://asr.example.test/stream?${key}=secret`))
        .toContain('must not contain credentials');
    },
  );

  it('allows protocol-owned model routing query parameters', () => {
    expect(validateVoiceInputCustomAsrWebsocketUrl(
      'wss://asr.example.test/stream?model=qwen3-asr-flash-realtime',
    )).toBeNull();
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
