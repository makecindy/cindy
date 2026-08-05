/**
 * selectVisibleModels.test.ts
 * ---------------------------------------------------------------------------
 * 回归 lib/providerModels.ts:selectVisibleModels —— device-link「以被控端为准」契约。
 *
 * 背景:model-providers 重构把 ModelSelector 的模型列表来源从被控端 capabilities 改成了控制端
 * 本地 provider catalog(deriveModelsFromProviders),无意中破坏了「远程会话列被控端模型」的契约
 * (控制端自定义供应商 / 版本差异会让 picker 列出被控端跑不了的模型,或漏掉被控端独有模型)。
 * 本组用例锁死:deviceId 非空 → 只用被控端 caps、完全忽略本地 providers;deviceId 空 → 走本地派生。
 *
 * 纯函数 + 仅依赖 @cindy/model-providers 的 providersForAgent,可在 node env 直接测。
 */
import { describe, expect, it } from 'vitest';

import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';
import {
  filterChatBridgedCodexProviders,
  isDeviceModelVisible,
  selectVisibleModels,
} from '@/lib/providerModels';
import type { AgentKind, ProviderView } from '@cindy/model-providers';

/** 被控端 capabilities.availableModels 形态(renderer ModelDescriptor)。 */
function devModel(id: string): ModelDescriptor {
  return { id, displayName: id, contextWindow: 100, efforts: ['high'], defaultEffort: 'high' };
}

/** 最小 ProviderView —— deriveModelsFromProviders 只读 providersForAgent(按 agents 过滤)+ models[agent]。 */
function provider(id: string, agent: AgentKind, modelIds: string[]): ProviderView {
  return {
    id,
    name: id,
    agents: [agent],
    routing: { [agent]: {} },
    models: {
      [agent]: modelIds.map((mid) => ({
        id: mid,
        name: mid,
        contextWindow: 100,
        efforts: ['high'],
        defaultEffort: 'high',
      })),
    },
  } as unknown as ProviderView;
}

/** codex 供应商 + 指定 wireProtocol(SSH 远程排除 openai-chat 桥接来源用)。 */
function codexProvider(id: string, modelIds: string[], wireProtocol: 'openai-responses' | 'openai-chat'): ProviderView {
  return {
    id,
    name: id,
    agents: ['codex'],
    routing: { codex: { wireProtocol } },
    models: {
      codex: modelIds.map((mid) => ({
        id: mid,
        name: mid,
        contextWindow: 100,
        efforts: ['high'],
        defaultEffort: 'high',
      })),
    },
  } as unknown as ProviderView;
}

const ids = (ms: ModelDescriptor[]): string[] => ms.map((m) => m.id);

