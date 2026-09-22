import { beforeEach, describe, expect, it, vi } from 'vitest';
const { download, remove } = vi.hoisted(() => ({ download: vi.fn(), remove: vi.fn() }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: download }));
vi.mock('expo-file-system', () => ({ File: class { exists = true; delete = remove; } }));
import { preparePdfPreviewSource } from '@/session/pdfPreviewSource';

describe('PDF preview native source', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('materializes inline PDF bytes and releases only its temporary file', async () => {
    download.mockResolvedValue('file:///cache/preview.pdf');
    const source = await preparePdfPreviewSource('data:application/pdf;base64,JVBERg==');
    expect(source.uri).toBe('file:///cache/preview.pdf');
    expect(download).toHaveBeenCalledWith('data:application/pdf;base64,JVBERg==', 'application/pdf', 'preview.pdf');
    expect(remove).not.toHaveBeenCalled();
    source.release();
    expect(remove).toHaveBeenCalledOnce();
  });
  it.each(['https://example.com/document.pdf', 'file:///existing/document.pdf'])('preserves existing source %s without owning its file', async uri => {
    const source = await preparePdfPreviewSource(uri);
    expect(source.uri).toBe(uri);
    source.release();
    expect(download).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('rejects unsupported sources and failed cache writes before reaching WebView', async () => {
    await expect(preparePdfPreviewSource('data:text/html;base64,AA==')).rejects.toThrow('INVALID_PDF_URL');
    download.mockResolvedValue(null);
    await expect(preparePdfPreviewSource('data:application/pdf;base64,JVBERg==')).rejects.toThrow('PDF_CACHE_FAILED');
  });
});
