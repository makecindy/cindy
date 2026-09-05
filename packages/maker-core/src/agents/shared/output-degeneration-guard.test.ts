import { describe, expect, it } from 'vitest';

import { OutputDegenerationGuard } from './output-degeneration-guard.js';

function feedInUnevenDeltas(guard: OutputDegenerationGuard, text: string): ReturnType<OutputDegenerationGuard['onTextDelta']> {
  const sizes = [1, 7, 31, 3, 127, 19, 509];
  let offset = 0;
  let verdict: ReturnType<OutputDegenerationGuard['onTextDelta']> = { kind: 'ok' };
  for (let index = 0; offset < text.length; index += 1) {
    const next = Math.min(text.length, offset + sizes[index % sizes.length]!);
    verdict = guard.onTextDelta(text.slice(offset, next));
    offset = next;
    if (verdict.kind === 'hard') return verdict;
  }
  return verdict;
}

describe('OutputDegenerationGuard', () => {
  it('detects the Issue #2866 low-entropy loop across arbitrary delta boundaries', () => {
    const guard = new OutputDegenerationGuard();
    guard.resetMessage();

    const verdict = feedInUnevenDeltas(
      guard,
      'let me write the file now; 现在执行；落地。'.repeat(1_100),
    );

    expect(verdict).toMatchObject({
      kind: 'hard',
      reason: 'low-entropy-repetition',
    });
    if (verdict.kind === 'hard') {
      expect(verdict.observedCharacters).toBeGreaterThanOrEqual(16_384);
      expect(verdict.uniqueNgramRatio).toBeLessThanOrEqual(0.08);
      expect(verdict.halfSimilarity).toBeGreaterThanOrEqual(0.92);
    }
  });

  it('checks every crossed interval when one text delta is large', () => {
    const guard = new OutputDegenerationGuard();
    guard.resetMessage();

    expect(
      guard.onTextDelta('let me write the file now; 现在执行；落地。'.repeat(1_100)),
    ).toMatchObject({
      kind: 'hard',
      reason: 'low-entropy-repetition',
    });
  });

  it.each([
    [
      'long prose',
      Array.from(
        { length: 700 },
        (_, index) =>
          `Section ${index}: component-${index} accepts request-${index * 17}, validates invariant-${index % 29}, and returns result-${index * 31}.`,
      ).join('\n'),
    ],
    [
      'source code',
      Array.from(
        { length: 650 },
        (_, index) =>
          `export function transform${index}(value: number): number { return value * ${index + 3} + ${index * 11}; }`,
      ).join('\n'),
    ],
    [
      'structured logs',
      Array.from(
        { length: 900 },
        (_, index) =>
          `2026-08-20T10:${String(index % 60).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}Z request=req-${index.toString(36)} latency=${17 + index}ms checksum=${(index * 2654435761 >>> 0).toString(16)}`,
      ).join('\n'),
    ],
    [
      'json data',
      JSON.stringify(
        Array.from({ length: 1_000 }, (_, index) => ({
          id: `record-${index}`,
          score: index * 13,
          label: `category-${index % 47}`,
          digest: (index * 2246822519 >>> 0).toString(36),
        })),
      ),
    ],
    [
      'repeated-format list',
      Array.from(
        { length: 1_000 },
        (_, index) =>
          `- Item ${index}: source-${index.toString(36)} -> target-${(index * 97).toString(36)}; checksum=${(index * 3266489917 >>> 0).toString(16)}`,
      ).join('\n'),
    ],
    [
      'multilingual prose',
      Array.from(
        { length: 700 },
        (_, index) =>
          `第 ${index} 节记录组件 ${index % 53} 的结果 ${index * 19}；English sample ${index.toString(36)} explains branch ${index * 23}; 日本語項目 ${index * 29}；한국어 값 ${index * 31}.`,
      ).join('\n'),
    ],
  ])('does not treat %s as degeneration merely because it is long', (_name, text) => {
    expect(text.length).toBeGreaterThan(16_384);
    const guard = new OutputDegenerationGuard();
    guard.resetMessage();

    expect(feedInUnevenDeltas(guard, text)).toEqual({ kind: 'ok' });
  });

  it('requires repeated confirmations and resets evidence for each assistant message', () => {
    const guard = new OutputDegenerationGuard({
      minimumCharacters: 4_096,
      analysisWindowCharacters: 4_096,
      checkIntervalCharacters: 1_024,
      requiredConfirmations: 2,
    });
    const repeated = 'prepare then execute; '.repeat(400);

    guard.resetMessage();
    expect(guard.onTextDelta(repeated.slice(0, 4_096))).toEqual({ kind: 'ok' });

    guard.resetMessage();
    expect(guard.onTextDelta(repeated.slice(0, 4_096))).toEqual({ kind: 'ok' });
    expect(guard.onTextDelta(repeated.slice(4_096))).toMatchObject({ kind: 'hard' });
  });
});
