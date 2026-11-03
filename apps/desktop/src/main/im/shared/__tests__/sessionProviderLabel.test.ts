/**
 * 额度说明里的「哪个供应商」必须是任务此刻实际走的那一家 —— 运行中会话口径
 * (actualSourceIdForModel), 停用 / 退役拷贝不让说明改名或退化成「当前供应商」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  row: null as null | { agentKind: string; model: string | null; providerId: string | null; title?: string },
  providers: [] as unknown[],
  live: undefined as undefined | string | null,
}));

vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (mocks.row ? [mocks.row] : []) }) }),
      }),
    },
  }),
}));
vi.mock('../../../maker-host/createDesktopProviderService', () => ({
  getDesktopProviderService: () => ({ listProviders: async () => mocks.providers }),
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  hasSessionProvider: () => mocks.live !== undefined,
  getSessionProvider: () => mocks.live ?? null,
}));

const { resolveSessionErrorContext } = await import('../sessionProviderLabel');

function codexProvider(id: string, name: string, disabled = false): ProviderView {
  return {
    id,
    name,
    source: 'builtin',
    agents: ['codex'],
    auth: { method: 'managed' },
    routing: { codex: { upstream: 'https://example.test', authStrategy: 'gateway-key' } },
    models: {
      codex: [
        {
          id: 'gpt-6-astra',
          name: 'GPT-6 Astra',
          contextWindow: 200_000,
          efforts: ['high'],
          defaultEffort: 'high',
          ...(disabled ? { disabled: true } : {}),
        },
      ],
    },
    connected: true,
  } as ProviderView;
}

beforeEach(() => {
  mocks.row = { agentKind: 'codex', model: 'gpt-6-astra', providerId: null };
  mocks.providers = [codexProvider('openai', 'OpenAI'), codexProvider('xd', 'Cindy AI')];
  mocks.live = undefined;
});

describe('resolveSessionErrorContext', () => {
  it('names the implicit native default source', async () => {
    await expect(resolveSessionErrorContext('s1')).resolves.toMatchObject({ providerLabel: 'OpenAI', modelLabel: 'GPT-6 Astra' });
  });

  it('keeps naming the implicit default when its copy was disabled while the task runs', async () => {
    // 新路由口径会剔除停用拷贝、落到 Cindy AI —— 说明会把 OpenAI 的花费上限归给别家。
    mocks.providers = [codexProvider('openai', 'OpenAI', true), codexProvider('xd', 'Cindy AI')];
    await expect(resolveSessionErrorContext('s1')).resolves.toMatchObject({ providerLabel: 'OpenAI' });
  });

  it('keeps naming an explicit source whose model was disabled while the task runs', async () => {
    mocks.row = { agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai' };
    mocks.providers = [codexProvider('openai', 'OpenAI', true), codexProvider('xd', 'Cindy AI')];
    await expect(resolveSessionErrorContext('s1')).resolves.toMatchObject({ providerLabel: 'OpenAI' });
  });

  it('prefers the in-memory source over the stored one', async () => {
    mocks.live = 'xd';
    await expect(resolveSessionErrorContext('s1')).resolves.toMatchObject({ providerLabel: 'Cindy AI' });
  });

  it('keeps task identity and the model ID when catalog metadata is missing', async () => {
    mocks.providers = [];
    mocks.row!.title = 'Telegram 测试';
    await expect(resolveSessionErrorContext('12345678-abcd')).resolves.toMatchObject({
      taskLabel: 'Telegram 测试（12345678）', modelLabel: 'gpt-6-astra',
    });
  });

  it('returns no context when the task is unknown', async () => {
    mocks.row = null;
    await expect(resolveSessionErrorContext('s1')).resolves.toEqual({});
  });
});
