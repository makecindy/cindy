/** Shared extension fallback for authorized direct files and OSS media exports. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
};

/** Bare lowercase extension; an authoritative MIME from the resolver takes precedence. */
export function mimeOf(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
export { MIME_BY_EXT };
