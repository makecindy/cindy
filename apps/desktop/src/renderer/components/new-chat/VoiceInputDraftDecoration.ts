import { Extension, type Editor } from '@tiptap/core';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { VoiceInputDraftSource } from '@cindy/voice-input-core';

import { MIC_WAVE_ICON_SVG } from '../../voice-input/VoiceInputMicWaveIcon';

/**
 * Voice caret rendered while the composer is read-only during dictation.
 * 'listening' shows a static mic with animated level bars inside the capsule;
 * 'processing' (submitting/refining) shows a spinner arc. Null hides the caret.
 */
export type VoiceInputCaretState = 'listening' | 'processing';

type VoiceInputDraftMeta = {
  text: string;
  source: VoiceInputDraftSource | null;
  from: number;
  to: number;
  anchorLocked: boolean;
  caretState: VoiceInputCaretState | null;
};

type VoiceInputDraftDecorationState = VoiceInputDraftMeta & {
  decorations: DecorationSet;
};

const PLUGIN_KEY = new PluginKey<VoiceInputDraftDecorationState>('voiceInputDraftDecoration');
const META_KEY = 'voiceInputDraftDecoration';

export type VoiceInputReplacementRange = {
  from: number;
  to: number;
};

export type VoiceInputReplacementRangeUpdate = {
  changed: boolean;
  range: VoiceInputReplacementRange | null;
};

function clampPosition(doc: PMNode, position: number): number {
  return Math.max(0, Math.min(position, doc.content.size));
}

/**
 * Snap a position onto the nearest place that can hold inline content.
 *
 * The draft/caret widgets are inline: rendered at a position whose parent is
 * NOT a textblock (0 or a boundary between blocks), ProseMirror puts them in
 * the doc-level DOM — an inline span between two `<p>`s, which the browser then
 * gives its own line. That reads as a stray blank line above the dictation
 * caret. Anchors reach such a position whenever the composer document is
 * rebuilt wholesale while dictation is live (external draft restore does a
 * `replace(0, size)`), because mapping a collapsed anchor across a full
 * replacement pushes it out to the block boundary.
 */
function clampToInlinePosition(doc: PMNode, position: number): number {
  const clamped = clampPosition(doc, position);
  const $pos = doc.resolve(clamped);
  if ($pos.parent.isTextblock) return clamped;
  return TextSelection.near($pos, 1).from;
}

function clampRange(doc: PMNode, from: number, to: number): { from: number; to: number } {
  const safeFrom = clampToInlinePosition(doc, Math.min(from, to));
  const safeTo = clampToInlinePosition(doc, Math.max(from, to));
  return safeFrom <= safeTo ? { from: safeFrom, to: safeTo } : { from: safeFrom, to: safeFrom };
}

/**
 * Resolve the replacement range that sibling decoration plugins should use
 * for this transaction. The voice plugin is registered after the list/CJK
 * plugins, so they cannot read its next state during their own `apply`; this
 * helper deliberately reads the shared transaction meta and maps the previous
 * range when only the document changed.
 */
export function resolveVoiceInputReplacementRange(
  tr: Transaction,
  oldState: EditorState,
): VoiceInputReplacementRangeUpdate {
  const meta = tr.getMeta(META_KEY) as VoiceInputDraftMeta | undefined;
  if (meta) {
    const range = clampRange(tr.doc, meta.from, meta.to);
    return {
      changed: true,
      range: meta.text && range.to > range.from ? range : null,
    };
  }
  const old = PLUGIN_KEY.getState(oldState);
  if (!old?.text || old.to <= old.from) {
    return { changed: false, range: null };
  }
  const range = tr.docChanged
    ? clampRange(tr.doc, tr.mapping.map(old.from, -1), tr.mapping.map(old.to, 1))
    : clampRange(tr.doc, old.from, old.to);
  return {
    changed: false,
    range: range.to > range.from ? range : null,
  };
}

