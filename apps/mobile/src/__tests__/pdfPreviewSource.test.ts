import { beforeEach, describe, expect, it, vi } from 'vitest';
const { download, remove, bounded } = vi.hoisted(() => ({ download: vi.fn(), remove: vi.fn(),
  bounded: vi.fn(),
}));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ retainRemoteFilePreview: download,
  withDownloadedRemoteMediaFile: bounded,
}));
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
  it.each(['file:///existing/document.pdf'])('delegates source ownership for %s', async (uri) => {
    download.mockResolvedValue({ uri, release: remove });
    const source = await preparePdfPreviewSource(uri);
    expect(source.uri).toBe(uri);
    source.release();
    expect(download).toHaveBeenCalledWith(uri, 'application/pdf', 'preview.pdf');
    expect(remove).toHaveBeenCalledOnce();
  });
  it("downloads remote PDFs within the byte budget and retains the copy before releasing the download", async () => {
    const controller = new AbortController();
    download.mockResolvedValue({
      uri: "file:///retained/report.pdf",
      release: remove,
    });
    bounded.mockImplementation(async (_url, _mime, limit, consume, signal) => {
      expect(limit).toBe(30 * 1024 * 1024);
      expect(signal).toBe(controller.signal);
      return consume({ uri: "file:///download/report.pdf" });
    });
    const source = await preparePdfPreviewSource(
      "https://example.com/report.pdf",
      controller.signal,
    );
    expect(download).toHaveBeenCalledWith(
      "file:///download/report.pdf",
      "application/pdf",
      "preview.pdf",
    );
    expect(source.uri).toBe("file:///retained/report.pdf");
    source.release();
    expect(remove).toHaveBeenCalledOnce();
  });
  it("reports an oversized download without opening a partial PDF", async () => {
    bounded.mockImplementation(
      async (_url, _mime, _limit, _consume, _signal, oversized) => {
        oversized();
        return null;
      },
    );
    await expect(
      preparePdfPreviewSource("https://example.com/huge.pdf"),
    ).rejects.toThrow("PDF_TOO_LARGE");
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects unsupported sources and failed cache writes before reaching WebView', async () => {
    await expect(preparePdfPreviewSource('data:text/html;base64,AA==')).rejects.toThrow('INVALID_PDF_URL');
    download.mockRejectedValue(new Error('PREVIEW_CACHE_FAILED'));
    await expect(preparePdfPreviewSource('data:application/pdf;base64,JVBERg==')).rejects.toThrow('PREVIEW_CACHE_FAILED');
  });
});
