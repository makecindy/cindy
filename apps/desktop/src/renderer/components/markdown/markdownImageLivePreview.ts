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
 * Recognized forms (v1) — the block must contain NOTHING but images:
 *   1. Markdown image alone on its line:
 *        `![alt](path)`, `![alt](<path with spaces>)`, `![alt](path "title")`
 *   2. HTML <img> alone on its line (README-style, GitHub-flavored):
 *        `<img src="doc/images/x.webp" alt="..." width="720" />`
 *   3. Single-line <p>-wrapped form:
 *        `<p align="center"><img src="..." /></p>`
 *   4. Multi-line <p> block — opener, 1..n <img> lines, closer:
 *        `<p align="center">`
 *        `  <img src="..." width="720" />`
 *        `</p>`
 *   `align="center"` on the <p> centers the rendered images; `width` /
 *   `height` attributes are applied (still capped at container width).
 *   5. Obsidian wiki-link image embed, alone on its line:
 *        `![[image.png]]`, `![[subfolder/image.png]]`, `![[image.png|300]]`,
 *        `![[image.png|300x200]]`
 *      The path may contain spaces and doesn't need angle brackets; `|300`
 *      sets width (px), `|300x200` sets width x height. Plain `[[note]]`
 *      (no leading `!`) is an Obsidian *note link*, not an image embed, and
 *      is intentionally left as raw source — only `![[...]]` renders. A
 *      non-numeric `|` suffix (Obsidian's alt-text alias form) is also left
 *      as raw source; out of scope for this module. `![[...]]` is also
 *      Obsidian's generic embed syntax for notes/PDFs/etc — the target is
 *      only treated as an image (and thus rendered) when its extension is
 *      one this app already recognizes as an image (`isLightboxImagePath`,
 *      shared with the workdir file tree); anything else stays raw source
 *      instead of being replaced by a broken-image card.
 *
 *   Inline images mid-paragraph, images inside blockquotes / list items, and
 *   mixed image+text lines stay as raw source — replacing those needs inline
 *   (non-block) widgets with cursor-reveal, which is exactly the
 *   selection-driven rebuild the mermaid module dropped for height-map
 *   stability. Editing an image block = select the widget (click / arrows)
 *   and delete, then retype; same affordance as deleting any atomic block.
 *
 * Path resolution (local files go through the privileged `xdt-file://`
 * protocol — Chromium blocks plain file:// loads from the app origin):
 *   - data: / http(s):// / xdt-image:// / xdt-file://  → pass through
 *   - file://...                                       → strip + re-route
 *   - absolute (C:\..., /abs/...)                      → xdt-file://
 *   - relative                                         → joined against
 *     `imageBaseDirFacet` (the previewed file's own directory, fed by the
 *     host) then xdt-file://. No base dir → unresolvable card.
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

import { isLightboxImagePath } from '@/features/cc-agent/workdir-browse/lib/imageExt';
import { resolveLocalPath, toLocalFileUrl } from '@/lib/localPathResolver';

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

// Same contract as `mermaidLocaleFacet`: widget reads i18n.t(...) at toDOM
// time, so hosts feed the live locale through a Compartment and the
// StateField rebuilds widgets when it flips.
export const imageLocaleFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? 'default',
});

// ─── Detection ──────────────────────────────────────────────────────────────
//
// Markdown form: one image, alone on its line. Src is either an
// angle-bracket form (`<may contain spaces>`) or a run without whitespace /
// `)`. Optional quoted title after the src. ≤3 leading spaces per
// CommonMark (4+ would be an indented code block and must stay raw).
const MD_IMAGE_LINE_RE =
  /^ {0,3}!\[([^\]]*)\]\(\s*(<[^<>]*>|[^)\s]+)(?:\s+("[^"]*"|'[^']*'))?\s*\)\s*$/;

// Obsidian wiki-link *embed* syntax (`![[target]]`) covers notes, PDFs and
// images alike — this regex only isolates the target/size text; the caller
// (matchSingleLineImage) still has to check the extension via
// isLightboxImagePath before treating it as an image. Path excludes `]` and
// `|` (so it stops at the size suffix or the closing `]]`); size suffix is
// `|width` or `|widthxheight`, digits only. A non-numeric `|` suffix
// (Obsidian's alt-text alias) fails to match here and the line stays raw
// source.
const WIKI_IMAGE_LINE_RE =
  /^ {0,3}!\[\[([^\]|]+)(?:\|(\d+)(?:x(\d+))?)?\]\]\s*$/;