describe('selectVisibleModels — device-link「以被控端为准」', () => {
  it('deviceId 非空:用被控端 caps,完全忽略本地 providers(含本地独有模型)', () => {
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: 'dev-1',
      // 本地有一个被控端没有的模型 —— 绝不能出现在远程列表里。
      providers: [provider('xd', 'claude-code', ['local-only', 'shared'])],
      deviceCcModels: [devModel('host-only'), devModel('shared')],
      deviceCodexModels: [],
    });
    expect(ids(out)).toEqual(['host-only', 'shared']);
    expect(ids(out)).not.toContain('local-only');
  });

  it('deviceId 非空但被控端 caps 尚未到位(空数组):列表为空,不回落本地', () => {
    // 远程能力 fetch 解析前列表应为空(避免误展示本地模型 → 选到被控端不支持的),而非回落本地 providers。
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: 'dev-1',
      providers: [provider('xd', 'claude-code', ['local-a', 'local-b'])],
      deviceCcModels: [],
      deviceCodexModels: [],
    });
    expect(out).toEqual([]);
  });

  it('deviceId 为 undefined(本机会话):从本地 providers 派生,忽略 device 侧入参', () => {
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: undefined,
      providers: [provider('xd', 'claude-code', ['local-a'])],
      // 本机会话不该读这两个(它们只在 deviceId 非空时生效)。
      deviceCcModels: [devModel('host-x')],
      deviceCodexModels: [devModel('host-y')],
    });
    expect(ids(out)).toEqual(['local-a']);
  });

  it('agentKind 锁定 codex:device-link 下只取被控端 codex 模型', () => {
    const out = selectVisibleModels({
      agentKind: 'codex',
      deviceId: 'dev-1',
      providers: [],
      deviceCcModels: [devModel('cc-a')],
      deviceCodexModels: [devModel('cx-a'), devModel('cx-b')],
    });
    expect(ids(out)).toEqual(['cx-a', 'cx-b']);
  });

  it('agentKind 锁定 pi:只展示 PI 通道真实提供的模型', () => {
    const out = selectVisibleModels({
      agentKind: 'pi',
      deviceId: undefined,
      providers: [
        provider('openai', 'codex', ['gpt-5.5']),
        provider('xd', 'pi', ['pi-model']),
      ],
      deviceCcModels: [],
      deviceCodexModels: [],
    });
    expect(ids(out)).toEqual(['pi-model']);
  });

  it('device-link Pi picker 不给 BYOM 显式 effort 子集补档', () => {
    const explicit = {
      ...devModel('reasoner'),
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const out = selectVisibleModels({
      agentKind: 'pi',
      deviceId: 'dev-1',
      providers: [],
      deviceCcModels: [],
      deviceCodexModels: [],
      devicePiModels: [explicit],
    });

    expect(out).toEqual([explicit]);
    expect(out[0]?.efforts).toEqual(['low', 'high']);
  });

  it('agentKind 为 null:device-link 下 cc + codex 按 id 首见去重并集(cc 优先)', () => {
    const out = selectVisibleModels({
      agentKind: null,
      deviceId: 'dev-1',
      providers: [],
      deviceCcModels: [devModel('shared'), devModel('cc-only')],
      deviceCodexModels: [devModel('shared'), devModel('cx-only')],
    });
    // 'shared' 只出现一次(cc 先见),顺序 = cc 全量 + codex 新增。
    expect(ids(out)).toEqual(['shared', 'cc-only', 'cx-only']);
  });
});

describe('isDeviceModelVisible — 使用被控端可见性快照', () => {
  const model = { id: 'gpt-5.5', defaultEnabled: true };

  it('显式 override 优先于目录默认值', () => {
    expect(
      isDeviceModelVisible(
        { 'codex:openai:gpt-5.5': false },
        'codex',
        'openai',
        model,
      ),
    ).toBe(false);
  });

  it('现代被控端无 override 时跟随目录默认值，旧被控端缺快照时 fail-open', () => {
    const defaultHidden = { id: 'preview-model', defaultEnabled: false };
    expect(isDeviceModelVisible({}, 'codex', 'openai', defaultHidden)).toBe(false);
    expect(isDeviceModelVisible(undefined, 'codex', 'openai', defaultHidden)).toBe(true);
  });
});

describe('selectVisibleModels — excludeSubscriptionDirect(SSH 远程保留但由调用方禁用订阅直连模型)', () => {
  it('true:订阅直连模型不再被过滤,仍全部列出(禁用在 ModelSelector 层打标)', () => {
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: undefined,
      providers: [provider('xd', 'claude-code', ['claude-opus-4-8', 'chatgpt/gpt-5.5', 'xai/grok-4.3', 'gpt-5.5'])],
      deviceCcModels: [],
      deviceCodexModels: [],
      excludeSubscriptionDirect: true,
    });
    // 语义变更:不再从清单剔除,避免静默消失;行级 disabled 由调用方按 isSubscriptionDirectModel 判定。
    expect(ids(out)).toEqual(['claude-opus-4-8', 'chatgpt/gpt-5.5', 'xai/grok-4.3', 'gpt-5.5']);
  });

  it('未传(默认)不过滤:订阅直连模型正常列出', () => {
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: undefined,
      providers: [provider('xd', 'claude-code', ['chatgpt/gpt-5.5', 'claude-opus-4-8'])],
      deviceCcModels: [],
      deviceCodexModels: [],
    });
    expect(ids(out)).toEqual(['chatgpt/gpt-5.5', 'claude-opus-4-8']);
  });

  it('device-link 路径同样保留(deviceId 非空 + excludeSubscriptionDirect)', () => {
    const out = selectVisibleModels({
      agentKind: null,
      deviceId: 'dev-1',
      providers: [],
      deviceCcModels: [devModel('chatgpt/gpt-5.5'), devModel('claude-opus-4-8')],
      deviceCodexModels: [devModel('xai/grok-4.3'), devModel('gpt-5.5')],
      excludeSubscriptionDirect: true,
    });
    expect(ids(out)).toEqual(['chatgpt/gpt-5.5', 'claude-opus-4-8', 'xai/grok-4.3', 'gpt-5.5']);
  });
});

