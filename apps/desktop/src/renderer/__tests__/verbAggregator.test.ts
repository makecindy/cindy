/**
 * verbAggregator.test.ts
 * ---------------------------------------------------------------------------
 * Unit tests for cc-agent-compact-blocks M1 — verb mapping, aggregation,
 * truncation, and summary formatting.
 *
 * formatSummary 已 i18n 化(issue #450):测试用真实 en locale JSON 实现一个
 * 最小 t(带 _one/_other 复数解析),既验证组合逻辑(顺序 / 分隔符 / 截断),
 * 也顺带钉住 en 文案与旧版输出完全一致。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TFunction } from 'i18next';

import {
  verbForTool,
  verbLabelKeyForIntent,
  verbLabelKeyForRow,
  aggregateVerbs,
  formatSummary,
} from '@/lib/agent-actions/verbAggregator';
import type { ChatMessage } from '@/lib/makerChatStore';

const enLocale = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'i18n', 'locales', 'en', 'common.json'), 'utf8'),
) as Record<string, unknown>;

/** 最小 en t:嵌套 key 解析 + i18next 风格 _one/_other 复数 + {{count}} 插值。 */
const enT = ((key: string, opts?: { count?: number }) => {
  const lookup = (k: string): unknown =>
    k.split('.').reduce<unknown>(
      (node, seg) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined),
      enLocale,
    );
  let value: unknown;
  if (typeof opts?.count === 'number') {
    value = lookup(`${key}_${opts.count === 1 ? 'one' : 'other'}`) ?? lookup(key);
  } else {
    value = lookup(key);
  }
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{count\}\}/g, String(opts?.count ?? ''));
}) as TFunction;

function tc(toolName: string, i = 0): ChatMessage {
  return {
    clientId: `c${i}`,
    role: 'tool_use',
    content: '',
    toolName,
    toolInput: null,
  };
}

describe('verbForTool', () => {
  it('maps the canonical tools', () => {
    expect(verbForTool('Edit')).toBe('edited');
    expect(verbForTool('MultiEdit')).toBe('edited');
    expect(verbForTool('file_change')).toBe('edited');
    expect(verbForTool('Write')).toBe('created');
    expect(verbForTool('Bash')).toBe('ran');
    expect(verbForTool('exec')).toBe('ran');
    expect(verbForTool('Read')).toBe('read');
    expect(verbForTool('TodoWrite')).toBe('updated');
    expect(verbForTool('Glob')).toBe('searched');
    expect(verbForTool('Grep')).toBe('searched');
    expect(verbForTool('WebFetch')).toBe('fetched');
    expect(verbForTool('WebSearch')).toBe('fetched');
    expect(verbForTool('web_search')).toBe('fetched');
  });

  it('falls back to "used" for unknown tools', () => {
    expect(verbForTool('FooBar')).toBe('used');
    expect(verbForTool('')).toBe('used');
  });
});

describe('verbLabelKeyForRow', () => {
  it('returns per-verb i18n keys that resolve to the capitalized en form', () => {
    expect(enT(verbLabelKeyForRow('edited'))).toBe('Edited');
    expect(enT(verbLabelKeyForRow('ran'))).toBe('Ran');
    expect(enT(verbLabelKeyForRow('updated'))).toBe('Updated');
  });
});

describe('verbLabelKeyForIntent', () => {
  it('reuses existing verb keys for read/search/fetch and resolves new keys in en', () => {
    expect(verbLabelKeyForIntent('read')).toBe('chat.agentActionRow.verb.read');
    expect(verbLabelKeyForIntent('search')).toBe('chat.agentActionRow.verb.searched');
    expect(verbLabelKeyForIntent('fetch')).toBe('chat.agentActionRow.verb.fetched');
    expect(enT(verbLabelKeyForIntent('list'))).toBe('Listed');
    expect(enT(verbLabelKeyForIntent('inspect'))).toBe('Inspect content');
    expect(enT(verbLabelKeyForIntent('inspectRepository'))).toBe('Inspect repository');
    expect(enT(verbLabelKeyForIntent('verify'))).toBe('Run checks');
    expect(enT(verbLabelKeyForIntent('install'))).toBe('Installed deps');
    expect(enT(verbLabelKeyForIntent('test'))).toBe('Ran tests');
    expect(enT(verbLabelKeyForIntent('build'))).toBe('Built');
    expect(enT(verbLabelKeyForIntent('lint'))).toBe('Linted');
    expect(enT(verbLabelKeyForIntent('typecheck'))).toBe('Type-checked');
  });
});

