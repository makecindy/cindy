import { describe, expect, it, vi } from 'vitest';

const { refresh, serverApiFetch, ServerApiError } = vi.hoisted(() => {
  class TestServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = 'ServerApiError';
    }
  }
  return {
    refresh: vi.fn<() => Promise<boolean>>(),
    serverApiFetch: vi.fn(),
    ServerApiError: TestServerApiError,
  };
});

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
}));
vi.mock('../../authManager.js', () => ({
  getAccessToken: vi.fn(() => 'stale-token'),
  refresh,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: vi.fn(() => 'https://voice.example.com'),
}));
vi.mock('../../serverApiClient.js', () => ({
  ServerApiError,
  serverApiFetch,
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyAccountServices: true }),
  requireAppCapability: vi.fn(),
}));

import { CindyVoiceRunContext } from '../CindyVoiceSessionClient.js';

const SESSION = {
  sessionId: 'session-1',
  ticket: 'ticket-1',
  expiresAt: '2026-07-22T00:00:00.000Z',
  asr: {
    provider: 'qwen-asr-flash-realtime',
    websocketUrl: 'wss://voice.example.com/api/voice/asr',
    protocolProfile: 'qwen-asr-server-vad' as const,
    sampleRate: 16_000,
  },
  refiner: { enabled: true, provider: 'qwen-plus' },
};

describe('CindyVoiceRunContext', () => {
  it('refreshes once and retries managed session allocation after a plain 401', async () => {
    refresh.mockResolvedValueOnce(true);
    serverApiFetch
      .mockRejectedValueOnce(new ServerApiError('UNAUTHORIZED', 401, 'Unauthorized'))
      .mockResolvedValueOnce(SESSION);
    const context = new CindyVoiceRunContext('zh-CN', 'qwen-plus');

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: SESSION.asr.websocketUrl,
      authorizationToken: SESSION.ticket,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(serverApiFetch).toHaveBeenCalledTimes(2);
    expect(serverApiFetch.mock.calls[0]).toEqual(serverApiFetch.mock.calls[1]);
  });

  it('keeps dictation working on a legacy server that rejects the auto refiner marker', async () => {
    serverApiFetch.mockReset();
    serverApiFetch
      .mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, '不支持的语音优化 Provider'))
      .mockResolvedValueOnce({ ...SESSION, refiner: { enabled: false } });
    const context = new CindyVoiceRunContext('zh-CN', 'auto');

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: SESSION.asr.websocketUrl,
      authorizationToken: SESSION.ticket,
    });
    // The retry drops managed refinement so ASR still works...
    expect(serverApiFetch).toHaveBeenCalledTimes(2);
    const retryBody = (serverApiFetch.mock.calls[1][1] as { body: { refinerProvider?: string } }).body;
    expect(retryBody.refinerProvider).toBeUndefined();
    // ...and refine/warmup fail fast instead of hitting a server without the contract.
    await expect(context.createRefinerTarget('auto')).rejects.toThrow('does not support managed refinement');
    await expect(
      context.warmRefiner({ system: 's', user: {}, promptCacheKey: 'k' }),
    ).rejects.toThrow('does not support managed refinement');
  });

  it('does not downgrade on a 400 when using a concrete refiner provider', async () => {
    serverApiFetch.mockReset();
    serverApiFetch.mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'bad request'));
    const context = new CindyVoiceRunContext('zh-CN', 'qwen-plus');

    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).rejects.toThrow('bad request');
    expect(serverApiFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps trying managed refinement on later ASR candidates when the retry also fails', async () => {
    // A 400 caused by the ASR candidate itself (not the 'auto' marker) fails
    // the no-refiner retry too; the next candidate on the same run context
    // must still request managed refinement.
    serverApiFetch.mockReset();
    serverApiFetch
      .mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'unsupported ASR provider'))
      .mockRejectedValueOnce(new ServerApiError('INVALID_PARAMS', 400, 'unsupported ASR provider'))
      .mockResolvedValueOnce(SESSION);
    const context = new CindyVoiceRunContext('zh-CN', 'auto');

    await expect(context.createAsrConnection('bad-candidate')).rejects.toThrow('unsupported ASR provider');
    await expect(context.createAsrConnection('qwen-asr-flash-realtime')).resolves.toEqual({
      websocketUrl: SESSION.asr.websocketUrl,
      authorizationToken: SESSION.ticket,
    });
    const thirdBody = (serverApiFetch.mock.calls[2][1] as { body: { refinerProvider?: string } }).body;
    expect(thirdBody.refinerProvider).toBe('auto');
  });

  it('does not let a late session allocation overwrite a newer fallback attempt', async () => {
    serverApiFetch.mockReset();
    let resolveFirst!: (session: typeof SESSION) => void;
    const firstResponse = new Promise<typeof SESSION>((resolve) => {
      resolveFirst = resolve;
    });
    serverApiFetch
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(SESSION);
    const context = new CindyVoiceRunContext('zh-CN', 'auto');

    const first = context.createAsrConnection('qwen-asr-flash-realtime');
    await Promise.resolve();
    const second = context.createAsrConnection('qwen-asr-flash-realtime');
    await expect(second).resolves.toEqual({
      websocketUrl: SESSION.asr.websocketUrl,
      authorizationToken: SESSION.ticket,
    });
    resolveFirst(SESSION);
    await expect(first).rejects.toThrow('superseded by a newer provider attempt');
  });
});
