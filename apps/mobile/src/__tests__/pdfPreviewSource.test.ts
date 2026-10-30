import { beforeEach, describe, expect, it, vi } from 'vitest';
const { download, remove } = vi.hoisted(() => ({ download: vi.fn(), remove: vi.fn() }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ retainRemoteFilePreview: download }));
import { preparePdfPreviewSource } from '@/session/pdfPreviewSource';

describe('PDF preview native source', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('materializes inline PDF bytes and releases only its temporary file', async () => {
    download.mockResolvedValue({ uri: 'file:///cache/preview.pdf', release: remove });
    const source = await preparePdfPreviewSource('data:application/pdf;base64,JVBERg==');
    expect(source.uri).toBe('file:///cache/preview.pdf');
    expect(download).toHaveBeenCalledWith('data:application/pdf;base64,JVBERg==', 'application/pdf', 'preview.pdf');
    expect(remove).not.toHaveBeenCalled();
    source.release();
    expect(remove).toHaveBeenCalledOnce();
  });
  it.each(['https://example.com/document.pdf', 'file:///existing/document.pdf'])('delegates source ownership for %s', async uri => {
    download.mockResolvedValue({ uri, release: remove });
    const source = await preparePdfPreviewSource(uri);
    expect(source.uri).toBe(uri);
    source.release();
    expect(download).toHaveBeenCalledWith(uri, 'application/pdf', 'preview.pdf');
    expect(remove).toHaveBeenCalledOnce();
  });
  it('rejects unsupported sources and failed cache writes before reaching WebView', async () => {
    await expect(preparePdfPreviewSource('data:text/html;base64,AA==')).rejects.toThrow('INVALID_PDF_URL');
    download.mockRejectedValue(new Error('PREVIEW_CACHE_FAILED'));
    await expect(preparePdfPreviewSource('data:application/pdf;base64,JVBERg==')).rejects.toThrow('PREVIEW_CACHE_FAILED');
  });
});
