/**
 * markdownMermaidLivePreview — render ```mermaid fenced blocks as SVG inside
 * the doc-mode CodeMirror editor (workdir-browse → FileBodyView).
 *
 * Implementation shape mirrors `markdownTableLivePreview`:
 *   - StateField scans the whole doc on docChange (not on selection/viewport
 *     changes — those triggered an unbounded height-map growth where every
 *     measure pass rebuilt new widgets and CM kept re-measuring).
 *   - Each ```mermaid fenced block becomes a single
 *     `Decoration.replace({block: true, widget: MermaidWidget})`.
 *   - Mermaid SVG renders asynchronously inside the widget; on success we
 *     swap `<pre>` placeholder → SVG element. On error we keep the
 *     `<pre>` placeholder visible AND prepend an inline error banner
 *     describing the failure (matches chat-side fallback for streaming-
 *     incomplete diagrams + makes hard parse errors visually obvious).
 *
 * Hover toolbar:
 *   The rendered widget exposes two icon buttons (top-right, hover-revealed)
 *   — Zoom (open `MermaidLightbox`) and Edit Source. Edit Source dispatches
 *   `MERMAID_EDIT_EVENT` carrying the body's char range plus a closure that
 *   captures `view`, so a React modal listening for the event can write the
 *   user's edits back via `view.dispatch`. Without this affordance the block
 *   widget would replace the source and leave users no way to update broken
 *   diagrams from the always-edit markdown surface.
 *
 * What was deliberately dropped vs. the first attempt:
 *   - Cursor-inside-fence reveal: rebuilding decorations on selection / focus
 *     changes broke CM's height map. v1 keeps the diagram always rendered;
 *     edits go through the toolbar → modal path instead of cursor reveal.
 *   - `view.requestMeasure()` after async SVG swap: CM has its own dirty
 *     tracking; calling it from inside an rAF that also mutated DOM created
 *     measurement feedback loops. The natural mutation observer on the
 *     widget DOM is enough to repaint correctly.
 *
 * Module cache: SVGs are memoized by `${theme}|${source}` so re-mounts
 * (theme flip, file switch, scroll out and back) reuse rendered output.
 * Capped at MAX_CACHE_ENTRIES with FIFO eviction so a long session over
 * many mermaid-heavy files can't accumulate unbounded SVG strings (Map
 * preserves insertion order, so `entries().next()` yields the oldest key).
 *
 * Theme switching: PlaintextEditor recreates the entire EditorView when the
 * dark/light flip toggles (see the comment block above its `useEffect`).
 * That tear-down + remount path naturally rebuilds widgets via fresh
 * `toDOM()` calls, which re-key the cache lookup against the new theme. We
 * therefore deliberately do NOT subscribe to theme changes inside this
 * field — doing so would add a second source of decoration rebuild that
 * could race with EditorView reconstruction.
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

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import {
  copyPngBlobToClipboard,
  resolveExportBackground,
  svgToPngBlob,
} from '@/lib/rasterizeToImage';

const log = createLogger('MermaidLivePreview');

// ─── Mermaid lazy-load + theme init ─────────────────────────────────────────
type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | null = null;
function loadMermaid(): Promise<MermaidModule> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((mod) => mod.default);
  return mermaidPromise;
}

function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

let initializedTheme: 'dark' | 'default' | null = null;
async function ensureMermaid(): Promise<MermaidModule> {
  const m = await loadMermaid();
  const theme: 'dark' | 'default' = isDarkMode() ? 'dark' : 'default';
  if (initializedTheme !== theme) {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      fontFamily: 'inherit',
      theme,
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
    });
    initializedTheme = theme;
  }
  return m;
}

// Bounded LRU-ish cache. Map preserves insertion order, so when over capacity
// we drop the oldest key. Touched on every successful render. Empirically
// 64 entries is plenty for typical doc browsing — a long doc with 6-8
// diagrams across both themes only needs ~16 slots.
const MAX_CACHE_ENTRIES = 64;
const renderCache = new Map<string, string>();

function setCacheEntry(key: string, svg: string): void {
  if (renderCache.has(key)) renderCache.delete(key); // re-insert as newest
  renderCache.set(key, svg);
  while (renderCache.size > MAX_CACHE_ENTRIES) {
    const oldest = renderCache.keys().next();
    if (oldest.done) break;
    renderCache.delete(oldest.value);
  }
}

function getCacheEntry(key: string): string | undefined {
  const v = renderCache.get(key);
  if (v !== undefined) {
    // Touch — move to newest end.
    renderCache.delete(key);
    renderCache.set(key, v);
  }
  return v;
}

// ─── Locale facet ───────────────────────────────────────────────────────────
//
// The widget reads i18n.t(...) at toDOM time for toolbar labels and the
// render-error banner prefix. After a `i18n.changeLanguage()` call those
// strings would still be in the OLD language until the document changes or
// the editor remounts, because StateField.update() only sees `docChanged`
// transactions. Mirror the table-menu pattern: hosts feed the current
// locale through `mermaidLocaleFacet` (typically inside a Compartment) and
// the StateField rebuilds widgets when the facet value changes.
//
// Hosts that don't care about locale switching can omit the facet entirely
// — `combine` falls back to `'default'` and the field never sees a flip.
export const mermaidLocaleFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? 'default',
});

// ─── Block detection ────────────────────────────────────────────────────────
//
// CommonMark §4.5: a fenced code block opens with 3+ backticks/tildes and the
// closer must use the same character with at least the same length. We honor
// that for both the mermaid opener AND the "other" opener — without it,
// a documentation file that wraps a literal `\`\`\`mermaid` example in a
// 4-backtick outer fence (the standard CommonMark escape) would have its
// outer fence ignored and the inner sample would render as a live diagram.
//
// Indent: CommonMark allows 0–3 spaces of leading indent on a fence opener.
// 4+ spaces (or a literal tab, which CM treats as 4 spaces) makes the line
// an *indented code block*, not a fence. So a sample like
//   `    \`\`\`mermaid` (4 spaces)
// must be left as raw code — using `\s*` here would (mis)render it as a live
// diagram and expose edit/zoom controls for what the author meant to
// display literally.
//
// Mermaid info-string matching: we accept `mermaid` as the FIRST token after
// the fence (with optional leading whitespace inside the info string and
// optional trailing attributes), so all of these are recognized:
//   ```mermaid
//   ```mermaid title="flow"
//   ``` mermaid
//   ```mermaid lang=...
// Without the trailing-attribute branch, `\`\`\`mermaid title="x"` would
// fall through to FENCE_OPEN_OTHER_RE and render as a non-mermaid block.
// The trailing token-boundary form (a non-backtick branch + a non-anything
// branch) enforces token isolation so `\`\`\`mermaidx` is not matched.
//
// Per CommonMark §4.5 the info-string rules differ by fence char:
//   - Backtick fence: info string CANNOT contain backticks (otherwise the
//     opener and closer become ambiguous on the same line).
//   - Tilde fence:    info string CAN contain anything (including backticks),
//     because the closer is a tilde run and there's no ambiguity.
// We therefore split BOTH the mermaid opener AND the non-mermaid opener by
// fence char. A unified regex with `(?:\s.*)?$` would (mis)accept
// ```mermaid title=`example` as a real mermaid block — but Markdown leaves
// that line as raw source, so rendering it as a live diagram is a real
// data-correctness bug, not just a visual quirk.
const FENCE_OPEN_MERMAID_BACKTICK_RE = /^ {0,3}`{3,}\s*mermaid(?:[ \t][^`]*)?$/;
const FENCE_OPEN_MERMAID_TILDE_RE = /^ {0,3}~{3,}\s*mermaid(?:[ \t].*)?$/;
const FENCE_OPEN_OTHER_BACKTICK_RE = /^ {0,3}`{3,}[^`]*$/;
const FENCE_OPEN_OTHER_TILDE_RE = /^ {0,3}~{3,}.*$/;

function buildFenceCloseRe(opener: string): RegExp {
  // Same fence char, length ≥ opener's. Per CommonMark, closer can be longer
  // but never shorter, must use the same char, and may be indented up to
  // three spaces (matching the opener's indent allowance).
  const ch = opener[0]; // '`' or '~'
  return new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${opener.length},}\\s*$`);
}

// Exported for unit tests only — `findMermaidBlocks` and
// `resolveBlockAtEditTime` are internal helpers, but covering them with pure-
// function tests is much cheaper than driving the whole CodeMirror editor.
// Production callsites stay inside this file.
export interface MermaidBlock {
  /** Start of opener fence line. */
  from: number;
  /** End of closer fence line (exclusive of trailing newline). */
  to: number;
  /** Start of first body char (= start of line after opener fence). */
  bodyFrom: number;
  /** Start of closer fence line — i.e., the position right after the body's
   *  trailing newline. Replacing [bodyFrom, bodyEnd] preserves both fences. */
  bodyEnd: number;
  source: string;
}

