/**
 * classification 单点语义的行为锁。
 *
 * categorize / groupOf / groupModelsForDisplay 三组用例**原文移植**自
 * apps/desktop/src/renderer/__tests__/sourceSwitch.test.ts —— P1 期间 renderer 原实现暂留,
 * 两份实现由同一套用例锁定等价;P2 renderer 改 re-export 后原测试继续跑这份下沉实现。
 */

import { describe, expect, it } from 'vitest';

import {
  CHATGPT_MODEL_PREFIX,
  SUBSCRIPTION_DIRECT_MODEL_PREFIXES,
  XAI_MODEL_PREFIX,
  categorize,
  formatContextWindow,
  groupModelsForDisplay,
  groupOf,
  isBudgetModel,
  isSubscriptionDirectModel,
  modelBadges,
} from '../classification.js';

// ── 原文移植: sourceSwitch.test.ts 的 categorize / groupOf / groupModelsForDisplay ──

describe('categorize', () => {
  it('按 id 前缀归类', () => {
    expect(categorize('claude-opus-4-8')).toBe('anthropic');
    expect(categorize('gpt-5.4')).toBe('gpt');
    expect(categorize('codex/gpt-5.4')).toBe('gpt-budget');
    expect(categorize('gemini-3-pro')).toBe('google');
    expect(categorize('moonshotai/kimi-k2')).toBe('china');
  });

  it('非对话类型先于厂商前缀判定(网关杂项模型按类型归组,不误入 gpt/google)', () => {
    expect(categorize('gpt-image-2')).toBe('image');
    expect(categorize('gemini-3-pro-image')).toBe('image');
    expect(categorize('gpt-4o-transcribe')).toBe('audio');
    expect(categorize('elevenlabs/scribe_v2')).toBe('audio');
    expect(categorize('gemini-omni-flash-preview')).toBe('audio');
    expect(categorize('voyage/voyage-context-4')).toBe('embedding');
    expect(categorize('doubao-seedance-2-0-260128')).toBe('video');
    expect(categorize('happyhorse-1.1-t2v')).toBe('video');
    expect(categorize('ai-gateway-doc')).toBe('other');
  });

  it('订阅直连前缀归组: chatgpt/ → gpt,xai/ → grok', () => {
    expect(categorize(`${CHATGPT_MODEL_PREFIX}gpt-5.5`)).toBe('gpt');
    expect(categorize(`${XAI_MODEL_PREFIX}grok-4`)).toBe('grok');
  });
});

describe('groupOf — 数据优先,前缀兜底', () => {
  it('合法 group 字段优先于 id 前缀', () => {
    // id 看着像 gpt,但目录把它归到 china → 以 group 为准
    expect(groupOf({ id: 'gpt-weird', group: 'china' })).toBe('china');
    expect(groupOf({ id: 'codex/gpt-5.5', group: 'gpt-budget' })).toBe('gpt-budget');
  });
  it('无 group / 未知 group → 回退 categorize', () => {
    expect(groupOf({ id: 'claude-opus-4-8' })).toBe('anthropic');
    expect(groupOf({ id: 'gemini-3-flash' })).toBe('google');
    expect(groupOf({ id: 'gpt-5.5', group: 'mistral' })).toBe('gpt'); // 未知 group 忽略,按前缀
  });
});

