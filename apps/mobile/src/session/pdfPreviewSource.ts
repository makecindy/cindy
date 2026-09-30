import { File } from 'expo-file-system';
import { downloadRemoteMediaShareTemp } from '@/session/remoteMediaDiskCacheExpo';

/** WKWebView cannot load a data URI through its native file-URL loader. */
export async function preparePdfPreviewSource(url: string): Promise<{ uri: string; release(): void }> {
  if (/^(https?:\/\/|file:\/\/)/i.test(url)) return { uri: url, release() {} };
  if (!url.startsWith('data:application/pdf;base64,')) throw new Error('INVALID_PDF_URL');
  const uri = await downloadRemoteMediaShareTemp(url, 'application/pdf', 'preview.pdf');
  if (!uri) throw new Error('PDF_CACHE_FAILED');
  return {
    uri,
    release() {
      try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* OS cache reclamation is the fallback. */ }
    },
  };
}