export function findMermaidBlocks(doc: CodeMirrorText): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let lineNum = 1;
  while (lineNum <= doc.lines) {
    const line = doc.line(lineNum);

    // First check for a *non-mermaid* fenced block that contains us. Skip
    // its body wholesale — any `\`\`\`mermaid` example inside a `\`\`\`markdown`
    // / `\`\`\`md` documentation block must NOT be rendered as a live
    // diagram. We test mermaid-opener BEFORE other-opener so a real
    // `\`\`\`mermaid` line at top level still wins.
    // Try mermaid first (backtick path, then tilde — mutually exclusive by
    // leading char). Then "other" (any fence that isn't a mermaid opener).
    // Splitting by fence char is required because CommonMark info-string
    // rules differ between ``` and ~~~ (backtick rejects backticks, tilde
    // accepts anything).
    let mermaidOpener: string | null = null;
    {
      const mm =
        FENCE_OPEN_MERMAID_BACKTICK_RE.exec(line.text) ??
        FENCE_OPEN_MERMAID_TILDE_RE.exec(line.text);
      if (mm) {
        const lead = mm[0].match(/^ {0,3}([`~]+)/);
        if (lead) mermaidOpener = lead[1];
      }
    }
    let otherOpener: string | null = null;
    if (!mermaidOpener) {
      const om =
        FENCE_OPEN_OTHER_BACKTICK_RE.exec(line.text) ??
        FENCE_OPEN_OTHER_TILDE_RE.exec(line.text);
      if (om) {
        const lead = om[0].match(/^ {0,3}([`~]+)/);
        if (lead) otherOpener = lead[1];
      }
    }
    if (otherOpener) {
      const otherCloseRe = buildFenceCloseRe(otherOpener);
      let otherClose = -1;
      for (let j = lineNum + 1; j <= doc.lines; j++) {
        if (otherCloseRe.test(doc.line(j).text)) {
          otherClose = j;
          break;
        }
      }
      // Open-ended other fence → leave the rest of the doc unscanned so a
      // partially-typed `\`\`\`markdown` block above doesn't accidentally
      // capture every following mermaid block. Bail conservatively.
      if (otherClose === -1) break;
      lineNum = otherClose + 1;
      continue;
    }
    if (!mermaidOpener) {
      lineNum++;
      continue;
    }
    const closeRe = buildFenceCloseRe(mermaidOpener);
    let closeLine = -1;
    for (let j = lineNum + 1; j <= doc.lines; j++) {
      if (closeRe.test(doc.line(j).text)) {
        closeLine = j;
        break;
      }
    }
    if (closeLine === -1) {
      // Open-ended fence — leave as raw source until user types the closer.
      lineNum++;
      continue;
    }
    const sourceLines: string[] = [];
    for (let j = lineNum + 1; j < closeLine; j++) {
      sourceLines.push(doc.line(j).text);
    }
    blocks.push({
      from: line.from,
      to: doc.line(closeLine).to,
      // Body range = [start of first body line, start of closer line].
      // Replacing that range keeps both fence lines and their separators
      // intact, regardless of whether the body is empty.
      bodyFrom: doc.line(closeLine).from === line.to + 1
        ? doc.line(closeLine).from // empty body: opener directly followed by closer
        : doc.line(lineNum + 1).from,
      bodyEnd: doc.line(closeLine).from,
      source: sourceLines.join('\n'),
    });
    lineNum = closeLine + 1;
  }
  return blocks;
}

