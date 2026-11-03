import { describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/ipc/botAvatarSelection.js', () => ({
  validateBotAvatarBuffer: (bytes: Buffer) => {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    throw new Error('invalid avatar');
  },
}));

import { resolveTeammateAvatarInput, type TeammateAvatarInputDeps } from '../teammateAvatarInput.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const baseInput = {
  sessionId: 'session-1', sessionInstanceId: 'instance-1',
  workingDir: 'C:\\task', remoteHostId: null,
};

function deps(overrides: Partial<TeammateAvatarInputDeps> = {}): TeammateAvatarInputDeps {
  return {
    isCurrentSession: () => true,
    authorizePath: async () => ({ allowed: true }),
    ...overrides,
  };
}

describe('teammate avatar input', () => {
  it('accepts portable avatars without reading an image', async () => {
    const readPicture = vi.fn();
    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: '🐱' }, deps({ readPicture })))
      .toEqual({ ok: true, avatar: '🐱' });
    expect(readPicture).not.toHaveBeenCalled();
  });

  it('downloads a public HTTPS image with a byte limit and validates its bytes', async () => {
    const fetchImage = vi.fn().mockResolvedValue({ buffer: png, mimeType: 'image/png' });
    const result = await resolveTeammateAvatarInput({ ...baseInput, avatar: 'https://example.com/avatar.png' }, deps({ fetchImage }));
    expect(result).toEqual({ ok: true, avatarImageBase64: png.toString('base64') });
    expect(fetchImage).toHaveBeenCalledWith('https://example.com/avatar.png', 5 * 1024 * 1024, undefined, { timeoutMs: 15_000 });
  });

  it('rejects untrusted URL schemes and invalid image bytes', async () => {
    const readPicture = vi.fn();
    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: 'http://example.com/avatar.png' }, deps({ readPicture })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(readPicture).not.toHaveBeenCalled();
    const fetchImage = vi.fn().mockResolvedValue({ buffer: Buffer.from('not an image') });
    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: 'https://example.com/avatar.png' }, deps({ fetchImage })))
      .toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });

  it('checks the live task instance before and after local image reads', async () => {
    const readPicture = vi.fn().mockResolvedValue({ ok: true, bytes: png });
    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: 'avatar.png' }, deps({
      isCurrentSession: () => false, readPicture,
    }))).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(readPicture).not.toHaveBeenCalled();
    const isCurrentSession = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: 'avatar.png' }, deps({
      isCurrentSession, readPicture,
    }))).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(readPicture).toHaveBeenCalledWith('avatar.png', 'C:\\task', expect.any(Function));
  });

  it('never reads a controller-local file for a remote task', async () => {
    const readPicture = vi.fn();
    expect(await resolveTeammateAvatarInput({ ...baseInput, remoteHostId: 'remote-1', avatar: 'avatar.png' }, deps({ readPicture })))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(readPicture).not.toHaveBeenCalled();
  });
});
