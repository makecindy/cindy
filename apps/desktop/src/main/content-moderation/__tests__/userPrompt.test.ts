import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModerationClient } from '../client.js';

const {
  getModerationIdentity,
  isModerationIdentityCurrent,
} = vi.hoisted(() => ({
  getModerationIdentity: vi.fn(),
  isModerationIdentityCurrent: vi.fn(),
}));

vi.mock('../identity.js', () => ({
  getModerationIdentity,
  isModerationIdentityCurrent,
}));

import {
  moderateUserPrompt,
  validateUserPromptReviewValue,
} from '../userPrompt.js';

describe('moderateUserPrompt', () => {
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

  it('清空提示词直接放行，不请求审核', async () => {
    const client = new ModerationClient();
    const review = vi.spyOn(client, 'review');
    await expect(moderateUserPrompt('   ', client)).resolves.toBe('allow');
    expect(getModerationIdentity).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it('使用 maker-sys-prompt 审核完整文本', async () => {
    const client = new ModerationClient();
    const review = vi.spyOn(client, 'review').mockResolvedValue('allow');
    await expect(moderateUserPrompt('Be concise.', client)).resolves.toBe('allow');
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      businessCode: 'maker-sys-prompt',
      membershipId: 'u1',
      items: [expect.objectContaining({ type: 'TEXT', data: 'Be concise.' })],
    }));
  });

  it('明确拒绝阻断；审核期间换号则作废结果', async () => {
    const client = new ModerationClient();
    vi.spyOn(client, 'review').mockResolvedValue('reject');
    await expect(moderateUserPrompt('blocked', client)).resolves.toBe('reject');

    isModerationIdentityCurrent.mockReturnValue(false);
    await expect(moderateUserPrompt('blocked', client)).resolves.toBe('cancelled');
  });
});

describe('validateUserPromptReviewValue', () => {
  it('拒绝非字符串和超过共享上限的文本', () => {
    expect(() => validateUserPromptReviewValue(null)).toThrowError();
    expect(() => validateUserPromptReviewValue('a'.repeat(8_001))).toThrowError();
    expect(() => validateUserPromptReviewValue('a'.repeat(8_000))).not.toThrow();
  });
});
