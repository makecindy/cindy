import { retainRemoteFilePreview } from '@/session/remoteMediaDiskCacheExpo';

/** WKWebView cannot load a data URI through its native file-URL loader. */
export async function preparePdfPreviewSource(url: string): Promise<{ uri: string; release(): void }> {
  if (!/^(https?:\/\/|file:\/\/)/i.test(url) && !url.startsWith('data:application/pdf;base64,'))
    throw new Error('INVALID_PDF_URL');
  return retainRemoteFilePreview(url, 'application/pdf', 'preview.pdf');
}
