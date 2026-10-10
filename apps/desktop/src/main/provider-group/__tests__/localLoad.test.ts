/**
 * 这台电脑上每个供应商正在运行一轮的任务数(provider-groups.md §5)：本机任务按任务记录的来源计，
 * Agent 在别处运行的不算；替其他电脑运行的远程 Agent 任务也算。
 */
import { describe, expect, it, vi } from 'vitest';

import { countProviderRunningTurns, type ProviderLocalLoadDeps, type ProviderLocalLoadRoute } from '../localLoad';

const route = (id: string, patch: Partial<ProviderLocalLoadRoute> = {}): ProviderLocalLoadRoute => ({
  id,
  agentKind: 'claude-code',
  model: 'claude-sonnet-5',
  providerId: 'anthropic',
  agentDeviceId: null,
  remoteHostId: null,
  ...patch,
});

function deps(overrides: Partial<ProviderLocalLoadDeps> = {}): ProviderLocalLoadDeps {
  return {
    listTurnRunningSessions: () => [],
    readSessionRoutes: async () => [],
    resolveImplicitProvider: async () => null,
    hostRunningProviders: () => [],
    ...overrides,
  };
}

describe('countProviderRunningTurns', () => {
  it('counts local tasks by provider and adds tasks run for other computers', async () => {
    const routes = [
      route('a'),
      route('b'),
      route('c', { agentKind: 'codex', model: 'gpt-5.5', providerId: 'openai' }),
      // Agent 在另一台电脑、分享来的电脑或 SSH 主机上运行：算在那里。
      route('d', { agentDeviceId: 'mini' }),
      route('e', { agentDeviceId: 'share:s1' }),
      route('f', { remoteHostId: 'ssh-1' }),
    ];
    const readSessionRoutes = vi.fn(async () => routes);
    const counts = await countProviderRunningTurns(deps({
      listTurnRunningSessions: () => routes.map((r) => r.id),
      readSessionRoutes,
      hostRunningProviders: () => ['anthropic', 'deepseek'],
    }));
    expect(Object.fromEntries(counts)).toEqual({ anthropic: 3, openai: 1, deepseek: 1 });
    expect(readSessionRoutes).toHaveBeenCalledWith(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('resolves tasks without a recorded provider once per model', async () => {
    const resolveImplicitProvider = vi.fn(async (_kind: string, model: string) => (model === 'claude-sonnet-5' ? 'anthropic' : null));
    const counts = await countProviderRunningTurns(deps({
      listTurnRunningSessions: () => ['a', 'b', 'c', 'd'],
      readSessionRoutes: async () => [
        route('a', { providerId: null }),
        route('b', { providerId: null }),
        // 本机找不到来源的不算。
        route('c', { providerId: null, model: 'mystery' }),
        route('d', { providerId: null, model: null }),
      ],
      resolveImplicitProvider,
    }));
    expect(Object.fromEntries(counts)).toEqual({ anthropic: 2 });
    expect(resolveImplicitProvider).toHaveBeenCalledTimes(2);
  });

  it('does not read task records when nothing local is running', async () => {
    const readSessionRoutes = vi.fn(async () => []);
    const counts = await countProviderRunningTurns(deps({ readSessionRoutes, hostRunningProviders: () => ['anthropic'] }));
    expect(Object.fromEntries(counts)).toEqual({ anthropic: 1 });
    expect(readSessionRoutes).not.toHaveBeenCalled();
  });
});
