import { describe, expect, it } from 'vitest';

import {
  asrRecognitionHintsFingerprint,
  buildAsrRecognitionHints,
  buildElevenLabsScribeKeyterms,
  buildOpenAiTranscriptionPrompt,
  buildQwenAsrCorpusText,
  buildVolcengineSaucCorpusContext,
} from '../asrHints.js';

describe('asrHints', () => {
  it('prioritizes manual entries over automatic entries, deduplicates case-insensitively, and reverses oldest-first history', () => {
    const hints = buildAsrRecognitionHints({
      dictionaryEntries: [
        { text: 'auto-low', source: 'automatic', frequency: 2, updatedAt: 10 },
        { text: 'PostgreSQL', source: 'manual', frequency: 1, updatedAt: 5 },
        { text: 'auto-high', source: 'automatic', frequency: 9, updatedAt: 20 },
        { text: 'postgresql', source: 'automatic', frequency: 99, updatedAt: 99 },
        { text: '  LiteLLM\n ', source: 'manual', frequency: 4, updatedAt: 30 },
        { text: '   ', source: 'manual' },
      ],
      recentHistory: ['较早的一句听写', '最新的一句听写'],
    });

    expect(hints.hotwords).toEqual(['LiteLLM', 'PostgreSQL', 'auto-high', 'auto-low']);
    expect(hints.recentContext).toEqual(['最新的一句听写', '较早的一句听写']);
  });

  it('returns undefined / empty outputs when there are no hints so provider payloads stay unchanged', () => {
    const empty = buildAsrRecognitionHints({});
    expect(buildVolcengineSaucCorpusContext(empty)).toBeUndefined();
    expect(buildQwenAsrCorpusText(empty)).toBeUndefined();
    expect(buildOpenAiTranscriptionPrompt(empty)).toBeUndefined();
    expect(buildElevenLabsScribeKeyterms(empty)).toEqual([]);
    expect(asrRecognitionHintsFingerprint(empty)).toBe('');
  });

  it('formats Volcengine SAUC corpus.context JSON with hotwords and dialog_ctx within budgets', () => {
    const hints = buildAsrRecognitionHints({
      dictionaryEntries: [
        { text: 'Cindy', source: 'manual' },
        { text: 'Volcengine', source: 'manual' },
      ],
      recentHistory: ['第一条历史', '刚才提到了 Volcengine 配置'],
    });

    const raw = buildVolcengineSaucCorpusContext(hints);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual({
      hotwords: [{ word: 'Cindy' }, { word: 'Volcengine' }],
      context_type: 'dialog_ctx',
      context_data: [
        { text: '刚才提到了 Volcengine 配置' },
        { text: '第一条历史' },
      ],
    });
  });

  it('enforces strict character and count caps for Qwen, OpenAI, and ElevenLabs keyterms', () => {
    const manyEntries = Array.from({ length: 120 }, (_, i) => ({
      text: `CustomTerm_${String(i).padStart(3, '0')}`,
      source: 'manual' as const,
      frequency: 120 - i,
    }));
    const longHistory = Array.from({ length: 10 }, (_, i) => `历史记录第${i}条 ${'内容'.repeat(80)}`);
    const hints = buildAsrRecognitionHints({
      dictionaryEntries: [
        ...manyEntries,
        { text: 'x'.repeat(65), source: 'manual' }, // >50 chars excluded
      ],
      recentHistory: longHistory,
    });

    const qwen = buildQwenAsrCorpusText(hints)!;
    expect(qwen.length).toBeLessThanOrEqual(800);
    expect(qwen).toContain('CustomTerm_000');

    const openai = buildOpenAiTranscriptionPrompt(hints)!;
    expect(openai.length).toBeLessThanOrEqual(600);
    expect(openai).toContain('CustomTerm_000');

    const keyterms = buildElevenLabsScribeKeyterms(hints);
    expect(keyterms.length).toBeLessThanOrEqual(50);
    expect(keyterms.reduce((sum, term) => sum + term.length, 0)).toBeLessThanOrEqual(800);
    expect(keyterms.every((term) => term.length <= 50)).toBe(true);
    expect(keyterms[0]).toBe('CustomTerm_000');
  });
});
