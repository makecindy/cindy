import { mailReadingColor } from '@cindy/maker-shared/mail-text-edit';

const authoredStyleAttribute = 'data-cindy-mail-authored-style';

function rememberMailPreviewPaint(el: Element, style = el.getAttribute('style')) {
  if (el.hasAttribute(authoredStyleAttribute)) return;
  el.setAttribute(authoredStyleAttribute, JSON.stringify(el.tagName === 'A'
    ? { style, href: el.getAttribute('href'), role: el.getAttribute('role') } : style));
}

/** Mail readers share the chat browser policy only for ordinary web links. */
export function mailPreviewLinkUrl(value: string | null): string | undefined {
  try {
    const url = new URL(value || '');
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Unsupported targets remain inert mail content. */ }
}

/** Restore both live nodes and browser-created clones from the same preview
 * metadata. The mail sanitizer strips this attribute from incoming/outgoing HTML. */
export function restoreMailPreviewPaint(root: Element): void {
  for (const el of [root, ...root.querySelectorAll(`[${authoredStyleAttribute}]`)]) {
    const encoded = el.getAttribute(authoredStyleAttribute);
    if (encoded === null) continue;
    el.removeAttribute(authoredStyleAttribute);
    try {
      const original: unknown = JSON.parse(encoded);
      // Accept the original style-only format as well as link metadata.
      const attributes = original && typeof original === 'object' ? original : { style: original };
      for (const name of ['style', 'href', 'role']) {
        const value = (attributes as Record<string, unknown>)[name];
        if (value === null) el.removeAttribute(name);
        else if (typeof value === 'string') el.setAttribute(name, value);
      }
    } catch { /* Invalid transient metadata is never applied. */ }
  }
}

/** Preview-only paint. Source HTML, CID images and editing spans stay intact. */
export function followMailPreviewTheme(doc: Document, host: Document, reading = false): () => void {
  const restore = () => restoreMailPreviewPaint(doc.documentElement);
  const paintLinks = () => {
    if (!reading) return;
    for (const link of doc.querySelectorAll<HTMLElement>('a')) {
      rememberMailPreviewPaint(link);
      const clickable = Boolean(mailPreviewLinkUrl(link.getAttribute('href')));
      if (!clickable) {
        link.removeAttribute('href');
        if (link.getAttribute('role')?.toLowerCase().split(/\s+/).includes('link')) link.removeAttribute('role');
      }
      link.style.setProperty('text-decoration', clickable ? 'underline' : 'none', 'important');
      link.style.setProperty('cursor', clickable ? 'pointer' : 'text', 'important');
    }
  };
  let previous = '';
  const paint = () => {
    const root = host.documentElement;
    const theme = host.defaultView!.getComputedStyle(root);
    const dark = root.classList.contains('dark');
    const surface = theme.getPropertyValue('--surface').trim();
    const text = theme.getPropertyValue('--text-primary').trim();
    const border = theme.getPropertyValue('--border-default').trim();
    const key = JSON.stringify([dark, surface, text, border]);
    if (key === previous) return;
    previous = key;
    restore();
    // Light mode preserves authored paper, colors and decoration. Recoloring
    // white backgrounds there exposes seams around images and signature tables.
    if (!dark || !surface || !text || !doc.defaultView) { paintLinks(); return; }

    // Read all authored colors before changing inheritance. Keep the original
    // inline attributes so theme changes and cleanup are lossless, even after typing.
    const nodes = Array.from(doc.querySelectorAll<HTMLElement>('html, body, body *'))
      .filter(el => el.tagName !== 'IMG');
    const authored = nodes.map(el => {
      const css = doc.defaultView!.getComputedStyle(el);
      return { el, style: el.getAttribute('style'), color: css.color, background: css.backgroundColor,
        image: css.backgroundImage, border: css.borderTopColor,
        borders: [css.borderTopColor, css.borderRightColor, css.borderBottomColor, css.borderLeftColor] };
    });
    const colorInfo = (color: string) => {
      const rgb = color.match(/^rgba?\(([^)]+)\)/)?.[1].split(/[, /]+/).map(Number);
      if (!rgb || rgb.length < 3 || rgb[3] === 0) return null;
      return {
        brightness: (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255,
        neutral: Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 16,
      };
    };
    for (const entry of authored) {
      const { el } = entry;
      // Native Enter/split/undo can clone these nodes. Carry the authored
      // style with the clone so neither saving nor cleanup relies on identity.
      rememberMailPreviewPaint(el, entry.style);
      const set = (name: string, value: string) => el.style.setProperty(name, value, 'important');
      if (reading) {
        const palette = { surface, text };
        // Gradients can remain bright even when backgroundColor is transparent.
        // Remove CSS decoration before making its foreground light, as in compose.
        if (entry.image && entry.image !== 'none') set('background-image', 'none');
        set('background-color', mailReadingColor(entry.background, 'background', palette));
        set('color', mailReadingColor(entry.color, 'text', palette));
        ['top', 'right', 'bottom', 'left'].forEach((side, index) =>
          set(`border-${side}-color`, mailReadingColor(entry.borders[index], 'background', palette)));
        continue;
      }
      const background = colorInfo(entry.background), foreground = colorInfo(entry.color);
      if (background && background.brightness > 0.25) {
        // Ordinary white/gray mail should share the reading canvas. Mixing
        // white into dark surfaces creates a conspicuous gray rectangle.
        set('background-color', background.neutral ? surface : `color-mix(in srgb, ${surface} 92%, ${entry.background})`);
      }
      if (foreground && foreground.brightness < 0.72) {
        set('color', foreground.neutral ? text : `color-mix(in srgb, ${text} 80%, ${entry.color})`);
      }
      if (border && colorInfo(entry.border)) set('border-color', `color-mix(in srgb, ${border} 75%, ${entry.border})`);
      // CSS backgrounds are decoration (remote CSS URLs are already removed by
      // the sanitizer). Photos remain untouched; no inversion filter is used.
      if (entry.image && entry.image !== 'none') set('background-image', 'none');
    }
    doc.documentElement.style.setProperty('color-scheme', 'dark', 'important');
    doc.documentElement.style.setProperty('background-color', surface, 'important');
    paintLinks();
  };
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(host.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  return () => { observer.disconnect(); restore(); };
}
