import type { Html, Image } from 'mdast';

const IMG_TAG_RE = /^\s*<img\b([^>]*)\/?>\s*$/i;
const IMG_TAG_GLOBAL_RE = /<img\b([^>]*)\/?>/gi;
const P_WRAPPER_RE = /^\s*<p(?:\s[^>]*)?>([\s\S]*?)<\/p>\s*$/i;
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const SAFE_DIMENSION_RE = /^\d{1,4}$/;
const SAFE_HTML_IMAGE_SRC_RE = /^https?:\/\//i;
const LOCAL_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i;
const WIN_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const SCHEME_PREFIX_RE = /^[a-z][a-z0-9+.-]*:/i;

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(amp|quot|#39|apos|lt|gt);/g, (entity, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case '#39':
      case 'apos':
        return "'";
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      default:
        return entity;
    }
  });
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs.set(key, decodeHtmlAttribute(value));
  }
  return attrs;
}

function hPropertiesFromAttrs(attrs: Map<string, string>): Record<string, string> | undefined {
  const hProperties: Record<string, string> = {};
  for (const key of ['width', 'height'] as const) {
    const value = attrs.get(key);
    if (value && SAFE_DIMENSION_RE.test(value)) {
      hProperties[key] = value;
    }
  }
  return Object.keys(hProperties).length > 0 ? hProperties : undefined;
}

function isSafeHtmlImageSrc(src: string): boolean {
  if (
    SAFE_HTML_IMAGE_SRC_RE.test(src) ||
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    src.startsWith('xdt-file://') ||
    src.startsWith('cindy-remote-media://')
  ) {
    return true;
  }
  if (!LOCAL_IMAGE_EXT_RE.test(src)) return false;
  if (src.startsWith('file://')) return true;
  if (WIN_DRIVE_PATH_RE.test(src)) return true;
  if (src.startsWith('//') || src.startsWith('\\\\')) return false;
  return !SCHEME_PREFIX_RE.test(src);
}

function imageNodeFromAttrString(rawAttrs: string, position: Html['position']): Image | null {
  const attrs = parseAttributes(rawAttrs);
  const src = attrs.get('src')?.trim();
  if (!src || !isSafeHtmlImageSrc(src)) return null;

  const image: Image = {
    type: 'image',
    url: src,
    alt: attrs.get('alt') ?? '',
    title: attrs.get('title') || null,
    position,
  };
  const hProperties = hPropertiesFromAttrs(attrs);
  if (hProperties) {
    image.data = { hProperties };
  }
  return image;
}

export function htmlImgToImageNode(node: Html): Image | null {
  const match = node.value.match(IMG_TAG_RE);
  if (!match) return null;
  return imageNodeFromAttrString(match[1], node.position);
}

/**
 * Convert a standalone raw HTML `<img>` or an image-only `<p><img ... /></p>`
 * block (common in READMEs and Markdown docs) into safe mdast Image nodes.
 * Rejects arbitrary HTML tags, mixed text, or unsafe schemes.
 */
export function htmlNodeToImageNodes(node: Html): { images: Image[]; wrappedInParagraph: boolean } | null {
  const single = htmlImgToImageNode(node);
  if (single) return { images: [single], wrappedInParagraph: false };

  const pMatch = node.value.match(P_WRAPPER_RE);
  if (!pMatch) return null;

  const inner = pMatch[1];
  const images: Image[] = [];
  IMG_TAG_GLOBAL_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMG_TAG_GLOBAL_RE.exec(inner)) !== null) {
    const between = inner.slice(lastIndex, match.index);
    if (!/^(?:\s|<br\s*\/?>)*$/i.test(between)) return null;
    const img = imageNodeFromAttrString(match[1], node.position);
    if (!img) return null;
    images.push(img);
    lastIndex = match.index + match[0].length;
  }
  const trailing = inner.slice(lastIndex);
  if (images.length === 0 || !/^(?:\s|<br\s*\/?>)*$/i.test(trailing)) return null;
  return { images, wrappedInParagraph: true };
}
