import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';

import {
  addBotProfile,
  addBotProfileAndWait,
  duplicateBotProfile,
  getBotProfiles,
  removeBotProfile,
  setCanonicalBotSession,
  setBotHidden,
  setBotPinned,
  updateBotProfile,
} from '../botStore';
import { getDefaultModelForVendor } from '@/lib/modelDefinitions';
import { getCachedProvidersSnapshot } from '@/lib/providersSnapshotStore';
import { getPersistedVendorModel } from '@/state/newMakerDraft';

vi.mock('@/lib/modelDefinitions', () => ({
  getDefaultModelForVendor: vi.fn(() => ({
    id: 'catalog-new-session-default',
    label: 'Catalog default',
    description: '',
    efforts: ['medium'],
    defaultEffort: 'medium',
    vendorKey: 'pi',
  })),
}));

vi.mock('@/lib/providersSnapshotStore', () => ({
  getCachedProvidersSnapshot: vi.fn(),
}));

vi.mock('@/lib/localCatalogSnapshot', () => ({
  refreshLocalCatalogSnapshot: vi.fn(async () => true),
}));

function piModel(
  id: string,
  sortOrder = 0,
  defaultEffort: string | null = 'high',
): CatalogModel {
  return {
    id,
    name: id,
    group: 'test',
    sortOrder,
    contextWindow: 200_000,
    efforts: defaultEffort ? [defaultEffort] : [],
    defaultEffort,
    supportsFastMode: false,
    status: 'active',
  } as CatalogModel;
}

function piProvider(
  id: string,
  connected: boolean,
  models: CatalogModel[],
  access: 'subscription' | 'managed' = 'managed',
): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['pi'],
    models: { pi: models },
    routing: {
      pi: { upstream: 'https://provider.test', authStrategy: 'none' },
    },
    auth: { method: 'oauth' },
    access: access === 'subscription' ? { kind: 'subscription', product: id } : { kind: access },
    connected,
  } as unknown as ProviderView;
}

function setProviders(providers: ProviderView[]): void {
  vi.mocked(getCachedProvidersSnapshot).mockReturnValue({
    dataOwnerId: null,
    ownerGeneration: 0,
    providers,
    providerOrder: providers.map((provider) => provider.id),
  });
}