// HTML forms. `[^>]*?` keeps attribute scanning inside the tag; an attr
// value containing a literal `>` is out of scope (stays raw source).
const HTML_BARE_IMG_LINE_RE = /^ {0,3}<img\b([^>]*?)\/?\s*>\s*$/i;
const HTML_P_WRAPPED_LINE_RE =
  /^ {0,3}<p\b([^>]*)>\s*<img\b([^>]*?)\/?\s*>\s*<\/p>\s*$/i;
const HTML_P_OPEN_LINE_RE = /^ {0,3}<p\b([^>]*)>\s*$/i;
const HTML_IMG_ONLY_LINE_RE = /^\s*<img\b([^>]*?)\/?\s*>\s*$/i;
const HTML_P_CLOSE_LINE_RE = /^\s*<\/p>\s*$/i;

// Fence tracking mirrors the mermaid module's simplified CommonMark rules:
// opener = 3+ backticks/tildes with ≤3 spaces indent, closer = same char,
// same-or-longer run. Image examples inside any fenced block (```markdown
// docs etc.) must stay raw source.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

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
  /** 1..n images (n > 1 only for the multi-line <p> block form). */
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
  // Accept plain integers and "720px"; percentages / other CSS units are
  // ignored (the CSS max-width cap governs anyway).
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
      // Open-ended fence → stop scanning entirely (conservative, mirrors the
      // mermaid scanner): while the user is mid-typing a fence, everything
      // below is potentially fenced content.
      if (closeLine === -1) break;
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
      // Not a well-formed image-only <p> block (mixed content / missing
      // closer) → the whole prefix INCLUDING any collected <img> lines stays
      // raw source. Resume scanning at the line that broke the pattern so a
      // stray `<img>` mid-broken-block doesn't render standalone while its
      // wrapper is visibly half-typed.
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
    // `![[...]]` is Obsidian's generic embed syntax (notes, PDFs, images);
    // only render it here when the target is actually an image extension —
    // otherwise a note/PDF embed would get replaced by a broken-image card.
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

/**
 * Percent-decode a markdown-authored path (`a%20b.png` → `a b.png`) without
 * blowing up on literal `%` in filenames (`100% done.png` → decodeURIComponent
 * throws URIError → keep the raw string).
 */
