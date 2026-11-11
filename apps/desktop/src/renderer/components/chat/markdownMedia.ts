import { parseRemoteMediaUrl } from '../../../shared/remoteMediaUrl';

const MANAGED_MEDIA_SCHEME_RE = /^(?:cindy-media|xdt-video|cindy-remote-media):\/\//i;
const VIDEO_EXTENSION_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;

/**
 * 解码后的「原始媒体 URL」：已编码的 `cindy-remote-media://m/<b64>/<b64>` 没有可见
 * 扩展名，判类型必须解出内层 URL 再看 scheme 与扩展名；解不出(或不是远程媒体 URL)
 * 时按原 URL 判定。
 */
function managedVideoTarget(src: string): string | null {
  const target = parseRemoteMediaUrl(src)?.origUrl ?? src;
  return MANAGED_MEDIA_SCHEME_RE.test(target) && VIDEO_EXTENSION_RE.test(target) ? target : null;
}

/**
 * Markdown image syntax is also used by generated-media replies. Keep the
 * video upgrade limited to Cindy-managed media so an arbitrary remote image
 * URL cannot silently become an autoplay-capable video surface.
 */
export function isManagedMarkdownVideoUrl(src: string | undefined): src is string {
  return Boolean(src && managedVideoTarget(src));
}

/** Use the alt text for the preview label, with the managed URL as fallback. */
export function markdownMediaFilename(src: string, alt?: string): string {
  const label = alt?.trim();
  if (label) return label;

  // 已编码的远程媒体 URL 用解码后的原始 URL 取文件名，避免把 base64 段当文件名。
  const target = parseRemoteMediaUrl(src)?.origUrl ?? src;
  try {
    const pathname = new URL(target).pathname;
    const filename = decodeURIComponent(pathname.split('/').pop() ?? '').trim();
    if (filename) return filename;
  } catch {
    // Keep the stable fallback below for malformed or legacy media URLs.
  }
  return 'video';
}
