import { describe, expect, it } from 'vitest';

import {
  buildEnhancedDocument,
  canApplyEnhanceResult,
  canUndoEnhanceResult,
  documentFingerprint,
  documentHasStructuredNodes,
  draftExceedsEnhanceInputLimit,
  editorIsComposing,
  resolveEnhanceErrorKind,
  type EnhanceLiveState,
  type EnhanceRequestOrigin,
  type EnhanceUndoRecord,
} from '../composerEnhanceDraft';
import { COMPOSER_ENHANCE_MAX_INPUT_CHARS } from '../../../shared/composerPromptEnhance';

const plainDoc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'add a search box' }] },
  ],
};

const editorInstance = { name: 'editor' };
const otherEditor = { name: 'other-editor' };

function liveState(overrides: Partial<EnhanceLiveState> = {}): EnhanceLiveState {
  return {
    editor: editorInstance,
    draftKey: 'draft-1',
    fingerprint: documentFingerprint(plainDoc),
    disabled: false,
    mounted: true,
    destroyed: false,
    composing: false,
    ...overrides,
  };
}

function origin(overrides: Partial<EnhanceRequestOrigin> = {}): EnhanceRequestOrigin {
  return {
    editor: editorInstance,
    draftKey: 'draft-1',
    fingerprint: documentFingerprint(plainDoc),
    ...overrides,
  };
}

describe('documentHasStructuredNodes', () => {
  it('accepts a draft that a plain-text rewrite can reproduce', () => {
    expect(documentHasStructuredNodes(plainDoc)).toBe(false);
  });

  it('rejects a draft carrying a mention chip, so enhancement cannot drop it', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'look at ' },
            { type: 'mentionChip', attrs: { kind: 'path', label: 'src', path: '/src' } },
          ],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('rejects a draft carrying a pasted-text chip', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'pastedTextChip', attrs: { text: 'long log' } }],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('rejects a draft carrying a list, whose numbering and nesting a plain text cannot restore', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'step one' }] }],
            },
          ],
        },
      ],
    };
    expect(documentHasStructuredNodes(doc)).toBe(true);
  });

  it('accepts a plain draft that only uses hard breaks', () => {
    const hardBreakDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'first line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }],
        },
      ],
    };
    expect(documentHasStructuredNodes(hardBreakDoc)).toBe(false);
  });

  it('treats a missing document as plain', () => {
    expect(documentHasStructuredNodes(undefined)).toBe(false);
  });
});

describe('documentFingerprint', () => {
  it('tells two documents that differ by one character apart', () => {
    const edited = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'add a search box!' }] },
      ],
    };
    expect(documentFingerprint(edited)).not.toBe(documentFingerprint(plainDoc));
  });

  it('tells two drafts with the same words but a different structure apart', () => {
    const sameWordsExtraBreak = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'add a search box' }] },
        { type: 'paragraph' },
      ],
    };
    expect(documentFingerprint(sameWordsExtraBreak)).not.toBe(documentFingerprint(plainDoc));
  });
});

describe('editorIsComposing', () => {
  it('reports an open IME composition', () => {
    expect(editorIsComposing({ view: { composing: true } })).toBe(true);
  });

  it('reports no composition otherwise', () => {
    expect(editorIsComposing({ view: { composing: false } })).toBe(false);
    expect(editorIsComposing({ view: null })).toBe(false);
  });
});

describe('canApplyEnhanceResult', () => {
  it('applies the answer when the composer still shows the same draft', () => {
    expect(canApplyEnhanceResult(origin(), liveState())).toBe(true);
  });

  it('drops the answer when the user edited the draft in the meantime', () => {
    const edited = liveState({ fingerprint: documentFingerprint({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'add a search box!' }] }],
    }) });
    expect(canApplyEnhanceResult(origin(), edited)).toBe(false);
  });

  it('drops the answer when the composer switched to another draft', () => {
    expect(canApplyEnhanceResult(origin(), liveState({ draftKey: 'draft-2' }))).toBe(false);
  });

  it('drops the answer when the composer moved to another editor instance', () => {
    expect(canApplyEnhanceResult(origin(), liveState({ editor: otherEditor }))).toBe(false);
  });

  it('drops the answer while an IME composition is in progress', () => {
    expect(canApplyEnhanceResult(origin(), liveState({ composing: true }))).toBe(false);
  });

  it('drops the answer when the composer is locked', () => {
    expect(canApplyEnhanceResult(origin(), liveState({ disabled: true }))).toBe(false);
  });

  it('drops the answer when the component was unmounted or the editor torn down', () => {
    expect(canApplyEnhanceResult(origin(), liveState({ mounted: false }))).toBe(false);
    expect(canApplyEnhanceResult(origin(), liveState({ destroyed: true }))).toBe(false);
  });
});

