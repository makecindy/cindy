import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import * as locks from '../../device-link/crossProcessLock';
import os from 'node:os';
import path from 'node:path';

import type { ProviderView } from '@cindy/model-providers';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  readBotModelChainSettingsState,
  resetBotModelChainSettings,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../bot-model-chain-settings-store';

const providerService = vi.hoisted(() => ({
  listProviders: vi.fn<() => Promise<ProviderView[]>>(),
}));
vi.mock('../createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => providerService,
}));

vi.mock('../index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => ['claude-code', 'codex', 'pi'] }) }));

const owner = vi.hoisted(() => ({ root: '', key: 'owner-a:1' }));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: owner.key }),
  activeOwnerScopeKey: () => owner.key,
  ownerScopedUserDataPath: () => owner.root,
}));

import { setModelVisibilityMirror } from '../model-visibility-mirror';
import { setNewMakerDraftCache } from '../newMakerDefaultsCache';
beforeEach(() => {
  providerService.listProviders.mockReset().mockResolvedValue([]);
  setModelVisibilityMirror({}, { fallback: true });
  setNewMakerDraftCache({ selectedRoute: { harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
});

const roots: string[] = [];

async function testRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-model-chain-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('bot model chain settings store', () => {
  // unit regression: a new-task draft change used to switch existing teammates,
  // including unattended routine sends. Exercise the actual default resolver
  // and reset with a different harness/source/model/tuning in the draft.
  it('keeps teammate defaults independent of new-task selections, including after reset', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      auth: { method: 'oauth' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    const before = await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers });
    expect(before).toHaveLength(1);
    providers.push({
      id: 'anthropic', source: 'builtin', connected: true, agents: ['claude-code'],
      auth: { method: 'oauth' }, access: { kind: 'subscription', product: 'Claude' },
      routing: { 'claude-code': { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { 'claude-code': [{ id: 'other-model', mode: 'chat', status: 'active', efforts: ['high'], defaultEffort: 'high' }] },
    } as ProviderView);
    setNewMakerDraftCache({ selectedRoute: { harness: 'claude', providerId: 'anthropic', model: 'other-model', effort: 'high', fastMode: true }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual(before);
    await writeBotModelChainSettings([{ harness: 'pi', model: 'custom-model' }], { rootPath });
    expect((await resetBotModelChainSettings({ rootPath, providers })).value.modelChain).toEqual(before);
  });

  it('keeps unconfigured defaults empty without writing a Gateway placeholder', async () => {
    const rootPath = await testRoot();
    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: false, value: { modelChain: [] },
    });
  });

  it('resolves uncustomized defaults from current connections without writing an override', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      auth: { method: 'oauth' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    // Teammates can resolve defaults before any new-task draft has synchronized.
    setNewMakerDraftCache({ lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    const state = await readBotModelChainSettingsState({ rootPath, providers });
    expect(state.isCustomized).toBe(false);
    expect(state.value.modelChain[0]).toMatchObject({
      harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium',
    });
    expect(await fs.readdir(rootPath)).toEqual([]);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers }))
      .toEqual(state.value.modelChain);
    await writeBotModelChainSettings(state.value.modelChain, { rootPath });
    expect((await readBotModelChainSettingsState({ rootPath, providers: [] })).value)
      .toEqual(state.value);
  });

  it('uses only enabled Luna with catalog tuning for new and existing default-following partners', async () => {
    const rootPath = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      auth: { method: 'oauth' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: ['gpt-5.6-sol', 'gpt-5.6-luna'].map(id => ({
        id, mode: 'chat', status: 'active', efforts: ['low', 'medium'], defaultEffort: 'low',
      })) },
    }] as ProviderView[];
    const selectedRoute = { harness: 'codex' as const, providerId: 'openai', model: 'gpt-5.6-luna', effort: 'medium', fastMode: false };
    const expected = [{ ...selectedRoute, effort: 'low' }];
    setModelVisibilityMirror({ 'codex:openai:gpt-5.6-luna': true }, { fallback: false, followCatalogKeys: [] });
    setNewMakerDraftCache({ selectedRoute, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect((await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain).toEqual(expected);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null, model: 'gpt-5.6-sol', effort: 'low' }, { rootPath, providers })).toEqual(expected);
    setNewMakerDraftCache({ selectedRoute: { ...selectedRoute, providerId: null }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, owner.key);
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual(expected);
    expect(await fs.readdir(rootPath)).toEqual([]);
    setModelVisibilityMirror({}, { fallback: false, followCatalogKeys: [] });
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual([]);
  });

  it('persists an ordered 1-5 route chain as the Main-owned source of truth', async () => {
    const rootPath = await testRoot();
    const modelChain = [
      {
        harness: 'codex' as const,
        model: 'gpt-5.6-sol',
        providerId: 'openai',
        effort: 'high',
        fastMode: false,
      },
      {
        harness: 'pi' as const,
        model: 'z-ai/glm-5.3-flash',
        providerId: 'xd',
        effort: '',
        fastMode: true,
      },
    ];

    await writeBotModelChainSettings(modelChain, { rootPath });

    expect(await readBotModelChainSettingsState({ rootPath, providers: [] })).toMatchObject({
      isCustomized: true,
      value: { modelChain },
    });

    expect(await readEffectiveBotModelChain({
      model: 'legacy-cache',
      harness: 'claude',
      modelOverride: null,
    }, { rootPath })).toEqual(modelChain);
    expect(await readEffectiveBotModelChain({
      modelChainOverride: null,
      modelChain: [{ harness: 'claude', model: 'stale-cache' }],
    }, { rootPath })).toEqual(modelChain);
  });

  it('keeps an explicit per-Bot chain authoritative even if its cache field drifted', async () => {
    const rootPath = await testRoot();
    const explicit = [{
      harness: 'claude' as const,
      model: 'claude-opus-5',
      providerId: 'anthropic',
      effort: 'high',
      fastMode: false,
    }];

    expect(await readEffectiveBotModelChain({
      modelChain: [{ harness: 'pi', model: 'stale-cache' }],
      modelChainOverride: explicit,
    }, { rootPath })).toEqual(explicit);
  });
  it('clears even an explicitly saved default and leaves per-Bot overrides and other owners intact', async () => {
    const rootPath = await testRoot();
    const otherRoot = await testRoot();
    const providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      auth: { method: 'oauth' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    const defaults = (await readBotModelChainSettingsState({ rootPath, providers })).value.modelChain;
    const custom = [{ ...defaults[0]!, model: 'custom-model' }];
    await writeBotModelChainSettings(defaults, { rootPath });
    await writeBotModelChainSettings(custom, { rootPath: otherRoot });
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);

    expect(await resetBotModelChainSettings({ rootPath, providers })).toMatchObject({
      value: { modelChain: defaults }, isCustomized: false, customizedKeys: [],
    });
    await expect(fs.stat(path.join(rootPath, 'bot-model-chain-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers })).toEqual(defaults);
    expect(await readEffectiveBotModelChain({ modelChainOverride: custom }, { rootPath })).toEqual(custom);
    expect(await readBotModelChainSettingsState({ rootPath: otherRoot })).toMatchObject({
      isCustomized: true, value: { modelChain: custom },
    });
    // Repeating restore is safe and never writes a default snapshot.
    expect((await resetBotModelChainSettings({ rootPath, providers })).isCustomized).toBe(false);
  });

  it('preserves disk and customized state if removing the override fails', async () => {
    const rootPath = await testRoot();
    const custom = [{ harness: 'pi', model: 'custom-model' }];
    await writeBotModelChainSettings(custom, { rootPath });
    const file = path.join(rootPath, 'bot-model-chain-settings.json');
    const before = await fs.readFile(file, 'utf8');
    const unlink = syncFs.unlinkSync;
    vi.spyOn(syncFs, 'unlinkSync').mockImplementation((target) => {
      if (target === file) throw new Error('permission denied');
      unlink(target);
    });
    await expect(resetBotModelChainSettings({ rootPath })).rejects.toThrow('permission denied');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);
  });

  it('does not clear either account when the owner changes while waiting for the lock', async () => {
    owner.root = await testRoot();
    owner.key = 'owner-a:1';
    await writeBotModelChainSettings([{ harness: 'pi', model: 'owner-a-model' }]);
    const file = path.join(owner.root, 'bot-model-chain-settings.json');
    const before = await fs.readFile(file, 'utf8');
    const oldRoot = owner.root;
    const otherRoot = await testRoot();
    await writeBotModelChainSettings([{ harness: 'pi', model: 'owner-b-model' }], { rootPath: otherRoot });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_path, _options, operation) => {
      owner.root = otherRoot;
      owner.key = 'owner-b:2';
      return operation({ held: true });
    });
    await expect(resetBotModelChainSettings()).rejects.toThrow('scope changed');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await readBotModelChainSettingsState({ rootPath: oldRoot })).isCustomized).toBe(true);
    expect((await readBotModelChainSettingsState({ rootPath: otherRoot })).value.modelChain[0]?.model).toBe('owner-b-model');
  });

  it('preserves the override if the shared lock cannot be acquired', async () => {
    const rootPath = await testRoot();
    await writeBotModelChainSettings([{ harness: 'pi', model: 'custom-model' }], { rootPath });
    vi.spyOn(locks, 'withCrossProcessLock').mockImplementationOnce(async (_path, _options, operation) => operation({ held: false, reason: 'busy' }));
    await expect(resetBotModelChainSettings({ rootPath })).rejects.toThrow('busy');
    expect((await readBotModelChainSettingsState({ rootPath })).isCustomized).toBe(true);
  });

  describe('模型组 Auto 被服务端挪到另一家 Cindy 来源', () => {
    const AUTO = 'auto/group-1';
    const view = (id: string, source: ProviderView['source'], modelIds: string[]) =>
      ({
        id,
        name: id,
        source,
        connected: true,
        agents: ['pi'],
        auth: { method: 'managed' },
        access: { kind: 'managed' },
        routing: { pi: { upstream: 'https://example.invalid', authStrategy: 'api-key-header' } },
        models: {
          pi: modelIds.map((id) => ({
            id,
            name: id,
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          })),
        },
      }) as unknown as ProviderView;
    // 管理员把 Auto 的目标从号池模型切到平台模型。
    const providers = [
      view('xd', 'builtin', ['auto', AUTO]),
      view('org-pool', 'organization', ['pool-model']),
    ];
    const route = (providerId: string | null, model = AUTO) => ({
      harness: 'pi' as const,
      model,
      providerId,
      effort: '',
      fastMode: false,
    });

    it('伙伴自己存的路由在使用时改用新来源，不改写资料里的值', async () => {
      const rootPath = await testRoot();
      const config = { modelChainOverride: [route('org-pool'), route('org-pool', 'pool-model')] };
      expect(await readEffectiveBotModelChain(config, { rootPath, providers })).toEqual([
        route('xd'),
        route('org-pool', 'pool-model'),
      ]);
      expect(config.modelChainOverride[0].providerId).toBe('org-pool');
    });

    // unit: #6355 / discussion_r4316083415。已有用例只传同步目录，未覆盖读目录时切账号。
    // 真实读取入口必须拒绝旧账号的结果；deferred 精确控制退出/切账号，不做真实等待。
    it.each([
      ['owner-b:2', false],
      ['signed-out:2', false],
      ['owner-b:2', true],
    ] as const)(
      '读取 Auto 目录时 owner 变成 %s（读取失败=%s）就拒绝旧结果',
      async (nextOwner, fails) => {
        owner.key = 'owner-a:1';
        let finish!: (providers: ProviderView[]) => void;
        let fail!: (error: Error) => void;
        providerService.listProviders.mockReturnValueOnce(
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
        );
        const config = { modelChainOverride: [route('org-pool')] };
        const pending = readEffectiveBotModelChain(config);
        const rejected = expect(pending).rejects.toThrow('Bot model chain owner changed');
        owner.key = nextOwner;
        if (fails) fail(new Error('catalog unavailable'));
        else finish(providers);
        await rejected;
        expect(config.modelChainOverride).toEqual([route('org-pool')]);
        // 下一次读取在新账号下独立解析，不复用刚丢弃的目录。
        providerService.listProviders.mockResolvedValueOnce([
          view('xd', 'builtin', ['auto']),
          view('org-pool', 'organization', [AUTO]),
        ]);
        expect(await readEffectiveBotModelChain(config)).toEqual([route('org-pool')]);
      },
    );

    it('账号没变且目录读取失败时保留原链，交给既有路由校验', async () => {
      providerService.listProviders.mockRejectedValueOnce(new Error('catalog unavailable'));
      expect(await readEffectiveBotModelChain({ modelChainOverride: [route('org-pool')] })).toEqual(
        [route('org-pool')],
      );
    });

    it('用户自定义的伙伴默认同样跟随；没挪动、预设 auto 与普通模型原样', async () => {
      const rootPath = await testRoot();
      await writeBotModelChainSettings([route('org-pool'), route('xd', 'auto')], { rootPath });
      expect(
        await readEffectiveBotModelChain({ modelChainOverride: null }, { rootPath, providers }),
      ).toEqual([route('xd'), route('xd', 'auto')]);
      // 保存的设置文件仍是原值。
      expect(
        (await readBotModelChainSettingsState({ rootPath, providers: [] })).value.modelChain[0],
      ).toMatchObject({ providerId: 'org-pool' });
      expect(
        await readEffectiveBotModelChain(
          { modelChainOverride: [route('xd')] },
          { rootPath, providers },
        ),
      ).toEqual([route('xd')]);
    });
  });
});
