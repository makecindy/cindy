/**
 * Unit tests for DictationRewriter (explicit "selected text + voice rewrite" mode).
 * Verifies:
 * - Separate prompt & schemaName (`dictation_rewrite`) from default dictation refinement
 * - Allows legitimate >3x expansion/translation of selected text without tripping dictation divergence guard
 * - Rejects safely (preserving original selection) on empty instruction, missing selection, or model error
 * - Default DictationRefiner remains completely untouched
 *
 * Tier: unit (< 50ms, fake TextModelClient).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT,
  DEFAULT_DICTATION_REWRITER_SYSTEM_PROMPT,
  DictationRewriter,
  MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS,
  type TextModelClient,
} from '../index';

describe('DictationRewriter', () => {
  it('rewrites selected text using spoken instruction and allows expansion/translation beyond 3x', async () => {
    const calls: Array<Parameters<TextModelClient['requestJson']>[0]> = [];
    const client: TextModelClient = {
      async requestJson<T>(input: Parameters<TextModelClient['requestJson']>[0]): Promise<T> {
        calls.push(input);
        return {
          text: 'This is a detailed, polite English translation with expanded context that is intentionally much longer than the brief spoken command.',
        } as T;
      },
    };
    const rewriter = new DictationRewriter({
      client,
      model: 'auxiliary',
      contextProvider: () => ({
        selectedText: '明天下午三点开会',
        selectionBefore: '通知大家：',
        selectionAfter: '，请准时参加。',
        uiLanguage: 'zh-CN',
        userDictionary: 'Cindy',
      }),
    });

    const result = await rewriter.refine({
      text: '翻译成礼貌详细的英文',
      runId: 'run-1',
      segmentIds: ['seg-1'],
    });

    expect(result.accepted).toBe(true);
    expect(result.refinedText).toContain('detailed, polite English translation');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.schemaName).toBe('dictation_rewrite');
    expect(call?.system).toBe(DEFAULT_DICTATION_REWRITER_SYSTEM_PROMPT);
    expect(call?.system).not.toBe(DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT);
    expect(call?.user).toMatchObject({
      selectedText: '明天下午三点开会',
      instruction: '翻译成礼貌详细的英文',
    });
  });

  it('rejects without modifying text when selectedText is missing', async () => {
    const spy = vi.fn();
    const client: TextModelClient = {
      async requestJson<T>(input: Parameters<TextModelClient['requestJson']>[0]): Promise<T> {
        spy(input);
        return { text: '' } as T;
      },
    };
    const rewriter = new DictationRewriter({
      client,
      model: 'auxiliary',
      contextProvider: () => ({ selectedText: '   ' }),
    });

    const result = await rewriter.refine({
      text: '改成正式语气',
      runId: 'run-2',
      segmentIds: ['seg-2'],
    });

    expect(result).toMatchObject({ accepted: false, rejectionReason: 'missing_selected_text' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an oversized selection instead of replacing text the model never received', async () => {
    const requestJson = vi.fn();
    const rewriter = new DictationRewriter({
      client: { async requestJson<T>(input: Parameters<TextModelClient['requestJson']>[0]): Promise<T> {
        requestJson(input);
        return { text: 'incomplete rewrite' } as T;
      } },
      model: 'auxiliary',
      contextProvider: () => ({ selectedText: 'A'.repeat(MAX_VOICE_REWRITE_SELECTED_TEXT_CHARS + 1) }),
    });
    const result = await rewriter.refine({ text: '翻译', runId: 'run-long', segmentIds: ['seg'] });
    expect(result).toMatchObject({ accepted: false, rejectionReason: 'selection_too_long' });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('returns accepted: false on client failure so caller preserves original selected text', async () => {
    const client: TextModelClient = {
      async requestJson<T>(): Promise<T> {
        throw new Error('auxiliary model unavailable');
      },
    };
    const rewriter = new DictationRewriter({
      client,
      model: 'auxiliary',
      contextProvider: () => ({ selectedText: '原文内容' }),
    });

    const result = await rewriter.refine({
      text: '精简一下',
      runId: 'run-3',
      segmentIds: ['seg-3'],
    });

    expect(result).toMatchObject({ accepted: false, rejectionReason: 'auxiliary model unavailable' });
  });
});
