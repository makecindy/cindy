/**
 * 模型组 Auto 只按模型 ID 认：服务端可以把同一个 `auto/<组ID>` 在 Cindy AI 与企业号池供应商
 * 之间挪动，记住的来源不再提供它时改用当前提供它的那一家；用户自己接的供应商不受影响。
 */
import { describe, expect, it } from 'vitest';

import { isCindyAutoModelId, isCindyDistributedProvider } from '../provider-identity.js';
import { effectiveSourceIdForModel, movedCindyAutoSourceId, type ProviderView } from '../registry.js';
import type { CatalogModel, ProviderSource } from '../types.js';

function model(id: string): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null };
}

function provider(id: string, source: ProviderSource, modelIds: string[], connected = true): ProviderView {
  return {
    id,
    name: id,
    source,
    agents: ['pi'],
    auth: { method: source === 'user' ? 'apiKey' : 'managed' },
    access: source === 'user' ? { kind: 'api' } : { kind: 'managed' },
    routing: { pi: { upstream: `https://${id}.test`, authStrategy: 'api-key-header' } },
    models: { pi: modelIds.map(model) },
    connected,
  };
}

const AUTO = 'auto/group-1';

describe('Cindy Auto 身份', () => {
  it('预设 auto 与 auto/<组ID> 都算，前缀相近的模型不算', () => {
    expect(isCindyAutoModelId('auto')).toBe(true);
    expect(isCindyAutoModelId(AUTO)).toBe(true);
    for (const id of ['auto/', 'autopilot', 'openrouter/auto', 'xd/auto']) {
      expect(isCindyAutoModelId(id)).toBe(false);
    }
  });

  it('只有 Cindy AI 与企业号池算 Cindy 下发的来源', () => {
    expect(isCindyDistributedProvider(provider('xd', 'builtin', []))).toBe(true);
    expect(isCindyDistributedProvider(provider('org-pool', 'organization', []))).toBe(true);
    expect(isCindyDistributedProvider(provider('xd', 'user', []))).toBe(false);
    expect(isCindyDistributedProvider(provider('anthropic', 'builtin', []))).toBe(false);
    expect(isCindyDistributedProvider(null)).toBe(false);
  });
});

describe('effectiveSourceIdForModel：Auto 跨 Cindy 来源改道', () => {
  it('号池 → Cindy AI、Cindy AI → 号池都跟着走', () => {
    const toPlatform = [provider('xd', 'builtin', ['auto', AUTO]), provider('org-pool', 'organization', ['pool-model'])];
    expect(effectiveSourceIdForModel(toPlatform, 'org-pool', AUTO, 'pi')).toBe('xd');
    const toPool = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', ['pool-model', AUTO])];
    expect(effectiveSourceIdForModel(toPool, 'xd', AUTO, 'pi')).toBe('org-pool');
    // 号池之间同样适用。
    const betweenPools = [
      provider('org-a', 'organization', ['pool-model']),
      provider('org-b', 'organization', [AUTO]),
    ];
    expect(effectiveSourceIdForModel(betweenPools, 'org-a', AUTO, 'pi')).toBe('org-b');
  });

  it('记住的来源仍提供它时保持不变', () => {
    const views = [provider('xd', 'builtin', [AUTO]), provider('org-pool', 'organization', [AUTO])];
    expect(effectiveSourceIdForModel(views, 'org-pool', AUTO, 'pi')).toBe('org-pool');
  });

  it('记住的来源还列着它、只是断连或停用时不改道，仍按显式来源失效处理', () => {
    const disconnected = [
      provider('xd', 'builtin', [AUTO]),
      provider('org-pool', 'organization', [AUTO], false),
    ];
    expect(effectiveSourceIdForModel(disconnected, 'org-pool', AUTO, 'pi')).toBeNull();
    const suspended = [provider('xd', 'builtin', [AUTO]), { ...provider('org-pool', 'organization', [AUTO]), suspended: true }];
    expect(effectiveSourceIdForModel(suspended, 'org-pool', AUTO, 'pi')).toBeNull();
  });

  it('用户自己接的供应商不参与：既不从它挪走，也不挪到它', () => {
    const fromUser = [provider('custom', 'user', ['other']), provider('xd', 'builtin', [AUTO])];
    expect(effectiveSourceIdForModel(fromUser, 'custom', AUTO, 'pi')).toBeNull();
    const toUser = [provider('org-pool', 'organization', ['pool-model']), provider('custom', 'user', [AUTO])];
    expect(effectiveSourceIdForModel(toUser, 'org-pool', AUTO, 'pi')).toBeNull();
  });

  it('普通模型与已不存在的来源保持原有的「显式来源失效返回 null」', () => {
    const views = [provider('xd', 'builtin', ['glm']), provider('org-pool', 'organization', ['pool-model'])];
    expect(effectiveSourceIdForModel(views, 'org-pool', 'glm', 'pi')).toBeNull();
    expect(effectiveSourceIdForModel([provider('xd', 'builtin', [AUTO])], 'gone-pool', AUTO, 'pi')).toBeNull();
  });
});

