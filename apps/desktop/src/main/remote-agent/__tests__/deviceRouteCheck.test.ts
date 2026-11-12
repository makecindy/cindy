import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { checkDeviceRoute, deviceOffersModel } from '../controller/deviceRouteCheck';

function view(id: string, models: Record<string, string[]>): ProviderView {
  return {
    id,
    name: id,
    agents: Object.keys(models),
    connected: true,
    remoteInvocationEnabled: true,
    routing: {},
    models: Object.fromEntries(
      Object.entries(models).map(([agent, ids]) => [agent, ids.map((modelId) => ({ id: modelId, efforts: [], defaultEffort: null }))]),
    ),
  } as unknown as ProviderView;
}

describe('deviceOffersModel', () => {
  const views = [view('anthropic', { 'claude-code': ['claude-opus-5-5'] })];

  it('按来源与 Agent 匹配,长上下文写法回落到基础条目', () => {
    expect(deviceOffersModel(views, 'claude-code', 'anthropic', 'claude-opus-5-5')).toBe(true);
    expect(deviceOffersModel(views, 'claude-code', 'anthropic', 'claude-opus-5-5[1m]')).toBe(true);
    expect(deviceOffersModel(views, 'claude-code', null, 'claude-opus-5-5')).toBe(true);
  });

  it('那台没开放这个来源 / 没有这个模型 / Agent 不对时为 false', () => {
    expect(deviceOffersModel(views, 'claude-code', 'xd', 'claude-opus-5-5')).toBe(false);
    expect(deviceOffersModel(views, 'claude-code', 'anthropic', 'anthropic/claude-opus-5-5[1m]')).toBe(false);
    expect(deviceOffersModel(views, 'codex', 'anthropic', 'claude-opus-5-5')).toBe(false);
  });
});

describe('checkDeviceRoute', () => {
  it('目录读不到 = unreachable,读到但没有 = not-offered,可用 = null', async () => {
    const views = [view('anthropic', { 'claude-code': ['claude-opus-5-5'] })];
    await expect(checkDeviceRoute(async () => { throw new Error('offline'); }, 'claude-code', null, 'x'))
      .resolves.toBe('unreachable');
    await expect(checkDeviceRoute(async () => views, 'claude-code', 'xd', 'claude-opus-5-5'))
      .resolves.toBe('not-offered');
    await expect(checkDeviceRoute(async () => views, 'claude-code', 'anthropic', 'claude-opus-5-5'))
      .resolves.toBeNull();
  });

  it('分享来的供应商不可用时保留分享原因', async () => {
    for (const code of ['REMOTE_AGENT_SHARE_PAUSED', 'REMOTE_AGENT_SHARE_REMOVED', 'REMOTE_AGENT_SHARE_UNAVAILABLE']) {
      await expect(checkDeviceRoute(async () => { throw new Error(`[${code}] nope`); }, 'claude-code', null, 'x'))
        .resolves.toBe(code);
    }
    await expect(checkDeviceRoute(async () => { throw new Error('see [REMOTE_AGENT_SHARE_PAUSED]'); }, 'claude-code', null, 'x'))
      .resolves.toBe('unreachable');
  });
});
