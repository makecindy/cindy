import { describe, expect, it, vi } from 'vitest';

import type { IMAttachment } from '@cindy/im';

vi.mock('../../localDb/ipc/messages', () => ({
  createMessage: vi.fn(),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { buildPersistedUserContent } from '../messagePersistence';

describe('IM message persistence content', () => {
  it('retains a managed file URL so message persistence pins the media blob', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.mp4`;
    const attachment: IMAttachment = {
      kind: 'file',
      absPath: 'C:\\managed\\clip.mp4',
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
      url,
    };

    expect(buildPersistedUserContent('', [attachment])).toEqual({
      text: '',
      images: [],
      files: [
        {
          name: 'clip.mp4',
          path: 'C:\\managed\\clip.mp4',
          url,
        },
      ],
    });
  });
});
