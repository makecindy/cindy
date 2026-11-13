/*
 * 测试价值
 * - 生产入口与可观察结果：projectSubscriptionPoolCatalog 返回的目录里 `openai` 的模型表。桌面的
 *   getDesktopSelectableCatalog 与 Node Host 的 model-context 都经它投影订阅账号池。
 * - 规则依据：只把「属于 OpenAI 账号池、未暂停、已登录」的导入 Codex 账号的模型并进 `openai`，
 *   不覆盖 `openai` 已有的同名模型；池断开或没有别名时原样返回同一个对象。
 * - 最小失败输入：并入了暂停或未登录账号的模型；覆盖了 `openai` 自己的同名模型；池断开仍投影。
 * - tier：unit（纯函数，端口全部是假实现）。
 */
import { describe, expect, it } from 'vitest';
import type { Catalog } from '@cindy/model-providers';

import { projectSubscriptionPoolCatalog } from '../subscriptionPoolCatalog.js';

const model = (id: string, contextWindow = 100_000) => ({ id, name: id, contextWindow, efforts: [], defaultEffort: null });

function catalog(): Catalog {
  return {
    providers: [
      { id: 'openai', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('shared', 1)] }, routing: {} },
      { id: 'acct-a', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('shared', 2), model('only-a')] }, routing: {} },
      { id: 'acct-b', agents: ['codex'], auth: { native: 'codex' }, models: { codex: [model('only-b')] }, routing: {} },
    ],
  } as unknown as Catalog;
}

const pool = (overrides: Record<string, unknown> = {}) => ({
  legacyCodexAccounts: { 'acct-a': 'pool-a', 'acct-b': 'pool-b' },
  accounts: [{ id: 'pool-a' }, { id: 'pool-b', paused: true }],
  ...overrides,
});

describe('projectSubscriptionPoolCatalog', () => {
  it('adds models of active, signed-in pool accounts to openai without replacing its own', () => {
    const projected = projectSubscriptionPoolCatalog(catalog(), {
      readPool: () => pool() as never,
      codexAccountState: () => ({ authenticated: true }),
    });
    const openai = projected.providers.find((provider) => provider.id === 'openai')!;
    expect(openai.models.codex!.map((entry) => entry.id)).toEqual(['shared', 'only-a']);
    expect(openai.models.codex![0]!.contextWindow).toBe(1);
  });

  it('skips accounts that are not signed in', () => {
    const projected = projectSubscriptionPoolCatalog(catalog(), {
      readPool: () => pool() as never,
      codexAccountState: (id) => ({ authenticated: id !== 'acct-a' }),
    });
    expect(projected.providers.find((provider) => provider.id === 'openai')!.models.codex!.map((entry) => entry.id)).toEqual(['shared']);
  });

  it('returns the same catalog when the pool is disconnected or has no aliases', () => {
    const input = catalog();
    const signedIn = { codexAccountState: () => ({ authenticated: true }) };
    expect(projectSubscriptionPoolCatalog(input, { ...signedIn, readPool: () => pool({ disconnected: true }) as never })).toBe(input);
    expect(projectSubscriptionPoolCatalog(input, { ...signedIn, readPool: () => null })).toBe(input);
  });
});
