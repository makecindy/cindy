/**
 * devMetaOverlay 单测 —— dev 本地 cindyModelMeta 覆盖服务端网关模型元数据的
 * 合并语义(与服务端 listGatewayChatModels 对齐):同 id 覆盖、null 撤销、
 * 网关权威字段保留、非法信封/条目保留服务端原值。纯函数,不碰 Electron。
 */
import { describe, expect, it, vi } from 'vitest';

import { overlayCindyModelMeta } from '../devMetaOverlay.js';
import type { ModelAccessGatewayModel } from '../../../shared/modelAccess.js';

const SERVER_MODEL: ModelAccessGatewayModel = {
  id: 'gpt-5.5',
  contextWindow: 272_000,
  maxOutputTokens: 32_000,
  agents: ['claude-code', 'codex'],
  name: 'GPT-5.5(server)',
  group: 'gpt',
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  sortOrder: 20,
  supportsFastMode: true,
};

const LOCAL_ENTRY = {
  agents: ['codex'],
  name: 'GPT-5.5(local)',
  group: 'gpt-local',
  contextWindow: 999_000,
  efforts: ['low', 'high', 'xhigh'],
  defaultEffort: 'xhigh',
  sortOrder: 3,
  supportsFastMode: false,
  defaultEnabled: false,
  perAgent: { codex: { supportsFastMode: true } },
};

const envelope = (models: Record<string, unknown>) => ({ version: 1, models });

describe('overlayCindyModelMeta', () => {
  it('同 id 条目整体替换元数据;网关上报的 contextWindow/maxOutputTokens 权威保留', () => {
    const [m] = overlayCindyModelMeta([SERVER_MODEL], envelope({ 'gpt-5.5': LOCAL_ENTRY }));
    expect(m).toMatchObject({
      id: 'gpt-5.5',
      contextWindow: 272_000, // 网关权威,本地 999_000 不生效
      maxOutputTokens: 32_000,
      agents: ['codex'],
      name: 'GPT-5.5(local)',
      group: 'gpt-local',
      efforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'xhigh',
      sortOrder: 3,
      supportsFastMode: false,
      defaultEnabled: false,
      perAgent: { codex: { supportsFastMode: true } },
    });
  });

  it('服务端条目没有 contextWindow 时才用本地值兜底(同服务端规则)', () => {
    const noCtx: ModelAccessGatewayModel = { id: 'gpt-5.5', name: 'x', agents: ['claude-code'] };
    const [m] = overlayCindyModelMeta([noCtx], envelope({ 'gpt-5.5': LOCAL_ENTRY }));
    expect(m.contextWindow).toBe(999_000);
  });

  it('本地元数据覆盖和撤销都保留 Gateway 价格字段', () => {
    const priced: ModelAccessGatewayModel = {
      ...SERVER_MODEL,
      costDiscount: 0.2,
      inputCostPerToken: 0.000003,
      outputCostPerToken: 0.000015,
      tieredPricing: [
        {
          range: [0, 200_000],
          inputCostPerToken: 0.000003,
          outputCostPerToken: 0.000015,
        },
      ],
    };
    const [overridden] = overlayCindyModelMeta(
      [priced],
      envelope({ 'gpt-5.5': LOCAL_ENTRY }),
    );
    const [revoked] = overlayCindyModelMeta(
      [priced],
      envelope({ 'gpt-5.5': null }),
    );

    for (const model of [overridden, revoked]) {
      expect(model).toMatchObject({
        costDiscount: 0.2,
        inputCostPerToken: 0.000003,
        outputCostPerToken: 0.000015,
        tieredPricing: [
          {
            range: [0, 200_000],
            inputCostPerToken: 0.000003,
            outputCostPerToken: 0.000015,
          },
        ],
      });
    }
  });

  it('icon(展示图标)可经本地条目覆盖 / 撤销:字符串透传,非字符串条目整条拒绝', () => {
    const [withIcon] = overlayCindyModelMeta(
      [SERVER_MODEL],
      envelope({ 'gpt-5.5': { ...LOCAL_ENTRY, icon: 'codex' } }),
    );
    expect(withIcon.icon).toBe('codex');
    // 本地条目未带 icon → 覆盖后的条目也不带(整体替换语义,服务端 icon 不残留)。
    const serverWithIcon: ModelAccessGatewayModel = { ...SERVER_MODEL, icon: 'claude' };
    const [replaced] = overlayCindyModelMeta(
      [serverWithIcon],
      envelope({ 'gpt-5.5': LOCAL_ENTRY }),
    );
    expect('icon' in replaced).toBe(false);
    const warn = vi.fn();
    const [kept] = overlayCindyModelMeta(
      [serverWithIcon],
      envelope({ 'gpt-5.5': { ...LOCAL_ENTRY, icon: 42 } }),
      { warn, info: vi.fn() },
    );
    expect(kept.icon).toBe('claude'); // 非法条目跳过,保留服务端原值
    expect(warn).toHaveBeenCalled();
  });

  it('null = 撤销登记:剥掉全部元数据只留网关权威字段', () => {
    const [m] = overlayCindyModelMeta([SERVER_MODEL], envelope({ 'gpt-5.5': null }));
    expect(m).toEqual({ id: 'gpt-5.5', contextWindow: 272_000, maxOutputTokens: 32_000 });
  });

  it('本地表没有的 id 原样保留;本地多出的 id 不会凭空进清单', () => {
    const out = overlayCindyModelMeta([SERVER_MODEL], envelope({ 'other-model': LOCAL_ENTRY }));
    expect(out).toEqual([SERVER_MODEL]);
    expect(out).toHaveLength(1);
  });

  it('信封非法(缺 version / models 非对象 / undefined)原样返回不炸', () => {
    for (const bad of [undefined, null, 42, { models: {} }, { version: 2, models: {} }, { version: 1, models: [] }]) {
      expect(overlayCindyModelMeta([SERVER_MODEL], bad)).toEqual([SERVER_MODEL]);
    }
  });

  it('单条目非法只跳过该条(warn)保留服务端原值,其余照常覆盖', () => {
    const other: ModelAccessGatewayModel = { id: 'm2', name: 'M2', agents: ['claude-code'] };
    const warn = vi.fn();
    const out = overlayCindyModelMeta(
      [SERVER_MODEL, other],
      envelope({
        'gpt-5.5': { ...LOCAL_ENTRY, agents: ['browser'] }, // 非法 agent
        m2: { agents: ['claude-code'], name: 'M2(local)' },
      }),
      { warn, info: vi.fn() },
    );
    expect(out[0]).toEqual(SERVER_MODEL);
    expect(out[1]).toMatchObject({ id: 'm2', name: 'M2(local)' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('efforts 显式空数组(不可调)被尊重透传', () => {
    const [m] = overlayCindyModelMeta(
      [SERVER_MODEL],
      envelope({ 'gpt-5.5': { agents: ['claude-code'], name: 'X', efforts: [] } }),
    );
    expect(m.efforts).toEqual([]);
  });
});
