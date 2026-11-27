/**
 * markdownImageLivePreview — render image references as inline images inside
 * the doc-mode CodeMirror editor (workdir-browse → FileBodyView).
 *
 * Implementation shape mirrors `markdownMermaidLivePreview`:
 *   - StateField scans the whole doc on docChange (NOT on selection/viewport
 *     changes — block widgets rebuilt on selection broke CM's height map,
 *     see the mermaid module's header for the full war story).
 *   - Each recognized image block becomes a single
 *     `Decoration.replace({block: true, widget: MarkdownImageWidget})`.
 *   - The browser loads images natively (no async render step); on error we
 *     swap the <img> for a compact "can't load" card that shows the raw src
 *     so the user can spot typos.
 *
 * Recognized forms — the block must contain NOTHING but images:
 *   1. Markdown image alone on its line:
 *        `![alt](path)`, `![alt](<path with spaces>)`, `![alt](path "title")`
 *   2. HTML <img> alone on its line (README-style, GitHub-flavored):
 *        `<img src="doc/images/x.webp" alt="..." width="720" />`
 *   3. Single-line <p>-wrapped form:
 *        `<p align="center"><img src="..." /></p>`
 *   4. Multi-line <p> block — opener, 1..n <img> lines, closer
 *   5. Obsidian wiki-link image embed, alone on its line:
 *        `![[image.png]]`, `![[subfolder/image.png]]`, `![[image.png|300]]`,
 *        `![[image.png|300x200]]`
 *   6. Image-only ````carousel / ~~~~carousel fenced blocks whose slides are
 *      separated by `<!-- slide -->`.
 *
 * Path resolution (local files go through the privileged `xdt-file://`
 * protocol — Chromium blocks plain file:// loads from the app origin):
 *   - data: / http(s):// / cindy-remote-media:// → pass through
 *   - xdt-image:// / cindy-media:// / xdt-file:// → pass through locally, or
 *     rewrite via `imageRemoteOriginFacet` in remote sessions
 *   - file://... / absolute / relative (against `imageBaseDirFacet`) →
 *     xdt-file:// locally, or `cindy-remote-media://` in remote sessions
 *     (SSH fails closed for paths outside the remote workdir).
 *
 * Security note: HTML <img> handling parses out ONLY the src/alt/title/
 * width/height attributes and builds the element via DOM APIs — the raw
 * markup never touches innerHTML, so no other attribute (onerror etc.) can
 * survive into the rendered widget.
 */

import {
  Facet,
  RangeSetBuilder,
  StateField,
  type Text as CodeMirrorText,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import i18n from 'i18next';
import { isCarouselFenceLanguage, splitCarouselSlides } from '@cindy/maker-shared/markdown-carousel';

import { isLightboxImagePath } from '@/features/cc-agent/workdir-browse/lib/imageExt';
import {
  isFileUrlHostHref,
  normalizeResolvedPathSegments,
  resolveLocalPath,
  toLocalFileUrl,
} from '@/lib/localPathResolver';
import {
  isSshRewritableMediaUrl,
  rewriteToRemoteMediaOrigin,
  type RemoteMediaOrigin,
} from '../../../shared/remoteMediaUrl';

// ─── Facets ─────────────────────────────────────────────────────────────────
//
// Base directory used to resolve relative image srcs — the markdown file's
// own parent directory (NOT the session cwd: `![](./img/a.png)` in
// `docs/readme.md` must resolve under `docs/`). Empty string = host didn't
// provide one; relative srcs then render the unresolvable card instead of
// guessing.
export const imageBaseDirFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
});

// Remote session origin (device-link / SSH) for rewriting resolved local image
// URLs to `cindy-remote-media://`. Null = local workspace.
export const imageRemoteOriginFacet = Facet.define<RemoteMediaOrigin | null, RemoteMediaOrigin | null>({
  combine: (values) => values[0] ?? null,
});

// Same contract as `mermaidLocaleFacet`: widget reads i18n.t(...) at toDOM
// time, so hosts feed the live locale through a Compartment and the
// StateField rebuilds widgets when it flips.
export const imageLocaleFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? 'default',
});

