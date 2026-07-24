import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationClient } from '../client.js';

const { getModerationIdentity, isModerationIdentityCurrent } = vi.hoisted(() => ({
  getModerationIdentity: vi.fn(),
  isModerationIdentityCurrent: vi.fn(),
}));

vi.mock('../identity.js', () => ({
  getModerationIdentity,
  isModerationIdentityCurrent,
}));

import { moderateProfileUpdate } from '../profile.js';

describe('moderateProfileUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModerationIdentity.mockReturnValue({
      membershipId: 'u1',
      accessToken: 'token',
      identityEpoch: 1,
      signBaseUrl: 'https://sign.example.invalid',
      environment: 'test',
    });
    isModerationIdentityCurrent.mockReturnValue(true);
  });

  it('先把本地头像字节上传到审核网关，再用 maker-avatar 审核', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const uploadImageBytes = vi.fn(async () => 'xdmoderation://uploaded/avatar');
    const review = vi.fn(async () => 'allow' as const);
    const client = { uploadImageBytes, review } as unknown as ModerationClient;

    await expect(
      moderateProfileUpdate(
        {
          avatar: {
            bytes,
            fileName: 'avatar.png',
            mimeType: 'image/png',
          },
        },
        client,
      ),
    ).resolves.toBe('allow');

    expect(uploadImageBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        bytes,
        fileName: 'avatar.png',
        mimeType: 'image/png',
      }),
    );
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        businessCode: 'maker-avatar',
        items: [
          expect.objectContaining({
            type: 'IMAGE',
            data: 'xdmoderation://uploaded/avatar',
          }),
        ],
      }),
    );
    expect(uploadImageBytes.mock.invocationCallOrder[0]).toBeLessThan(
      review.mock.invocationCallOrder[0]!,
    );
  });
});