describe('aggregateVerbs', () => {
  it('handles a single tool call', () => {
    const s = aggregateVerbs([tc('Edit')]);
    expect(s.totalCalls).toBe(1);
    expect(s.truncatedExtra).toBe(0);
    expect(s.verbs).toEqual([{ verb: 'edited', count: 1 }]);
  });

  it('counts multiple of the same verb', () => {
    const s = aggregateVerbs([tc('Edit', 0), tc('MultiEdit', 1), tc('Edit', 2)]);
    expect(s.verbs).toEqual([{ verb: 'edited', count: 3 }]);
  });

  it('orders by ORDER, not arrival order', () => {
    // Bash arrives before Edit, but ORDER puts edited (1st) before ran (2nd).
    const s = aggregateVerbs([tc('Bash', 0), tc('Edit', 1)]);
    expect(s.verbs.map((v) => v.verb)).toEqual(['edited', 'ran']);
  });

  it('truncates to top 5 verbs and reports the remainder', () => {
    const calls = [
      tc('Edit', 0),     // edited
      tc('Bash', 1),     // ran
      tc('Read', 2),     // read
      tc('TodoWrite', 3), // updated
      tc('Write', 4),    // created
      tc('Glob', 5),     // searched
      tc('WebFetch', 6), // fetched
      tc('CustomTool', 7), // used
    ];
    const s = aggregateVerbs(calls);
    expect(s.verbs.length).toBe(5);
    expect(s.truncatedExtra).toBe(3);
    expect(s.verbs.map((v) => v.verb)).toEqual([
      'edited',
      'ran',
      'read',
      'updated',
      'created',
    ]);
  });
});

describe('formatSummary', () => {
  it('formats a single Edit call', () => {
    const s = aggregateVerbs([tc('Edit')]);
    expect(formatSummary(s, enT)).toBe('Edited a file');
  });

  it('formats 3 Edit + 2 Bash + 1 Read in canonical order', () => {
    const calls = [
      tc('Edit', 0), tc('Edit', 1), tc('Edit', 2),
      tc('Bash', 3), tc('Bash', 4),
      tc('exec', 6),
      tc('Read', 5),
    ];
    const s = aggregateVerbs(calls);
    expect(formatSummary(s, enT)).toBe(
      'Edited 3 files, ran 3 commands and read a file',
    );
  });

  it('appends "N more" when truncated', () => {
    const calls = [
      tc('Edit', 0),
      tc('Bash', 1),
      tc('Read', 2),
      tc('TodoWrite', 3),
      tc('Write', 4),
      tc('Glob', 5),
      tc('WebFetch', 6),
      tc('CustomTool', 7),
    ];
    const s = aggregateVerbs(calls);
    expect(formatSummary(s, enT)).toBe(
      'Edited a file, ran a command, read a file, updated todos, created a file and 3 more',
    );
  });

  it('returns empty string for empty input', () => {
    const s = aggregateVerbs([]);
    expect(formatSummary(s, enT)).toBe('');
  });

  it('uses lowercase for non-leading verbs', () => {
    // Sanity: leading is capitalized, followups lowercase.
    const s = aggregateVerbs([tc('Edit', 0), tc('Bash', 1)]);
    expect(formatSummary(s, enT)).toBe('Edited a file and ran a command');
  });
});