describe('movedCindyAutoSourceId：已保存 / 运行中的路由', () => {
  const toPool = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', [AUTO])];

  it('挪动后给出新来源，没挪动给 null', () => {
    expect(movedCindyAutoSourceId(toPool, { agent: 'pi', model: AUTO, providerId: 'xd' })).toBe('org-pool');
    expect(movedCindyAutoSourceId(toPool, { agent: 'pi', model: AUTO, providerId: 'org-pool' })).toBeNull();
    expect(movedCindyAutoSourceId(toPool, { agent: 'pi', model: 'auto', providerId: 'xd' })).toBeNull();
  });

  it('Pi 的 null 就是 Cindy AI；其它引擎的 null 不推断', () => {
    expect(movedCindyAutoSourceId(toPool, { agent: 'pi', model: AUTO, providerId: null })).toBe('org-pool');
    expect(movedCindyAutoSourceId(toPool, { agent: 'codex', model: AUTO, providerId: null })).toBeNull();
  });
});

describe('负向与回归', () => {
  it('订阅等内置非 Cindy AI 来源里的 auto/... 不当组 Auto：不从它挪走，也不挪到它', () => {
    const fromSubscription = [provider('openai', 'builtin', ['other']), provider('xd', 'builtin', [AUTO])];
    expect(effectiveSourceIdForModel(fromSubscription, 'openai', AUTO, 'pi')).toBeNull();
    expect(movedCindyAutoSourceId(fromSubscription, { agent: 'pi', model: AUTO, providerId: 'openai' })).toBeNull();
    const toSubscription = [provider('xd', 'builtin', ['auto']), provider('openai', 'builtin', [AUTO])];
    expect(effectiveSourceIdForModel(toSubscription, 'xd', AUTO, 'pi')).toBeNull();
    expect(movedCindyAutoSourceId(toSubscription, { agent: 'pi', model: AUTO, providerId: 'xd' })).toBeNull();
  });

  it('Auto 从两份目录都消失：不改道，按显式来源失效返回 null（由既有的来源失效提示接手）', () => {
    const gone = [provider('xd', 'builtin', ['auto']), provider('org-pool', 'organization', ['pool-model'])];
    expect(effectiveSourceIdForModel(gone, 'org-pool', AUTO, 'pi')).toBeNull();
    expect(movedCindyAutoSourceId(gone, { agent: 'pi', model: AUTO, providerId: 'org-pool' })).toBeNull();
    expect(movedCindyAutoSourceId(gone, { agent: 'pi', model: AUTO, providerId: null })).toBeNull();
  });

  it('回归：预设 auto 与普通模型的来源解析不变', () => {
    const views = [provider('xd', 'builtin', ['auto', 'glm']), provider('custom', 'user', ['custom-model'])];
    expect(effectiveSourceIdForModel(views, 'xd', 'auto', 'pi')).toBe('xd');
    expect(effectiveSourceIdForModel(views, null, 'auto', 'pi')).toBe('xd');
    expect(movedCindyAutoSourceId(views, { agent: 'pi', model: 'auto', providerId: null })).toBeNull();
    expect(effectiveSourceIdForModel(views, 'custom', 'custom-model', 'pi')).toBe('custom');
    expect(effectiveSourceIdForModel(views, 'custom', 'glm', 'pi')).toBeNull();
  });
});