// ─── Lightbox + edit-source event protocol ──────────────────────────────────
//
// Vanilla-DOM widgets dispatch these events on `window`; React hosts (mounted
// via `MermaidLightboxHost` / `MermaidSourceEditorHost`) listen and render
// the actual modals. Keeping the contract here so widget + hosts stay in sync.
export const MERMAID_LIGHTBOX_EVENT = 'xdt-open-mermaid-lightbox';

export interface MermaidLightboxOpenDetail {
  svg: string;
  /** mermaid 原始源码(可选):lightbox「复制图片」随图附带 text/plain 表示。 */
  source?: string;
}

export const MERMAID_EDIT_EVENT = 'xdt-edit-mermaid-source';

/**
 * Detail payload for the edit-source modal.
 *
 * The widget closes over its EditorView so the modal doesn't need its own
 * dispatch path back to CodeMirror — it just calls `applyEdit(newSource)` and
 * the change goes through the right view instance even when multiple files
 * are open.
 *
 * `applyEdit` returns a discriminated result so the modal (which has React /
 * i18n context) can surface failure to the user via a toast. The widget
 * itself stays React-free.
 */
export type MermaidEditApplyResult = 'applied' | 'target-missing';

export interface MermaidEditOpenDetail {
  source: string;
  applyEdit: (newSource: string) => MermaidEditApplyResult;
}

