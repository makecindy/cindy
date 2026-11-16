/**
 * 测试价值
 * - 可观察结果：Claude 子代理显式模型的准入结论（allowed / unknown / denied），桌面绑定
 *   （subagent-model-access.ts）与 Host 的装配（apps/host/src/agent/subagent-model-access.ts，Host
 *   自己的代码）在 XD 快照的六种状态下、对同一组请求逐格相同。快照由 Host 自己的供应商目录
 *   （providers.mjs）逐步产生；它与桌面模型目录同步的快照相同，见 hostXdSnapshotAuthorityParity。
 * - 规则依据：放行表第 19 行 C2。只有本轮成功的快照能把清单里的缺席判成拒绝；刷新进行中、失败后
 *   只能是未知（照常放行），付费墓碑在失败后仍然拒绝。
 * - 最小失败输入：Host 不传网关 key；供应商视图读错；按旧清单拒绝。
 * - tier：unit（进程内，`/models` 由测试给出，不连网）。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  key: 'fixture-gateway-key' as string | null,
  providers: [] as unknown[],
  pending: [] as Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }>,
}));

vi.mock('../auth-adapters.js', () => ({ readClaudeApiKey: () => h.key }));
vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => h.providers }),
}));

import { resolveDesktopClaudeSubagentModelAccess } from '../subagent-model-access.js';
import { getXdGatewayModels, markXdGatewayModelAccessUnknown, setXdGatewayModels } from '../active-catalog.js';

type HostAccess = typeof import('../../../../../host/src/agent/subagent-model-access.js');
// providers.mjs is JavaScript without declarations; the shape this test calls.
type HostProviders = { createProviderCatalog: (ports: Record<string, unknown>) =>
  (options: { gateway?: { endpoint: string; credential: string }; ownerId: string; force?: boolean }) => Promise<unknown> };

const hostAccessModule = '../../../../../host/src/agent/subagent-model-access.ts';
const hostProvidersModule = '../../../../../host/src/agent/providers.mjs';

const model = (id: string, availability: 'available' | 'requires_payment') => ({
  id, name: id, contextWindow: 200_000, currency: 'USD', agents: ['claude-code'], mode: 'chat', availability,
});
const gatewayModels = [model('claude-sonnet-4-5', 'available'), model('claude-opus-4-1', 'requires_payment')];
const contexts = [
  { providerId: 'xd' },
  { providerId: null, credentialMode: 'gateway-key' as const },
  { providerId: null, credentialMode: 'oauth-bearer' as const },
  { providerId: 'cprov-claude' },
];
const models = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'sonnet', 'custom-model'];
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const answer = (outcome: 'ok' | 'fail') => {
  const pending = h.pending.shift();
  if (!pending) throw new Error('no /models request is pending');
  if (outcome === 'ok') pending.resolve(gatewayModels); else pending.reject(new Error('fixture /models failure'));
};

describe('Host subagent model access matches the desktop', () => {
  afterAll(() => setXdGatewayModels([]));

  it('gives the same answer in every snapshot state', async () => {
    h.providers = [
      { id: 'xd', connected: true, suspended: false, models: { 'claude-code': [{ id: 'claude-sonnet-4-5' }] } },
      { id: 'cprov-claude', connected: true, suspended: false, models: { 'claude-code': [{ id: 'custom-model' }] } },
    ];
    const { createHostClaudeSubagentModelAccess } = await import(hostAccessModule) as HostAccess;
    const host = createHostClaudeSubagentModelAccess({ readGatewayKey: () => h.key, listProviderViews: async () => h.providers as never });
    const { createProviderCatalog } = await import(hostProvidersModule) as HostProviders;
    const list = createProviderCatalog({
      readProviders: async () => [],
      applyModels: (value: never, options: never) => setXdGatewayModels(value, options),
      markModelsUnknown: () => markXdGatewayModelAccessUnknown(),
      readModels: () => getXdGatewayModels(),
      fetchModels: () => new Promise((resolve, reject) => { h.pending.push({ resolve, reject }); }),
    });
    const gateway = (credential: string) => ({ endpoint: 'http://gateway.example.test', credential });

    const table = async () => {
      const rows: Record<string, unknown> = {};
      for (const key of ['fixture-gateway-key', null]) {
        h.key = key;
        for (const context of contexts) for (const requested of models) {
          const request = { ...context, parentModel: 'claude-sonnet-4-5', model: requested };
          const desktop = await resolveDesktopClaudeSubagentModelAccess(request);
          const hostAnswer = await host(request);
          expect(hostAnswer, JSON.stringify({ key, ...request })).toEqual(desktop);
          rows[`${key ? 'key' : 'no-key'} ${context.providerId ?? context.credentialMode} ${requested}`] = desktop.status;
        }
      }
      h.key = 'fixture-gateway-key';
      return rows;
    };

    const states: Record<string, Record<string, unknown>> = {};
    let call = list({ gateway: gateway('key-a'), ownerId: 'owner' });
    await settle(); states.firstInFlight = await table();
    answer('ok'); await call; states.success = await table();
    call = list({ gateway: gateway('key-a'), ownerId: 'owner', force: true });
    await settle(); states.nextInFlight = await table();
    answer('fail'); await call; states.failureAfterSuccess = await table();
    call = list({ gateway: gateway('key-b'), ownerId: 'owner-b' });
    await settle(); states.accountChange = await table();
    answer('fail'); await call; states.failureNeverSucceeded = await table();
    expect(h.pending).toEqual([]);

    // The cells that decide: an absent gateway model is denied only by a successful round; the paid
    // refusal survives a failed refresh; an account change starts from nothing known.
    const xd = (state: string, requested: string) => states[state]![`key xd ${requested}`];
    expect(['firstInFlight', 'success', 'nextInFlight', 'failureAfterSuccess', 'accountChange', 'failureNeverSucceeded']
      .map(state => [xd(state, 'claude-haiku-4-5'), xd(state, 'claude-opus-4-1'), xd(state, 'claude-sonnet-4-5')]))
      .toEqual([
        ['unknown', 'unknown', 'unknown'],
        ['denied', 'denied', 'allowed'],
        ['unknown', 'denied', 'unknown'],
        ['unknown', 'denied', 'unknown'],
        ['unknown', 'unknown', 'unknown'],
        ['unknown', 'unknown', 'unknown'],
      ]);
    // Outside the gateway the provider views only tell available from unknown.
    expect(states.success!['key cprov-claude custom-model']).toBe('allowed');
    expect(states.success!['key cprov-claude claude-haiku-4-5']).toBe('unknown');
  });
});