function safeDecodePath(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;

/**
 * Resolve a raw markdown src into a URL the renderer's <img> can load, or
 * null when it can't be resolved (empty, or relative with no base dir).
 * Exported for unit tests.
 */
export function resolveImageSrcToUrl(src: string, baseDir: string): string | null {
  if (!src) return null;
  if (
    src.startsWith('data:') ||
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('xdt-image://') ||
    src.startsWith('cindy-media://') ||
    src.startsWith('xdt-file://')
  ) {
    return src;
  }
  if (src.startsWith('file://')) {
    // resolveLocalPath already strips the scheme + decodes + fixes the
    // Windows leading-slash form; baseDir is irrelevant for absolute URLs.
    return toLocalFileUrl(resolveLocalPath(src, baseDir || '/'));
  }
  const decoded = safeDecodePath(src);
  if (decoded.startsWith('/') || WIN_ABS_RE.test(decoded)) {
    return toLocalFileUrl(decoded);
  }
  if (!baseDir) return null;
  return toLocalFileUrl(resolveLocalPath(decoded, baseDir));
}

// ─── Lightbox event protocol ────────────────────────────────────────────────
//
// Vanilla-DOM widget dispatches on `window`; `MarkdownImageLightboxHost`
// (mounted by FileBodyView) listens and renders the React ImageLightbox.
// Same bridge pattern as MERMAID_LIGHTBOX_EVENT.
export const MD_IMAGE_LIGHTBOX_EVENT = 'xdt-open-md-image-lightbox';

export interface MdImageLightboxOpenDetail {
  src: string;
}

// ─── Widget ─────────────────────────────────────────────────────────────────

interface ResolvedImageItem extends ImageSpec {
  /** Resolved loadable URL, or null when unresolvable. */
  url: string | null;
}

class MarkdownImageWidget extends WidgetType {
  constructor(
    private readonly items: ResolvedImageItem[],
    private readonly align: 'center' | null,
    private readonly locale: string,
  ) {
    super();
  }

  eq(other: MarkdownImageWidget): boolean {
    // `url` folds in the base dir, so a facet flip that changes resolution
    // produces a non-equal widget → fresh toDOM. `locale` is part of equality
    // for the same reason as the mermaid widget: i18n strings are read at
    // toDOM time. Position is intentionally NOT compared — typing elsewhere
    // must reuse the loaded <img> DOM instead of re-fetching it.
    if (other.align !== this.align || other.locale !== this.locale) return false;
    if (other.items.length !== this.items.length) return false;
    return this.items.every((a, i) => {
      const b = other.items[i];
      return (
        a.url === b.url &&
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

    for (const item of this.items) {
      root.appendChild(this.buildItem(item));
    }
    return root;
  }

  private buildItem(item: ResolvedImageItem): HTMLElement {
    const holder = document.createElement('div');
    holder.className = 'cm-md-image-item';

    if (item.url === null) {
      holder.appendChild(this.buildErrorCard(item.src));
      return holder;
    }
    const url = item.url;

    const img = document.createElement('img');
    img.src = url;
    img.alt = item.alt;
    if (item.title) img.title = item.title;
    // Honor authored dimensions (README `width="720"` etc.); the theme's
    // max-width:100% cap still prevents overflow on narrow panes.
    if (item.width !== null) img.style.width = `${item.width}px`;
    if (item.height !== null) img.style.height = `${item.height}px`;
    img.draggable = false;
    // Native lazy loading keeps offscreen images from stampeding disk reads
    // when a doc has dozens of them; CM's own mutation observer picks up the
    // height change on load, no requestMeasure needed (mermaid learned this
    // the hard way).
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
          detail: { src: url },
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

// ─── StateField: scan whole doc on docChange / baseDir / locale flip ───────
export const markdownImageDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(
      state.doc,
      state.facet(imageBaseDirFacet),
      state.facet(imageLocaleFacet),
    );
  },
  update(value, tr) {
    const prevBase = tr.startState.facet(imageBaseDirFacet);
    const nextBase = tr.state.facet(imageBaseDirFacet);
    const prevLocale = tr.startState.facet(imageLocaleFacet);
    const nextLocale = tr.state.facet(imageLocaleFacet);
    if (!tr.docChanged && prevBase === nextBase && prevLocale === nextLocale) {
      return value;
    }
    return buildDecorations(tr.state.doc, nextBase, nextLocale);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(
  doc: CodeMirrorText,
  baseDir: string,
  locale: string,
): DecorationSet {
  const targets = findImageTargets(doc);
  if (targets.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const t of targets) {
    builder.add(
      t.from,
      t.to,
      Decoration.replace({
        block: true,
        widget: new MarkdownImageWidget(
          t.images.map((spec) => ({
            ...spec,
            url: resolveImageSrcToUrl(spec.src, baseDir),
          })),
          t.align,
          locale,
        ),
      }),
    );
  }
  return builder.finish();
}
