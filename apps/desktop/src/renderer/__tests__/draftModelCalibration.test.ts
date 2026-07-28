/**
 * 草稿默认模型的可用性校准。
 *
 * 回归的是「全新用户首屏就撞墙」：种子默认模型写死在产品默认里（cc → Opus），与本机
 * 连了哪些来源无关；可连来源不提供那个 id 时，Send 直接禁用、只能弹「当前模型没有已
 * 连接的来源」。校准只作用于**没被显式选过**的默认值。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  calibrateDraftModel,
  pickConnectedModelForAgent,
} from '../lib/draftModelCalibration';

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    group: 'test',
    sortOrder: 0,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    supportsFastMode: false,
    status: 'active',
  } as CatalogModel;
}

function provider(
  id: string,
  connected: boolean,
  models: Record<string, CatalogModel[]>,
): ProviderView {
  const agents = Object.keys(models);
  return {
    id,
    name: id,
    source: 'builtin',
    agents,
    models,
    // Provider availability now requires an enabled runtime, not only an entry in `agents`.
    routing: Object.fromEntries(
      agents.map((agent) => [
        agent,
        { upstream: 'https://provider.test', authStrategy: 'none' },
      ]),
    ),
    auth: { method: 'oauth' },
    connected,
  } as unknown as ProviderView;
}

const gatewayWithoutOpus = provider('xd', true, {
  'claude-code': [model('claude-sonnet-5'), model('claude-haiku-4-5')],
});
const disconnectedAnthropic = provider('anthropic', false, {
  'claude-code': [model('claude-opus-4-8')],
});
/** 已连接但零模型 —— 正是动态发现失败的 anthropic 的形态。 */
const connectedButEmpty = provider('anthropic', true, { 'claude-code': [] });

describe('pickConnectedModelForAgent', () => {
  it('默认模型本身可用时原样保留,不无谓换模型', () => {
    const providers = [provider('xd', true, { 'claude-code': [model('claude-opus-4-8')] })];
    expect(pickConnectedModelForAgent(providers, 'claude-code', 'claude-opus-4-8')).toBe(
      'claude-opus-4-8',
    );
  });

  it('默认模型没有已连接来源时落到已连接来源的第一个模型', () => {
    expect(
      pickConnectedModelForAgent(
        [gatewayWithoutOpus, disconnectedAnthropic],
        'claude-code',
        'claude-opus-4-8',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('已连接但零模型的来源不算数(动态发现失败的 anthropic)', () => {
    expect(
      pickConnectedModelForAgent([connectedButEmpty], 'claude-code', 'claude-opus-4-8'),
    ).toBeNull();
    // 同时存在一个真有模型的来源时,挑那个。
    expect(
      pickConnectedModelForAgent(
        [connectedButEmpty, gatewayWithoutOpus],
        'claude-code',
        'claude-opus-4-8',
      ),
    ).toBe('claude-sonnet-5');
  });

  it('一个已连接来源都没有时返回 null,交给零来源空态', () => {
    expect(
      pickConnectedModelForAgent([disconnectedAnthropic], 'claude-code', 'claude-opus-4-8'),
    ).toBeNull();
  });
});

describe('calibrateDraftModel', () => {
  const base = {
    providers: [gatewayWithoutOpus, disconnectedAnthropic],
    agent: 'claude-code' as const,
    model: 'claude-opus-4-8',
    providersLoading: false,
  };

  it('校准从未被显式选过的种子默认', () => {
    expect(calibrateDraftModel({ ...base, chosenByUser: false })).toBe('claude-sonnet-5');
  });

  it('绝不改写用户显式选过的模型', () => {
    expect(calibrateDraftModel({ ...base, chosenByUser: true })).toBe('claude-opus-4-8');
  });

  it('供应商清单加载期不校准,避免首帧闪模型', () => {
    expect(calibrateDraftModel({ ...base, chosenByUser: false, providersLoading: true })).toBe(
      'claude-opus-4-8',
    );
  });

  it('没有任何可用来源时原样返回,不返回空', () => {
    expect(
      calibrateDraftModel({ ...base, providers: [disconnectedAnthropic], chosenByUser: false }),
    ).toBe('claude-opus-4-8');
  });

  it('候选来源由调用方先过滤 —— SSH 草稿不该被推荐仅本地可桥接的来源', () => {
    // 调用方(NewMakerDraftRoute)按 filterChatBridgedCodexProviders 先剔除 chat-bridged
    // codex 来源;校准只在剩下的候选里挑,不会把远端根本路由不出去的模型选成默认。
    const localOnlyBridge = provider('chatgpt', true, {
      codex: [model('gpt-5.5-bridge')],
    });
    const routableEverywhere = provider('xd', true, { codex: [model('gpt-5.5')] });

    // 未过滤(本地草稿):bridge 来源可用。
    expect(
      calibrateDraftModel({
        providers: [localOnlyBridge, routableEverywhere],
        agent: 'codex',
        model: 'gpt-nonexistent',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('gpt-5.5-bridge');

    // 已过滤(SSH 草稿):只会落到远端也能路由的来源。
    expect(
      calibrateDraftModel({
        providers: [routableEverywhere],
        agent: 'codex',
        model: 'gpt-nonexistent',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('gpt-5.5');
  });

  it('候选须由调用方逐模型预过滤 —— 供应商级过滤盖不住同一供应商里的混合清单', () => {
    // 同一个已连接供应商里既有订阅直连模型(远端 bridge 不可达)又有可路由模型。
    // 过滤放在候选构造上而不是这里:同一份候选还要喂给来源解析,只在挑模型时过滤会让
    // 来源解析仍看见被剔除的条目,从而选中一个用户已排除掉该模型的来源。
    const models = [model('chatgpt/gpt-5.5'), model('claude-sonnet-5')];
    const input = {
      agent: 'claude-code' as const,
      model: 'claude-opus-4-8',
      chosenByUser: false,
      providersLoading: false,
    };

    // 本地草稿:候选未剔除,取清单里的第一个。
    expect(
      calibrateDraftModel({
        ...input,
        providers: [provider('xd', true, { 'claude-code': models })],
      }),
    ).toBe('chatgpt/gpt-5.5');

    // SSH 草稿:候选已剔除订阅直连,落到真正可路由的模型。
    expect(
      calibrateDraftModel({
        ...input,
        providers: [
          provider('xd', true, {
            'claude-code': models.filter((m) => !m.id.startsWith('chatgpt/')),
          }),
        ],
      }),
    ).toBe('claude-sonnet-5');
  });

  it('候选里剔掉用户隐藏的条目后就不会被选成默认(与选择器可见性同口径)', () => {
    const visibleOnly = [model('claude-sonnet-5')];
    expect(
      calibrateDraftModel({
        providers: [provider('xd', true, { 'claude-code': visibleOnly })],
        agent: 'claude-code',
        model: 'claude-opus-4-8',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('claude-sonnet-5');
  });

  it('某来源的模型被剔光后整条来源不再是候选,不会被解析成生效来源', () => {
    // 调用方会把「过滤后零模型」的来源整条丢掉;这里断言即便传进来也不会被选中。
    const emptied = provider('xd', true, { 'claude-code': [] });
    const usable = provider('anthropic', true, { 'claude-code': [model('claude-sonnet-5')] });
    expect(
      calibrateDraftModel({
        providers: [emptied, usable],
        agent: 'claude-code',
        model: 'claude-opus-4-8',
        chosenByUser: false,
        providersLoading: false,
      }),
    ).toBe('claude-sonnet-5');
  });
});
