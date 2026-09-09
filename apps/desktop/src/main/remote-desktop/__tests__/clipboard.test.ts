import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clipboard: {
    availableFormats: vi.fn(), readImage: vi.fn(), readText: vi.fn(),
    readHTML: vi.fn(), readRTF: vi.fn(),
  },
  version: vi.fn(), selection: vi.fn(),
}));
vi.mock('electron', () => ({ clipboard: mocks.clipboard, nativeImage: {} }));
vi.mock('../inputHost', () => ({
  readDesktopClipboardVersion: mocks.version, readDesktopSelection: mocks.selection,
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
it.each(['CF_HDROP', 'public.file-url', 'text/uri-list'])('copies inline image without %s metadata or paths', async (format) => {
  mocks.clipboard.availableFormats.mockReturnValue([format, 'image/png', 'text/plain']);
  mocks.clipboard.readText.mockReturnValue('/private/local-image.png');
  await expect(copy()).resolves.toEqual({ png: png.toString('base64') });
  expect(mocks.clipboard.readImage).toHaveBeenCalledTimes(1);
  expect(mocks.clipboard.readText).not.toHaveBeenCalled();
  expect(mocks.clipboard.readHTML).not.toHaveBeenCalled();
  expect(mocks.clipboard.readRTF).not.toHaveBeenCalled();
});
it('still refuses file-only clipboard content', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'text/plain']);
  mocks.clipboard.readImage.mockReturnValue({ isEmpty: () => true });
  await expect(copy()).rejects.toThrow('CLIPBOARD_UNSUPPORTED');
  expect(mocks.clipboard.readText).not.toHaveBeenCalled();
});
it('retains ordinary portable alternatives without file formats', async () => {
  await expect(copy()).resolves.toEqual({ text: 'caption', html: '<p>caption</p>', rtf: 'rtf caption', png: png.toString('base64') });
});
it('rejects an image if the clipboard changes during capture', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'image/png']);
  mocks.version.mockResolvedValueOnce('1').mockResolvedValueOnce('2');
  await expect(copy()).rejects.toThrow('DESKTOP_CLIPBOARD_CHANGED');
});
it('retains pixel bounds on file-backed images', async () => {
  mocks.clipboard.availableFormats.mockReturnValue(['CF_HDROP', 'image/png']);
  mocks.clipboard.readImage.mockReturnValue({ ...image, getSize: () => ({ width: 10000, height: 10000 }) });
  await expect(copy()).rejects.toThrow('CLIPBOARD_TOO_LONG');
});
