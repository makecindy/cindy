import { describe, expect, it, vi } from 'vitest';
import { createSessionMeetingApi, SessionMeetingScopeChangedError } from '../sessionMeetingApi.js';

const snapshot = () => ({
  meetingId: 'meeting', sessionId: 'session', ownerAccountId: 'owner', hostDeviceId: 'desktop',
  revision: 2, status: 'active', title: 'Task', guests: [{
    memberId: 'member', accountId: 'guest', deviceIds: ['phone'], version: 1, displayName: 'Guest', joinedAt: 1,
  }],
});
function setup() {
  let generation = 1;
  const request = vi.fn<(path: string, options: unknown) => Promise<unknown>>();
  const api = createSessionMeetingApi({ request, captureScope: () => {
    const captured = generation;
    return { isCurrent: () => captured === generation };
  } });
  return { api, request, changeAccountOrRegion: () => { generation++; } };
}
describe('meeting management client', () => {
  it('observes a late create ID for host cleanup but never returns stale UI success', async () => {
    const { api, request, changeAccountOrRegion } = setup();
    const observed = vi.fn();
    request.mockImplementation(async () => { changeAccountOrRegion(); return { meetingId: 'meeting', revision: 1 }; });
    await expect(api.create('session', 'Task', observed)).rejects.toBeInstanceOf(SessionMeetingScopeChangedError);
    expect(observed).toHaveBeenCalledExactlyOnceWith('meeting');
  });
  it('does not pass malformed create IDs to cleanup', async () => {
    const { api, request } = setup();
    const observed = vi.fn();
    request.mockResolvedValue({ meetingId: '../bad', revision: 1 });
    await expect(api.create('session', 'Task', observed)).rejects.toThrow('identifier');
    expect(observed).not.toHaveBeenCalled();
  });
  it('projects the server snapshot separately from display labels', async () => {
    const { api, request } = setup();
    const input = snapshot();
    request.mockResolvedValue(input);
    const detail = await api.get('meeting');
    expect(detail.guests[0]).not.toHaveProperty('displayName');
    expect(detail.memberLabels).toEqual([{ memberId: 'member', displayName: 'Guest', joinedAt: 1 }]);
    input.guests[0].deviceIds.push('another');
    expect(detail.guests[0].deviceIds).toEqual(['phone']);
    expect(request).toHaveBeenCalledWith('/api/device-link/meetings/meeting', expect.objectContaining({ method: 'GET' }));
  });
  it('keeps invitation credentials in POST bodies instead of URL paths', async () => {
    const { api, request } = setup();
    const invitation = 'x'.repeat(43);
    request.mockResolvedValue({ meetingId: 'meeting', memberId: 'member', status: 'joined', created: true });
    await api.join(invitation, 'Guest');
    expect(request).toHaveBeenCalledWith('/api/device-link/meetings/join', expect.objectContaining({ method: 'POST', body: { invitation, displayName: 'Guest' } }));
    expect(request.mock.calls[0][0]).not.toContain(invitation);
  });
  it('rejects late authority replies after account or region changes', async () => {
    const { api, request, changeAccountOrRegion } = setup();
    request.mockImplementation(async () => { changeAccountOrRegion(); return snapshot(); });
    await expect(api.get('meeting')).rejects.toBeInstanceOf(SessionMeetingScopeChangedError);
  });
  it('does not submit operations for an already invalid scope', async () => {
    const request = vi.fn();
    const api = createSessionMeetingApi({ request, captureScope: () => ({ isCurrent: () => false }) });
    await expect(api.close('meeting')).rejects.toBeInstanceOf(SessionMeetingScopeChangedError);
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects responses for another meeting or member', async () => {
    const { api, request } = setup();
    request.mockResolvedValue({ ...snapshot(), meetingId: 'other-meeting' });
    await expect(api.get('meeting')).rejects.toThrow('scope mismatch');
    request.mockResolvedValue({ memberId: 'other-member', status: 'removed' });
    await expect(api.remove('meeting', 'member')).rejects.toThrow('scope mismatch');
  });
  it('validates decisions, identifier paths, and malformed snapshots', async () => {
    const { api, request } = setup();
    await expect(api.close('../devices')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue({ ...snapshot(), guests: [{ ...snapshot().guests[0], accountId: 'owner' }] });
    await expect(api.get('meeting')).rejects.toThrow();
  });
  it('preserves server errors instead of silently accepting failed revocations', async () => {
    const { api, request } = setup();
    const error = new Error('Service unavailable');
    request.mockRejectedValue(error);
    await expect(api.remove('meeting', 'member')).rejects.toBe(error);
    await expect(api.close('meeting')).rejects.toBe(error);
  });
  it('validates list bounds', async () => {
    const { api, request } = setup();
    request.mockResolvedValue({ meetings: [snapshot(), snapshot()] });
    await expect(api.list()).rejects.toThrow('Duplicate');
  });
});
