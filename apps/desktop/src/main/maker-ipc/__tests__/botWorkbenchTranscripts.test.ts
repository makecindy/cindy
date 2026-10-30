/**
 * 测试价值
 * - 生产入口与可观察结果:boundTranscript / lastExchange 的摘录与任务摘要。
 * - 规则依据:内部协调不是用户要求;最新助手回复保留重点,由工具层按预算截短。
 * - 现有覆盖缺口:内部回报覆盖了用户要求;多行回复只保留最后一行而丢失结论。
 * - 最小失败输入:用户要求之后出现隐藏协调输入;助手先说结论再说下一步。
 * - tier:unit(纯函数,数据库模块 mock 掉,不加载)。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => { throw new Error('not used'); } }));

import { boundTranscript, lastExchange } from '../botWorkbenchTranscripts.js';

describe('boundTranscript', () => {
  it('strips instruction blocks, drops empty messages and keeps the most recent within the budget', () => {
    const items = [
      { role: 'user' as const, text: 'old '.repeat(400), at: 1 },
      { role: 'assistant' as const, text: '<system-reminder>internal</system-reminder>', at: 2 },
      { role: 'user' as const, text: '把图标导出来', at: 3 },
      { role: 'assistant' as const, text: '导好了 mdpi,还差 xxhdpi', at: 4 },
    ];
    const bounded = boundTranscript(items, 200);
    expect(bounded.items.map((item) => item.at)).toEqual([1, 3, 4]);
    expect(bounded.items[0].text.startsWith('…')).toBe(true);
    expect(bounded.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(200);
    expect(bounded.truncated).toBe(true);
    expect(boundTranscript(items.slice(2)).truncated).toBe(false);
  });
});

describe('lastExchange', () => {
  it('keeps the latest user ask and the full latest non-empty assistant reply', () => {
    expect(lastExchange([
      { role: 'user', text: '先修登录' },
      { role: 'assistant', text: '好的' },
      { role: 'user', text: '<system-reminder>internal</system-reminder>再跑一遍测试' },
      { role: 'assistant', text: '跑完了。\n还有 2 个失败' },
      { role: 'user', text: '[UI_ACTION_TRIGGER]后台回报：正在修复失败项' },
      { role: 'assistant', text: '<system-reminder>only a hint</system-reminder>' },
    ])).toEqual({ lastUserAsk: '再跑一遍测试', lastAssistantLine: '跑完了。\n还有 2 个失败' });
    expect(lastExchange([])).toEqual({ lastUserAsk: null, lastAssistantLine: null });
    expect(lastExchange([{ role: 'user', text: '[UI_ACTION_TRIGGER]仅内部协调' }]))
      .toEqual({ lastUserAsk: null, lastAssistantLine: null });
  });
});
