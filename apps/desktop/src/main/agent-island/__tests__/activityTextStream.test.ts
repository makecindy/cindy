import { describe, expect, it } from 'vitest';

import {
  AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH,
  appendActivityTextStream,
  createActivityTextStreamState,
  normalizeActivityText,
  type ActivityTextStreamMetrics,
} from '../activityTextStream.js';

function createMetrics(): ActivityTextStreamMetrics {
  return {
    classificationCodeUnits: 0,
    normalizationCodeUnits: 0,
    jsonSyntaxCodeUnits: 0,
    jsonParseCodeUnits: 0,
  };
}

function expectEveryStreamingStepToMatchLegacyNormalization(chunks: string[]): void {
  const stream = createActivityTextStreamState();
  let accumulated = '';

  for (const chunk of chunks) {
    accumulated += chunk;
    expect(appendActivityTextStream(stream, chunk)).toBe(legacyNormalizeActivityText(accumulated));
  }
}

function legacyNormalizeActivityText(text: string): string {
  return legacyExtractActivityDisplayText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH)
    .trim();
}

function legacyExtractActivityDisplayText(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return rawText;

  try {
    return legacyExtractTextFromStructuredContent(JSON.parse(trimmed) as unknown) ?? rawText;
  } catch {
    return rawText;
  }
}

function legacyExtractTextFromStructuredContent(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value
      .map(legacyExtractTextFromStructuredContent)
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'message', 'prompt']) {
    const text = record[key];
    if (typeof text === 'string' && text.trim()) return text.trim();
  }

  const content = record.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  return legacyExtractTextFromStructuredContent(content);
}

