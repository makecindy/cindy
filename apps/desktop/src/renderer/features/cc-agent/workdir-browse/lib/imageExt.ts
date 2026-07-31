const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const LIGHTBOX_IMAGE_EXTS = new Set([...IMAGE_EXTS, '.svg']);

function extname(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = filePath.slice(lastSlash + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath));
}

/** ImageLightbox 能直接渲染的文件类型；SVG 保持文本编辑语义，但可单独预览。 */
export function isLightboxImagePath(filePath: string): boolean {
  return LIGHTBOX_IMAGE_EXTS.has(extname(filePath));
}