describe('selectVisibleModels — excludeChatBridgedCodex(SSH 远程隐藏 Chat 桥接的 Codex 供应商)', () => {
  it('true:剔除 wireProtocol=openai-chat 的 codex 供应商模型,保留原生 Responses 供应商', () => {
    const out = selectVisibleModels({
      agentKind: 'codex',
      deviceId: undefined,
      providers: [
        codexProvider('deepseek', ['deepseek-chat'], 'openai-chat'),
        codexProvider('openai', ['gpt-5.5'], 'openai-responses'),
      ],
      deviceCcModels: [],
      deviceCodexModels: [],
      excludeChatBridgedCodex: true,
    });
    // Chat 桥接的 DeepSeek 在 SSH 远程不可用(桥只在本地),原生 Responses 的 gpt-5.5 保留。
    expect(ids(out)).toEqual(['gpt-5.5']);
  });

  it('同一 model id 另有原生 Responses 供应商时仍可见(仅剔除桥接来源)', () => {
    const out = selectVisibleModels({
      agentKind: 'codex',
      deviceId: undefined,
      // 桥接来源在前(first-wins),但被跳过后原生来源仍补上同名模型。
      providers: [
        codexProvider('bridged', ['shared'], 'openai-chat'),
        codexProvider('native', ['shared'], 'openai-responses'),
      ],
      deviceCcModels: [],
      deviceCodexModels: [],
      excludeChatBridgedCodex: true,
    });
    expect(ids(out)).toEqual(['shared']);
  });

  it('未传(默认)不过滤:Chat 桥接的 codex 模型正常列出', () => {
    const out = selectVisibleModels({
      agentKind: 'codex',
      deviceId: undefined,
      providers: [codexProvider('deepseek', ['deepseek-chat'], 'openai-chat')],
      deviceCcModels: [],
      deviceCodexModels: [],
    });
    expect(ids(out)).toEqual(['deepseek-chat']);
  });

  it('claude-code 列表不受影响(仅作用于 codex 派生)', () => {
    const out = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: undefined,
      providers: [provider('anthropic', 'claude-code', ['claude-opus-4-8'])],
      deviceCcModels: [],
      deviceCodexModels: [],
      excludeChatBridgedCodex: true,
    });
    expect(ids(out)).toEqual(['claude-opus-4-8']);
  });
});

describe('filterChatBridgedCodexProviders — provider source sections', () => {
  const bridged = { ...codexProvider('bridged', ['deepseek-chat'], 'openai-chat'), connected: true };
  const native = { ...codexProvider('native', ['gpt-5.5'], 'openai-responses'), connected: true };

  it('SSH exclusion removes bridged Codex sources from section inputs', () => {
    expect(filterChatBridgedCodexProviders([bridged, native], 'codex', true).map((p) => p.id)).toEqual(['native']);
  });

  it('does not filter Claude sources or normal local Codex sources', () => {
    expect(filterChatBridgedCodexProviders([bridged, native], 'codex', false).map((p) => p.id)).toEqual([
      'bridged',
      'native',
    ]);
    expect(filterChatBridgedCodexProviders([bridged, native], 'claude-code', true).map((p) => p.id)).toEqual([
      'bridged',
      'native',
    ]);
  });
});
