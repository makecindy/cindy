import { describe, expect, it } from 'vitest';

import {
  DictationDictionaryAdvisor,
  getDictationDictionaryAdviceSkipReason,
  type DictationDictionaryAdviceInput,
} from '../DictationDictionaryAdvisor.js';
import type { TextModelClient } from '../DictationRefiner.js';

class FakeClient implements TextModelClient {
  public captured: unknown = null;

  constructor(private readonly response: unknown) {}

  async requestJson<T>(input: {
    model: string;
    system: string;
    user: unknown;
    schemaName: string;
    promptCacheScope?: string;
  }): Promise<T> {
    this.captured = input;
    return this.response as T;
  }
}

function makeAdvisor(response: unknown): { advisor: DictationDictionaryAdvisor; client: FakeClient } {
  const client = new FakeClient(response);
  return {
    client,
    advisor: new DictationDictionaryAdvisor({
      client,
      model: 'test-model',
      promptCacheScope: 'test',
      debug: true,
    }),
  };
}

describe('DictationDictionaryAdvisor', () => {
  it('keeps full phrase learning actions from the model', async () => {
    const { advisor, client } = makeAdvisor({
      actions: [
        {
          action: 'add_entry',
          term: 'Vibe Coding',
          aliases: ['web coding'],
          type: 'technical_term',
          confidence: 'high',
          reason: '完整短语纠错',
        },
      ],
    });

    const result = await advisor.advise({
      source: 'external_overlay',
      beforeText: '继续试一下 web coding，TapTap Maker。',
      afterText: '继续试一下 Vibe Coding，TapTap Maker。',
      existingCandidates: [
        {
          term: 'Vibe Coding',
          evidenceCount: 2,
          aliases: [{ text: 'web coding', count: 2 }],
        },
      ],
    });

    expect(result.actions).toEqual([
      {
        action: 'add_entry',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'high',
        reason: '完整短语纠错',
      },
    ]);
    expect(client.captured).toMatchObject({
      schemaName: 'dictation_dictionary_learning',
      model: 'test-model',
      user: {
        promptVersion: 'dictation-dictionary-learning.zh.v8-phonetic',
      },
    });
  });

  it('allows aliases grounded in the raw pre-refine transcript', async () => {
    const { advisor, client } = makeAdvisor({
      actions: [
        {
          action: 'add_candidate',
          term: 'Vibe Coding',
          aliases: ['web coding'],
          type: 'technical_term',
          confidence: 'medium',
          reason: '用户把 refine 后文本改成稳定术语，原始 ASR 包含误识别 alias',
        },
      ],
    });

    const result = await advisor.advise({
      rawTranscriptText: '继续试一下 web coding。',
      beforeText: '继续试一下外部 coding。',
      afterText: '继续试一下 Vibe Coding。',
    });

    expect(result.actions).toEqual([
      {
        action: 'add_candidate',
        term: 'Vibe Coding',
        aliases: ['web coding'],
        type: 'technical_term',
        confidence: 'medium',
        reason: '用户把 refine 后文本改成稳定术语，原始 ASR 包含误识别 alias',
      },
    ]);
    expect(client.captured).toMatchObject({
      user: {
        rawTranscriptText: '继续试一下 web coding。',
        beforeText: '继续试一下外部 coding。',
        afterText: '继续试一下 Vibe Coding。',
      },
    });
  });

  it('filters term and alias evidence independently', async () => {
    const { advisor } = makeAdvisor({
      actions: [
        {
          action: 'add_entry',
          term: 'Made Up Term',
          aliases: ['web coding'],
          type: 'technical_term',
          confidence: 'high',
        },
        {
          action: 'add_entry',
          term: 'Vibe Coding',
          aliases: ['not in before'],
          type: 'technical_term',
          confidence: 'high',
        },
        {
          action: 'add_entry',
          term: 'Vibe Coding',
          aliases: ['web coding'],
          type: 'technical_term',
          confidence: 'low',
        },
      ],
    });

    const result = await advisor.advise({
      beforeText: '继续试一下 web coding。',
      afterText: '继续试一下 Vibe Coding。',
    });

    expect(result.actions).toEqual([expect.objectContaining({ term: 'Vibe Coding', aliases: [] })]);
  });

  it.each([[], undefined])('keeps a learned name without an alias (%j)', async (aliases) => {
    const { advisor } = makeAdvisor({ actions: [
      { action: 'add_entry', term: 'Slack', aliases, type: 'product_name', confidence: 'high' },
    ] });
    const result = await advisor.advise({ beforeText: '检查一下机器人。', afterText: '检查一下 Slack 机器人。' });
    expect(result.actions).toEqual([expect.objectContaining({ term: 'Slack', aliases: [] })]);
  });

  it('ignores malformed model strings without losing other valid vocabulary', async () => {
    const { advisor } = makeAdvisor({ actions: [
      { action: 'add_entry', term: 123, confidence: 'high' },
      { action: 'add_entry', term: 'Slack', aliases: [null, {}, 123, 'Slate'], confidence: 'high' },
    ] });
    const result = await advisor.advise({ beforeText: '检查 Slate 机器人。', afterText: '检查 Slack 机器人。' });
    expect(result.actions).toEqual([expect.objectContaining({ term: 'Slack', aliases: ['Slate'] })]);
  });

  it('keeps model ignore reason for empty debug decisions', async () => {
    const { advisor } = makeAdvisor({
      actions: [],
      ignoreReason: '普通改写，不是稳定术语纠错',
    });

    const result = await advisor.advise({
      beforeText: '帮我继续看看这个日志。',
      afterText: '继续检查一下这个日志。',
    });

    expect(result.actions).toEqual([]);
    expect(result.ignoreReason).toBe('普通改写，不是稳定术语纠错');
  });

  it('returns no actions when text did not change', async () => {
    const { advisor, client } = makeAdvisor({
      actions: [
        {
          action: 'add_entry',
          term: 'Codex',
          aliases: ['扣德克斯'],
          type: 'product_name',
          confidence: 'high',
        },
      ],
    });

    const input: DictationDictionaryAdviceInput = {
      beforeText: 'Codex',
      afterText: 'Codex',
    };
    const result = await advisor.advise(input);

    expect(result.actions).toEqual([]);
    expect(result.ignoreReason).toBe('same_text');
    expect(client.captured).toBeNull();
  });

  it('skips punctuation-only edits before calling the model', async () => {
    const { advisor, client } = makeAdvisor({
      actions: [
        {
          action: 'add_entry',
          term: 'Codex',
          aliases: ['扣德克斯'],
          type: 'product_name',
          confidence: 'high',
        },
      ],
    });

    const input: DictationDictionaryAdviceInput = {
      beforeText: '我们测试一下 Codex',
      afterText: '我们测试一下 Codex。',
    };

    expect(getDictationDictionaryAdviceSkipReason(input)).toBe('formatting_only');
    const result = await advisor.advise(input);

    expect(result.actions).toEqual([]);
    expect(result.ignoreReason).toBe('formatting_only');
    expect(client.captured).toBeNull();
  });

  it('skips broad rewrites before calling the model', async () => {
    const { advisor, client } = makeAdvisor({
      actions: [
        {
          action: 'add_entry',
          term: 'Vibe Coding',
          aliases: ['web coding'],
          type: 'technical_term',
          confidence: 'high',
        },
      ],
    });

    const input: DictationDictionaryAdviceInput = {
      beforeText: '我们刚才说的这个语音输入方案整体看起来应该可以，但是还需要继续观察一下具体效果。',
      afterText: '我重新整理了一版完全不同的表达：这个方案先暂停，等明天评估完上下文和成本以后再决定。',
    };

    expect(getDictationDictionaryAdviceSkipReason(input)).toBe('large_rewrite');
    const result = await advisor.advise(input);

    expect(result.actions).toEqual([]);
    expect(result.ignoreReason).toBe('large_rewrite');
    expect(client.captured).toBeNull();
  });

  it('does not skip term spacing corrections', async () => {
    const input: DictationDictionaryAdviceInput = {
      beforeText: '我们继续测试 Chat GPT。',
      afterText: '我们继续测试 ChatGPT。',
    };

    expect(getDictationDictionaryAdviceSkipReason(input)).toBeNull();
  });
});
