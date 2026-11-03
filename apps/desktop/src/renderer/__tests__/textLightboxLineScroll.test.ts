/**
 * textLightboxLineScroll.test.ts
 * ---------------------------------------------------------------------------
 * Behaviour coverage for the `path:line` jump (markdown target rendering). When a chat file reference like `foo.ts:42` is opened,
 * TextLightbox scrolls the preview to that line.
 *
 * Markdown scroll touches layout (getBoundingClientRect / scrollTop), which
 * jsdom does not compute — a full-render layout assertion would be flaky.
 * So the non-trivial decision is extracted into a pure helper on TextLightbox
 * and exercised here directly:
 *   - pickSourceLineAnchor: which `[data-source-line]` block to jump to.
 *
 * text/code 的 `path:line` 由 PlaintextEditor.scrollToLine 承担。
 *
 * Lives in its own file (not textLightbox.test.ts) so the line-scroll feature's
 * tests stay scoped to this MR and don't entangle with that file's existing
 * source-string contract checks.
 */

import { describe, it, expect } from 'vitest';
import { pickSourceLineAnchor } from '../components/chat/TextLightbox';

describe('TextLightbox — pickSourceLineAnchor (markdown jump target)', () => {
  const entries = [
    { el: 'h1', line: 1 },
    { el: 'p3', line: 3 },
    { el: 'code10', line: 10 },
    { el: 'p20', line: 20 },
  ];

  it('picks the block whose source line is the largest still <= target', () => {
    // target 12 sits between the line-10 block and the line-20 block → the
    // line-10 block is the one that contains line 12.
    expect(pickSourceLineAnchor(entries, 12)?.el).toBe('code10');
  });

  it('picks the exact block when target lands on a marker line', () => {
    expect(pickSourceLineAnchor(entries, 3)?.el).toBe('p3');
    expect(pickSourceLineAnchor(entries, 20)?.el).toBe('p20');
  });

  it('returns null when target is above the first marker (caller falls back)', () => {
    expect(pickSourceLineAnchor(entries, 0)).toBeNull();
  });

  it('clamps to the last block when target is past the final marker', () => {
    expect(pickSourceLineAnchor(entries, 9999)?.el).toBe('p20');
  });

  it('ignores entries with a non-finite line (bad data-source-line attr)', () => {
    const dirty = [
      { el: 'good', line: 5 },
      { el: 'nan', line: Number.NaN },
    ];
    expect(pickSourceLineAnchor(dirty, 100)?.el).toBe('good');
  });

  it('returns null for an empty marker set', () => {
    expect(pickSourceLineAnchor([], 5)).toBeNull();
  });
});