// Lucide `Loader2` arc. The arc rotates around the viewBox centre via CSS
// (`voice-caret-spin` on [data-voice-spinner-arc]) — NOT the whole <svg>.
// Rotating the inline svg element makes its swept bounding box bleed into the
// adjacent wrapped text lines, which Chromium then repaints every frame
// (visible as text jitter on multi-line drafts during refine). Spinning only
// the inner path keeps the svg's paint box fixed — the same containment the
// listening level-bars rely on. Static markup only — never interpolate user
// content into these strings.
const PROCESSING_CARET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path data-voice-spinner-arc d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;

function createCaretElement(caretState: VoiceInputCaretState): HTMLSpanElement {
  const caret = document.createElement('span');
  caret.dataset.voiceCaret = 'true';
  caret.dataset.voiceCaretState = caretState;
  if (caretState === 'listening') {
    caret.dataset.voiceMicActive = 'true';
  }
  caret.innerHTML = caretState === 'listening' ? MIC_WAVE_ICON_SVG : PROCESSING_CARET_SVG;
  return caret;
}

function createDecorations(
  doc: PMNode,
  text: string,
  source: VoiceInputDraftSource | null,
  from: number,
  to: number,
  caretState: VoiceInputCaretState | null,
): DecorationSet {
  if (!text && !caretState) return DecorationSet.empty;
  const range = clampRange(doc, from, to);
  const decorations: Decoration[] = [];
  if (text && range.to > range.from) {
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: 'voice-input-draft-replaced',
        'data-voice-draft-replaced': 'true',
      }),
    );
  }
  if (text) {
    // Content-independent key: ASR partials and refinement preview stream
    // text updates several times per second, and recreating the widget DOM
    // each time repaints/relayouts every wrapped line of the draft (visible
    // as flicker on multi-line drafts). With a stable key ProseMirror keeps
    // the node and the plugin view below syncs textContent in place, so the
    // browser only repaints the glyphs that actually changed.
    decorations.push(
      Decoration.widget(
        range.from,
        () => {
          const node = document.createElement('span');
          node.dataset.voiceDraftInline = 'true';
          if (source) node.dataset.voiceDraftSource = source;
          node.append(document.createTextNode(text));
          return node;
        },
        {
          key: `voice-input-draft:${range.from}:${range.to}`,
          side: 1,
        },
      ),
    );
  }
  if (caretState) {
    // Separate widget so the caret's lifecycle is independent from the draft
    // text (it must exist before the first partial arrives, and its CSS
    // animation must never restart on draft updates). side: 2 keeps it
    // rendered after the draft text at the same position, i.e. exactly where
    // the next text will land.
    decorations.push(
      Decoration.widget(
        range.from,
        () => createCaretElement(caretState),
        {
          key: `voice-input-caret:${caretState}:${range.from}`,
          side: 2,
        },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

function createState(
  doc: PMNode,
  text: string,
  source: VoiceInputDraftSource | null,
  from: number,
  to: number,
  anchorLocked: boolean,
  caretState: VoiceInputCaretState | null,
): VoiceInputDraftDecorationState {
  const range = clampRange(doc, from, to);
  return {
    text,
    source,
    from: range.from,
    to: range.to,
    anchorLocked,
    caretState,
    decorations: createDecorations(doc, text, source, range.from, range.to, caretState),
  };
}

export type VoiceInputDraftRange = {
  from: number;
  to: number;
};

export function setVoiceInputDraftDecoration(
  editor: Editor | null,
  text: string,
  source: VoiceInputDraftSource | null,
  range?: VoiceInputDraftRange | null,
  caretState: VoiceInputCaretState | null = null,
): void {
  if (!editor || editor.isDestroyed) return;
  const from = range?.from ?? editor.state.selection.from;
  const to = range?.to ?? editor.state.selection.to;
  const anchorLocked = Boolean(range);
  const current = PLUGIN_KEY.getState(editor.state);
  if (
    current?.text === text &&
    current.source === source &&
    current.from === from &&
    current.to === to &&
    current.anchorLocked === anchorLocked &&
    current.caretState === caretState
  ) return;
  editor.view.dispatch(
    editor.state.tr.setMeta(META_KEY, {
      text,
      source,
      from,
      to,
      anchorLocked,
      caretState,
    } satisfies VoiceInputDraftMeta),
  );
}

/**
 * Exported for direct instantiation in tests: the anti-flicker contract
 * (stable widget keys + in-place text sync) lives entirely in this plugin and
 * is testable at the ProseMirror state layer without mounting an editor.
 */
export function createVoiceInputDraftPlugin(): Plugin<VoiceInputDraftDecorationState> {
  return new Plugin<VoiceInputDraftDecorationState>({
    key: PLUGIN_KEY,
    state: {
      init(_config, state: EditorState) {
        return createState(state.doc, '', null, state.selection.from, state.selection.to, false, null);
      },
      apply(tr: Transaction, old: VoiceInputDraftDecorationState) {
        const meta = tr.getMeta(META_KEY) as VoiceInputDraftMeta | undefined;
        if (meta) {
          return createState(
            tr.doc,
            meta.text,
            meta.source,
            meta.from,
            meta.to,
            meta.anchorLocked,
            meta.caretState,
          );
        }
        if (!old.text && !old.caretState) return old;
        if (tr.selectionSet) {
          if (!old.anchorLocked) {
            return createState(
              tr.doc,
              old.text,
              old.source,
              tr.selection.from,
              tr.selection.to,
              false,
              old.caretState,
            );
          }
        }
        if (tr.docChanged) {
          // A collapsed anchor must stay collapsed: mapping it with opposite
          // biases grows it into a range, and a non-empty range makes the
          // `voice-input-draft-replaced` decoration hide whatever text now sits
          // inside it (a full-document rebuild would blank the existing draft).
          const collapsed = old.from === old.to;
          const mappedFrom = tr.mapping.map(old.from, collapsed ? 1 : -1);
          const mappedTo = collapsed ? mappedFrom : tr.mapping.map(old.to, 1);
          return createState(
            tr.doc,
            old.text,
            old.source,
            mappedFrom,
            mappedTo,
            old.anchorLocked,
            old.caretState,
          );
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
    // The draft widget's key is content-independent (see createDecorations),
    // so ProseMirror reuses its DOM across text updates. This view syncs the
    // streamed text/source into the live node in place — the cheap path the
    // stable key relies on.
    //
    // Ordering note: this relies on EditorView.updateState running plugin-view
    // updates after docView.update within the same synchronous task, so no
    // paint can show the stale text in between. Verified against
    // prosemirror-view 1.x dist source (updatePluginViews is called right
    // after the DOM sync in updateStateInner); this ordering is not part of
    // the documented API, so re-check it when bumping prosemirror-view. Even
    // if it ever changed, a full redraw rebuilds widgets from the current
    // decoration closures (fresh text) and this sync degrades to a no-op.
    view() {
      return {
        update(view) {
          const pluginState = PLUGIN_KEY.getState(view.state);
          if (!pluginState?.text) return;
          const node = view.dom.querySelector<HTMLElement>('[data-voice-draft-inline="true"]');
          if (!node) return;
          if (node.textContent !== pluginState.text) {
            node.textContent = pluginState.text;
          }
          if ((node.dataset.voiceDraftSource ?? null) !== pluginState.source) {
            if (pluginState.source) {
              node.dataset.voiceDraftSource = pluginState.source;
            } else {
              delete node.dataset.voiceDraftSource;
            }
          }
        },
      };
    },
  });
}

export const VoiceInputDraftDecoration = Extension.create({
  name: 'voiceInputDraftDecoration',

  addProseMirrorPlugins() {
    return [createVoiceInputDraftPlugin()];
  },
});
