import { expect, it } from 'vitest';
import { extractTranscript } from '../VolcengineSaucAsrProvider';

it.each([
  [null, ''],
  ['root text is not a transcript field', ''],
  [{ text: '  ', transcript: '' }, ''],
  [{ TEXT: '  中文结果  ', unrelated: 'a much longer unrelated value' }, '中文结果'],
  [{ text: 'first', nested: [{ sentence: 'later' }] }, 'first'],
  [{ result: { utterances: [{ text: '短句' }, { ASR_TEXT: '完整识别结果' }] } }, '完整识别结果'],
  [{ text: 123, nested: { transcript: '有效文本' } }, '有效文本'],
])('preserves field matching, whitespace and tie behavior for %j', (payload, expected) => {
  expect(extractTranscript(payload)).toBe(expected);
});

// Frozen pre-optimization algorithm, used as a differential oracle over varied
// nested server JSON. Longest-field and tie semantics must not change.
function previousExtract(payload: unknown): string {
  const keys = new Set(['text', 'transcript', 'sentence', 'asr_text']);
  function collect(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(collect);
    const result: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key.toLowerCase()) && typeof child === 'string') result.push(child);
      result.push(...collect(child));
    }
    return result;
  }
  return (
    collect(payload)
      .map((value) => value.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? ''
  );
}

it('matches the previous implementation for 200 deterministic nested payloads', () => {
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  function payload(depth: number): unknown {
    if (depth === 0)
      return ['  中文  ', 'same', '', null, 0, ' another result ', '😀'][random() % 7];
    if (random() % 3 === 0) return Array.from({ length: random() % 5 }, () => payload(depth - 1));
    return Object.fromEntries(
      ['text', 'TRANSCRIPT', 'sentence', 'asr_text', 'other']
        .slice(0, random() % 6)
        .map((key) => [key, payload(random() % depth)]),
    );
  }
  for (let i = 0; i < 200; i++) {
    const value = payload(4);
    expect(extractTranscript(value)).toBe(previousExtract(value));
  }
});
