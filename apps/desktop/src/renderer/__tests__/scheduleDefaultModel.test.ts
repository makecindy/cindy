/**
 * scheduleDefaultModel.test.ts
 * ---------------------------------------------------------------------------
 * 回归 useScheduleForm.ts 新任务默认模型的三级回退约定:
 *   1. 上次建自动化任务时选的模型(scheduleFormPrefs.lastByAgent)优先
 *   2. 没有 → 跟随对话上次选择(newMakerDraft localStorage **真实持久化值**,
 *      不吃 sanitize 的默认回填 —— 全新用户不能被对话侧的 Opus 默认顶掉)
 *   3. 都没有 → 新建任务默认(resolveNewTaskDefaultRoute,与 runner 对空 model 任务的
 *      实时解析同源);不写死型号,供应商清单未到位或无可用来源时为 ''
 *
 * 项目 vitest env=node,无 window。与 newMakerDraft.test.ts 同款:
 * vi.stubGlobal 注入最小 localStorage,避免新增 jsdom 依赖。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { CatalogModel, ProviderView } from '@cindy/model-providers';

class MemLocalStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

function model(id: string, sortOrder = 0): CatalogModel {
  return {
    id,
    name: id,
    group: 'test',
    sortOrder,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    supportsFastMode: false,
    status: 'active',
  } as CatalogModel;
}

function provider(
  id: string,
  models: Record<string, CatalogModel[]>,
  access: 'subscription' | 'managed' = 'managed',
): ProviderView {
  const agents = Object.keys(models);
  return {
    id,
    name: id,
    source: 'builtin',
    agents,
    models,
    routing: Object.fromEntries(
      agents.map((agent) => [agent, { upstream: 'https://provider.test', authStrategy: 'none' }]),
    ),
    auth: { method: 'oauth' },
    access: access === 'subscription' ? { kind: 'subscription', product: id } : { kind: access },
    connected: true,
  } as unknown as ProviderView;
}

const PROVIDERS: ProviderView[] = [
  provider('xd', {
    'claude-code': [model('claude-sonnet-5', 0), model('claude-haiku-4-5', 1)],
    codex: [model('gpt-6-luna', 0)],
  }),
  provider('anthropic', { 'claude-code': [model('claude-opus-5-5', 0)] }, 'subscription'),
];

const SCHEDULE_PREFS_KEY = 'xdt:scheduleFormPrefs:v1';
const CHAT_DRAFT_KEY = 'xdt:newMakerDraft:v1';

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/features/scheduler/hooks/useScheduleForm');
}

function seedSchedulePrefs(model: string): void {
  memStorage.setItem(
    SCHEDULE_PREFS_KEY,
    JSON.stringify({
      agentKind: 'claude-code',
      workspaceKind: 'dialogue',
      workingDir: '',
      useWorktree: false,
      lastByAgent: {
        'claude-code': { model, effort: 'high', fastMode: false },
        codex: { model: '', effort: '', fastMode: false },
      },
    }),
  );
}

function seedChatDraft(ccModel?: string, opts: { chosen?: boolean } = {}): void {
  // chosen 默认 true —— 模拟用户在 New Maker 界面显式选过 cc 模型
  // (patchVendorPrefs 会打 modelChosenByVendor 标记)。
  const chosen = opts.chosen ?? true;
  memStorage.setItem(
    CHAT_DRAFT_KEY,
    JSON.stringify({
      vendor: 'cc',
      lastByVendor: {
        cc: ccModel !== undefined ? { model: ccModel, effort: 'high', permissionMode: 'acceptEdits' } : {},
        codex: { model: 'gpt-5.4', effort: 'high', permissionMode: 'auto' },
      },
      modelChosenByVendor: chosen && ccModel !== undefined ? { cc: true } : {},
    }),
  );
}

describe('getScheduleDefaultModel 三级回退', () => {
  // Unit characterization for the reported Grok default: existing tests cover
  // schedule reads, but not whether saving a schedule changes ordinary defaults.
  it('自动任务记住 Grok 时，不改普通新建任务的模型与来源', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('pi', { model: 'gpt-6-sol', providerId: 'openai' });
    const before = draft.getDraft().lastByVendor.pi;
    const { makeFormFromSchedule, rememberScheduleFormPrefs, getScheduleDefaultRoute } = await loadModule();
    rememberScheduleFormPrefs({
      ...makeFormFromSchedule(null), agentKind: 'pi', model: 'grok-4.7', providerId: 'xai',
    });
    expect(getScheduleDefaultRoute('pi')).toEqual({ model: 'grok-4.7', providerId: 'xai' });
    expect(draft.getDraft().lastByVendor.pi).toEqual(before);
    expect(draft.getPersistedVendorModel('pi')).toBe('gpt-6-sol');
  });

  it('一级:上次建任务的选择优先(即使对话侧有不同选择)', async () => {
    seedSchedulePrefs('claude-haiku-4-5');
    seedChatDraft('claude-opus-4-8');
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-haiku-4-5');
  });

  it('二级:任务维度没记忆时跟随对话上次选择(真实持久化值)', async () => {
    seedChatDraft('claude-opus-4-8');
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-opus-4-8');
  });

  it('三级:全新用户按新建任务口径取已连接来源里的默认(订阅优先),不写死型号', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code', PROVIDERS)).toBe('claude-opus-5-5');
    expect(getScheduleDefaultModel('codex', PROVIDERS)).toBe('gpt-6-luna');
  });

  it('三级:默认模型与来源成对返回;一级没记来源时为 null', async () => {
    const { getScheduleDefaultRoute } = await loadModule();
    expect(getScheduleDefaultRoute('claude-code', PROVIDERS)).toEqual({
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
    });
    seedSchedulePrefs('claude-haiku-4-5');
    expect(getScheduleDefaultRoute('claude-code', PROVIDERS)).toEqual({
      model: 'claude-haiku-4-5',
      providerId: null,
    });
  });

  it('二级:对话里显式选过的模型带上它记着的来源', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-5-5', providerId: 'anthropic' });
    const { getScheduleDefaultRoute } = await loadModule();
    expect(getScheduleDefaultRoute('claude-code', PROVIDERS)).toEqual({
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
    });
  });

  it('表单初始化一次性应用二级回退的模型与来源', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-5-5', providerId: 'anthropic' });
    const { makeFormFromSchedule } = await loadModule();
    expect(makeFormFromSchedule(null)).toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-5-5',
      providerId: 'anthropic',
    });
  });

  it('只记了来源时,默认模型限定在该来源内,且与它整对返回', async () => {
    memStorage.setItem(
      SCHEDULE_PREFS_KEY,
      JSON.stringify({
        agentKind: 'claude-code', workspaceKind: 'dialogue', workingDir: '', useWorktree: false,
        lastByAgent: { 'claude-code': { model: '', providerId: 'xd', effort: '', fastMode: false } },
      }),
    );
    const { getScheduleDefaultRoute, makeFormFromSchedule } = await loadModule();
    expect(getScheduleDefaultRoute('claude-code', PROVIDERS, 'xd')).toEqual({
      model: 'claude-sonnet-5',
      providerId: 'xd',
    });
    // 清单未到位:先保留记着的来源,等清单到位在该来源内回填模型。
    expect(makeFormFromSchedule(null)).toMatchObject({ model: '', providerId: 'xd' });
  });

  it('三级:供应商清单未到位时留空,等清单到位再回填', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('');
  });

  it('三级:一个可用来源都没有时留空,不编造型号', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code', [])).toBe('');
  });

  it('三级:对话 draft 持久化了种子默认 model 但用户从未显式选过 → 不算上次选择,按清单校准', async () => {
    // lastByVendor 整个快照随任意 draft 写入落盘:只改过 workingDir / 只用过
    // Codex 的用户,持久化里也躺着 cc 的种子默认。没有显式选择标记时不能当成
    // 用户选择,必须按供应商清单校准(这里种子没有已连接来源)。
    seedChatDraft('claude-opus-4-8', { chosen: false });
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code', PROVIDERS)).toBe('claude-opus-5-5');
  });

  it('三级:已有任务只改思考档不打显式选择标记 → 调度按新建任务默认', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });
    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getPersistedVendorModel('cc')).toBe('');
    expect(getScheduleDefaultModel('claude-code', PROVIDERS)).toBe('claude-opus-5-5');
  });

  it('三级:已有任务换模后调度跟随这次选择', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });
    expect(draft.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');

    draft.patchVendorPrefs('cc', {
      model: 'claude-sonnet-4-7',
      effort: 'high',
    });

    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getDraft().lastByVendor.cc.model).toBe('claude-sonnet-4-7');
    expect(draft.getPersistedVendorModel('cc')).toBe('claude-sonnet-4-7');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-7');
  });

  it('三级:旧显式选模后只改思考档,调度仍用原来的模型', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });

    draft.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });

    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(draft.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-opus-4-8');
  });

  it('损坏的 localStorage JSON → 静默回退新建任务默认,不抛错', async () => {
    memStorage.setItem(CHAT_DRAFT_KEY, '{not json');
    memStorage.setItem(SCHEDULE_PREFS_KEY, '{not json');
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code', PROVIDERS)).toBe('claude-opus-5-5');
  });
});
