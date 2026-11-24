import { expect, it, vi } from 'vitest';
import { savePreviewImage } from '@/session/savePreviewImage';

const native = vi.hoisted(() => ({ createAsset: vi.fn() }));

vi.mock('react-native', () => ({ Platform: { Version: 36 } }));
vi.mock('expo-media-library', () => ({ Asset: { create: native.createAsset } }));
vi.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    uri: string;
    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }
    create() {}
    delete() {}
  },
  File: class {
    uri: string;
    size = 24;
    constructor(parent: { uri: string }, name: string) {
      this.uri = `${parent.uri}/${name}`;
    }
    moveSync() {}
  },
}));
vi.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: async () => Buffer.from('0000ftypmif1').toString('base64'),
}));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ copyRemoteFile: async () => undefined }));

// Unit regression for PR #12410. A Markdown image may supply only its URL, with
// no MIME hint. Toolbar tests mock the export helper, so they cannot catch a
// missing original-file extension at the native gallery boundary.
it.each(['avif', 'heic', 'heif'])('exports a Markdown image with the .%s extension', async (extension) => {
  native.createAsset.mockClear();
  await expect(savePreviewImage(`https://example.invalid/photo.${extension}?signature=test`))
    .resolves.toBe(true);
  expect(native.createAsset).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(new RegExp(`/Image-\\d+\\.${extension}$`)),
  );
});
