/** The entry file is already authorized by FileLightbox. Embedded resources
 * must not reuse that authorization to fetch local files or contact a server. */
export function embeddedModelResourceUrl(url: string): string {
  if (/^(?:blob:|data:)/i.test(url)) return url;
  throw new Error('External model resources are not supported');
}