describe('Agent Island activity text stream', () => {
  // Regression: Island preferred raw activity over the already-readable companion preview.
  // Unit tier; exercise the production normalizer/stream with a minimal rich answer.
  const richAnswer = '```cindy-ui\n'
    + '{"version":1,"seq":1,"op":"create","id":"answer","kind":"text","props":{"text":"网络检查完成"}}\n'
    + '```';

  it('extracts component text before truncating final activity previews', () => {
    expect(normalizeActivityText(richAnswer)).toBe('网络检查完成');
    expect(normalizeActivityText(JSON.stringify({ content: richAnswer }))).toBe('网络检查完成');
    expect(normalizeActivityText(`检查结果\n${richAnswer}\n可以继续使用。`))
      .toBe('检查结果 网络检查完成 可以继续使用。');
  });

  it('keeps rich protocol out of streamed previews across delta boundaries', () => {
    const stream = createActivityTextStreamState();
    for (const chunk of ['```cindy-', 'ui\n', '{"version":1,',
      '"seq":1,"op":"create","id":"answer","kind":"text","props":{"text":"网络检查完成"}}\n', '```']) {
      expect(appendActivityTextStream(stream, chunk)).not.toMatch(/cindy-|version|seq|create|props/);
    }
    expect(appendActivityTextStream(stream, '')).toBe('网络检查完成');
  });

  it('preserves ordinary code and explicitly quoted rich protocol examples', () => {
    const example = `\`\`\`\`markdown\n${richAnswer}\n\`\`\`\``;
    expect(normalizeActivityText(example)).toBe(legacyNormalizeActivityText(example));
    const code = '```json\n{"status":"ok"}\n```';
    expect(normalizeActivityText(code)).toBe(legacyNormalizeActivityText(code));
  });

  // Review regressions: only unfinished rich opening fences may be hidden.
  // Ordinary closing fences and inline/quoted examples must survive every delta.
  it.each(['`', '~'])('preserves %s code fences and examples during streaming', (fenceCharacter) => {
    const fence = fenceCharacter.repeat(3);
    expectEveryStreamingStepToMatchLegacyNormalization([`${fence}json\n`, ...`{"status":"ok"}\n${fence}`]);
    const quoted = `${fenceCharacter.repeat(4)}markdown\n${fence}cindy-ui\n{}\n${fence}\n${fenceCharacter.repeat(4)}`;
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, quoted)).toBe(legacyNormalizeActivityText(quoted));
  });

  it('does not turn leading whitespace into a line break inside an inline example', () => {
    const inline = '\n示例 ```cindy-ui\n{}\n```';
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, inline)).toBe(normalizeActivityText(inline));
  });

  it('hides a truncated rich operation until the full final text is available', () => {
    const source = '```cindy-ui\n'
      + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'answer', kind: 'text',
        props: { style: { padding: 12 }, text: '检查完成。'.repeat(100) } }) + '\n```';
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, source)).toBe('');
    expect(normalizeActivityText(source)).toBe('检查完成。'.repeat(100).slice(0, AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH));
  });

  it('preserves the existing display text across whitespace, markdown, emoji, and the 280-code-unit boundary', () => {
    expectEveryStreamingStepToMatchLegacyNormalization([
      '\n  ',
      'I will **inspect**',
      '\t  the logs',
      '\r\n\r\n',
      'before editing. ',
      'x'.repeat(240),
      '\ud83d',
      '\ude00',
      ' invisible suffix',
    ]);
  });

  it('keeps showing partial JSON verbatim, then switches to its extracted text when it becomes valid', () => {
    expectEveryStreamingStepToMatchLegacyNormalization([
      '  {',
      '"content":[{"text":"first line\\nsecond line with } and ["},',
      '{"message":"quoted \\"value\\""}]',
      '}',
      '  ',
    ]);
  });

  it('falls back to the exact raw preview when completed structured text receives trailing content', () => {
    expectEveryStreamingStepToMatchLegacyNormalization([
      '{"text":"display text"}',
      '   ',
      'trailing content',
      ' and more',
    ]);
  });

  it('preserves raw fallback behavior for invalid or non-text structured values', () => {
    expectEveryStreamingStepToMatchLegacyNormalization(['{"text":', '123}']);
    expectEveryStreamingStepToMatchLegacyNormalization(['[{"unknown":true}', ',42]']);
    expectEveryStreamingStepToMatchLegacyNormalization(['{"text":"unfinished}', ' still a string']);
  });

  it('bounds ordinary streaming work after the visible prefix instead of rescanning cumulative text', () => {
    const stream = createActivityTextStreamState();
    const metrics = createMetrics();
    const chunk = 'abcdefghij';
    const chunkCount = 32_000;
    let legacyCumulativeScanCodeUnits = 0;

    for (let index = 1; index <= chunkCount; index += 1) {
      appendActivityTextStream(stream, chunk, metrics);
      legacyCumulativeScanCodeUnits += index * chunk.length;
    }

    const optimizedScanCodeUnits =
      metrics.classificationCodeUnits +
      metrics.normalizationCodeUnits +
      metrics.jsonSyntaxCodeUnits +
      metrics.jsonParseCodeUnits;
    expect(stream.rawPreview).toBe('abcdefghij'.repeat(28));
    expect(stream.rawChunks).toHaveLength(0);
    expect(optimizedScanCodeUnits).toBeLessThanOrEqual(AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH + 1);
    expect(legacyCumulativeScanCodeUnits).toBeGreaterThan(optimizedScanCodeUnits * 1_000_000);
  });

  it('scans a long structured stream linearly and parses it only once', () => {
    const stream = createActivityTextStreamState();
    const metrics = createMetrics();
    const payload = JSON.stringify({ content: `start ${'x'.repeat(100_000)} end` });
    const chunkSize = 10;

    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      appendActivityTextStream(stream, payload.slice(offset, offset + chunkSize), metrics);
    }

    const measuredWork =
      metrics.classificationCodeUnits +
      metrics.normalizationCodeUnits +
      metrics.jsonSyntaxCodeUnits +
      metrics.jsonParseCodeUnits;
    expect(stream.mode).toBe('structured-extracted');
    expect(stream.rawChunks).toHaveLength(0);
    expect(stream.structuredDisplayText).toBe(legacyNormalizeActivityText(payload));
    expect(metrics.jsonParseCodeUnits).toBe(payload.length);
    expect(measuredWork).toBeLessThanOrEqual(payload.length * 3 + 300);
  });

  it('compacts tiny deltas while an incomplete structured stream is retained', () => {
    const stream = createActivityTextStreamState();
    const prefix = '{"content":"';
    const deltaCount = 100_000;
    appendActivityTextStream(stream, prefix);

    for (let index = 0; index < deltaCount; index += 1) {
      appendActivityTextStream(stream, 'x');
    }

    const retainedText = `${prefix}${'x'.repeat(deltaCount)}`;
    expect(stream.mode).toBe('structured');
    expect(stream.rawChunks.join('')).toBe(retainedText);
    expect(stream.rawPreview).toBe(legacyNormalizeActivityText(retainedText));
    expect(stream.rawChunks.length).toBeLessThanOrEqual(
      Math.ceil(Math.log2(retainedText.length)) + 1,
    );
  });
});