describe('bot profile store', () => {
  const createdIds: string[] = [];

  beforeEach(() => {
    vi.mocked(getDefaultModelForVendor).mockReturnValue({
      id: 'catalog-new-session-default',
      label: 'Catalog default',
      description: '',
      efforts: ['medium'],
      defaultEffort: 'medium',
      vendorKey: 'pi',
    });
    setProviders([
      piProvider('xd', true, [piModel('z-ai/glm-5.3-flash')]),
    ]);
  });

  afterEach(() => {
    for (const id of createdIds.splice(0)) removeBotProfile(id);
  });

  it('creates a Bot profile without a fake Session projection', () => {
    const bot = addBotProfile({
      name: 'Telegram release helper',
      channel: 'telegram',
      description: 'Release notes',
    });
    createdIds.push(bot.id);

    expect(bot.sessions).toHaveLength(0);
    expect(bot.canonicalSessionId).toBeUndefined();
  });

  it('does not let a legacy harness hint bypass the global Bot model chain', () => {
    expect(getPersistedVendorModel('cc')).toBeFalsy();

    const bot = addBotProfile({
      name: 'Brand new',
      channel: 'local',
      description: '',
      capabilities: { harness: 'claude' },
    });
    createdIds.push(bot.id);

    expect(bot.capabilities).toMatchObject({
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
  });

  it('defaults new Bots to Pi GLM-5.3-Flash when it is selectable', () => {
    const bot = addBotProfile({ name: 'Pi Bot', channel: 'local', description: '' });
    createdIds.push(bot.id);

    expect(bot.capabilities).toMatchObject({
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
  });

  it('does not invent an unconfigured fallback when GLM-5.3-Flash is unavailable', () => {
    setProviders([
      piProvider(
        'openai',
        true,
        [
          piModel('chatgpt/gpt-second', 9),
          piModel('chatgpt/gpt-first', 0, 'medium'),
        ],
        'subscription',
      ),
      piProvider('xd', false, [piModel('z-ai/glm-5.3-flash')]),
    ]);

    const bot = addBotProfile({ name: 'Fallback Bot', channel: 'local', description: '' });
    createdIds.push(bot.id);

    expect(bot.capabilities).toMatchObject({
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
  });

  it('keeps the durable Pi + GLM default while the catalog is still unavailable', () => {
    setProviders([
      piProvider('xd', false, [piModel('z-ai/glm-5.3-flash')]),
    ]);

    const bot = addBotProfile({ name: 'Empty Bot', channel: 'local', description: '' });
    createdIds.push(bot.id);

    expect(bot.capabilities).toMatchObject({
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
  });

  it('creates new Bots hands-on by default, and never with memory turned off', () => {
    const bot = addBotProfile({ name: 'Fresh teammate', channel: 'local', description: '' });
    createdIds.push(bot.id);

    // 产品裁决 2026-08-18:默认放手做;记忆恒开。
    expect(bot.capabilities.permissions).toBe('trusted');
    expect(bot.capabilities.memory).toBe(true);
  });

  it('persists Hide and Pin as roster metadata without changing lifecycle status', async () => {
    const original = addBotProfile({ name: 'Roster Bot', channel: 'local', description: '' });
    createdIds.push(original.id);
    let persisted = { ...original, status: 'active' as const, hiddenAt: null as number | null, pinnedAt: null as number | null };
    const update = vi.fn(async (input: { id: string; hidden?: boolean; pinned?: boolean }) => {
      persisted = {
        ...persisted,
        ...(input.hidden !== undefined ? { hiddenAt: input.hidden ? 20 : null } : {}),
        ...(input.pinned !== undefined ? { pinnedAt: input.pinned ? 30 : null } : {}),
      };
      return persisted;
    });
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      electronAPI: { localDb: { bots: { update } } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    try {
      await setBotHidden(original.id, true);
      await setBotPinned(original.id, true);
      expect(update).toHaveBeenNthCalledWith(1, { id: original.id, hidden: true });
      expect(update).toHaveBeenNthCalledWith(2, { id: original.id, pinned: true });
      expect(getBotProfiles().find((item) => item.id === original.id)).toMatchObject({
        status: 'active',
        hiddenAt: 20,
        pinnedAt: 30,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('duplicates identity, capabilities, Skills, and appearance without copying chat ownership', async () => {
    const source = addBotProfile({
      name: 'Researcher',
      channel: 'local',
      description: 'Find evidence',
      identitySource: '# SOUL\nResearch carefully.',
      userContextSource: '# USER\nChris',
      avatar: '🔎',
      avatarColor: 'blue',
      skills: ['web-research'],
      capabilities: { permissions: 'trusted' },
    });
    source.hiddenAt = 10;
    source.pinnedAt = 11;
    source.canonicalSessionId = 'source-chat';
    source.sessions = [{
      id: 'source-chat', title: 'Researcher', kind: 'chat', channel: 'local', updatedAt: 12,
    }];
    createdIds.push(source.id);
    const create = vi.fn(async (input: Record<string, unknown>) => ({
      ...source,
      id: String(input.id),
      name: String(input.name),
      hiddenAt: null,
      pinnedAt: null,
      canonicalSessionId: undefined,
      sessions: [],
    }));
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      electronAPI: { localDb: { bots: { create } } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    try {
      const copy = await duplicateBotProfile(source.id);
      createdIds.push(copy.id);
      expect(copy).toMatchObject({
        name: 'Researcher-2',
        description: 'Find evidence',
        identitySource: '# SOUL\nResearch carefully.',
        userContextSource: '# USER\nChris',
        avatar: '🔎',
        avatarColor: 'blue',
        skills: ['web-research'],
        hiddenAt: null,
        pinnedAt: null,
        sessions: [],
      });
      expect(copy.canonicalSessionId).toBeUndefined();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Researcher-2',
        identitySource: '# SOUL\nResearch carefully.',
        capabilities: expect.objectContaining({ permissions: 'trusted' }),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('replaces the optimistic Bot with the authoritative profile returned by main', async () => {
    const create = vi.fn(async (input: { id: string }) => ({
      id: input.id,
      name: 'Hermes identity bot',
      description: 'Authoritative profile',
      identitySource: '# SOUL\nYou are the real Bot identity.',
      userContextSource: '# USER\nChris',
      avatar: '🪽',
      avatarColor: 'blue',
      enabled: true,
      status: 'active',
      currentVersion: 1,
      createdAt: 123,
      skills: ['research'],
      capabilities: {
        harness: 'claude',
        model: 'claude-sonnet-4-6',
        permissions: 'ask',
      },
      sessions: [],
    }));
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      electronAPI: { localDb: { bots: { create } } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    try {
      const bot = await addBotProfileAndWait({
        name: 'Draft name',
        channel: 'local',
        description: '',
        identitySource: '# SOUL\nPersistent release steward.',
        userContextSource: '# USER\nWorks with the release team.',
        avatar: '🛠️',
        avatarColor: 'blue',
        skills: ['research'],
        capabilities: { permissions: 'trusted' },
      });
      createdIds.push(bot.id);
      expect(bot).toMatchObject({
        name: 'Hermes identity bot',
        identitySource: '# SOUL\nYou are the real Bot identity.',
        userContextSource: '# USER\nChris',
        avatar: '🪽',
      });
      expect(getBotProfiles().find((item) => item.id === bot.id)).toMatchObject({
        identitySource: '# SOUL\nYou are the real Bot identity.',
      });
      // 新建默认改成 trusted 之后,**读**到的 profile 仍以 main 的值为准:
      // 已存在的伙伴不会因为默认值变了就被悄悄升成信任。
      expect(bot.capabilities.permissions).toBe('ask');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          identitySource: '# SOUL\nPersistent release steward.',
          userContextSource: '# USER\nWorks with the release team.',
          avatar: '🛠️',
          avatarColor: 'blue',
          skills: ['research'],
          capabilities: expect.objectContaining({
            permissions: 'trusted',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps one canonical projection and archives the previous one', () => {
    const bot = addBotProfile({ name: 'History helper', channel: 'local', description: '' });
    createdIds.push(bot.id);

    setCanonicalBotSession(bot.id, { id: 'session-1', title: 'History helper', updatedAt: 1 });
    setCanonicalBotSession(bot.id, { id: 'session-2', title: 'History helper', updatedAt: 2 });

    const current = getBotProfiles().find((item) => item.id === bot.id);
    expect(current?.canonicalSessionId).toBe('session-2');
    expect(current?.sessions.filter((item) => item.kind === 'chat')).toHaveLength(1);
    expect(current?.sessions.find((item) => item.id === 'session-1')).toMatchObject({
      kind: 'history',
      status: 'archived',
    });
  });

  it('returns the persisted Bot profile when updating only the selected Bot', async () => {
    const first = addBotProfile({ name: 'First', channel: 'local', description: '' });
    const second = addBotProfile({ name: 'Second', channel: 'slack', description: '' });
    createdIds.push(first.id, second.id);

    const updated = await updateBotProfile(first.id, { name: 'Renamed', enabled: false });

    expect(updated).toMatchObject({
      id: first.id,
      name: 'Renamed',
      enabled: false,
    });

    expect(getBotProfiles().find((bot) => bot.id === first.id)).toMatchObject({
      name: 'Renamed',
      enabled: false,
    });
    expect(getBotProfiles().find((bot) => bot.id === second.id)?.name).toBe('Second');

    removeBotProfile(first.id);
    expect(getBotProfiles().some((bot) => bot.id === first.id)).toBe(false);
    expect(getBotProfiles().some((bot) => bot.id === second.id)).toBe(true);
  });
});

/**
 * 保存失败时的回滚边界。
 *
 * 原先 updateBotProfile 的 catch 是 `profiles = previous` —— 拿**整张列表**在
 * 乐观写之前的快照覆盖回去。于是从乐观写到失败之间落地的任何其它写入都被静默
 * 撤销。三个并发写入方是真实存在的(生命周期设置、伙伴设置页、对话界面的模型
 * 回写),其中模型回写是即发即忘、失败无声的,它的回滚会把用户刚在设置页保存的
 * 修改一起抹掉;而伙伴列表只在进入伙伴页时重新投影,所以界面会一直显示被还原的
 * 旧值,直到用户离开再进来。
 */
describe('保存失败只回滚自己那一行', () => {
  const createdIds: string[] = [];
  let restoreApi: (() => void) | null = null;

  afterEach(() => {
    restoreApi?.();
    restoreApi = null;
    for (const id of createdIds.splice(0)) removeBotProfile(id);
  });

  /**
   * 让 localDb.bots.update 交出每次调用的 reject,由用例决定何时失败。
   *
   * 这个文件跑在 node 环境(没有 window),而 botsApi() 与 persist() 都以
   * `typeof window !== 'undefined'` 为闸 —— 所以要连 localStorage 一起补齐,
   * 否则 persist() 会在写入时炸。用例结束后整个 window 移除,回到原状。
   */
  function stubDeferredUpdates(): (id: string) => (error: unknown) => void {
    // 同一个伙伴可能有多次写在飞 —— 按调用顺序排队,不能后来的覆盖先来的。
    const rejectors = new Map<string, Array<(error: unknown) => void>>();
    const store = new Map<string, string>();
    const globalScope = globalThis as unknown as { window?: Record<string, unknown> };
    const hadWindow = 'window' in globalThis;
    const previousWindow = globalScope.window;
    globalScope.window = {
      ...(previousWindow ?? {}),
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
      electronAPI: {
        localDb: {
          bots: {
            update: (input: { id: string }) =>
              new Promise((_resolve, reject) => {
                const queue = rejectors.get(input.id) ?? [];
                queue.push(reject);
                rejectors.set(input.id, queue);
              }),
          },
        },
      },
    };
    restoreApi = () => {
      if (hadWindow) globalScope.window = previousWindow;
      else delete globalScope.window;
    };
    /** 取该伙伴**最早**那次还没结算的写并让它失败。 */
    return (id: string) =>
      (error: unknown) => {
        const next = rejectors.get(id)?.shift();
        if (!next) throw new Error(`no pending update for ${id}`);
        next(error);
      };
  }

  it('另一个伙伴在同期保存的修改不被撤销', async () => {
    const failing = addBotProfile({ name: 'Failing', channel: 'local', description: '' });
    const other = addBotProfile({ name: 'Other', channel: 'local', description: '' });
    createdIds.push(failing.id, other.id);

    const rejectorFor = stubDeferredUpdates();

    const pendingFailure = updateBotProfile(failing.id, { description: '这次会失败' }).catch(
      () => undefined,
    );
    // 在上面那次还在飞的时候,另一个伙伴也写了一笔。
    const pendingOther = updateBotProfile(other.id, { description: '另一个伙伴改的' }).catch(
      () => undefined,
    );

    rejectorFor(failing.id)(new Error('write failed'));
    await pendingFailure;

    expect(getBotProfiles().find((bot) => bot.id === other.id)?.description).toBe(
      '另一个伙伴改的',
    );
    // 失败的那一行照常回滚。
    expect(getBotProfiles().find((bot) => bot.id === failing.id)?.description).toBe('');

    rejectorFor(other.id)(new Error('cleanup'));
    await pendingOther;
  });

  it('同一个伙伴上更新的那次写赢过落后的回滚', async () => {
    const bot = addBotProfile({ name: 'Same row', channel: 'local', description: '' });
    createdIds.push(bot.id);

    const rejectorFor = stubDeferredUpdates();

    const firstWrite = updateBotProfile(bot.id, { description: '第一次' }).catch(() => undefined);
    // 第二次写覆盖了同一行,并且代际更新。
    const secondWrite = updateBotProfile(bot.id, { description: '第二次' }).catch(() => undefined);

    // 第一次失败:它已经不是最新那次写,不许把界面拽回「第一次」之前的值。
    rejectorFor(bot.id)(new Error('stale write failed'));
    await firstWrite;

    expect(getBotProfiles().find((item) => item.id === bot.id)?.description).toBe('第二次');

    rejectorFor(bot.id)(new Error('cleanup'));
    await secondWrite;
  });
});