// ─── Widget ─────────────────────────────────────────────────────────────────
class MermaidWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly bodyFrom: number,
    private readonly bodyEnd: number,
    private readonly hostEditable: boolean,
    private readonly locale: string,
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    // Position is intentionally NOT part of equality so SVG re-renders are
    // skipped when the user types outside the block (source unchanged →
    // CM reuses our DOM by `compare(oldWidget, newWidget) === true`).
    //
    // Caveat: when CM reuses the DOM, the click handlers attached during
    // toDOM keep their original `bodyFrom`/`bodyEnd` closure values. New
    // `MermaidWidget` instances with updated positions are created by every
    // rebuild but the listeners on the live DOM are NOT re-installed.
    // `applyEdit` therefore must NOT trust `this.bodyFrom`/`this.bodyEnd`
    // captured at toDOM time — it re-runs `findMermaidBlocks` on the current
    // doc to resolve real positions before dispatching the change. See
    // `attachToolbar` below.
    //
    // `hostEditable` IS part of equality so a facet flip (read-only →
    // editable and vice versa) forces a fresh `toDOM()` and the toolbar gets
    // rebuilt with / without the Edit-Source button. Without this,
    // FileBodyView's initial `editMode=false` mount would leave the cached
    // widget stuck with a zoom-only toolbar even after edit mode toggles on.
    //
    // `locale` IS part of equality so a `i18n.changeLanguage()` call forces
    // a fresh `toDOM()`, which re-runs `i18n.t(...)` for the toolbar labels
    // and error-banner prefix in the new language.
    //
    // Field name is `hostEditable` (not `editable`) because `WidgetType`
    // already has a getter named `editable` controlling whether the widget's
    // own DOM is contenteditable — assigning to the same name in a subclass
    // throws "Cannot set property editable of #<WidgetType> which has only a
    // getter" at runtime.
    return (
      other.source === this.source &&
      other.hostEditable === this.hostEditable &&
      other.locale === this.locale
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // wrapper 只承载纵向留白(theme 里是 padding)。留白必须落在 rect 之内:
    // CM 的 height map 用 getBoundingClientRect().height 记账,margin 不计入,
    // 之前卡片直接带 margin 导致视觉排版和坐标记账错位("点上面选中下面")。
    // 卡片视觉(边框/背景/toolbar 锚点)在内层 .cm-md-mermaid-card 上,下面的
    // 渲染/toolbar/loading 逻辑全部围绕 card(变量名沿用 root)。
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-mermaid-widget';
    wrapper.setAttribute('contenteditable', 'false');

    const root = document.createElement('div');
    root.className = 'cm-md-mermaid-card';
    wrapper.appendChild(root);

    const placeholder = document.createElement('pre');
    placeholder.className = 'cm-md-mermaid-fallback';
    placeholder.textContent = this.source;

    const theme = isDarkMode() ? 'dark' : 'default';
    const cacheKey = `${theme}|${this.source}`;
    const cached = getCacheEntry(cacheKey);
    if (cached) {
      const svgEl = parseSvg(cached);
      if (svgEl) {
        root.appendChild(svgEl);
        this.attachToolbar(view, root, cached);
        this.attachClickToZoom(root, cached);
        return wrapper;
      }
    }

    root.classList.add('cm-md-mermaid-loading');
    root.appendChild(placeholder);
    this.attachToolbar(view, root, null);
    void this.kickRender(view, root, placeholder, cacheKey);
    return wrapper;
  }

  private async kickRender(
    view: EditorView,
    root: HTMLElement,
    placeholder: HTMLElement,
    cacheKey: string,
  ): Promise<void> {
    const trimmed = this.source.trim();
    if (!trimmed) {
      this.surfaceError(
        root,
        placeholder,
        i18n.t('ccAgent.workdirBrowse.mermaidEditor.errEmpty'),
      );
      return;
    }
    let svg: string;
    try {
      const m = await ensureMermaid();
      await m.parse(trimmed);
      const id = `cm-mmd-${Math.random().toString(36).slice(2, 10)}`;
      ({ svg } = await m.render(id, trimmed));
    } catch (err) {
      log.error('render failed', err);
      if (!root.isConnected) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.surfaceError(root, placeholder, msg);
      return;
    }
    // Order matters: check `isConnected` BEFORE caching. If the widget got
    // detached mid-render (e.g., theme switch recreated the EditorView), the
    // SVG we just produced was rendered against the OLD theme's mermaid
    // initialization — caching it under our toDOM-time `cacheKey` would
    // poison the cache so the next mount of this same source serves a
    // wrong-theme SVG. Bail without caching when orphaned.
    if (!root.isConnected) return;
    setCacheEntry(cacheKey, svg);
    const svgEl = parseSvg(svg);
    if (!svgEl) {
      log.error('SVG parse failed', svg.slice(0, 200));
      this.surfaceError(
        root,
        placeholder,
        i18n.t('ccAgent.workdirBrowse.mermaidEditor.errSvgParse', {
          length: svg.length,
        }),
      );
      return;
    }
    root.classList.remove('cm-md-mermaid-loading');
    root.replaceChildren(svgEl);
    this.attachToolbar(view, root, svg);
    this.attachClickToZoom(root, svg);
  }

  /**
   * Render the failure state: keep the source `<pre>` AND prepend a visible
   * error banner. Without the banner a parse failure would be visually
   * indistinguishable from the loading state, leaving the user unsure whether
   * to wait or fix the syntax.
   *
   * The toolbar (if already attached by toDOM) is preserved across the swap
   * so the user can click "edit source" to fix the broken syntax — without
   * it the widget is `contenteditable=false` and the source is unreachable.
   */
  private surfaceError(
    root: HTMLElement,
    placeholder: HTMLElement,
    message: string,
  ): void {
    if (!root.isConnected) return;
    root.classList.remove('cm-md-mermaid-loading');
    root.classList.add('cm-md-mermaid-error');
    const banner = document.createElement('div');
    banner.className = 'cm-md-mermaid-error-banner';
    banner.textContent = `${i18n.t(
      'ccAgent.workdirBrowse.mermaidEditor.renderFailedPrefix',
    )}${message}`;
    // Replace children so we don't accumulate stale banners on repeated
    // attempts; existing toolbar (attached during toDOM) is re-included so
    // the user can still click "edit source" from the error state.
    const existingToolbar = root.querySelector<HTMLElement>('.cm-md-mermaid-toolbar');
    const nodes: Node[] = [banner, placeholder];
    if (existingToolbar) nodes.push(existingToolbar);
    root.replaceChildren(...nodes);
  }

  /**
   * Hover-revealed toolbar (top-right). Two buttons:
   *   - Zoom (Expand icon): opens MermaidLightbox via lightbox CustomEvent.
   *   - Edit Source (Code2 icon): opens MermaidSourceEditor modal via edit
   *     CustomEvent, with a closure that writes the user's edits back to
   *     this widget's body range through `view.dispatch`.
   *
   * `svg` may be null when no diagram has rendered yet (loading / error
   * state) — we hide the Zoom button in that case since there's nothing to
   * zoom into, but Edit Source stays available so the user can fix broken
   * syntax.
   */
  private attachToolbar(view: EditorView, root: HTMLElement, svg: string | null): void {
    // Idempotent: drop any prior toolbar before attaching a fresh one (cached
    // and async-render paths both flow through here).
    root.querySelector('.cm-md-mermaid-toolbar')?.remove();

    const tb = document.createElement('div');
    tb.className = 'cm-md-mermaid-toolbar';

    if (svg !== null) {
      const zoomBtn = makeToolbarButton(
        i18n.t('ccAgent.workdirBrowse.mermaidEditor.toolbarZoom'),
        SVG_EXPAND,
      );
      zoomBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        window.dispatchEvent(
          new CustomEvent<MermaidLightboxOpenDetail>(MERMAID_LIGHTBOX_EVENT, {
            detail: { svg, source: this.source },
          }),
        );
      });
      tb.appendChild(zoomBtn);

      // Copy (PNG + mermaid source in one ClipboardItem — paste targets pick
      // their preferred flavor). Vanilla-DOM twin of the chat-side
      // useCopyAsImage hook: same rasterizer (intrinsic viewBox size, 3x
      // scale, 4096 cap, themed solid background sampled from the widget
      // card), same 1.5s check-icon feedback. No annotate entry here — this
      // editor surface has no chat session to send into.
      const copyImgBtn = makeToolbarButton(
        i18n.t('ccAgent.workdirBrowse.mermaidEditor.toolbarCopy'),
        SVG_COPY,
      );
      let copyImgPending = false;
      let copyImgTimer: ReturnType<typeof setTimeout> | null = null;
      copyImgBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (copyImgPending) return;
        copyImgPending = true;
        svgToPngBlob(svg, {
          background: resolveExportBackground(root),
          fontFamily: window.getComputedStyle(root).fontFamily,
        })
          .then((blob) => copyPngBlobToClipboard(blob, this.source))
          .then(() => {
            copyImgBtn.innerHTML = SVG_CHECK;
            if (copyImgTimer) clearTimeout(copyImgTimer);
            copyImgTimer = setTimeout(() => {
              copyImgBtn.innerHTML = SVG_COPY;
              copyImgTimer = null;
            }, 1500);
          })
          .catch((err) => {
            log.warn('copy as image failed', err);
            toast.error(i18n.t('chat.media.copyFailed'));
          })
          .finally(() => {
            copyImgPending = false;
          });
      });
      tb.appendChild(copyImgBtn);
    }

    // Hide edit-source when the editor is non-editable: FileBodyView gates
    // truncated files / loading states with `readOnly={!editMode}` AND in
    // those states does NOT wire the autosave onChange. A user click in
    // that mode would update the in-memory doc but never flush to disk —
    // silent data loss. Skipping the button entirely makes the truncation
    // visible (only zoom remains).
    //
    // We use `this.hostEditable` (captured at widget-construction time from
    // the EditorView.editable facet by `buildDecorations`) rather than
    // reading the facet here. The StateField rebuilds widgets when the
    // facet flips, and `eq()` includes `hostEditable`, so a flip forces a
    // fresh `toDOM()` — which is the path that gets us re-evaluated.
    // Reading the facet at click time would also work for live state but
    // adds an asymmetry: toolbar visible/hidden state would diverge from
    // the widget's eq() identity, making cache-reuse reasoning harder.
    if (!this.hostEditable) {
      root.appendChild(tb);
      return;
    }
    const editBtn = makeToolbarButton(
      i18n.t('ccAgent.workdirBrowse.mermaidEditor.toolbarEdit'),
      SVG_CODE2,
    );
    editBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const detail: MermaidEditOpenDetail = {
        source: this.source,
        applyEdit: (newSource: string): MermaidEditApplyResult => {
          // Re-resolve real positions against the current doc. The toDOM-time
          // `this.bodyFrom` / `this.bodyEnd` are stale: CM compare()'s
          // source-only equality means our DOM (and this listener closure)
          // gets reused when the block shifts in the doc.
          //
          // `view.posAtDOM(root)` is CM's live mapping from a rendered DOM
          // node back to its current document position — authoritative even
          // when our closure values lag. We then find the matching mermaid
          // block whose range contains that position.
          const target = resolveBlockAtLivePos(view, root, this.source);
          if (target == null) {
            // Block disappeared from the doc (deleted / fence broken). Bail
            // and let the caller (the modal) surface a user-visible toast.
            log.warn('applyEdit: live pos not inside any matching block, skipping');
            return 'target-missing';
          }
          // Normalize: ensure the inserted body ends with a newline so the
          // closer fence line stays on its own line. Strip any trailing \n
          // first to keep the result canonical.
          const stripped = newSource.replace(/\r?\n+$/, '');
          const insert = stripped.length > 0 ? stripped + '\n' : '';
          view.dispatch({
            changes: { from: target.bodyFrom, to: target.bodyEnd, insert },
          });
          return 'applied';
        },
      };
      window.dispatchEvent(
        new CustomEvent<MermaidEditOpenDetail>(MERMAID_EDIT_EVENT, { detail }),
      );
    });
    tb.appendChild(editBtn);

    root.appendChild(tb);
  }

  // Wire SVG click → dispatch a CustomEvent carrying the SVG markup.
  // FileBodyView (or any host) listens and renders MermaidLightbox. Vanilla-
  // DOM widget stays React-free; the React lightbox stays a normal component.
  private attachClickToZoom(root: HTMLElement, svg: string): void {
    root.classList.add('cm-md-mermaid-clickable');
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    const open = (ev: Event) => {
      // Don't intercept clicks routed at the toolbar (zoom / edit buttons).
      if (ev.target instanceof Element && ev.target.closest('.cm-md-mermaid-toolbar')) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      window.dispatchEvent(
        new CustomEvent<MermaidLightboxOpenDetail>(MERMAID_LIGHTBOX_EVENT, {
          detail: { svg, source: this.source },
        }),
      );
    };
    root.addEventListener('click', open);
    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') open(ev);
    });
  }
}

