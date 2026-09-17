import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clipboard: {
    availableFormats: vi.fn(),
    readImage: vi.fn(),
    readText: vi.fn(),
    readHTML: vi.fn(),
    readRTF: vi.fn(),
    write: vi.fn(),
  },
  version: vi.fn(),
  selection: vi.fn(),
  decode: vi.fn(),
}));
vi.mock('electron', () => ({
  clipboard: mocks.clipboard,
  nativeImage: { createFromBuffer: mocks.decode },
}));
vi.mock('../inputHost', () => ({
  readDesktopClipboardVersion: mocks.version,
  readDesktopSelection: mocks.selection,
}));
import { transferDesktopClipboardContent } from '../clipboard';

const png = Buffer.from('iVBORw0KGgo=', 'base64');
const image = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png };
const copy = () => transferDesktopClipboardContent('copy', undefined, () => true, vi.fn());
beforeEach(() => {
  vi.resetAllMocks();
  mocks.selection.mockResolvedValue('');
  mocks.version.mockResolvedValue('1');
  mocks.clipboard.availableFormats.mockReturnValue(['image/png']);
  mocks.clipboard.readImage.mockReturnValue(image);
  mocks.clipboard.readText.mockReturnValue('caption');
  mocks.clipboard.readHTML.mockReturnValue('<p>caption</p>');
  mocks.clipboard.readRTF.mockReturnValue('rtf caption');
});
it.each(['CF_HDROP', 'public.file-url', 'text/uri-list'])(
  'copies inline image without %s metadata or paths',
  async (format) => {
    mocks.clipboard.availableFormats.mockReturnValue([format, 'image/png', 'text/plain']);
    mocks.clipboard.readText.mockReturnValue('/private/local-image.png');
    await expect(copy()).resolves.toEqual({ png: png.toString('base64') });
    expect(mocks.clipboard.readImage).toHaveBeenCalledTimes(1);
    expect(mocks.clipboard.readText).not.toHaveBeenCalled();
    expect(mocks.clipboard.readHTML).not.toHaveBeenCalled();
    expect(mocks.clipboard.readRTF).not.toHaveBeenCalled();
  },
);
it('still refuses file-only clipboard content', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'text/plain']);
  mocks.clipboard.readImage.mockReturnValue({ isEmpty: () => true });
  await expect(copy()).rejects.toThrow('CLIPBOARD_UNSUPPORTED');
  expect(mocks.clipboard.readText).not.toHaveBeenCalled();
});
it('retains ordinary portable alternatives without file formats', async () => {
  await expect(copy()).resolves.toEqual({
    text: 'caption',
    html: '<p>caption</p>',
    rtf: 'rtf caption',
    png: png.toString('base64'),
  });
});
it('rejects an image if the clipboard changes during capture', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'image/png']);
  mocks.version.mockResolvedValueOnce('1').mockResolvedValueOnce('2');
  await expect(copy()).rejects.toThrow('DESKTOP_CLIPBOARD_CHANGED');
});
it('retains pixel bounds on file-backed images', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'image/png']);
  mocks.clipboard.readImage.mockReturnValue({
    ...image,
    getSize: () => ({ width: 10000, height: 10000 }),
  });
  await expect(copy()).rejects.toThrow('CLIPBOARD_TOO_LONG');
});

const syncCopy = () =>
  transferDesktopClipboardContent('copy', undefined, () => true, vi.fn(), { sync: true });
it.each([copy, syncCopy])(
  'rejects oversized native images before encoding in either copy mode',
  async (read) => {
    const encode = vi.fn();
    mocks.clipboard.readImage.mockReturnValue({
      ...image,
      getSize: () => ({ width: 2001, height: 2000 }),
      toPNG: encode,
    });
    await expect(read()).rejects.toThrow('CLIPBOARD_TOO_LONG');
    expect(encode).not.toHaveBeenCalled();
  },
);
it('rejects an oversized encoded buffer before making a Base64 copy', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
  const stringify = vi.spyOn(bytes, 'toString');
  mocks.clipboard.readImage.mockReturnValue({ ...image, toPNG: () => bytes });
  await expect(syncCopy()).rejects.toThrow('CLIPBOARD_TOO_LONG');
  expect(stringify).not.toHaveBeenCalled();
});
it('accepts the exact pixel boundary and explicitly encodes at scale one', async () => {
  const encode = vi.fn(() => png);
  const size = vi.fn(() => ({ width: 2000, height: 2000 }));
  mocks.clipboard.readImage.mockReturnValue({
    ...image,
    getSize: size,
    toPNG: encode,
  });
  await syncCopy();
  expect(size).toHaveBeenCalledWith(1);
  expect(encode).toHaveBeenCalledWith({ scaleFactor: 1 });
});
it.each([0, 2001, 0xffffffff])(
  'refuses incoming invalid/oversized dimensions before native decode: %s',
  async (width) => {
    const bytes = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]).copy(bytes);
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(2000, 20);
    await expect(
      transferDesktopClipboardContent(
        'paste',
        { png: bytes.toString('base64') },
        () => true,
        vi.fn(),
      ),
    ).rejects.toThrow('CLIPBOARD_TOO_LONG');
    expect(mocks.decode).not.toHaveBeenCalled();
    expect(mocks.clipboard.write).not.toHaveBeenCalled();
  },
);
it('also bounds image encoding during post-write synchronization verification', async () => {
  const encode = vi.fn();
  mocks.clipboard.readImage.mockReturnValue({
    ...image,
    getSize: () => ({ width: 8000, height: 8000 }),
    toPNG: encode,
  });
  await expect(
    transferDesktopClipboardContent('paste', { text: 'caption' }, () => true, vi.fn(), {
      sync: true,
    }),
  ).rejects.toThrow('CLIPBOARD_TOO_LONG');
  expect(encode).not.toHaveBeenCalled();
});
