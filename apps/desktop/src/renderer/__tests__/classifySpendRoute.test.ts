/**
 * classifySpendRoute 的**运行期真值表** —— 与 todaySpendChip.test.ts 的源码契约断言互补。
 *
 * 为什么单独一个文件:todaySpendChip.test.ts 刻意只做源码字符串断言(组件依赖 Electron
 * 全局与 renderer hooks),而这个分类器是纯函数,值得真跑一遍。
 *
 * 它是两套语义的合成:①「目录元数据权威」(sourceAccess.product / category·group 优先);
 * ②「显式选定的供应商是硬门」+「cc 与 pi 共用桥接口径」。每个输出位各自服从负责该关注
 * 点的那一侧,任一位都不该出现「两套语义都没有」的答案。
 */

import { describe, expect, it } from 'vitest';

import { classifySpendRoute } from '../components/status/TodaySpendChip';

const CHATGPT = 'chatgpt/gpt-5.5';
const XAI = 'xai/grok-4.3';
const BUDGET = 'codex/gpt-5.5';
const SUB = (product: string) => ({ sourceAccess: { kind: 'subscription' as const, product } });

describe('classifySpendRoute —— 元数据缺失时逐项回落原前缀判定', () => {
  it('cc/pi 的 chatgpt/ 与 xai/ 前缀按前缀认桥接', () => {
    for (const vendor of ['cc', 'pi'] as const) {
      expect(classifySpendRoute(vendor, CHATGPT, undefined, null).chatgptBridge).toBe(true);
      expect(classifySpendRoute(vendor, XAI, undefined, null).xaiBridge).toBe(true);
    }
  });

  it('codex 不认 cc/pi 的桥接前缀;codex 的 xai/ 走 codexXai', () => {
    expect(classifySpendRoute('codex', CHATGPT, undefined, null).chatgptBridge).toBe(false);
    expect(classifySpendRoute('codex', XAI, undefined, null).codexXai).toBe(true);
  });

  it('codex/ 前缀在无元数据时判为折扣版', () => {
    expect(classifySpendRoute('codex', BUDGET, undefined, null).codexBudget).toBe(true);
    expect(classifySpendRoute('codex', 'gpt-5.5', undefined, null).codexBudget).toBe(false);
  });

  it('sourceAccess 为 api / managed 时不进订阅分支,仍按前缀', () => {
    for (const kind of ['api', 'managed'] as const) {
      const md = { sourceAccess: { kind } } as Parameters<typeof classifySpendRoute>[2];
      expect(classifySpendRoute('cc', CHATGPT, md, null).chatgptBridge).toBe(true);
      expect(classifySpendRoute('cc', 'gpt-5.5', md, null).chatgptBridge).toBe(false);
    }
  });
});

describe('classifySpendRoute —— 目录元数据权威', () => {
  it('订阅产品判定桥接,裸 id 也认(不依赖前缀)', () => {
    expect(classifySpendRoute('cc', 'gpt-5.5', SUB('ChatGPT'), null).chatgptBridge).toBe(true);
    expect(classifySpendRoute('cc', 'grok-4.3', SUB('SuperGrok'), null).xaiBridge).toBe(true);
  });

  it('pi 与 cc 共用桥接口径(upstream 把 pi 提为一等 agent)', () => {
    expect(classifySpendRoute('pi', 'gpt-5.5', SUB('ChatGPT'), null).chatgptBridge).toBe(true);
    expect(classifySpendRoute('pi', 'grok-4.3', SUB('SuperGrok'), null).xaiBridge).toBe(true);
  });

  it('订阅产品与桥接不匹配(如 Claude.ai)时两个桥接都为假', () => {
    const r = classifySpendRoute('cc', CHATGPT, SUB('Claude.ai'), null);
    expect(r.chatgptBridge).toBe(false);
    expect(r.xaiBridge).toBe(false);
  });

  it('category/group 判折扣版优先于前缀,且 category 优先于 group', () => {
    expect(classifySpendRoute('codex', 'plain-id', { group: 'gpt-budget' }, null).codexBudget).toBe(true);
    expect(classifySpendRoute('codex', BUDGET, { group: 'gpt' }, null).codexBudget).toBe(false);
    expect(
      classifySpendRoute('codex', 'plain-id', { category: 'gpt-budget', group: 'gpt' }, null).codexBudget,
    ).toBe(true);
  });

  it('group=grok 判 codexXai;已登记但非 grok 则明确为假', () => {
    expect(classifySpendRoute('codex', 'plain-id', { group: 'grok' }, null).codexXai).toBe(true);
    expect(classifySpendRoute('codex', XAI, { group: 'gpt' }, null).codexXai).toBe(false);
  });
});

describe('classifySpendRoute —— 显式选定的供应商是硬门', () => {
  it('无关的显式 provider 关掉桥接,元数据也不能翻案', () => {
    for (const pid of ['anthropic', 'xd', 'custom-x'] as const) {
      expect(classifySpendRoute('cc', CHATGPT, SUB('ChatGPT'), pid).chatgptBridge).toBe(false);
      expect(classifySpendRoute('cc', XAI, SUB('SuperGrok'), pid).xaiBridge).toBe(false);
    }
  });

  it('匹配的显式 provider 放行', () => {
    expect(classifySpendRoute('cc', CHATGPT, SUB('ChatGPT'), 'openai').chatgptBridge).toBe(true);
    expect(classifySpendRoute('cc', XAI, SUB('SuperGrok'), 'xai').xaiBridge).toBe(true);
    expect(classifySpendRoute('codex', XAI, undefined, 'xai').codexXai).toBe(true);
  });

  it('codexBudget 本身不受 provider 影响(网关门在组件侧另加)', () => {
    for (const pid of [null, 'openai', 'xd', 'xai'] as const) {
      expect(classifySpendRoute('codex', BUDGET, undefined, pid).codexBudget).toBe(true);
    }
  });
});
