import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationClient } from '../client.js';

const {
  getModerationIdentity,
  isModerationIdentityCurrent,
  resolveCindyMediaUrl,
  resolveLegacyImageUrl,
} = vi.hoisted(() => ({
  getModerationIdentity: vi.fn(),
  isModerationIdentityCurrent: vi.fn(),
  resolveCindyMediaUrl: vi.fn(),
  resolveLegacyImageUrl: vi.fn(),
}));

vi.mock('../identity.js', () => ({
  getModerationIdentity,
  isModerationIdentityCurrent,
}));

vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: resolveCindyMediaUrl,
}));

vi.mock('../../imageCacheStore.js', () => ({
  resolveSafe: resolveLegacyImageUrl,
}));

import { moderateAgentInput } from '../input.js';

function queuedImage(
  file: NonNullable<AgentInputQueuedMessage['files']>[number],
): AgentInputQueuedMessage {
  return {
    clientId: 'client-1',
    text: '',
    persistedContent: JSON.stringify({ text: '', images: [], files: [] }),
    model: 'gpt-5.4-mini',
    effort: 'medium',
    permissionMode: 'ask',
    workingDir: 'C:\\workspace',
    files: [file],
    chatMessage: {
      clientId: 'client-1',
      role: 'user',
      content: '',
    },
    createOpts: {
      agentKind: 'codex',
      workingDir: 'C:\\workspace',
      model: 'gpt-5.4-mini',
    },
  };
}

function fakeClient() {
  const uploadLocalImage = vi.fn(async () => 'xdmoderation://uploaded/local');
  const uploadImageBytes = vi.fn(async () => 'xdmoderation://uploaded/bytes');
  const review = vi.fn(async () => 'allow' as const);
  return {
    client: { uploadLocalImage, uploadImageBytes, review } as unknown as ModerationClient,
    uploadLocalImage,
    uploadImageBytes,
    review,
  };
}

describe('moderateAgentInput image projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModerationIdentity.mockReturnValue({
      membershipId: 'member-1',
      accessToken: 'access-token',
      identityEpoch: 1,
      signBaseUrl: 'https://sign.example.invalid',
      environment: 'test',
    });
    isModerationIdentityCurrent.mockReturnValue(true);
  });

  it('uploads an attachment-only base64 image and reviews it as maker-input-t2t', async () => {
    const fixture = fakeClient();
    const raw = Buffer.from('png-bytes');

    await expect(moderateAgentInput('session-1', queuedImage({
      id: 'image-1',
      name: 'paste.png',
      path: 'clipboard://paste-1',
      ext: '.png',
      size: raw.byteLength,
      category: 'image',
      mimeType: 'image/png',
      base64: raw.toString('base64'),
      originalName: 'screenshot.png',
    }), fixture.client)).resolves.toBe('allow');

    expect(fixture.uploadImageBytes).toHaveBeenCalledWith(expect.objectContaining({
      bytes: raw,
      fileName: 'screenshot.png',
      mimeType: 'image/png',
    }));
    expect(fixture.uploadLocalImage).not.toHaveBeenCalled();
    expect(fixture.review).toHaveBeenCalledWith(expect.objectContaining({
      businessCode: 'maker-input-t2t',
      items: [{
        type: 'IMAGE',
        data: 'xdmoderation://uploaded/bytes',
        content_id: 'client-1:image:0',
      }],
    }));
  });

  it('resolves a managed cindy-media image before uploading it', async () => {
    const fixture = fakeClient();
    resolveCindyMediaUrl.mockReturnValue({
      absPath: 'C:\\user-data\\cindy-media\\blobs\\image.png',
      mimeType: 'image/png',
    });

    await moderateAgentInput('session-1', queuedImage({
      id: 'image-2',
      name: 'paste.png',
      path: 'clipboard://paste-2',
      url: 'cindy-media://blobs/abcdef.png',
      ext: '.png',
      size: 10,
      category: 'image',
      mimeType: 'image/png',
    }), fixture.client);

    expect(resolveCindyMediaUrl).toHaveBeenCalledWith('cindy-media://blobs/abcdef.png');
    expect(fixture.uploadLocalImage).toHaveBeenCalledWith(expect.objectContaining({
      filePath: 'C:\\user-data\\cindy-media\\blobs\\image.png',
    }));
    expect(fixture.review).toHaveBeenCalledWith(expect.objectContaining({
      businessCode: 'maker-input-t2t',
      items: [expect.objectContaining({ type: 'IMAGE' })],
    }));
  });
});