describe('canUndoEnhanceResult', () => {
  const record: EnhanceUndoRecord = {
    editor: editorInstance,
    draftKey: 'draft-1',
    original: plainDoc as never,
    applied: documentFingerprint(plainDoc),
  };

  it('allows the undo while the rewrite result is still in the editor', () => {
    expect(canUndoEnhanceResult(record, liveState())).toBe(true);
  });

  it('allows the undo even when the rewrite produced a list', () => {
    // The rewrite's own document may be structured; undo restores a full
    // document, so the structured-node rule must not block it.
    const listDoc = {
      type: 'doc',
      content: [{ type: 'orderedList', content: [] }],
    };
    const recordWithList: EnhanceUndoRecord = {
      ...record,
      applied: documentFingerprint(listDoc),
    };
    expect(canUndoEnhanceResult(recordWithList, liveState({ fingerprint: documentFingerprint(listDoc) }))).toBe(true);
  });

  it('blocks the undo once the user changed the content', () => {
    expect(canUndoEnhanceResult(record, liveState({ fingerprint: 'changed' }))).toBe(false);
  });

  it('blocks the undo when the composer switched to another draft', () => {
    expect(canUndoEnhanceResult(record, liveState({ draftKey: 'draft-2' }))).toBe(false);
  });

  it('blocks the undo while a request is running or the composer is locked', () => {
    expect(canUndoEnhanceResult(record, liveState(), { busy: true })).toBe(false);
    expect(canUndoEnhanceResult(record, liveState({ disabled: true }))).toBe(false);
  });

  it('blocks the undo while an IME composition is in progress', () => {
    expect(canUndoEnhanceResult(record, liveState({ composing: true }))).toBe(false);
  });

  it('has nothing to undo without a record', () => {
    expect(canUndoEnhanceResult(null, liveState())).toBe(false);
  });
});

describe('buildEnhancedDocument', () => {
  it('fills the rewrite back as plain text, not parsed markup', () => {
    const doc = buildEnhancedDocument('add <div class="x">a search box</div>');
    const text = JSON.stringify(doc);
    // The markup stays text: setContent(string) would have parsed it as HTML.
    expect(text).toContain('<div class=\\"x\\">');
    expect(doc.type).toBe('doc');
  });

  it('keeps the rewritten text in the document', () => {
    const doc = buildEnhancedDocument('add a search box to the page');
    expect(JSON.stringify(doc)).toContain('add a search box to the page');
  });
});

describe('draftExceedsEnhanceInputLimit', () => {
  it('accepts a draft inside the main-side budget', () => {
    expect(draftExceedsEnhanceInputLimit('a'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS))).toBe(false);
  });

  it('refuses a draft over the budget, the case main rejects with INVALID_PARAMS', () => {
    expect(draftExceedsEnhanceInputLimit('a'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS + 1))).toBe(true);
  });

  it('measures the trimmed draft, the same text main receives', () => {
    const atLimit = 'a'.repeat(COMPOSER_ENHANCE_MAX_INPUT_CHARS);
    expect(draftExceedsEnhanceInputLimit(`   ${atLimit}   `)).toBe(false);
    expect(draftExceedsEnhanceInputLimit(`   ${atLimit}a   `)).toBe(true);
  });

  it('uses the shared main-side limit rather than a second copy of it', () => {
    // A drifted copy of the budget would let the button stay enabled for a
    // draft main refuses.
    expect(draftExceedsEnhanceInputLimit('a'.repeat(10), 10)).toBe(false);
    expect(draftExceedsEnhanceInputLimit('a'.repeat(11), 10)).toBe(true);
    expect(COMPOSER_ENHANCE_MAX_INPUT_CHARS).toBe(1500);
  });
});

describe('resolveEnhanceErrorKind', () => {
  // The renderer receives the failure as the "[CODE] message" string the main
  // process encodes, so the tests use that shape.
  it('treats a missing auxiliary model as a configuration problem', () => {
    expect(resolveEnhanceErrorKind(
      new Error('[AUXILIARY_MODEL_UNAVAILABLE] No auxiliary model is available'),
    )).toBe('missing-config');
  });

  it('treats an execution failure as the operation failing, not as a missing setting', () => {
    // The upstream refused the call, or the completeness check rejected the
    // rewrite. Neither is fixed by configuring a model, and the generic
    // ipcError wording carries retry advice that no reason here supports.
    expect(resolveEnhanceErrorKind(
      new Error('[PRECONDITION_FAILED] Prompt enhancement timed out'),
    )).toBe('failed');
    expect(resolveEnhanceErrorKind(
      new Error('[INTERNAL] The enhancement model returned an empty prompt'),
    )).toBe('failed');
    expect(resolveEnhanceErrorKind(
      new Error('[INVALID_PARAMS] Prompt text is too long to enhance'),
    )).toBe('failed');
  });

  it('treats an error without an IPC code as a plain failure', () => {
    expect(resolveEnhanceErrorKind(new Error('boom'))).toBe('failed');
    expect(resolveEnhanceErrorKind(undefined)).toBe('failed');
  });
});
