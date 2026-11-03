/**
 * resolveFastSupported —— device-link fast 可用判定收敛的唯一渲染层入口的单测。
 *
 * 锁住三件事:
 *  1. per-provider 分叉:同一 model id 在不同来源 supportsFastMode 不同时,结果跟 providerId 走;
 *  2. **旧被控端回退(no-break 硬约束)**:device 模式 + deviceProviders 空 → 回退拍平 capabilities;
 *  3. agent 级 hasFastMode / agentKind 空 / 模型缺失等边界。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { buildRegistry, composeAtomicModelSelection, type Catalog, type ProviderView } from '@cindy/model-providers';

import { resolveFastSupported } from '@/lib/providerModels';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';

/** 合成目录:同 id `opus` 在 official(fast=true)与 xd(fast=false)分叉;均 cc。 */
const DIVERGENT: Catalog = {
  version: '1',
  providers: [
    {
      id: 'official',
      name: 'Official',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': { upstream: 'https://a', authStrategy: 'oauth-passthrough' } },
      models: {
        'claude-code': [
          { id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: true },
        ],
      },
    },
    {
      id: 'xd',
      name: 'XD',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'managed' },
      routing: { 'claude-code': { upstream: 'https://b', authStrategy: 'gateway-key' } },
      models: {
        'claude-code': [
          { id: 'opus', name: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: false },
        ],
      },
    },
  ],
};

const localViews: ProviderView[] = buildRegistry(DIVERGENT, { official: true, xd: true });

// Execute the production restoration callbacks, including the route capability
// wiring, without mounting the entire editor or copying its decision logic.
const composerSource = readFileSync(new URL('../components/new-chat/ChatInput.tsx', import.meta.url), 'utf8');
const restorationSource = composerSource.slice(
  composerSource.indexOf('  const modelFastSupported = useCallback('),
  composerSource.indexOf('  const syncSessionDraftModelPrefs = useCallback('),
);
const restorationJs = ts.transpileModule(restorationSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const createRestorer = new Function('resolveFastSupported', 'env', `
  const {catalogDeviceId, remoteProviders, providers, currentModelAgentKind,
    ccCaps, codexCaps, piCaps, modelMemory} = env;
  const useCallback = fn => fn;
  ${restorationJs}
  return resolveFast;
`);

// Agent-switch uses a separate restoration path. Execute its production speed
// decision too: the earlier callback regression did not cover this request.
const switchFastSource = composerSource.slice(
  composerSource.indexOf('        const requestedFast = overrides?.fastMode ?? ('),
  composerSource.indexOf('        // 会话级操作按来源路由:'),
);
const switchFastJs = ts.transpileModule(switchFastSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const resolveSwitchFast = new Function('resolveFastSupported', 'env', `
  const {deviceLinkDeviceId, remoteProviders, providers, targetAgentKind,
    ccCaps, codexCaps, piCaps, providerId, newModelId, modelMemory,
    overrides, fromOtherCatalog} = env;
  ${switchFastJs}
  return targetFast;
`);

/** 最小 AgentCapabilities 工厂(helper 只读 hasFastMode + availableModels)。 */
function caps(hasFastMode: boolean, flatFast: boolean | undefined): AgentCapabilities {
  return {
    availableModels: [
      { id: 'opus', displayName: 'Opus', contextWindow: 1000, efforts: [], defaultEffort: null, supportsFastMode: flatFast },
    ],
    hasFastMode,
    effortLevels: [],
    permissionModes: [],
  };
}

describe('resolveFastSupported', () => {
  const base = {
    deviceId: undefined as string | undefined,
    deviceProviders: [] as ProviderView[],
    localProviders: localViews,
    capabilities: caps(true, true),
    modelId: 'opus',
    agentKind: 'claude-code' as const,
  };

  it('local: per-provider 分叉跟随显式 providerId', () => {
    expect(resolveFastSupported({ ...base, providerId: 'official' })).toBe(true);
    expect(resolveFastSupported({ ...base, providerId: 'xd' })).toBe(false);
  });

  it('local: providerId=null → 走 nativeDefault(cc 默认 xd)→ false', () => {
    // cc 的 nativeDefaultSourceId 优先 xd;xd 的 opus.supportsFastMode=false。
    expect(resolveFastSupported({ ...base, providerId: null })).toBe(false);
  });

  it('device 现代被控端:用 deviceProviders 的 per-provider,忽略 localProviders', () => {
    // localProviders 故意置空以证明走的是 deviceProviders。
    expect(
      resolveFastSupported({
        ...base,
        deviceId: 'dev-1',
        deviceProviders: localViews,
        localProviders: [],
        providerId: 'official',
      }),
    ).toBe(true);
    expect(
      resolveFastSupported({
        ...base,
        deviceId: 'dev-1',
        deviceProviders: localViews,
        localProviders: [],
        providerId: 'xd',
      }),
    ).toBe(false);
  });

  it('device 旧被控端(deviceProviders 空)→ 回退拍平 capabilities(no-break 守卫)', () => {
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], capabilities: caps(true, true), providerId: 'official' }),
    ).toBe(true);
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], capabilities: caps(true, false), providerId: 'official' }),
    ).toBe(false);
  });

  it('agent 级 hasFastMode=false → 恒 false', () => {
    expect(resolveFastSupported({ ...base, capabilities: caps(false, true), providerId: 'official' })).toBe(false);
  });

  it('agentKind=null → false', () => {
    expect(resolveFastSupported({ ...base, agentKind: null, providerId: 'official' })).toBe(false);
  });

  it('device 旧被控端 + 模型不在拍平 caps → false', () => {
    expect(
      resolveFastSupported({ ...base, deviceId: 'old-dev', deviceProviders: [], modelId: 'missing', providerId: 'official' }),
    ).toBe(false);
  });

  it('capabilities=null → false(无 hasFastMode)', () => {
    expect(resolveFastSupported({ ...base, capabilities: null, providerId: 'official' })).toBe(false);
  });
});