function makeToolbarButton(label: string, iconSvg: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cm-md-mermaid-toolbar-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = iconSvg;
  return b;
}

// Inline lucide-react icon paths so the widget doesn't drag a React tree in.
// Stroke / fill are 'currentColor' so theme tokens drive color from CSS.
const SVG_EXPAND =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8"/><path d="M3 16.2V21m0 0h4.8M3 21l6-6"/><path d="M21 7.8V3m0 0h-4.8M21 3l-6 6"/><path d="M3 7.8V3m0 0h4.8M3 3l6 6"/></svg>';

const SVG_CODE2 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 16 22 12 18 8"/><polyline points="6 8 2 12 6 16"/><line x1="14.5" y1="4" x2="9.5" y2="20"/></svg>';

// lucide `copy`(与聊天块单一「复制」按钮同一图标语义:PNG + 源码双格式)。
const SVG_COPY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

// lucide `check`(复制成功的 1.5s 反馈态)。
const SVG_CHECK =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function parseSvg(svgString: string): SVGElement | null {
  const tmp = document.createElement('div');
  tmp.innerHTML = svgString;
  const el = tmp.firstElementChild;
  if (el instanceof SVGElement) return el;
  return null;
}

/**
 * Resolve the mermaid block at the widget's live document position.
 *
 * Why this exists: `MermaidWidget.eq()` returns true on matching `source`,
 * so CM reuses the rendered DOM (and the toolbar click handler's closure)
 * when the block shifts in the doc — e.g., the user types ABOVE the block.
 * The closure-captured `bodyFrom`/`bodyEnd` go stale; using them in
 * `view.dispatch` writes to the wrong byte range.
 *
 * `view.posAtDOM(root)` is CM's authoritative DOM-to-doc-position lookup,
 * which it tracks correctly across edits regardless of whether the widget's
 * `eq()` says "same content". Using that we can:
 *   - Disambiguate identical-source duplicate blocks deterministically (the
 *     widget's own DOM lives at exactly one position).
 *   - Detect block deletion (no block contains livePos) and bail out.
 *
 * Sanity-guarded by `source` equality — if for any reason CM hands us a
 * livePos that lands inside a NON-matching block, we still refuse to write
 * (returns null).
 */
