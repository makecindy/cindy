import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { selectWorkerModels } from '../workerModelAvailability';

const model = (id: string): ModelDescriptor => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  efforts: ['high'],
  defaultEffort: 'high',
});

const capabilities = (models: ModelDescriptor[]): AgentCapabilities =>
  ({ availableModels: models }) as AgentCapabilities;

const provider = (
  id: string,
  connected: boolean,
  agent: 'claude-code' | 'codex',
  models: ModelDescriptor[],
): ProviderView =>
  ({
    id,
    name: id,
    connected,
    agents: [agent],
    routing: { [agent]: {} },
    models: {
      [agent]: models.map((entry) => ({ ...entry, name: entry.displayName })),
    },
  }) as unknown as ProviderView;

describe('selectWorkerModels', () => {
  const standard = model('gpt-5.5');
  const budget = model('codex/gpt-5.5');
  const caps = capabilities([standard, budget]);

  it('only offers local Codex models backed by a connected provider', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('openai', true, 'codex', [standard])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['gpt-5.5']);

    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('xd', true, 'codex', [budget])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['codex/gpt-5.5']);

    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        providers: [provider('custom', true, 'codex', [])],
        providersLoading: false,
        providersError: null,
      }),
    ).toEqual([]);
  });

  it('only offers local Claude models backed by a connected provider', () => {
    const opus = model('claude-opus-4-8');
    const sonnet = model('claude-sonnet-4-6');

    expect(
      selectWorkerModels({
        agent: 'claude-code',
        capabilities: capabilities([opus, sonnet]),
        providers: [provider('anthropic', true, 'claude-code', [sonnet])],
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['claude-sonnet-4-6']);
  });

  it('excludes ignored local models while retaining a model enabled by another provider', () => {
    const hidden = model('hidden-model');
    const shared = model('shared-model');

    expect(
      selectWorkerModels({
        agent: 'claude-code',
        capabilities: capabilities([hidden, shared]),
        providers: [
          provider('provider-a', true, 'claude-code', [hidden, shared]),
          provider('provider-b', true, 'claude-code', [shared]),
        ],
        providersLoading: false,
        providersError: null,
        isVisible: (providerId, entry) =>
          entry.id === 'shared-model' && providerId === 'provider-b',
      }).map((entry) => entry.id),
    ).toEqual(['shared-model']);
  });

  it('uses each controlled device provider snapshot without leaking models across devices', () => {
    const deviceA = selectWorkerModels({
      agent: 'codex',
      capabilities: caps,
      deviceId: 'device-a',
      providers: [provider('openai', true, 'codex', [standard])],
      providersLoading: false,
      providersError: null,
    });
    const deviceB = selectWorkerModels({
      agent: 'codex',
      capabilities: caps,
      deviceId: 'device-b',
      providers: [provider('xd', true, 'codex', [budget])],
      providersLoading: false,
      providersError: null,
    });

    expect(deviceA.map((entry) => entry.id)).toEqual(['gpt-5.5']);
    expect(deviceB.map((entry) => entry.id)).toEqual(['codex/gpt-5.5']);
  });

  it('falls back to controlled-device capabilities for old peers without provider:list', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        deviceId: 'old-device',
        providers: [],
        providersLoading: false,
        providersError: 'unknown channel',
        providersUnsupported: true,
      }),
    ).toEqual([standard, budget]);
  });

  it('fails closed when the controlled-device provider list has a real read error', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        deviceId: 'offline-device',
        providers: [provider('openai', true, 'codex', [standard])],
        providersLoading: false,
        providersError: 'proxy policy: request not allowed remotely',
        providersUnsupported: false,
      }),
    ).toEqual([]);
  });

  it('does not submit a stale selection while a new device provider snapshot is loading', () => {
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: caps,
        deviceId: 'device-b',
        providers: [],
        providersLoading: true,
        providersError: null,
      }),
    ).toEqual([]);
  });

  it('hides subscription-direct models for SSH remote leads (main-side guard would reject them)', () => {
    // codex review R28:chatgpt/ 与 xai/ 经本地 compat-proxy 翻译,SSH 远端
    // 不经它 — 提交前就不该出现在可提交清单里(与 ChatInput 同口径)。
    const chatgpt = model('chatgpt/gpt-5.5');
    const grok = model('xai/grok-4.3');
    const capsWithSub = capabilities([standard, chatgpt, grok]);
    const providers = [provider('openai', true, 'codex', [standard, chatgpt, grok])];

    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: capsWithSub,
        providers,
        providersLoading: false,
        providersError: null,
        excludeSubscriptionDirect: true,
      }).map((entry) => entry.id),
    ).toEqual(['gpt-5.5']);

    // 不开关:维持原样(本地 Lead 可提交订阅直连)。
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: capsWithSub,
        providers,
        providersLoading: false,
        providersError: null,
      }).map((entry) => entry.id),
    ).toEqual(['gpt-5.5', 'chatgpt/gpt-5.5', 'xai/grok-4.3']);
  });

  it('hides chat-bridged Codex providers for SSH remote leads, keeping same-id models offered elsewhere', () => {
    const bridged = {
      ...provider('deepseek', true, 'codex', [model('deepseek-chat'), model('shared-model')]),
      routing: { codex: { wireProtocol: 'openai-chat' } },
    } as unknown as ProviderView;
    const direct = provider('openai', true, 'codex', [standard, model('shared-model')]);
    const capsAll = capabilities([model('deepseek-chat'), model('shared-model'), standard]);

    // 桥接供应商整条剔除;shared-model 由非桥接来源补上(与 selectVisibleModels
    // 的 excludeProvider 语义一致),deepseek-chat 无处可路由 → 消失。
    expect(
      selectWorkerModels({
        agent: 'codex',
        capabilities: capsAll,
        providers: [bridged, direct],
        providersLoading: false,
        providersError: null,
        excludeChatBridgedCodex: true,
      }).map((entry) => entry.id),
    ).toEqual(['shared-model', 'gpt-5.5']);

    // 排除只对 codex 生效:claude-code 不受 wireProtocol 影响。
    const opus = model('claude-opus-4-8');
    expect(
      selectWorkerModels({
        agent: 'claude-code',
        capabilities: capabilities([opus]),
        providers: [provider('anthropic', true, 'claude-code', [opus])],
        providersLoading: false,
        providersError: null,
        excludeChatBridgedCodex: true,
      }).map((entry) => entry.id),
    ).toEqual(['claude-opus-4-8']);
  });
});
