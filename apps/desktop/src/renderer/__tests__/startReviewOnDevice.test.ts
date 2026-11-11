import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReviewOnDevice } from '../lib/startReviewOnDevice';

afterEach(() => vi.unstubAllGlobals());

describe('Review execution device', () => {
  const request = { sourceSessionId: 'source-task', focus: 'changes' };

  function setup() {
    const invoke = vi.fn().mockResolvedValue({ reviewerSessionId: 'reviewer' });
    const startReview = vi.fn().mockResolvedValue({ reviewerSessionId: 'local-reviewer' });
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke }, maker: { startReview } } });
    return { invoke, startReview };
  }

  it('creates local Reviews through the local Main handler', async () => {
    const { invoke, startReview } = setup();
    await startReviewOnDevice(request, null);
    expect(startReview).toHaveBeenCalledWith(request);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes the source and attachments only to the controlled device', async () => {
    const { invoke, startReview } = setup();
    const remoteRequest = { ...request, attachments: [{
      id: 'notes', name: 'notes.md', path: 'notes.md', ext: '.md', size: 10,
      category: 'text' as const, mimeType: 'text/markdown',
    }] };
    await startReviewOnDevice(remoteRequest, 'controlled-device');
    expect(invoke).toHaveBeenCalledWith('controlled-device', 'maker:review:start', [remoteRequest]);
    expect(startReview).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('does not dispatch before task ownership resolves (%s)', async (deviceId) => {
    const { invoke, startReview } = setup();
    await expect(startReviewOnDevice(request, deviceId)).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');
    expect(invoke).not.toHaveBeenCalled();
    expect(startReview).not.toHaveBeenCalled();
  });

  it.each(['CHANNEL_NOT_ALLOWED', 'DEVICE_LINK_NOT_CONNECTED', 'TIMEOUT'])(
    'never falls back locally or retries on %s', async (code) => {
      const { invoke, startReview } = setup();
      invoke.mockRejectedValue(new Error(code));
      await expect(startReviewOnDevice(request, 'controlled-device')).rejects.toThrow(code);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(startReview).not.toHaveBeenCalled();
    },
  );
});
