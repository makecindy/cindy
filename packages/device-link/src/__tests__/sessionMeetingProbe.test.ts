import { describe, expect, it, vi } from 'vitest';
import { meetingHostPeer } from '../protocol.js';
import { probeSessionMeetingHost } from '../sessionMeetingProbe.js';

const peer = meetingHostPeer('meeting');
function fixture() {
  return {
    isCurrent: vi.fn(() => true),
    get: vi.fn(async () => ({ meetingId: 'meeting', sessionId: 'task', status: 'active' })),
    openLink: vi.fn(async () => undefined),
    invoke: vi.fn(async () => ({ ok: true })),
  };
}
describe('shared task recovery probe', () => {
  it('proves DB responsiveness using only the authorized task', async () => {
    const deps = fixture();
    await expect(probeSessionMeetingHost(peer, deps)).resolves.toEqual({ ok: true });
    expect(deps.get).toHaveBeenCalledWith('meeting');
    expect(deps.openLink).toHaveBeenCalledOnce();
    expect(deps.invoke).toHaveBeenCalledExactlyOnceWith('local-db:sessions:get', ['task']);
  });
  it('does not open a link without a current active membership response', async () => {
    for (const detail of [
      { meetingId: 'other', sessionId: 'task', status: 'active' },
      { meetingId: 'meeting', sessionId: 'task', status: 'closed' },
    ]) {
      const deps = fixture();
      deps.get.mockResolvedValue(detail);
      await expect(probeSessionMeetingHost(peer, deps)).rejects.toThrow();
      expect(deps.openLink).not.toHaveBeenCalled();
    }
  });
  it('does not reuse a stale account or link after either await', async () => {
    for (const boundary of ['get', 'openLink'] as const) {
      const deps = fixture();
      if (boundary === 'get') deps.get.mockImplementation(async () => {
        deps.isCurrent.mockReturnValue(false);
        return { meetingId: 'meeting', sessionId: 'task', status: 'active' };
      });
      else deps.openLink.mockImplementation(async () => { deps.isCurrent.mockReturnValue(false); });
      await expect(probeSessionMeetingHost(peer, deps)).rejects.toThrow();
      expect(deps.invoke).not.toHaveBeenCalled();
    }
  });
  it('keeps another peer probe independent when one fails', async () => {
    const bad = fixture();
    bad.openLink.mockRejectedValue(new Error('peer offline'));
    const good = fixture();
    const results = await Promise.allSettled([probeSessionMeetingHost(peer, bad), probeSessionMeetingHost(peer, good)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(good.invoke).toHaveBeenCalledOnce();
  });
  it('rejects unknown peers before any request', async () => {
    const deps = fixture();
    await expect(probeSessionMeetingHost('ordinary-device', deps)).rejects.toThrow();
    expect(deps.get).not.toHaveBeenCalled();
  });
});
