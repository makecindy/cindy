const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

export function isImagePath(filePath: string): boolean {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = filePath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  return IMAGE_EXTS.has(ext);
}