export function resolveBlockAtLivePos(
  view: EditorView,
  root: HTMLElement,
  source: string,
): MermaidBlock | null {
  let livePos: number;
  try {
    livePos = view.posAtDOM(root);
  } catch {
    // posAtDOM throws when the node isn't in the editor's DOM tree (e.g.,
    // the widget got detached during a viewport reflow). Treat as no-target.
    return null;
  }
  const blocks = findMermaidBlocks(view.state.doc);
  for (const b of blocks) {
    if (livePos >= b.from && livePos <= b.to && b.source === source) {
      return b;
    }
  }
  return null;
}

// ─── StateField: scan whole doc on docChange / editable / locale flip ──────
//
// We rebuild on THREE triggers:
//   1. `tr.docChanged` — the obvious case, source content changed.
//   2. `EditorView.editable` facet flipped between `tr.startState` and
//      `tr.state` — FileBodyView mounts PlaintextEditor with editMode=false
//      then flips to true via an effect; without rebuilding here, the
//      widget's editable-captured-at-construction value would be stale and
//      the toolbar Edit button would never appear (the widget's `eq()` does
//      compare `hostEditable`, but only re-running buildDecorations creates
//      a new widget instance for `eq()` to compare against in the first
//      place).
//   3. `mermaidLocaleFacet` flipped — the host (PlaintextEditor) reconfigures
//      this facet on `i18n.changeLanguage()` so toolbar labels and the
//      render-error banner prefix re-localize without remounting the editor.
export const markdownMermaidDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(
      state.doc,
      state.facet(EditorView.editable),
      state.facet(mermaidLocaleFacet),
    );
  },
  update(value, tr) {
    const prevEditable = tr.startState.facet(EditorView.editable);
    const nextEditable = tr.state.facet(EditorView.editable);
    const prevLocale = tr.startState.facet(mermaidLocaleFacet);
    const nextLocale = tr.state.facet(mermaidLocaleFacet);
    if (
      !tr.docChanged &&
      prevEditable === nextEditable &&
      prevLocale === nextLocale
    ) {
      return value;
    }
    return buildDecorations(tr.state.doc, nextEditable, nextLocale);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(
  doc: CodeMirrorText,
  editable: boolean,
  locale: string,
): DecorationSet {
  const blocks = findMermaidBlocks(doc);
  if (blocks.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const b of blocks) {
    builder.add(
      b.from,
      b.to,
      Decoration.replace({
        block: true,
        widget: new MermaidWidget(
          b.source,
          b.bodyFrom,
          b.bodyEnd,
          editable,
          locale,
        ),
      }),
    );
  }
  return builder.finish();
}
