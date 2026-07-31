export interface RemoteMarkdownImage {
  alt: string;
  url: string;
}

const REMOTE_MARKDOWN_IMAGE =
  /!\[([^\]\r\n]{0,512})\]\((https:\/\/[^)\s]{1,2048})\)/g;

function isSafePublicImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Collect unique HTTPS image references without fetching them. */
export function collectRemoteMarkdownImages(
  text: string,
  limit: number,
): RemoteMarkdownImage[] {
  const images = new Map<string, RemoteMarkdownImage>();
  for (const match of text.matchAll(REMOTE_MARKDOWN_IMAGE)) {
    const url = match[2];
    if (!isSafePublicImageUrl(url) || images.has(url)) continue;
    images.set(url, { alt: match[1].trim(), url });
    if (images.size >= limit) break;
  }
  return Array.from(images.values());
}

/**
 * Replace only images that were successfully uploaded. Failed downloads retain
 * the original Markdown URL as a usable fallback.
 */
export function replaceUploadedRemoteImages(
  text: string,
  uploadedUrls: ReadonlySet<string>,
): string {
  return text.replace(REMOTE_MARKDOWN_IMAGE, (raw, alt: string, url: string) =>
    uploadedUrls.has(url) ? alt.trim() || "图片" : raw,
  );
}