function remoteOriginsEqual(a: RemoteMediaOrigin | null, b: RemoteMediaOrigin | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'device' && b.kind === 'device') return a.deviceId === b.deviceId;
  if (a.kind === 'ssh' && b.kind === 'ssh') {
    return a.remoteHostId === b.remoteHostId && a.workdir === b.workdir;
  }
  return false;
}

// ─── Detection ──────────────────────────────────────────────────────────────
//
// Markdown form: one image, alone on its line. Src is either an
// angle-bracket form (`<may contain spaces>`) or a run without whitespace /
// `)`. Optional quoted title after the src. ≤3 leading spaces per
// CommonMark (4+ would be an indented code block and must stay raw).
const MD_IMAGE_LINE_RE =
  /^ {0,3}!\[([^\]]*)\]\(\s*(<[^<>]*>|[^)\s]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)\s*$/;

const WIKI_IMAGE_LINE_RE =
  /^ {0,3}!\[\[([^\]|]+)(?:\|(\d+)(?:x(\d+))?)?\]\]\s*$/;

const HTML_BARE_IMG_LINE_RE = /^ {0,3}<img\b([^>]*?)\/?\s*>\s*$/i;
const HTML_P_WRAPPED_LINE_RE =
  /^ {0,3}<p\b([^>]*)>\s*<img\b([^>]*?)\/?\s*>\s*<\/p>\s*$/i;
const HTML_P_OPEN_LINE_RE = /^ {0,3}<p\b([^>]*)>\s*$/i;
const HTML_IMG_ONLY_LINE_RE = /^\s*<img\b([^>]*?)\/?\s*>\s*$/i;
const HTML_P_CLOSE_LINE_RE = /^\s*<\/p>\s*$/i;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function buildFenceCloseRe(opener: string): RegExp {
  const ch = opener[0] === '`' ? '`' : '~';
  return new RegExp(`^ {0,3}${ch}{${opener.length},}\\s*$`);
}

// Exported for unit tests only — production callsites stay inside this file.
export interface ImageSpec {
  /** Raw src as authored (angle brackets stripped, still percent-encoded). */
  src: string;
  alt: string;
  /** Quoted title with quotes stripped, or ''. */
  title: string;
  /** Explicit width/height from HTML attrs (integer px), or null. */
  width: number | null;
  height: number | null;
}

export interface ImageTarget {
  /** Start of the first line of the block. */
  from: number;
  /** End of the last line of the block (exclusive of trailing newline). */
  to: number;
  /** 'center' when the wrapping <p> declares align="center", else null. */
  align: 'center' | null;
  /** True when the block comes from an image-only ````carousel fence. */
  carousel?: boolean;
  /** 1..n images (n > 1 for multi-line <p> blocks or ````carousel blocks). */
  images: ImageSpec[];
}

