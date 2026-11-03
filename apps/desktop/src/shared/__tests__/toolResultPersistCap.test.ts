import { describe, expect, it } from 'vitest';
import { extractToolResultDiagnostics } from '@cindy/maker-shared/tool-result-compaction';

import {
  TOOL_RESULT_PERSIST_CONTENT_LIMIT,
  TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX,
  capImportedToolResultContent,
  capToolResultTextForPersist,
} from '../toolResultPersistCap';

describe('capToolResultTextForPersist', () => {
  it('returns short text unchanged', () => {
    expect(capToolResultTextForPersist('hello')).toBe('hello');
    const exact = 'x'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capToolResultTextForPersist(exact)).toBe(exact);
  });

  it('caps oversized text to the limit with a truncation suffix', () => {
    const big = 'a'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT + 1);
    const capped = capToolResultTextForPersist(big);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
    expect(capped.startsWith('aaa')).toBe(true);
  });

  // CU-008: flags can appear after the discarded body; inspect the original structured result.
  it('retains only bounded diagnostic fields before truncation', () => {
    const text = JSON.stringify({ body: 'x'.repeat(9000), ok: false, errorCode: 'STALE_SNAPSHOT', message: 'PRIVATE' });
    const capped = capToolResultTextForPersist(text);
    expect(capped.length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capped).not.toContain('PRIVATE');
    expect(extractToolResultDiagnostics(capped)).toEqual({ ok: false, errorCode: 'STALE_SNAPSHOT' });
    expect(capToolResultTextForPersist(capped)).toBe(capped);
    expect(extractToolResultDiagnostics(capToolResultTextForPersist(text, 100))).toBeUndefined();
  });

  it('is idempotent', () => {
    const big = 'b'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 3);
    const once = capToolResultTextForPersist(big);
    expect(capToolResultTextForPersist(once)).toBe(once);
  });

  it('does not split a surrogate pair at the cut point', () => {
    const budget = TOOL_RESULT_PERSIST_CONTENT_LIMIT - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length;
    const text = `${'x'.repeat(budget - 1)}😀${'y'.repeat(2 * TOOL_RESULT_PERSIST_CONTENT_LIMIT)}`;
    const capped = capToolResultTextForPersist(text);
    const kept = capped.slice(0, capped.length - TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX.length);
    const lastCode = kept.charCodeAt(kept.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(kept).toBe('x'.repeat(budget - 1));
  });

  it('respects a custom limit', () => {
    const capped = capToolResultTextForPersist('c'.repeat(300), 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped.endsWith(TOOL_RESULT_PERSIST_TRUNCATION_SUFFIX)).toBe(true);
  });

  // Long HTML draft read-backs used to lose their trailing card ID at 8KB.
  // Check the actual persistence entry point, including phone byte budgets.
  it('preserves card references as valid bounded JSON when the body is oversized', () => {
    const input = JSON.stringify({ ok: true, result: { bodyHtml: '你好\\"😀'.repeat(4000) },
      xdt_card_id: 'draft-card', xdt_anchor_card_id: 'original-card',
      afterSnapshot: { ok: false, errorCode: 'ACT_INVALID_REQUEST', message: 'PRIVATE' } });
    const stored = capToolResultTextForPersist(input);
    expect(JSON.parse(stored)).toMatchObject({ ok: true, xdt_card_id: 'draft-card', xdt_anchor_card_id: 'original-card' });
    expect(stored).not.toContain('PRIVATE');
    expect(extractToolResultDiagnostics(stored)).toEqual({ ok: true, afterSnapshotOk: false, afterSnapshotErrorCode: 'ACT_INVALID_REQUEST' });
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(8192);
    expect(capToolResultTextForPersist(stored)).toBe(stored);
  });
});

describe('capImportedToolResultContent', () => {
  it('caps string tool_result and leaves other roles alone', () => {
    const huge = 'z'.repeat(TOOL_RESULT_PERSIST_CONTENT_LIMIT * 2);
    const capped = capImportedToolResultContent('tool_result', huge);
    expect(typeof capped).toBe('string');
    expect((capped as string).length).toBeLessThanOrEqual(TOOL_RESULT_PERSIST_CONTENT_LIMIT);
    expect(capImportedToolResultContent('assistant', huge)).toBe(huge);
    expect(capImportedToolResultContent('tool_result', { text: huge })).toEqual({ text: huge });
  });
});