it.each([undefined, 'remote-host'])('composer restores speed by the target account after revocation (%s)', deviceId => {
  const account = (id: string, supportsUltrafastMode: boolean): ProviderView => ({
    ...localViews[0],
    id,
    agents: ['codex'],
    routing: { codex: localViews[0].routing['claude-code'] },
    models: { codex: [{
      ...localViews[0].models['claude-code']![0],
      supportsFastMode: true,
      supportsUltrafastMode,
    }] },
  });
  const eligible = account('eligible', true);
  const standard = account('standard', false);
  const executionProviders = [eligible, standard];
  const remoteProviders = { providers: deviceId ? executionProviders : [] as ProviderView[] };
  let remembered: boolean | 'ultrafast' = 'ultrafast';
  const capability = { capabilities: caps(true, true) };
  const restore = createRestorer(resolveFastSupported, {
    catalogDeviceId: deviceId,
    remoteProviders,
    // Deliberately disagree with the remote account catalog.
    providers: deviceId ? [account('eligible', true), account('standard', true)] : executionProviders,
    currentModelAgentKind: 'codex',
    ccCaps: capability, codexCaps: capability, piCaps: capability,
    modelMemory: { getFast: () => remembered },
  }) as (modelId: string, providerId: string) => boolean | 'ultrafast';
  const selection = (providerId: string) => composeAtomicModelSelection({
    efforts: ['high'], effort: 'high', fastSupported: true,
    requestedFast: restore('opus', providerId),
  });
  expect(selection('eligible').fastMode).toBe('ultrafast');
  expect(selection('standard').fastMode).toBe(false);
  // Choosing an ineligible account must not erase the shared preference.
  expect(selection('eligible').fastMode).toBe('ultrafast');
  eligible.models.codex![0].supportsUltrafastMode = false;
  expect(selection('eligible').fastMode).toBe(false);
  eligible.models.codex![0].supportsUltrafastMode = true;
  expect(selection('eligible').fastMode).toBe('ultrafast');
  if (deviceId) {
    remoteProviders.providers = [];
    expect(selection('eligible').fastMode).toBe(false);
  }
  remembered = true;
  expect(selection('standard').fastMode).toBe(true);
  remembered = false;
  expect(selection('eligible').fastMode).toBe(false);
});

// PR #6559 P1: actual performAgentSwitch request speed, unit tier. Existing
// resolveFast coverage misses both its memory and override branches. Minimal
// failure: remembered ultrafast + same model on a Fast-only target account.
it.each([undefined, 'remote-host'])('agent switch constrains restored and override speed by the target account (%s)', deviceId => {
  const account = (id: string, supportsUltrafastMode: boolean): ProviderView => ({
    ...localViews[0], id, agents: ['codex'],
    routing: { codex: localViews[0].routing['claude-code'] },
    models: { codex: [{ ...localViews[0].models['claude-code']![0],
      supportsFastMode: true, supportsUltrafastMode }] },
  });
  const eligible = account('eligible', true);
  const executionProviders = [eligible, account('standard', false)];
  let remembered: boolean | 'ultrafast' = 'ultrafast';
  const capability = { capabilities: caps(true, true) };
  const env = {
    deviceLinkDeviceId: deviceId,
    remoteProviders: { providers: deviceId ? executionProviders : [] as ProviderView[] },
    providers: deviceId ? [account('eligible', true), account('standard', true)] : executionProviders,
    targetAgentKind: 'codex',
    ccCaps: { capabilities: caps(false, false) }, codexCaps: capability, piCaps: capability,
    newModelId: 'opus', modelMemory: { getFast: () => remembered },
    fromOtherCatalog: false,
  };
  const speed = (providerId: string, overrides?: { fastMode: boolean | 'ultrafast' }) =>
    resolveSwitchFast(resolveFastSupported, { ...env, providerId, overrides });
  for (const overrides of [undefined, { fastMode: 'ultrafast' as const }]) {
    expect(speed('eligible', overrides)).toBe('ultrafast');
    expect(speed('standard', overrides)).toBe(false);
    expect(speed('eligible', overrides)).toBe('ultrafast');
    eligible.models.codex![0].supportsUltrafastMode = false;
    expect(speed('eligible', overrides)).toBe(false);
    eligible.models.codex![0].supportsUltrafastMode = true;
  }
  if (deviceId) {
    env.remoteProviders.providers = [];
    expect(speed('eligible')).toBe(false);
    expect(speed('eligible', { fastMode: 'ultrafast' })).toBe(false);
  }
  remembered = true;
  expect(speed('standard')).toBe(true);
  expect(speed('standard', { fastMode: false })).toBe(false);
  // Picks from another computer's catalog have already been reconciled there.
  expect(resolveSwitchFast(resolveFastSupported, {
    ...env, providerId: 'standard', fromOtherCatalog: true,
    overrides: { fastMode: 'ultrafast' },
  })).toBe('ultrafast');
});
