import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setMobileAuthOwner, __testing } from '@/auth/authOwnerGeneration';
import { discardNewSessionUploadedAttachments } from '@/session/newSessionAttachmentCleanup';

const discard = vi.hoisted(() => vi.fn());
vi.mock('@/session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: discard }));

describe('new task attachment cleanup on account change', () => {
  beforeEach(() => { __testing.reset(); discard.mockReset(); });

  it('reclaims every completed upload with one eagerly captured outgoing token', async () => {
    setMobileAuthOwner('a');
    setMobileAuthOwner(null);
    const attachments = [{ path: 'one' }, { path: 'two' }];
    const getToken = vi.fn(async () => 'outgoing-token');
    discardNewSessionUploadedAttachments(attachments, getToken);
    expect(getToken).toHaveBeenCalledOnce();
    expect(discard.mock.calls.map(([attachment]) => attachment)).toEqual(attachments);
    for (const [, options] of discard.mock.calls) {
      await expect(options.getToken()).resolves.toBe('outgoing-token');
    }
  });

  it('does not use credentials across a later account or realm transition', async () => {
    let resolve!: (token: string) => void;
    const token = new Promise<string>((done) => { resolve = done; });
    discardNewSessionUploadedAttachments([{ path: 'one' }], () => token);
    setMobileAuthOwner('b', 'cn');
    resolve('late-token');
    await expect(discard.mock.calls[0]![1].getToken()).resolves.toBeNull();
  });

  it('does not fetch credentials for an empty draft and tolerates credential failure', async () => {
    const getToken = vi.fn(async () => { throw new Error('expired'); });
    discardNewSessionUploadedAttachments([], getToken);
    expect(getToken).not.toHaveBeenCalled();
    discardNewSessionUploadedAttachments([{ path: 'one' }], getToken);
    await expect(discard.mock.calls[0]![1].getToken()).resolves.toBeNull();
  });
});
