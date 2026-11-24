import { expect, it, vi } from 'vitest';
import { savePreviewImage } from '@/session/savePreviewImage';

const native = vi.hoisted(() => ({ createAsset: vi.fn(), writeBase64: vi.fn() }));

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
  writeAsStringAsync: native.writeBase64,
  readAsStringAsync: async () => Buffer.from('0000ftypmif1').toString('base64'),
}));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ copyRemoteFile: async () => undefined }));

// Unit regression for PR #12410. A Markdown image may supply only its URL, with
// no MIME hint. Toolbar tests mock the export helper, so they cannot catch a
// missing original-file extension at the native gallery boundary. An alt label
// like preview.png must not override the known source URL extension.
it.each(['avif', 'heic', 'heif', 'bmp'])('uses the Markdown image URL extension .%s ahead of its display title', async (extension) => {
  native.createAsset.mockClear();
  await expect(savePreviewImage(`https://example.invalid/photo.${extension}?signature=test`, undefined, 'preview.png'))
    .resolves.toBe(true);
  expect(native.createAsset).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(new RegExp(`/Image-\\d+\\.${extension}$`)),
  );
});

// Unit regression for PR #12410: message normalization preserves MIME parameters
// in inline image URLs. The previous URL-only tests never staged inline bytes.
it('saves base64 image attachments with MIME parameters and escaped padding', async () => {
  native.createAsset.mockClear();
  const base64 = 'iVBORw0KGgo=';
  const source = 'data:image/PNG;charset=utf-8;base64,iVBORw0KGgo%3D';

  await expect(savePreviewImage(source)).resolves.toBe(true);

  expect(native.writeBase64).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/\/original$/),
    base64,
    { encoding: 'base64' },
  );
  expect(native.createAsset).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/\/Image-\d+\.png$/),
  );
});
