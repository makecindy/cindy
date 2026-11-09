import { retainRemoteFilePreview } from "@/session/remoteMediaDiskCacheExpo";
import { withDownloadedRemoteMediaFile } from '@/session/remoteMediaDiskCacheExpo';

/** WKWebView cannot load a data URI through its native file-URL loader. */
export async function preparePdfPreviewSource(url: string,
  signal?: AbortSignal,
): Promise<{ uri: string; release(): void }> {
  if (!/^(https?:\/\/|file:\/\/)/i.test(url) && !url.startsWith('data:application/pdf;base64,'))
    throw new Error('INVALID_PDF_URL');
  if (/^https?:\/\//i.test(url)) {
    let tooLarge = false;
    const source = await withDownloadedRemoteMediaFile(
      url,
      "application/pdf",
      30 * 1024 * 1024,
      (file) =>
        retainRemoteFilePreview(file.uri, "application/pdf", "preview.pdf"),
      signal ?? new AbortController().signal,
      () => {
        tooLarge = true;
      },
    );
    if (!source)
      throw new Error(tooLarge ? "PDF_TOO_LARGE" : "PDF_DOWNLOAD_FAILED");
    if (signal?.aborted) {
      source.release();
      throw new Error("ABORTED");
    }
    return source;
  }
  return retainRemoteFilePreview(url, 'application/pdf', 'preview.pdf');
}
