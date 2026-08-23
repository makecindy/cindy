/**
 * scheduleDefaultModel.test.ts
 * ---------------------------------------------------------------------------
 * 回归 useScheduleForm.ts 新任务默认模型的三级回退约定:
 *   1. 上次建自动化任务时选的模型(scheduleFormPrefs.lastByAgent)优先
 *   2. 没有 → 跟随对话上次选择(newMakerDraft localStorage **真实持久化值**,
 *      不吃 sanitize 的默认回填 —— 全新用户不能被对话侧的 Opus 默认顶掉)
 *   3. 都没有 → 成本保守冷启动兜底:cc → claude-sonnet-4-6, codex → gpt-5.5
 *      (与 scheduler-host/runner.ts defaultModelFor 同步,两边漂移会复现
 *      "UI 显示 X 实际跑 Y" 的 2026-06 事故)
 *
 * 项目 vitest env=node,无 window。与 newMakerDraft.test.ts 同款:
 * vi.stubGlobal 注入最小 localStorage,避免新增 jsdom 依赖。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

  it('三级:全新用户(无任何持久化)冷启动兜底 Sonnet,不被对话侧 Opus 默认顶掉', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('三级:对话 draft 存在但 model 字段缺失(老 schema)→ 仍走 Sonnet 兜底', async () => {
    seedChatDraft(undefined);
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('三级:对话 draft 持久化了种子默认 model 但用户从未显式选过(无 modelChosenByVendor 标记)→ 不算上次选择,落 Sonnet', async () => {
    // lastByVendor 整个快照随任意 draft 写入落盘:只改过 workingDir / 只用过
    // Codex 的用户,持久化里也躺着 cc 的种子默认(Opus)。没有显式选择标记时
    // 必须忽略,否则成本保守兜底被对话侧 Opus 默认顶掉。
    seedChatDraft('claude-opus-4-8', { chosen: false });
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('三级:已有任务只改思考档不打显式选择标记 → 调度仍走 Sonnet 兜底', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });
    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getPersistedVendorModel('cc')).toBe('');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
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

  it('codex 冷启动兜底 gpt-5.5', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('codex')).toBe('gpt-5.5');
  });

  it('损坏的 localStorage JSON → 静默回退兜底,不抛错', async () => {
    memStorage.setItem(CHAT_DRAFT_KEY, '{not json');
    memStorage.setItem(SCHEDULE_PREFS_KEY, '{not json');
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('schedulerFallbackModel 与 runner defaultModelFor 的约定值一致(防漂移锚点)', async () => {
    const { schedulerFallbackModel } = await loadModule();
    // scheduler-host/runner.ts defaultModelFor 必须返回同样的值;
    // runner 侧的等价断言见 runnerModelSelection.test.ts。
    expect(schedulerFallbackModel('claude-code')).toBe('claude-sonnet-4-6');
    expect(schedulerFallbackModel('codex')).toBe('gpt-5.5');
  });
});
