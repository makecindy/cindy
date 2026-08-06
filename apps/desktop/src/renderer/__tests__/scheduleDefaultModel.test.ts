/**
 * scheduleDefaultModel.test.ts
 * ---------------------------------------------------------------------------
 * 回归 useScheduleForm.ts 新任务默认模型的三级回退约定:
 *   1. 上次建自动化任务时选的模型(scheduleFormPrefs.lastByAgent)优先
 *   2. 没有 → 跟随对话上次选择(newMakerDraft localStorage **真实持久化值**,
 *      不吃 sanitize 的默认回填 —— 全新用户不能被对话侧的 Opus 默认顶掉)
 *   3. 兼容 helper 无记忆时仍保留 bundled 历史回退；实际新表单保持空 model，
 *      保存时由 Main 的 scheduler-host/defaultModelFor(active catalog)物化
 *      （避免“UI 显示 X、实际跑 Y”的 2026-06 事故）。
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

  it('兼容 helper:全新用户回落 bundled Sonnet,不被对话侧 Opus 种子顶掉', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('兼容 helper:对话 draft 缺 model(老 schema)时回落 bundled', async () => {
    seedChatDraft(undefined);
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('兼容 helper:对话 draft 的未选择种子不算用户记忆', async () => {
    // lastByVendor 整个快照随任意 draft 写入落盘:只改过 workingDir / 只用过
    // Codex 的用户,持久化里也躺着 cc 的种子默认(Opus)。没有显式选择标记时
    // 必须忽略,否则真正的 Main 默认会被对话侧 Opus 种子顶掉。
    seedChatDraft('claude-opus-4-8', { chosen: false });
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('兼容 helper:会话同步草稿不打显式选择标记', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });
    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(draft.getPersistedVendorModel('cc')).toBe('');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('三级:旧 New Maker 显式选模被会话同步覆盖后不污染调度默认模型', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });
    expect(draft.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');

    draft.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-sonnet-4-7',
      effort: 'high',
    });

    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getDraft().lastByVendor.cc.model).toBe('claude-sonnet-4-7');
    expect(draft.getPersistedVendorModel('cc')).toBe('');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('三级:旧 New Maker 显式选模被同 model 会话同步更新后仍作为调度默认模型', async () => {
    const draft = await import('@/state/newMakerDraft');
    draft.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });

    draft.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    const { getScheduleDefaultModel } = await loadModule();
    expect(draft.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(draft.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-opus-4-8');
  });

  it('兼容 helper:codex 回落 bundled gpt-5.5', async () => {
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('codex')).toBe('gpt-5.5');
  });

  it('损坏的 localStorage JSON → 静默回退兜底,不抛错', async () => {
    memStorage.setItem(CHAT_DRAFT_KEY, '{not json');
    memStorage.setItem(SCHEDULE_PREFS_KEY, '{not json');
    const { getScheduleDefaultModel } = await loadModule();
    expect(getScheduleDefaultModel('claude-code')).toBe('claude-sonnet-4-6');
  });

  it('schedulerFallbackModel 保留 bundled 兼容值', async () => {
    const { schedulerFallbackModel } = await loadModule();
    expect(schedulerFallbackModel('claude-code')).toBe('claude-sonnet-4-6');
    expect(schedulerFallbackModel('codex')).toBe('gpt-5.5');
  });

  it('新表单无用户记忆时初始化保持空，交给 Main 写入边界物化', async () => {
    const { makeFormFromSchedule } = await loadModule();
    expect(makeFormFromSchedule(null).model).toBe('');
  });

  it('新表单仍立即物化用户明确记住的模型', async () => {
    seedSchedulePrefs('remembered-schedule-model');
    const { makeFormFromSchedule } = await loadModule();
    expect(makeFormFromSchedule(null).model).toBe('remembered-schedule-model');
  });
});
