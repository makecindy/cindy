import { describe, expect, it, vi } from 'vitest';
import * as previewText from '../../../shared/markdownPreviewText.js';

import {
  AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH,
  appendActivityTextStream,
  createActivityTextStreamState,
  normalizeActivityText,
  normalizeRemoteActivityText,
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

  // Screenshot regression: completed local Markdown and flattened remote rich
  // previews both reached the native Text label verbatim (unit tier).
  it('projects Markdown before shortening the final reply', () => {
    const source = '分两部分：**更新已完成**；见[改动](https://example.com/' + 'x'.repeat(300) + ')。';
    expect(normalizeActivityText(source)).toBe('分两部分：更新已完成；见改动。');
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, '分两部分：**已完成**')).toBe('分两部分：已完成');
    expect(normalizeActivityText('`foo_bar **literal**`')).toBe('foo_bar **literal**');
  });

  // #7566: source-only limits froze a link destination before its closing
  // delimiter and discarded the visible result. Unit, including tiny deltas.
  it.each(['[文档](', '![图示](', '[文档](<'])('budgets visible text after a long streamed destination (%s)', opening => {
    const parse = vi.spyOn(previewText, 'streamingMarkdownPreviewText');
    const stream = createActivityTextStreamState();
    const label = opening.startsWith('!') ? '图示' : '文档';
    try {
      expect(appendActivityTextStream(stream, opening)).toBe(label);
      const calls = parse.mock.calls.length;
      for (const delta of ['https://example.com/', ...'x'.repeat(1_000)]) {
        expect(appendActivityTextStream(stream, delta)).toBe(label);
      }
      expect(parse.mock.calls.length).toBe(calls);
      expect(appendActivityTextStream(stream, '(nested)')).toBe(label);
      expect(appendActivityTextStream(stream, (opening.endsWith('<') ? '>)' : ')') + ' 测试已通过'))
        .toBe(label + ' 测试已通过');
    } finally {
      parse.mockRestore();
    }
  });

  it('hides irrecoverable rich protocol from old remote summaries', () => {
    const collapsed = richAnswer.replace(/\s+/g, ' ');
    expect(normalizeRemoteActivityText(collapsed)).toBe('');
    expect(normalizeRemoteActivityText(collapsed.slice(0, 80) + '...')).toBe('');
    expect(normalizeRemoteActivityText('已完成\n' + collapsed)).toBe('已完成');
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
    expect(normalizeActivityText(example)).toBe(richAnswer.replace(/\s+/g, ' '));
    const code = '```json\n{"status":"ok"}\n```';
    expect(normalizeActivityText(code)).toBe('{"status":"ok"}');
    // A destination-shaped string inside code is literal, even when it has no `)`.
    for (const quoted of ['`[文档](https://example.com/unfinished`', '```text\n[文档](https://example.com/unfinished\n```']) {
      const stream = createActivityTextStreamState();
      expect(appendActivityTextStream(stream, quoted)).toBe('[文档](https://example.com/unfinished');
    }
  });

  // #7566 review: transport recovery must not strip a valid local code example.
  it('preserves a flattened component example inside an outer code fence', () => {
    const example = '```cindy-ui {"version":1}';
    expect(normalizeActivityText('````markdown\n' + example + '\n````\n继续说明'))
      .toBe(example + ' 继续说明');
    expect(normalizeRemoteActivityText('````markdown\n' + example + '\n````\n继续说明'))
      .toBe(example + ' 继续说明');
  });

  // #7566 review, unit: extracted code/Markdown is display content, not a
  // second protocol document. Existing quoted-fence cases had no outer rich node.
  it.each(['code', 'markdown'] as const)('does not execute a rich %s example during projection', kind => {
    const example = JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'inner',
      kind: 'text', props: { text: '不应执行' } });
    const source = '```cindy-ui\n' + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'example', kind,
      props: { language: 'cindy-ui', text: kind === 'code' ? example : '```cindy-ui\n' + example + '\n```' } }) + '\n```';
    for (const input of [source, JSON.stringify({ content: source })]) {
      expect(normalizeActivityText(input)).toBe(example);
      expect(normalizeRemoteActivityText(input)).toBe(example);
      const stream = createActivityTextStreamState();
      expect(appendActivityTextStream(stream, input)).toBe(example);
    }
  });

  // Deterministic work assertion plus visible result; no wall-clock timing.
  it.each(['', '{"content":"'])('does not parse an unchanged formatted streaming prefix again (%s)', prefix => {
    const parse = vi.spyOn(previewText, 'streamingMarkdownPreviewText');
    try {
      const stream = createActivityTextStreamState();
      const visible = appendActivityTextStream(stream, prefix + '**完成** ' + 'x'.repeat(280));
      expect(visible).toContain('完成');
      expect(visible).not.toContain('**');
      const calls = parse.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      for (let i = 0; i < 128; i++) {
        expect(appendActivityTextStream(stream, ' more output')).toBe(visible);
      }
      expect(parse.mock.calls.length).toBe(calls);
    } finally {
      parse.mockRestore();
    }
  });

  // #7566 review, unit: definitions/comments keep display text short while source
  // grows. The stream must bound parsing work, and final text must still recover.
  it.each([
    { opening: '# 摘要\n[id]: https://example.com/', closing: '\n\n正文' },
    { opening: '摘要\n<!--', closing: '-->\n正文' },
  ])('bounds invisible Markdown source (%j)', ({ opening, closing }) => {
    const parse = vi.spyOn(previewText, 'streamingMarkdownPreviewText');
    const stream = createActivityTextStreamState();
    const delta = 'x'.repeat(64);
    try {
      expect(appendActivityTextStream(stream, opening)).toBe('摘要');
      for (let i = 0; i < 128; i++) appendActivityTextStream(stream, delta);
      const calls = parse.mock.calls.length;
      for (let i = 0; i < 128; i++) expect(appendActivityTextStream(stream, delta)).toBe('摘要');
      expect(parse.mock.calls.length).toBe(calls);
      expect(normalizeActivityText(opening + delta.repeat(256) + closing)).toBe('摘要 正文');
    } finally {
      parse.mockRestore();
    }
  });

  // Review regression: closing ordinary code fences must not retract their
  // content; explicitly quoted component examples remain literal code.
  it.each(['`', '~'])('preserves %s code content and examples during streaming', (fenceCharacter) => {
    const fence = fenceCharacter.repeat(3);
    const codeStream = createActivityTextStreamState();
    appendActivityTextStream(codeStream, `${fence}json\n`);
    appendActivityTextStream(codeStream, '{"status":"ok"}\n');
    for (const character of fence) {
      expect(appendActivityTextStream(codeStream, character)).toContain('{"status":"ok"}');
    }
    expect(appendActivityTextStream(codeStream, '')).toBe('{"status":"ok"}');
    const quoted = `${fenceCharacter.repeat(4)}markdown\n${fence}cindy-ui\n{}\n${fence}\n${fenceCharacter.repeat(4)}`;
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, quoted)).toBe(`${fence}cindy-ui {} ${fence}`);
  });

  it('does not turn leading whitespace into a line break inside an inline example', () => {
    const inline = '\n示例 ```cindy-ui\n{}\n```';
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, inline)).toBe(normalizeActivityText(inline));
  });

  it('hides an incomplete rich operation and projects it once the rest arrives', () => {
    const source = '```cindy-ui\n'
      + JSON.stringify({ version: 1, seq: 1, op: 'create', id: 'answer', kind: 'text',
        props: { style: { padding: 12 }, text: '检查完成。'.repeat(100) } }) + '\n```';
    const stream = createActivityTextStreamState();
    expect(appendActivityTextStream(stream, source.slice(0, 400))).toBe('');
    const expected = '检查完成。'.repeat(100).slice(0, AGENT_ISLAND_ACTIVITY_TEXT_MAX_LENGTH);
    expect(appendActivityTextStream(stream, source.slice(400))).toBe(expected);
    expect(normalizeActivityText(source)).toBe(expected);
  });

  it('preserves plain text across whitespace, emoji, and the 280-code-unit boundary', () => {
    expectEveryStreamingStepToMatchLegacyNormalization([
      '\n  ',
      'I will inspect',
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
    expect(stream.displayText).toBe(legacyNormalizeActivityText(payload));
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
