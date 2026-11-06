import { realpathSync } from 'node:fs';
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
    expect(result).toMatchObject({ ok: true, avatarImageBase64: png.toString('base64') });
    expect(fetchImage).toHaveBeenCalledWith('https://example.com/avatar.png', 5 * 1024 * 1024, undefined, { timeoutMs: 15_000 });
  });

  it('accepts a public HTTPS avatar for a live SSH task without reading its filesystem', async () => {
    const fetchImage = vi.fn().mockResolvedValue({ buffer: png, mimeType: 'image/png' });
    const readPicture = vi.fn();
    expect(await resolveTeammateAvatarInput({ ...baseInput, remoteHostId: 'ssh-1', workingDir: null,
      avatar: 'https://example.com/avatar.png' }, deps({ fetchImage, readPicture })))
      .toMatchObject({ ok: true, avatarImageBase64: png.toString('base64') });
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(readPicture).not.toHaveBeenCalled();
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

  it.each([
    { avatar: String.raw`\\avatar-test.invalid\share\avatar.png` },
    { avatar: '//avatar-test.invalid/share/avatar.png' },
    { avatar: String.raw`\\avatar-test.invalid@SSL\DavWWWRoot\avatar.png` },
    { avatar: String.raw`\\?\UNC\avatar-test.invalid\share\avatar.png` },
    { avatar: String.raw`\\.\C:\avatar.png` },
    { avatar: String.raw`\??\C:\avatar.png` },
    { avatar: 'file://avatar-test.invalid/share/avatar.png' },
    { avatar: 'file:////avatar-test.invalid/share/av%61tar.png' },
    { avatar: 'avatar.png', workingDir: '//avatar-test.invalid/share' },
    { avatar: 'C:\\task\\avatar.png', workingDir: '//avatar-test.invalid/share' },
  ])('rejects a network or device avatar before filesystem lookup: %o', async input => {
    const realpath = vi.spyOn(realpathSync, 'native').mockImplementation(() => {
      throw new Error('filesystem access blocked by this test');
    });
    const authorizePath = vi.fn(async () => ({ allowed: false as const, reason: 'not granted' }));
    try {
      expect(await resolveTeammateAvatarInput({ ...baseInput, ...input }, deps({ authorizePath })))
        .toMatchObject({ ok: false, errorCode: 'IMAGE_NOT_FOUND' });
      expect(realpath).not.toHaveBeenCalled();
      expect(authorizePath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
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
    expect(readPicture).toHaveBeenCalledWith('avatar.png', 'C:\\task', expect.any(Function),
      { allowWebp: true, maxBytes: 5 * 1024 * 1024 });
  });

  it('retains an outside-file grant until avatar persistence', async () => {
    let current = true;
    const authorization = async () => ({ allowed: true as const, isCurrent: () => current });
    const readPicture: NonNullable<TeammateAvatarInputDeps['readPicture']> = async (_ref, _workingDir, authorize) => {
      await authorize('C:\\outside\\avatar.png');
      return { ok: true, bytes: png };
    };
    const result = await resolveTeammateAvatarInput({ ...baseInput, avatar: 'C:\\outside\\avatar.png' },
      deps({ authorizePath: authorization, readPicture }));
    expect(result).toMatchObject({ ok: true, avatarImageBase64: png.toString('base64') });
    if (!result.ok) throw new Error('expected authorized avatar');
    expect(result.isAccessCurrent?.()).toBe(true);
    current = false;
    expect(result.isAccessCurrent?.()).toBe(false);

    expect(await resolveTeammateAvatarInput({ ...baseInput, avatar: 'C:\\outside\\avatar.png' }, deps({
      authorizePath: authorization, readPicture,
    }))).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
  });

  it.each(['https://example.com/avatar.png', 'avatar.png'])(
    'rejects an image result after its task instance closes: %s', async avatar => {
      let live = true;
      const result = await resolveTeammateAvatarInput({ ...baseInput, avatar }, deps({
        isCurrentSession: () => live,
        fetchImage: vi.fn().mockResolvedValue({ buffer: png, mimeType: 'image/png' }),
        readPicture: async () => ({ ok: true, bytes: png }),
      }));
      expect(result).toMatchObject({ ok: true, avatarImageBase64: png.toString('base64') });
      if (!result.ok) throw new Error('expected image result');
      expect(result.isAccessCurrent?.()).toBe(true);
      live = false;
      expect(result.isAccessCurrent?.()).toBe(false);
    },
  );

  it('never reads a controller-local file for a remote task', async () => {
    const readPicture = vi.fn();
    expect(await resolveTeammateAvatarInput({ ...baseInput, remoteHostId: 'remote-1', avatar: 'avatar.png' }, deps({ readPicture })))
      .toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(readPicture).not.toHaveBeenCalled();
  });
});