describe('groupModelsForDisplay — sortOrder 升序 + group 分桶 + 桶序按最小 sortOrder', () => {
  it('按 sortOrder 排序并分桶,桶序 = 桶内首个出现序', () => {
    const out = groupModelsForDisplay([
      { id: 'qwen/q', group: 'china', sortOrder: 40 },
      { id: 'gpt-5.5', group: 'gpt', sortOrder: 20 },
      { id: 'codex/gpt-5.5', group: 'gpt-budget', sortOrder: 10 },
      { id: 'claude-opus-4-8', group: 'anthropic', sortOrder: 0 },
      { id: 'gpt-5.4', group: 'gpt', sortOrder: 21 },
    ]);
    // 桶序:anthropic(0) → gpt-budget(10) → gpt(20) → china(40)
    expect(out.map((g) => g.category)).toEqual(['anthropic', 'gpt-budget', 'gpt', 'china']);
    // gpt 桶内按 sortOrder:5.5(20) 在 5.4(21) 前
    expect(out.find((g) => g.category === 'gpt')!.models.map((m) => m.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('缺 sortOrder 的排末尾;group 缺省回退前缀', () => {
    const out = groupModelsForDisplay([
      { id: 'gpt-5.5', sortOrder: 20 }, // 无 group → 前缀 gpt
      { id: 'claude-opus-4-8' }, // 无 group 无 sortOrder → anthropic,排末尾
    ]);
    expect(out.map((g) => g.category)).toEqual(['gpt', 'anthropic']);
  });
});

// ── 新增语义 ─────────────────────────────────────────────────────────────────

describe('isSubscriptionDirectModel(下沉自 shared/subscriptionModels,签名一致)', () => {
  it('前缀命中', () => {
    expect(isSubscriptionDirectModel('chatgpt/gpt-5.5')).toBe(true);
    expect(isSubscriptionDirectModel('xai/grok-4')).toBe(true);
    expect(isSubscriptionDirectModel('gpt-5.5')).toBe(false);
  });
  it('null / undefined / 空串 → false(历史签名)', () => {
    expect(isSubscriptionDirectModel(null)).toBe(false);
    expect(isSubscriptionDirectModel(undefined)).toBe(false);
    expect(isSubscriptionDirectModel('')).toBe(false);
  });
  it('前缀清单恒为 chatgpt/ + xai/(路由/记账/排除三方共用,改动即破坏)', () => {
    expect(SUBSCRIPTION_DIRECT_MODEL_PREFIXES).toEqual(['chatgpt/', 'xai/']);
  });
});

describe('isBudgetModel — 目录 group 优先,codex/ 前缀兜底', () => {
  it('group 标注优先(网关新数据)', () => {
    expect(isBudgetModel({ id: 'whatever', group: 'gpt-budget' })).toBe(true);
  });
  it('无 group 时按前缀(网关旧数据)', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5' })).toBe(true);
    expect(isBudgetModel({ id: 'gpt-5.5' })).toBe(false);
  });
  // 与 groupOf 同一「数据优先」契约(2026-07 Greptile review):目录显式给出合法的
  // 非 budget 分组时,前缀不再 override —— 否则徽章显示 budget、分组却归非 budget,自相矛盾。
  it('codex/ 前缀 + 合法非 budget 分组 → 尊重目录,不打 budget 徽章', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5', group: 'gpt' })).toBe(false);
  });
  it('codex/ 前缀 + 未知 group 值 → 视同缺失,前缀兜底(与 groupOf 的未知回退一致)', () => {
    expect(isBudgetModel({ id: 'codex/gpt-5.5', group: 'not-a-category' })).toBe(true);
  });
});

describe('modelBadges — 徽章唯一口径', () => {
  it('分段模式: 用段 provider 的 access', () => {
    expect(
      modelBadges({ id: 'claude-opus-5' }, { access: { kind: 'subscription', product: 'Claude.ai' } }),
    ).toEqual({ subscription: true, budget: false });
  });

  it('flat 模式: provider 缺失时读条目 sourceAccess(真实溯源,标签不再消失)', () => {
    expect(
      modelBadges(
        { id: 'claude-opus-5', sourceAccess: { kind: 'subscription', product: 'Claude.ai' } },
        null,
      ),
    ).toEqual({ subscription: true, budget: false });
  });

  it('两者都拿不到(device-link 旧被控端拍平清单)→ 不显示,诚实降级', () => {
    expect(modelBadges({ id: 'claude-opus-5' }, null)).toEqual({
      subscription: false,
      budget: false,
    });
  });

  // 2026-07 Copilot review: 分段模式下段供应商无 access 元数据时,不得回读条目的
  // sourceAccess(那可能是 flat 首见的**另一家**供应商)——否则当前段的行会挂上别家的订阅徽章。
  it('分段模式: provider 无 access 时不回读 sourceAccess,徽章按当前段诚实为空', () => {
    expect(
      modelBadges(
        { id: 'claude-opus-5', sourceAccess: { kind: 'subscription', product: 'Claude.ai' } },
        {},
      ),
    ).toEqual({ subscription: false, budget: false });
  });

  it('骨折徽章与订阅徽章独立判定', () => {
    expect(modelBadges({ id: 'codex/gpt-5.5' }, { access: { kind: 'managed' } })).toEqual({
      subscription: false,
      budget: true,
    });
  });
});

describe('formatContextWindow(下沉自 ModelSelector,输出逐字一致)', () => {
  it('M 档: 整数不带小数,非整取 1 位', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
  });
  it('K 档: 整数不带小数,非整四舍五入取整', () => {
    expect(formatContextWindow(272_000)).toBe('272K');
    expect(formatContextWindow(200_000)).toBe('200K');
    expect(formatContextWindow(8_192)).toBe('8K');
  });
  it('<1000 原样', () => {
    expect(formatContextWindow(512)).toBe('512');
  });
});