/** Pull one attribute value out of an <img>/<p> attribute string. */
function readAttr(attrText: string, name: string): string | null {
  const m = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  ).exec(attrText);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function readDimensionAttr(attrText: string, name: string): number | null {
  const raw = readAttr(attrText, name);
  if (raw === null) return null;
  const m = /^(\d+)(?:px)?$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/** Parse an <img> attribute string into an ImageSpec; null when src is missing/empty. */
function parseImgAttrs(attrText: string): ImageSpec | null {
  const src = readAttr(attrText, 'src');
  if (!src) return null;
  return {
    src,
    alt: readAttr(attrText, 'alt') ?? '',
    title: readAttr(attrText, 'title') ?? '',
    width: readDimensionAttr(attrText, 'width'),
    height: readDimensionAttr(attrText, 'height'),
  };
}

function parseAlign(pAttrText: string): 'center' | null {
  return readAttr(pAttrText, 'align')?.toLowerCase() === 'center' ? 'center' : null;
}

function parseImageOnlyCarousel(body: string): ImageSpec[] | null {
  const slides = splitCarouselSlides(body);
  if (slides.length === 0) return null;
  const images: ImageSpec[] = [];
  for (const slide of slides) {
    const slideLines = slide.split('\n').map((l) => l.trim()).filter(Boolean);
    if (slideLines.length === 0) return null;
    if (slideLines.length === 1) {
      const matched = matchSingleLineImage(slideLines[0]);
      if (!matched) return null;
      images.push(matched.spec);
      continue;
    }
    if (
      HTML_P_OPEN_LINE_RE.test(slideLines[0]) &&
      HTML_P_CLOSE_LINE_RE.test(slideLines[slideLines.length - 1])
    ) {
      const inner = slideLines.slice(1, -1);
      if (inner.length === 0) return null;
      for (const innerLine of inner) {
        const m = HTML_IMG_ONLY_LINE_RE.exec(innerLine);
        if (!m) return null;
        const spec = parseImgAttrs(m[1]);
        if (!spec) return null;
        images.push(spec);
      }
      continue;
    }
    return null;
  }
  return images.length > 0 ? images : null;
}

export function findImageTargets(doc: CodeMirrorText): ImageTarget[] {
  const targets: ImageTarget[] = [];
  let lineNum = 1;
  while (lineNum <= doc.lines) {
    const line = doc.line(lineNum);

    const fence = FENCE_OPEN_RE.exec(line.text);
    if (fence) {
      const closeRe = buildFenceCloseRe(fence[1]);
      let closeLine = -1;
      for (let j = lineNum + 1; j <= doc.lines; j++) {
        if (closeRe.test(doc.line(j).text)) {
          closeLine = j;
          break;
        }
      }
      if (closeLine === -1) break;
      if (isCarouselFenceLanguage(fence[2])) {
        const bodyLines: string[] = [];
        for (let j = lineNum + 1; j < closeLine; j++) {
          bodyLines.push(doc.line(j).text);
        }
        const carouselImages = parseImageOnlyCarousel(bodyLines.join('\n'));
        if (carouselImages) {
          targets.push({
            from: line.from,
            to: doc.line(closeLine).to,
            align: 'center',
            carousel: true,
            images: carouselImages,
          });
        }
      }
      lineNum = closeLine + 1;
      continue;
    }

    // Multi-line <p> block: opener line, 1..n <img>-only lines, closer line.
    const pOpen = HTML_P_OPEN_LINE_RE.exec(line.text);
    if (pOpen) {
      const images: ImageSpec[] = [];
      let j = lineNum + 1;
      while (j <= doc.lines) {
        const m = HTML_IMG_ONLY_LINE_RE.exec(doc.line(j).text);
        if (!m) break;
        const spec = parseImgAttrs(m[1]);
        if (!spec) break;
        images.push(spec);
        j++;
      }
      if (images.length > 0 && j <= doc.lines && HTML_P_CLOSE_LINE_RE.test(doc.line(j).text)) {
        targets.push({
          from: line.from,
          to: doc.line(j).to,
          align: parseAlign(pOpen[1]),
          images,
        });
        lineNum = j + 1;
        continue;
      }
      lineNum = j;
      continue;
    }

    const singleLineTarget = matchSingleLineImage(line.text);
    if (singleLineTarget) {
      targets.push({
        from: line.from,
        to: line.to,
        align: singleLineTarget.align,
        images: [singleLineTarget.spec],
      });
    }
    lineNum++;
  }
  return targets;
}

function matchSingleLineImage(
  text: string,
): { spec: ImageSpec; align: 'center' | null } | null {
  const md = MD_IMAGE_LINE_RE.exec(text);
  if (md) {
    const rawSrc = md[2].startsWith('<') ? md[2].slice(1, -1).trim() : md[2];
    if (!rawSrc) return null;
    return {
      spec: {
        src: rawSrc,
        alt: md[1],
        title: md[3] ? md[3].slice(1, -1) : '',
        width: null,
        height: null,
      },
      align: null,
    };
  }
  const wiki = WIKI_IMAGE_LINE_RE.exec(text);
  if (wiki) {
    const rawSrc = wiki[1].trim();
    if (!rawSrc || !isLightboxImagePath(rawSrc)) return null;
    return {
      spec: {
        src: rawSrc,
        alt: '',
        title: '',
        width: wiki[2] ? Number(wiki[2]) : null,
        height: wiki[3] ? Number(wiki[3]) : null,
      },
      align: null,
    };
  }
  const wrapped = HTML_P_WRAPPED_LINE_RE.exec(text);
  if (wrapped) {
    const spec = parseImgAttrs(wrapped[2]);
    return spec ? { spec, align: parseAlign(wrapped[1]) } : null;
  }
  const bare = HTML_BARE_IMG_LINE_RE.exec(text);
  if (bare) {
    const spec = parseImgAttrs(bare[1]);
    return spec ? { spec, align: null } : null;
  }
  return null;
}

// ─── Src → loadable URL ─────────────────────────────────────────────────────

function safeDecodePath(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

function applyRemoteOriginToLocalMediaUrl(
  url: string,
  remoteOrigin: RemoteMediaOrigin | null,
): string | null {
  if (!remoteOrigin) return url;
  if (remoteOrigin.kind === 'device') {
    return rewriteToRemoteMediaOrigin(url, remoteOrigin);
  }
  return isSshRewritableMediaUrl(url, remoteOrigin.workdir)
    ? rewriteToRemoteMediaOrigin(url, remoteOrigin)
    : null;
}

/**
 * Resolve a raw markdown src into a URL the renderer's <img> can load, or
 * null when it can't be resolved (empty, relative with no base dir, or
 * outside an SSH remote workdir). Exported for unit tests.
 */
export function resolveImageSrcToUrl(
  src: string,
  baseDir: string,
  remoteOrigin: RemoteMediaOrigin | null = null,
): string | null {
  if (!src) return null;
  if (
    src.startsWith('data:') ||
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('cindy-remote-media://')
  ) {
    return src;
  }
  if (
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    src.startsWith('xdt-file://')
  ) {
    return applyRemoteOriginToLocalMediaUrl(src, remoteOrigin);
  }
  if (src.startsWith('file://')) {
    if (remoteOrigin && isFileUrlHostHref(src, baseDir || '/')) return null;
    const absPath = normalizeResolvedPathSegments(resolveLocalPath(src, baseDir || '/'));
    return applyRemoteOriginToLocalMediaUrl(toLocalFileUrl(absPath), remoteOrigin);
  }
  const decoded = safeDecodePath(src);
  if (decoded.startsWith('/') || WIN_ABS_RE.test(decoded)) {
    const absPath = normalizeResolvedPathSegments(decoded);
    return applyRemoteOriginToLocalMediaUrl(toLocalFileUrl(absPath), remoteOrigin);
  }
  if (!baseDir) return null;
  const absPath = normalizeResolvedPathSegments(resolveLocalPath(decoded, baseDir));
  return applyRemoteOriginToLocalMediaUrl(toLocalFileUrl(absPath), remoteOrigin);
}

// ─── Lightbox event protocol ────────────────────────────────────────────────
//
// Vanilla-DOM widget dispatches on `window`; `MarkdownImageLightboxHost`
// (mounted by FileBodyView) listens and renders the React ImageLightbox.
// Same bridge pattern as MERMAID_LIGHTBOX_EVENT.
export const MD_IMAGE_LIGHTBOX_EVENT = 'xdt-open-md-image-lightbox';

export interface MdImageLightboxGalleryEntry {
  src: string;
  galleryId: string;
}

export interface MdImageLightboxOpenDetail {
  src: string;
  gallery?: readonly MdImageLightboxGalleryEntry[];
  galleryId?: string;
}

// ─── Widget ─────────────────────────────────────────────────────────────────

interface ResolvedImageItem extends ImageSpec {
  /** Resolved loadable URL, or null when unresolvable. */
  url: string | null;
  /** Stable id within the document's gallery when url is resolvable. */
  galleryId: string | null;
}

class MarkdownImageWidget extends WidgetType {
  constructor(
    private readonly items: ResolvedImageItem[],
    private readonly align: 'center' | null,
    private readonly locale: string,
    private readonly carousel: boolean,
    private readonly docGallery: readonly MdImageLightboxGalleryEntry[],
    private readonly docGalleryKey: string,
  ) {
    super();
  }

  eq(other: MarkdownImageWidget): boolean {
    if (
      other.align !== this.align ||
      other.locale !== this.locale ||
      other.carousel !== this.carousel ||
      other.docGalleryKey !== this.docGalleryKey
    ) {
      return false;
    }
    if (other.items.length !== this.items.length) return false;
    return this.items.every((a, i) => {
      const b = other.items[i];
      return (
        a.url === b.url &&
        a.galleryId === b.galleryId &&
        a.src === b.src &&
        a.alt === b.alt &&
        a.title === b.title &&
        a.width === b.width &&
        a.height === b.height
      );
    });
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'cm-md-image-widget';
    if (this.align === 'center') root.classList.add('cm-md-image-center');
    root.setAttribute('contenteditable', 'false');

    if (this.carousel) {
      root.appendChild(this.buildCarousel());
      return root;
    }

    for (const item of this.items) {
      root.appendChild(this.buildItem(item));
    }
    return root;
  }

  private buildCarousel(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cm-md-carousel-card';
    card.setAttribute('data-cm-md-carousel', '');

    const stage = document.createElement('div');
    stage.className = 'cm-md-carousel-stage';
    card.appendChild(stage);

    let activeIndex = 0;
    const total = this.items.length;

    const caption = document.createElement('div');
    caption.className = 'cm-md-carousel-caption';

    const counter = document.createElement('span');
    counter.className = 'cm-md-carousel-counter';

    const dotButtons: HTMLButtonElement[] = [];

    const renderActive = () => {
      const current = this.items[activeIndex];
      stage.replaceChildren(this.buildItem(current));
      if (current.alt) {
        caption.textContent = current.alt;
        caption.style.display = '';
      } else {
        caption.textContent = '';
        caption.style.display = 'none';
      }
      counter.textContent = `${activeIndex + 1} / ${total}`;
      dotButtons.forEach((btn, idx) => {
        const selected = idx === activeIndex;
        btn.classList.toggle('cm-md-carousel-dot-active', selected);
        btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      });
    };

    const step = (delta: number) => {
      if (total <= 1) return;
      activeIndex = (activeIndex + delta + total) % total;
      renderActive();
    };

    card.appendChild(caption);

    if (total > 1) {
      const bar = document.createElement('div');
      bar.className = 'cm-md-carousel-bar';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'cm-md-carousel-btn';
      prevBtn.textContent = '‹';
      prevBtn.setAttribute('aria-label', i18n.t('chat.media.prevImage'));
      prevBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        step(-1);
      });

      const center = document.createElement('div');
      center.className = 'cm-md-carousel-meta';

      if (total <= 12) {
        const dots = document.createElement('div');
        dots.className = 'cm-md-carousel-dots';
        dots.setAttribute('role', 'tablist');
        for (let i = 0; i < total; i++) {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'cm-md-carousel-dot';
          dot.setAttribute('role', 'tab');
          dot.setAttribute('aria-label', `${i + 1} / ${total}`);
          dot.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            activeIndex = i;
            renderActive();
          });
          dotButtons.push(dot);
          dots.appendChild(dot);
        }
        center.appendChild(dots);
      }
      center.appendChild(counter);

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'cm-md-carousel-btn';
      nextBtn.textContent = '›';
      nextBtn.setAttribute('aria-label', i18n.t('chat.media.nextImage'));
      nextBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        step(1);
      });

      bar.append(prevBtn, center, nextBtn);
      card.appendChild(bar);

      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          ev.stopPropagation();
          step(-1);
        } else if (ev.key === 'ArrowRight') {
          ev.preventDefault();
          ev.stopPropagation();
          step(1);
        }
      });
    }

    renderActive();
    return card;
  }

  private buildItem(item: ResolvedImageItem): HTMLElement {
    const holder = document.createElement('div');
    holder.className = 'cm-md-image-item';

    if (item.url === null) {
      holder.appendChild(this.buildErrorCard(item.src));
      return holder;
    }
    const url = item.url;
    const galleryId = item.galleryId ?? undefined;

    const img = document.createElement('img');
    img.src = url;
    img.alt = item.alt;
    if (item.title) img.title = item.title;
    if (item.width !== null) img.style.width = `${item.width}px`;
    if (item.height !== null) img.style.height = `${item.height}px`;
    img.draggable = false;
    img.loading = 'lazy';

    let loaded = false;
    img.addEventListener('load', () => {
      loaded = true;
      holder.classList.add('cm-md-image-clickable');
      holder.setAttribute('role', 'button');
      holder.setAttribute('tabindex', '0');
      holder.setAttribute(
        'aria-label',
        item.alt || i18n.t('ccAgent.workdirBrowse.imagePreview.viewLarge'),
      );
    });
    img.addEventListener('error', () => {
      loaded = false;
      holder.classList.remove('cm-md-image-clickable');
      holder.removeAttribute('role');
      holder.removeAttribute('tabindex');
      holder.replaceChildren(this.buildErrorCard(item.src));
    });

    const open = (ev: Event) => {
      if (!loaded) return;
      ev.preventDefault();
      ev.stopPropagation();
      window.dispatchEvent(
        new CustomEvent<MdImageLightboxOpenDetail>(MD_IMAGE_LIGHTBOX_EVENT, {
          detail: {
            src: url,
            ...(this.docGallery.length > 0 ? { gallery: this.docGallery, galleryId } : {}),
          },
        }),
      );
    };
    holder.addEventListener('click', open);
    holder.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') open(ev);
    });

    holder.appendChild(img);
    return holder;
  }

  private buildErrorCard(rawSrc: string): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cm-md-image-error';

    const label = document.createElement('div');
    label.className = 'cm-md-image-error-label';
    label.textContent = i18n.t('ccAgent.workdirBrowse.imagePreview.loadFailed');

    const path = document.createElement('div');
    path.className = 'cm-md-image-error-path';
    path.textContent = rawSrc;

    card.append(label, path);
    return card;
  }
}

