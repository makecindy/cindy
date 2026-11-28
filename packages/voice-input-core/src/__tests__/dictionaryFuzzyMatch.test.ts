import { describe, expect, it } from 'vitest';

import {
  buildFuzzyUserDictionaryMatches,
  DictationRefiner,
  type TextModelClient,
} from '../index.js';

type CapturedRequest = Parameters<TextModelClient['requestJson']>[0];

// 测试价值：验证零重依赖词典模糊召回（中文同音/近音、英文连写/分词、有界拼写编辑距离）及误召回防护，并确认通过 DictationRefiner 端到端注入。
// 依据：语音输入优化 ⑧ 要求不引入重型三方拼音库，覆盖同音误识/英文空格拆分/轻微拼错，同时防止短词误召回与保持 prompt cache 前缀契约。
// 缺口：既有 DictationRefiner.test.ts 仅覆盖精确别名字符串包含匹配，未覆盖无别名词条、拼音同音/近音、复合词去分隔符及 Damerau-Levenshtein 边界。
// 最小输入：典型中英专有名词词表 + 同音/近音/空格拆分/单字错拼转写片段与易混淆短词反例。
// tier: unit，纯内存执行，无外部依赖。
describe('dictionaryFuzzyMatch', () => {
  it('recalls Chinese exact homophones and near-homophones without requiring manual aliases', () => {
    const matches = buildFuzzyUserDictionaryMatches(
      '今天和皇一孟聊了星动网洛还有飞书多维表哥的排期',
      undefined,
      '黄一孟\n心动网络\n飞书多维表格',
    );

    expect(matches).toBeDefined();
    expect(matches).toContain('黄一孟');
    expect(matches).toContain('心动网络');
    expect(matches).toContain('飞书多维表格');
  });

  it('guards 2-character Chinese terms against loose near-homophone false collisions', () => {
    // Neither syllable matches exact pinyin ("星通" xing+tong vs "心动" xin+dong).
    const matches = buildFuzzyUserDictionaryMatches(
      '我们看下星通的数据',
      undefined,
      '心动',
    );

    expect(matches).toBeUndefined();
  });

  it('still recalls 2-character Chinese terms on exact tone-insensitive pinyin match', () => {
    const matches = buildFuzzyUserDictionaryMatches(
      '先连上新洞看看',
      undefined,
      '心动',
    );

    expect(matches).toContain('心动');
  });

  it('normalizes spaces and punctuation for Latin and mixed compound terms', () => {
    const matches = buildFuzzyUserDictionaryMatches(
      '请把 lite llm 和 next js 升级到最新版本，再测一下 claudecode',
      undefined,
      'LiteLLM\nNext.js\nClaude Code',
    );

    expect(matches).toBeDefined();
    expect(matches).toContain('LiteLLM');
    expect(matches).toContain('Next.js');
    expect(matches).toContain('Claude Code');
  });

  it('matches bounded Damerau-Levenshtein typos while blocking short-word false positives', () => {
    const hitMatches = buildFuzzyUserDictionaryMatches(
      '把 Kubernets 集群和 Antigrvity 配置同步一下，还有 Claud',
      undefined,
      'Kubernetes\nAntigravity\nClaude',
    );

    expect(hitMatches).toContain('Kubernetes');
    expect(hitMatches).toContain('Antigravity');
    expect(hitMatches).toContain('Claude');

    // Short-word guard: 5-char Latin words like "codes" / "stack" must not falsely
    // match unrelated 5-char terms "Codex" / "Slack".
    const falsePositiveCheck = buildFuzzyUserDictionaryMatches(
      'check the codes and stack trace first',
      undefined,
      'Codex\nSlack',
    );
    expect(falsePositiveCheck).toBeUndefined();
  });

  it('integrates fuzzy recall and precedingRefinedText through DictationRefiner while keeping strict schema keys', async () => {
    const capturedRequests: CapturedRequest[] = [];
    const client: TextModelClient = {
      async requestJson<T>(input: CapturedRequest): Promise<T> {
        capturedRequests.push(input);
        return { text: '好的，我们联系黄一孟和 LiteLLM 团队。' } as T;
      },
    };
    const refiner = new DictationRefiner({
      client,
      model: 'auto',
      contextProvider: () => ({
        uiLanguage: 'zh-CN',
        sourceLanguage: 'zh-CN',
        userDictionary: '黄一孟\nLiteLLM',
        selectionBefore: '会议记录：',
      }),
    });

    const result = await refiner.refine({
      text: '好的我们联系皇一孟和 lite llm 团队',
      precedingRefinedText: '先同步下上周结论。',
      runId: 'run-fuzzy',
      segmentIds: ['seg-1'],
    });

    expect(result.accepted).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    const userPayload = capturedRequests[0].user as {
      context?: Record<string, unknown>;
      dictationText: string;
      userDictionaryMatches?: string;
    };
    expect(userPayload.userDictionaryMatches).toContain('黄一孟');
    expect(userPayload.userDictionaryMatches).toContain('LiteLLM');
    expect(userPayload.context?.selectionBefore).toBe('会议记录：先同步下上周结论。');
    // Strict schema invariant: precedingRefinedText must never leak as an unknown top-level or context field.
    expect(Object.keys(userPayload)).toEqual([
      'promptVersion',
      'context',
      'dictationText',
      'userDictionaryMatches',
    ]);
    expect('precedingRefinedText' in (userPayload.context ?? {})).toBe(false);
  });
});
