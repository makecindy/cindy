import { describe, expect, it, vi } from 'vitest';

import type { MemoryEvent, MemoryRecord } from '@cindy/maker-core';

// one-shot 路由链在 vitest 无 electron 环境加载不了 (titleOneShot.test.ts 同因);
// 本测试只覆盖 prompt 构造与响应解析, one-shot 执行由 mock 替身挡掉。
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: vi.fn(async () => ({ ok: false, reason: 'no_candidate', attempts: [] })),
}));

import {
  buildMemoryHubAiPrompt,
  parseMemoryHubAiResponse,
} from '../memory-hub-ai-analysis.js';

function makeRecord(overrides: Partial<MemoryRecord['frontmatter']> = {}): MemoryRecord {
  return {
    filename: 'user_role.md',
    slug: 'user_role',
    frontmatter: {
      title: 'User role',
      description: 'works on observability',
      type: 'user',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    },
    body: 'body',
    sizeBytes: 100,
  } satisfies MemoryRecord;
}

describe('buildMemoryHubAiPrompt', () => {
  it('includes entry summaries and events', () => {
    const entries = [makeRecord()];
    const events: MemoryEvent[] = [
      {
        id: 1,
        ts: '2026-09-01T00:00:00.000Z',
        op: 'create',
        actor: 'user',
        filename: 'user_role.md',
        type: 'user',
        title: 'User role',
        description: 'works on observability',
      },
    ];
    const prompt = buildMemoryHubAiPrompt(entries, events);
    expect(prompt).toContain('User role');
    expect(prompt).toContain('create');
  });

  it('handles empty store', () => {
    const prompt = buildMemoryHubAiPrompt([], []);
    expect(prompt).toContain('(empty)');
    expect(prompt).toContain('(none)');
  });
});

describe('parseMemoryHubAiResponse', () => {
  it('parses plain JSON', () => {
    const raw = JSON.stringify({
      text: 'The user is an engineer.',
      gaps: ['prefers concise answers'],
      recommendations: [
        {
          kind: 'deprecate',
          filename: 'old_note.md',
          title: 'Old note',
          reason: 'no longer relevant',
          suggestedAction: 'deprecate',
        },
      ],
    });
    const parsed = parseMemoryHubAiResponse(raw, '2026-09-02T00:00:00.000Z');
    expect(parsed.text).toContain('engineer');
    expect(parsed.text).toContain('Gaps:');
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0].suggestedAction).toBe('deprecate');
    expect(parsed.source).toBe('manual');
  });

  it('parses fenced JSON and drops invalid recommendations', () => {
    const raw = [
      '```json',
      JSON.stringify({
        text: 'Summary',
        recommendations: [{ kind: 'bogus', filename: 'x.md' }, { filename: 'y.md' }, 'junk'],
      }),
      '```',
    ].join('\n');
    const parsed = parseMemoryHubAiResponse(raw, '2026-09-02T00:00:00.000Z');
    expect(parsed.text).toContain('Summary');
    expect(parsed.recommendations).toHaveLength(0);
  });

  it('throws when text is missing', () => {
    expect(() => parseMemoryHubAiResponse('{"gaps":[]}', '2026-09-02T00:00:00.000Z')).toThrow();
  });
});