// ─── StateField: scan whole doc on docChange / baseDir / origin / locale flip
export const markdownImageDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(
      state.doc,
      state.facet(imageBaseDirFacet),
      state.facet(imageLocaleFacet),
      state.facet(imageRemoteOriginFacet),
    );
  },
  update(value, tr) {
    const prevBase = tr.startState.facet(imageBaseDirFacet);
    const nextBase = tr.state.facet(imageBaseDirFacet);
    const prevLocale = tr.startState.facet(imageLocaleFacet);
    const nextLocale = tr.state.facet(imageLocaleFacet);
    const prevOrigin = tr.startState.facet(imageRemoteOriginFacet);
    const nextOrigin = tr.state.facet(imageRemoteOriginFacet);
    if (
      !tr.docChanged &&
      prevBase === nextBase &&
      prevLocale === nextLocale &&
      remoteOriginsEqual(prevOrigin, nextOrigin)
    ) {
      return value;
    }
    return buildDecorations(tr.state.doc, nextBase, nextLocale, nextOrigin);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(
  doc: CodeMirrorText,
  baseDir: string,
  locale: string,
  remoteOrigin: RemoteMediaOrigin | null,
): DecorationSet {
  const targets = findImageTargets(doc);
  if (targets.length === 0) return Decoration.none;

  const docGallery: MdImageLightboxGalleryEntry[] = [];
  const resolvedTargets = targets.map((t) => {
    const items: ResolvedImageItem[] = t.images.map((spec) => {
      const url = resolveImageSrcToUrl(spec.src, baseDir, remoteOrigin);
      if (url) {
        const galleryId = `md-doc-img-${docGallery.length}`;
        docGallery.push({ src: url, galleryId });
        return { ...spec, url, galleryId };
      }
      return { ...spec, url: null, galleryId: null };
    });
    return { target: t, items };
  });

  const docGalleryKey = docGallery.map((g) => `${g.galleryId}:${g.src}`).join('\u0000');

  const builder = new RangeSetBuilder<Decoration>();
  for (const { target, items } of resolvedTargets) {
    builder.add(
      target.from,
      target.to,
      Decoration.replace({
        block: true,
        widget: new MarkdownImageWidget(
          items,
          target.align,
          locale,
          Boolean(target.carousel),
          docGallery,
          docGalleryKey,
        ),
      }),
    );
  }
  return builder.finish();
}
