import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  edit: vi.fn(), generate: vi.fn(), video: vi.fn(), peek: vi.fn(),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  peekHostMediaModel: calls.peek,
  runHostImageEdit: calls.edit,
  runHostImageGenerate: calls.generate,
  runHostImageToVideo: calls.video,
}));
import { generateDesktopCompanionStill } from '../media.js';

beforeEach(() => vi.clearAllMocks());

describe('memory wallpaper generation', () => {
  it('reports an edit failure without issuing a second generation request', async () => {
    calls.edit.mockRejectedValue(new Error('QUOTA_EXCEEDED'));
    await expect(generateDesktopCompanionStill({ prompt: 'scene', refPath: '/reference.jpg' }))
      .rejects.toThrow('QUOTA_EXCEEDED');
    expect(calls.generate).not.toHaveBeenCalled();
  });
});
