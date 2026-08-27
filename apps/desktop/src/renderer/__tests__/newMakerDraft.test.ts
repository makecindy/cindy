/**
 * newMakerDraft.test.ts
 * ---------------------------------------------------------------------------
 * 回归 state/newMakerDraft.ts 的核心约定:
 *   1. 默认 vendor='cc',workingDir=null,lastByVendor 各 vendor 的硬默认填齐
 *   2. localStorage 持久化:patch 后 reload(模拟 app 重启)→ 状态恢复
 *   3. switchVendor:把当前 vendor 的 prefs 落进 lastByVendor[oldVendor]
 *   4. patchCurrentVendorPrefs:仅修当前 vendor 的 prefs,不影响另一个 vendor
 *   5. Fast Mode 按模型记忆,缺省 false
 *   6. schema 损坏的 localStorage 入参 → 静默回退默认,不抛错
 *
 * 项目 vitest env=node,无 window。这里用 vi.stubGlobal 注入最小 localStorage
 * 实现,避免新增 jsdom/happy-dom 依赖。
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

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

async function loadModule() {
  return await import('@/state/newMakerDraft');
}

describe('newMakerDraft store', () => {
  it('默认状态:vendor=cc,workingDir=null,lastByVendor 各 vendor 的硬默认填齐', async () => {
    const { getDraft } = await loadModule();
    const d = getDraft();
    expect(d.vendor).toBe('cc');
    expect(d.workingDir).toBeNull();
    expect(d.lastByVendor.cc.permissionMode).toBe('auto');
    expect(d.lastByVendor.cc.effort).toBe('medium');
    expect(d.lastByVendor.cc.model.length).toBeGreaterThan(0);
    expect(d.lastByVendor.codex.permissionMode).toBe('auto');
    expect(d.lastByVendor.codex.effort).toBe('high');
    expect(d.lastByVendor.pi.permissionMode).toBe('auto');
    // 种子模型不再写死在 store 里（原先是 'gpt-5.4'，与 modelDefinitions 写死的 'gpt-5.5'
    // 漂移，且两者在目录里都是默认隐藏的模型）。现在统一从 getDefaultModelForVendor 取，
    // capabilities 未加载时它给冷启动占位 id —— 这里只锁「非空且与那个入口同源」。
    const { coldStartModelIdForVendor } = await import('@/lib/modelDefinitions');
    expect(d.lastByVendor.codex.model).toBe(coldStartModelIdForVendor('codex'));
    expect(d.lastByVendor.cc.model).toBe(coldStartModelIdForVendor('cc'));
    expect(d.fastModeByModel).toEqual({});
    expect(d.effortByModel).toEqual({});
    expect(d.worktreeEnabled).toBe(false);
    expect(d.worktreePreferenceCustomized).toBe(false);
    expect(d.defaultTupleCustomized).toBe(false);
    expect(d.defaultTupleSelectionCustomized).toBe(false);
  });

  it('产品默认原子写入完整组合，但不伪装成用户显式选模', async () => {
    const { applySuggestedDefaultTuple, getDraft } = await loadModule();
    expect(
      applySuggestedDefaultTuple({
        vendor: 'codex',
        providerId: 'openai',
        model: 'chatgpt/gpt-5.6-sol',
        effort: 'high',
      }),
    ).toBe(true);
    expect(getDraft()).toMatchObject({
      vendor: 'codex',
      defaultTupleCustomized: false,
      lastByVendor: {
        codex: {
          providerId: 'openai',
          model: 'chatgpt/gpt-5.6-sol',
          effort: 'high',
        },
      },
    });
    expect(getDraft().modelChosenByVendor.codex).toBeUndefined();

    vi.resetModules();
    const reloaded = await loadModule();
    expect(reloaded.getDraft().defaultTupleCustomized).toBe(false);
  });

  it('用户明确改过组合后，登录态变化不再覆盖', async () => {
    const { applySuggestedDefaultTuple, getDraft, markDefaultTupleCustomized } = await loadModule();
    markDefaultTupleCustomized();
    expect(
      applySuggestedDefaultTuple({
        vendor: 'pi',
        providerId: 'xai',
        model: 'grok-4.6',
        effort: 'high',
      }),
    ).toBe(false);
    expect(getDraft().vendor).toBe('cc');
    expect(getDraft().defaultTupleCustomized).toBe(true);
    expect(getDraft().defaultTupleSelectionCustomized).toBe(true);
  });

  it('恢复推荐只撤销 effort/Fast 调档，不清除模型/来源/Harness 选择', async () => {
    const tuningOnly = await loadModule();
    tuningOnly.markDefaultTupleCustomized(false);
    expect(tuningOnly.getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: false,
    });
    tuningOnly.clearDefaultTupleTuningCustomization({
      modelId: 'claude-sonnet-4-6',
      hasExternalOverrides: false,
    });
    expect(tuningOnly.getDraft().defaultTupleCustomized).toBe(false);

    tuningOnly.markDefaultTupleCustomized();
    tuningOnly.markDefaultTupleCustomized(false);
    tuningOnly.clearDefaultTupleTuningCustomization({
      modelId: 'claude-sonnet-4-6',
      hasExternalOverrides: false,
    });
    expect(tuningOnly.getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
    });
  });

  it.each(['effort', 'fast'] as const)(
    '当前默认模型只改 %s 时，恢复推荐清空旧记忆并允许后续默认变化',
    async (kind) => {
      const modelId = 'claude-sonnet-4-6';
      const draft = await loadModule();
      draft.markDefaultTupleCustomized(false);
      if (kind === 'effort') draft.setEffortForModel(modelId, 'high');
      else draft.setFastModeForModel(modelId, true);

      draft.clearDefaultTupleTuningCustomization({
        modelId,
        hasExternalOverrides: false,
      });
      expect(draft.getDraft()).toMatchObject({
        defaultTupleCustomized: false,
        defaultTupleSelectionCustomized: false,
        effortByModel: {},
        fastModeByModel: {},
      });
      expect(
        draft.applySuggestedDefaultTuple({
          vendor: 'pi',
          providerId: 'xai',
          model: 'grok-4.6',
          effort: 'high',
        }),
      ).toBe(true);

      vi.resetModules();
      const reloaded = await loadModule();
      expect(reloaded.getDraft()).toMatchObject({
        defaultTupleCustomized: false,
        effortByModel: {},
        fastModeByModel: {},
      });
    },
  );

  it('恢复当前项后仍有其它草稿或外部 override 时继续保护默认组合', async () => {
    const draft = await loadModule();
    draft.markDefaultTupleCustomized(false);
    draft.setEffortForModel('claude-sonnet-4-6', 'high');
    draft.setFastModeForModel('gpt-5.5', true);

    draft.clearDefaultTupleTuningCustomization({
      modelId: 'claude-sonnet-4-6',
      hasExternalOverrides: false,
    });
    expect(draft.getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      effortByModel: {},
      fastModeByModel: { 'gpt-5.5': true },
    });

    draft.clearDefaultTupleTuningCustomization({
      modelId: 'gpt-5.5',
      hasExternalOverrides: true,
    });
    expect(draft.getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      effortByModel: {},
      fastModeByModel: {},
    });
  });

  it('只改权限不把模型组合误标成用户自定义', async () => {
    const { getDraft, patchCurrentVendorPrefs } = await loadModule();
    patchCurrentVendorPrefs({ permissionMode: 'bypassPermissions' });
    expect(getDraft().defaultTupleCustomized).toBe(false);
  });

  it('旧草稿的模型、来源、思考深度或 Fast 选择会迁移成已自定义', async () => {
    for (const saved of [
      { vendor: 'cc', modelChosenByVendor: { cc: true } },
      { vendor: 'cc', lastByVendor: { cc: { model: 'claude-opus-4-8' } } },
      { vendor: 'cc', lastByVendor: { cc: { providerId: 'anthropic' } } },
      { vendor: 'cc', effortByModel: { 'claude-opus-5': 'high' } },
      { vendor: 'cc', fastModeByModel: { 'claude-opus-5': true } },
    ]) {
      memStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify(saved));
      vi.resetModules();
      const { getDraft } = await loadModule();
      expect(getDraft().defaultTupleCustomized).toBe(true);
    }
  });

  it('旧 preserving 路径仅留下 cc.model 时仍保护旧模型', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'cc', lastByVendor: { cc: { model: 'claude-opus-4-8' } } }),
    );
    vi.resetModules();
    const { applySuggestedDefaultTuple, getDraft } = await loadModule();
    expect(getDraft().defaultTupleCustomized).toBe(true);
    expect(
      applySuggestedDefaultTuple({
        vendor: 'pi',
        providerId: 'xai',
        model: 'grok-4.6',
        effort: 'high',
      }),
    ).toBe(false);
    expect(getDraft().vendor).toBe('cc');
    expect(getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
  });

  it('旧 device-link preserving 完整快照与空 marker 仍保护 cc 旧模型', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        modelChosenByVendor: {},
        lastByVendor: {
          cc: {
            model: 'claude-opus-4-8',
            providerId: null,
            effort: 'medium',
            permissionMode: 'auto',
            planMode: false,
          },
          codex: { model: 'gpt-5.5', providerId: null, effort: 'high' },
          pi: { model: 'claude-sonnet-5', providerId: null, effort: 'high' },
          orca: { model: 'claude-sonnet-4-6', providerId: null, effort: 'medium' },
        },
      }),
    );
    vi.resetModules();
    const { applySuggestedDefaultTuple, getDraft } = await loadModule();
    expect(getDraft()).toMatchObject({
      vendor: 'cc',
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      lastByVendor: { cc: { model: 'claude-opus-4-8', providerId: null, effort: 'medium' } },
    });
    expect(
      applySuggestedDefaultTuple({
        vendor: 'pi',
        providerId: 'xai',
        model: 'grok-4.6',
        effort: 'high',
      }),
    ).toBe(false);
    expect(getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
  });

  it('旧完整快照里的 cc 种子模型不误判成用户自定义', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        workingDir: '/tmp/project',
        lastByVendor: {
          cc: { model: 'claude-sonnet-4-6' },
          codex: { model: 'gpt-5.5' },
          pi: { model: 'claude-sonnet-5' },
          orca: { model: 'claude-sonnet-4-6' },
        },
      }),
    );
    vi.resetModules();
    const { applySuggestedDefaultTuple, getDraft } = await loadModule();
    expect(getDraft().defaultTupleCustomized).toBe(false);
    expect(
      applySuggestedDefaultTuple({
        vendor: 'pi',
        providerId: 'xai',
        model: 'grok-4.6',
        effort: 'high',
      }),
    ).toBe(true);
    expect(getDraft()).toMatchObject({
      vendor: 'pi',
      lastByVendor: { pi: { providerId: 'xai', model: 'grok-4.6', effort: 'high' } },
    });
  });

  it('旧 head 已标明系统默认时，不因 Gateway 来源反推成用户选择', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'pi',
        defaultTupleCustomized: false,
        modelChosenByVendor: {},
        lastByVendor: {
          cc: { model: 'claude-sonnet-4-6' },
          codex: { model: 'gpt-5.5' },
          pi: { model: 'grok-4.6', providerId: 'xai', effort: 'high' },
        },
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft()).toMatchObject({
      defaultTupleCustomized: false,
      defaultTupleSelectionCustomized: false,
    });
  });

  it('旧 head 已标明自定义时，从显式模型证据补出 selection marker', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        defaultTupleCustomized: true,
        modelChosenByVendor: { cc: true },
        lastByVendor: { cc: { model: 'claude-opus-4-8' } },
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
    });
  });

  it('旧 head 的 Gateway 默认来源加调档，不误补成 selection marker', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'pi',
        defaultTupleCustomized: true,
        modelChosenByVendor: {},
        effortByModel: { 'grok-4.6': 'medium' },
        lastByVendor: {
          cc: { model: 'claude-sonnet-4-6' },
          codex: { model: 'gpt-5.5' },
          pi: { model: 'grok-4.6', providerId: 'xai', effort: 'medium' },
        },
      }),
    );
    vi.resetModules();
    const { clearDefaultTupleTuningCustomization, getDraft } = await loadModule();
    expect(getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: false,
    });
    clearDefaultTupleTuningCustomization({
      modelId: 'grok-4.6',
      hasExternalOverrides: false,
    });
    expect(getDraft().defaultTupleCustomized).toBe(false);
  });

  it('旧 head 只换来源时，即使没有 modelChosen marker 也保护真实来源选择', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'pi',
        defaultTupleCustomized: true,
        modelChosenByVendor: {},
        lastByVendor: {
          cc: { model: 'claude-sonnet-4-6' },
          codex: { model: 'gpt-5.5' },
          pi: { model: 'grok-4.6', providerId: 'openrouter', effort: 'high' },
        },
      }),
    );
    vi.resetModules();
    const { clearDefaultTupleTuningCustomization, getDraft } = await loadModule();
    expect(getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
    });
    clearDefaultTupleTuningCustomization({
      modelId: 'grok-4.6',
      hasExternalOverrides: false,
    });
    expect(getDraft().defaultTupleCustomized).toBe(true);
  });

  it('旧版系统可用性 fallback 不迁移成用户自定义', async () => {
    for (const vendor of ['codex', 'pi'] as const) {
      memStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify({ vendor }));
      vi.resetModules();
      const { applySuggestedDefaultTuple, getDraft } = await loadModule();
      expect(getDraft().defaultTupleCustomized).toBe(false);
      expect(
        applySuggestedDefaultTuple({
          vendor: 'pi',
          providerId: 'xai',
          model: 'grok-4.6',
          effort: 'high',
        }),
      ).toBe(true);
      expect(getDraft()).toMatchObject({
        vendor: 'pi',
        defaultTupleCustomized: false,
        lastByVendor: { pi: { providerId: 'xai', model: 'grok-4.6', effort: 'high' } },
      });
    }
  });

  it('默认组合先落 Pi 后，可用性回退读取实时草稿且不被旧 cc 闭包覆盖', async () => {
    const { applySuggestedDefaultTuple, fallbackUnavailableVendor, getDraft } = await loadModule();
    expect(
      applySuggestedDefaultTuple({
        vendor: 'pi',
        providerId: 'xai',
        model: 'grok-4.6',
        effort: 'high',
      }),
    ).toBe(true);
    expect(fallbackUnavailableVendor(new Set(['codex', 'pi']))).toBe(false);
    expect(getDraft()).toMatchObject({
      vendor: 'pi',
      defaultTupleCustomized: false,
      lastByVendor: { pi: { providerId: 'xai', model: 'grok-4.6', effort: 'high' } },
    });
  });

  it('系统可用性回退本身不标记用户自定义', async () => {
    const { fallbackUnavailableVendor, getDraft } = await loadModule();
    expect(fallbackUnavailableVendor(new Set(['codex', 'pi']))).toBe(true);
    expect(getDraft().vendor).toBe('codex');
    expect(getDraft().defaultTupleCustomized).toBe(false);
  });

  it('persists an explicit Pi model choice across reload', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('pi', { model: 'chatgpt/gpt-5.6' });
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().modelChosenByVendor.pi).toBe(true);
    expect(m2.getPersistedVendorModel('pi')).toBe('chatgpt/gpt-5.6');
  });

  it('Effort 按模型记忆:get/set + 同值短路 + 持久化', async () => {
    const m1 = await loadModule();
    expect(m1.getEffortForModel('claude-opus-4-7')).toBeUndefined();

    m1.setEffortForModel('claude-opus-4-7', 'xhigh');
    m1.setEffortForModel('claude-haiku-4-5', 'low');
    expect(m1.getEffortForModel('claude-opus-4-7')).toBe('xhigh');
    expect(m1.getEffortForModel('claude-haiku-4-5')).toBe('low');
    expect(m1.getDraft().effortByModel).toEqual({
      'claude-opus-4-7': 'xhigh',
      'claude-haiku-4-5': 'low',
    });

    // 同值写入应短路 (此处只能间接断言不抛错; 持久化层面无外部信号)
    m1.setEffortForModel('claude-opus-4-7', 'xhigh');
    expect(m1.getEffortForModel('claude-opus-4-7')).toBe('xhigh');

    // 模拟 app 重启 → 仍按模型恢复
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getEffortForModel('claude-opus-4-7')).toBe('xhigh');
    expect(m2.getEffortForModel('claude-haiku-4-5')).toBe('low');
    expect(m2.getEffortForModel('not-recorded')).toBeUndefined();
  });

  it('Effort 按模型记忆:老版本 localStorage 无该字段 → 空对象兜底, 不抛', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'cc' /* 无 effortByModel */ }),
    );
    vi.resetModules();
    const { getDraft, getEffortForModel } = await loadModule();
    expect(getDraft().effortByModel).toEqual({});
    expect(getEffortForModel('claude-opus-4-7')).toBeUndefined();
  });

  it('Effort 按模型记忆:脏数据 (非 string value / 空 key) 被过滤', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        effortByModel: {
          'claude-opus-4-7': 'high',
          '': 'low',
          'claude-haiku-4-5': 42,
          'gpt-5.5': null,
          'gpt-5.4': '',
        },
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().effortByModel).toEqual({ 'claude-opus-4-7': 'high' });
  });

  it('patchDraft + 重新加载 module → 持久化生效(模拟 app 重启)', async () => {
    const m1 = await loadModule();
    m1.patchDraft({ workingDir: 'E:/projects/foo' });
    // scheduleWrite 改成同步落盘后, patch 完应立刻可见
    expect(memStorage.getItem(m1.__STORAGE_KEY)).not.toBeNull();

    // 模拟"app 重启"——重置 module cache,重新 import 后从 localStorage 恢复
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().workingDir).toBe('E:/projects/foo');
  });

  it('extraDirs 不跨重启还原:运行内生效,重启后一律空(引用目录=单次草稿授权)', async () => {
    const m1 = await loadModule();
    m1.patchDraft({ workingDir: 'E:/projects/foo', extraDirs: ['E:/projects/shared-lib'] });
    // 同一次运行内:内存态生效
    expect(m1.getDraft().extraDirs).toEqual(['E:/projects/shared-lib']);

    // 模拟 app 重启 → workingDir 等偏好保留,extraDirs 清空(sanitize 一律置空)
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().workingDir).toBe('E:/projects/foo');
    expect(m2.getDraft().extraDirs).toEqual([]);
  });

  it('collab.workerConfig 跨重启保留耐久字段,丢弃一次性 initialTask(codex P2)', async () => {
    const m1 = await loadModule();
    m1.patchDraft({
      workingDir: '/projects/foo',
      collab: {
        enabled: true,
        worker: 'cc',
        workerConfig: {
          role: 'developer',
          model: 'claude-opus-4-7',
          effort: 'high',
          fast: true,
          workerPermissionMode: 'bypassPermissions',
          initialTask: '先跑一遍测试',
        },
      },
    });
    // 当前运行内 initialTask 可用(Send/New Goal 立即消费)
    expect(m1.getDraft().collab.workerConfig?.initialTask).toBe('先跑一遍测试');

    // 模拟 app 重启:耐久选择(role/model/effort/fast)恢复,一次性任务不复活——
    // 否则重启后 Send 会静默把过期任务当 delegateTask 派给 Worker,而收起态
    // pill 无从看见/编辑。
    vi.resetModules();
    const m2 = await loadModule();
    const wc = m2.getDraft().collab.workerConfig;
    expect(wc).toMatchObject({
      role: 'developer',
      model: 'claude-opus-4-7',
      effort: 'high',
      fast: true,
      workerPermissionMode: 'bypassPermissions',
    });
    expect(wc?.initialTask).toBeUndefined();
  });

  it('另起干净任务时只关闭协同，不覆盖 Worker 创建偏好', async () => {
    const { getDraft, patchDraft, resetDraftWorkspaceTargets } = await loadModule();
    patchDraft({
      collab: {
        enabled: true,
        worker: 'codex',
        workerConfig: {
          role: 'developer',
          model: 'gpt-5.5',
          workerPermissionMode: 'bypassPermissions',
        },
      },
    });

    resetDraftWorkspaceTargets();

    expect(getDraft().collab.enabled).toBe(false);
    expect(getDraft().collab.workerConfig).toMatchObject({
      role: 'developer',
      model: 'gpt-5.5',
      workerPermissionMode: 'bypassPermissions',
    });
  });

  it('patchDraft: Cindy worktree 路径会折回项目根目录', async () => {
    const { getDraft, patchDraft } = await loadModule();
    patchDraft({ workingDir: 'E:/projects/foo/.cindy-worktrees/auto-abc' });
    expect(getDraft().workingDir).toBe('E:/projects/foo');
  });

  it('patchDraft: 普通 Windows 路径归一成 POSIX 分隔符,worktree 路径继续折回', async () => {
    const { getDraft, patchDraft } = await loadModule();
    patchDraft({ workingDir: 'E:\\projects\\foo' });
    expect(getDraft().workingDir).toBe('E:/projects/foo');
    patchDraft({ workingDir: 'E:\\projects\\foo\\.cindy-worktrees\\auto-abc\\src' });
    expect(getDraft().workingDir).toBe('E:/projects/foo');
  });

  it('patchDraft: Windows 盘符根目录下的 worktree 会折回盘符根目录', async () => {
    const { getDraft, patchDraft } = await loadModule();
    patchDraft({ workingDir: 'E:\\.cindy-worktrees\\auto-abc\\src' });
    expect(getDraft().workingDir).toBe('E:/');
  });

  it('localStorage 历史残留:旧 xdt worktree 路径读取时迁移回项目根目录', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        workingDir: 'E:/projects/foo/.xdt-worktrees/auto-abc/src',
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().workingDir).toBe('E:/projects/foo');
  });

  it('patchDraft: 不折叠用户手选的非 xdt worktree 目录', async () => {
    const { getDraft, patchDraft } = await loadModule();
    patchDraft({ workingDir: 'E:/projects/foo/.worktrees/auto-abc/src' });
    expect(getDraft().workingDir).toBe('E:/projects/foo/.worktrees/auto-abc/src');

    patchDraft({ workingDir: 'E:/projects/foo/.claude/worktrees/auto-abc/src' });
    expect(getDraft().workingDir).toBe('E:/projects/foo/.claude/worktrees/auto-abc/src');
  });

  it('switchVendor:保留已同步的当前 vendor prefs 后再切到目标 vendor', async () => {
    const { getDraft, patchCurrentVendorPrefs, switchVendor } = await loadModule();
    patchCurrentVendorPrefs({
      model: 'claude-opus-4-7',
      effort: 'high',
      permissionMode: 'bypassPermissions',
    });
    switchVendor('codex');
    const d = getDraft();
    expect(d.vendor).toBe('codex');
    // 旧 vendor(cc)的 prefs 被落地为传入的值
    expect(d.lastByVendor.cc.model).toBe('claude-opus-4-7');
    expect(d.lastByVendor.cc.effort).toBe('high');
    expect(d.lastByVendor.cc.permissionMode).toBe('bypassPermissions');
    // 新 vendor(codex)的 prefs 不变(等待用户在 codex 下继续操作)
    expect(d.lastByVendor.codex.permissionMode).toBe('auto');
  });

  it('switchVendor:选中的引擎跨重启保留(模拟 app 重启后仍是上次选的)', async () => {
    const m1 = await loadModule();
    expect(m1.getDraft().vendor).toBe('cc');
    m1.switchVendor('codex');
    expect(m1.getDraft().vendor).toBe('codex');

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().vendor).toBe('codex');
  });

  it('sanitize:引擎白名单按 SELECTABLE_VENDORS 校验,表内的值一律保留', async () => {
    const { SELECTABLE_VENDORS } = await import('@/lib/agentVendors');
    for (const vendor of SELECTABLE_VENDORS) {
      memStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify({ vendor }));
      vi.resetModules();
      const { getDraft } = await loadModule();
      // 逐个写死白名单时,新上线的引擎在这里会被静默重置回 'cc' —— 用户选中后重启就丢。
      expect(getDraft().vendor).toBe(vendor);
    }
  });

  it("sanitize:表外的引擎值(历史 'orca' / 未知 / 非字符串)回退默认", async () => {
    for (const vendor of ['orca', 'unknown-engine', '', 42, null]) {
      memStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify({ vendor }));
      vi.resetModules();
      const { getDraft } = await loadModule();
      expect(getDraft().vendor).toBe('cc');
    }
  });

  it('switchVendor:相同 vendor 不变(no-op,避免误覆盖)', async () => {
    const { getDraft, switchVendor } = await loadModule();
    const before = getDraft().lastByVendor.cc;
    switchVendor('cc');
    expect(getDraft().lastByVendor.cc).toEqual(before);
  });

  it('patchCurrentVendorPrefs:只改当前 vendor,不影响另一个', async () => {
    const { getDraft, patchCurrentVendorPrefs } = await loadModule();
    const codexBefore = getDraft().lastByVendor.codex;
    patchCurrentVendorPrefs({ effort: 'xhigh', model: 'claude-opus-4-7' });
    const d = getDraft();
    expect(d.lastByVendor.cc.effort).toBe('xhigh');
    expect(d.lastByVendor.cc.model).toBe('claude-opus-4-7');
    expect(d.lastByVendor.codex).toEqual(codexBefore);
  });

  it('modelChosenByVendor:显式选 model 打标记并持久化;只改 effort 不打;种子默认不算选择', async () => {
    const m1 = await loadModule();
    // 初始:没有任何显式选择 → getPersistedVendorModel 返回 ''
    //（即使 patchDraft 已把含种子默认 model 的快照落盘)
    m1.patchDraft({ workingDir: '/foo' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');

    // 只改 effort → 仍不算选过 model
    m1.patchCurrentVendorPrefs({ effort: 'xhigh' });
    expect(m1.getPersistedVendorModel('cc')).toBe('');

    // 显式选 model → 打标记,getPersistedVendorModel 返回该值
    m1.patchCurrentVendorPrefs({ model: 'claude-opus-4-8' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
    expect(m1.getPersistedVendorModel('codex')).toBe('');

    // 模拟 app 重启 → 标记与值都恢复
    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m2.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
  });

  it('patchVendorPrefsPreservingModelChoice:只改思考档不打显式选择标记', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });

    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');

    m1.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
  });

  it('patchVendorPrefsPreservingModelChoice:已有任务换模后只改思考档不得清掉选模标记', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('cc', { model: 'claude-sonnet-4-6' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-sonnet-4-6');

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-sonnet-4-6',
      effort: 'high',
    });

    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-sonnet-4-6');
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-sonnet-4-6');
  });

  it('patchVendorPrefsPreservingModelChoice:可写回活动模型但不打标也不清标', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });
    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');

    m1.patchVendorPrefs('cc', { model: 'claude-sonnet-4-6', effort: 'medium' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      providerId: 'anthropic',
      effort: 'high',
    });
    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-sonnet-4-6');
    expect(m1.getDraft().lastByVendor.cc.providerId).toBeNull();
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('medium');
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-sonnet-4-6');
  });

  it('patchVendorPrefsPreservingModelChoice:已打标且活动模型一致时才更新思考档', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('cc', { model: 'claude-sonnet-4-6', effort: 'medium' });

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });
    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-sonnet-4-6');
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
  });

  it('patchVendorPrefsPreservingModelChoice:未打标且不带 model 时不得改活动模型', async () => {
    const m1 = await loadModule();
    const seedModel = m1.getDraft().lastByVendor.cc.model;

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      effort: 'high',
    });

    expect(m1.getDraft().lastByVendor.cc.model).toBe(seedModel);
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');
  });

  it('patchVendorPrefsPreservingModelChoice:未打标时仍可写回活动模型与来源', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      providerId: 'anthropic',
      effort: 'high',
    });
    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(m1.getDraft().lastByVendor.cc.providerId).toBe('anthropic');
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');
  });

  it('已有任务换模走 patchVendorPrefs,下次新建跟随这次选择', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('cc', { model: 'claude-sonnet-4-6' });
    m1.patchVendorPrefs('cc', { model: 'claude-opus-4-8', effort: 'high' });

    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
  });

  it('clearDraft → 回到初始默认', async () => {
    const { getDraft, patchDraft, clearDraft } = await loadModule();
    patchDraft({ workingDir: '/foo' });
    expect(getDraft().workingDir).toBe('/foo');
    clearDraft();
    expect(getDraft().workingDir).toBeNull();
    expect(getDraft().vendor).toBe('cc');
  });

  it('Fast Mode:按模型记忆,缺省 false', async () => {
    const { getDraft, getFastModeForModel, setFastModeForModel } = await loadModule();
    expect(getFastModeForModel('gpt-5.5')).toBe(false);

    setFastModeForModel('gpt-5.5', true);
    expect(getFastModeForModel('gpt-5.5')).toBe(true);
    expect(getFastModeForModel('gpt-5.4')).toBe(false);
    expect(getDraft().fastModeByModel).toEqual({ 'gpt-5.5': true });

    setFastModeForModel('gpt-5.5', false);
    expect(getFastModeForModel('gpt-5.5')).toBe(false);
  });

  it('Fast Mode:持久化后重新加载仍按模型恢复', async () => {
    const m1 = await loadModule();
    m1.setFastModeForModel('gpt-5.5', true);

    vi.resetModules();
    const m2 = await loadModule();
    expect(m2.getFastModeForModel('gpt-5.5')).toBe(true);
    expect(m2.getFastModeForModel('claude-opus-4-7')).toBe(false);
  });

  it('schema 损坏的 localStorage 入参 → 静默回退默认,不抛错', async () => {
    memStorage.setItem('xdt:newMakerDraft:v1', '{"vendor":"unknown","oops":true,broken json');
    vi.resetModules();
    const { getDraft } = await loadModule();
    const d = getDraft();
    expect(d.vendor).toBe('cc');
    expect(d.workingDir).toBeNull();
  });

  it("历史草稿 permissionMode='plan' → 迁移为 planMode=true + vendor 默认权限档", async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        lastByVendor: {
          cc: { model: 'claude-opus-4-7', effort: 'high', permissionMode: 'plan' },
          codex: { model: 'gpt-5.4', effort: 'high', permissionMode: 'auto', planMode: true },
        },
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    const d = getDraft();
    // legacy 'plan' 档 → planMode 开关 + 回落该 vendor 默认权限档(与 DB 迁移同语义)
    expect(d.lastByVendor.cc.permissionMode).toBe('auto');
    expect(d.lastByVendor.cc.planMode).toBe(true);
    // 显式 planMode 布尔原样保留
    expect(d.lastByVendor.codex.permissionMode).toBe('auto');
    expect(d.lastByVendor.codex.planMode).toBe(true);
  });

  it('schema 部分缺失的 localStorage 入参 → 缺字段补默认', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'codex' /* workingDir / lastByVendor 都缺 */ }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    const d = getDraft();
    expect(d.vendor).toBe('codex');
    expect(d.workingDir).toBeNull();
    expect(d.lastByVendor.cc.permissionMode).toBe('auto');
    expect(d.lastByVendor.codex.effort).toBe('high');
    expect(d.lastByVendor.codex.permissionMode).toBe('auto');
    expect(d.fastModeByModel).toEqual({});
  });

  it('schema:legacy wt* root 字段仍被忽略,不迁移进 worktreeEnabled', async () => {
    // 2026-07-28「勾选状态保存在工作端」上线后 worktree 记忆走新字段 worktreeEnabled;
    // 历史残留的 wtEnabled/wtName/wtSourceBranch/wtBaseRepo(更早的持久化实验)继续
    // 丢弃,且不从旧值猜测用户意图做迁移(configuration-and-overrides 规则)。
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        wtEnabled: true,
        wtName: 'foo',
        wtSourceBranch: 'main',
        wtBaseRepo: '/x',
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    const d = getDraft();
    expect(d).not.toHaveProperty('wtEnabled');
    expect(d).not.toHaveProperty('wtName');
    expect(d).not.toHaveProperty('wtSourceBranch');
    expect(d).not.toHaveProperty('wtBaseRepo');
    expect(d.worktreeEnabled).toBe(false);
  });

  it('schema:worktree 偏好以显式 override 持久化,脏值/缺字段跟随系统默认', async () => {
    // 勾选记忆是「工作端一份」的显式 override:专用 setter 写入 → 重载后恢复。
    vi.resetModules();
    {
      const { getDraft, setWorktreePreference } = await loadModule();
      expect(getDraft().worktreeEnabled).toBe(false); // 出厂默认不勾选(防误操作)
      expect(getDraft().worktreePreferenceCustomized).toBe(false);
      setWorktreePreference(true);
      expect(getDraft().worktreeEnabled).toBe(true);
      expect(getDraft().worktreePreferenceCustomized).toBe(true);
    }
    vi.resetModules();
    {
      const { getDraft } = await loadModule();
      expect(getDraft().worktreeEnabled).toBe(true);
      expect(getDraft().worktreePreferenceCustomized).toBe(true);
    }
    // 脏值(非布尔 true)一律归一 false
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'cc', worktreeEnabled: 'yes' }),
    );
    vi.resetModules();
    {
      const { getDraft } = await loadModule();
      expect(getDraft().worktreeEnabled).toBe(false);
      expect(getDraft().worktreePreferenceCustomized).toBe(false);
    }
  });

  it('通用草稿 patch 不能改动 worktree 偏好', async () => {
    vi.resetModules();
    const { getDraft, patchDraft, setWorktreePreference } = await loadModule();

    patchDraft({ worktreeEnabled: true, worktreePreferenceCustomized: true });
    expect(getDraft().worktreeEnabled).toBe(false);
    expect(getDraft().worktreePreferenceCustomized).toBe(false);

    setWorktreePreference(true);
    patchDraft({ worktreeEnabled: false, worktreePreferenceCustomized: false });
    expect(getDraft().worktreeEnabled).toBe(true);
    expect(getDraft().worktreePreferenceCustomized).toBe(true);
  });

  it('旧 false 快照不固化默认,旧 true 迁移为显式 override', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'cc', worktreeEnabled: false }),
    );
    vi.resetModules();
    {
      const { getDraft, patchDraft } = await loadModule();
      expect(getDraft().worktreeEnabled).toBe(false);
      expect(getDraft().worktreePreferenceCustomized).toBe(false);
      patchDraft({ workingDir: '/projects/default-following' });
      expect(
        JSON.parse(memStorage.getItem('xdt:newMakerDraft:v1') ?? '{}'),
      ).toMatchObject({
        worktreeEnabled: false,
        worktreePreferenceCustomized: false,
      });
    }

    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({ vendor: 'cc', worktreeEnabled: true }),
    );
    vi.resetModules();
    {
      const { getDraft } = await loadModule();
      expect(getDraft().worktreeEnabled).toBe(true);
      expect(getDraft().worktreePreferenceCustomized).toBe(true);
    }
  });

  it('customized=false 时忽略旧快照布尔并重新采用系统默认', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        vendor: 'cc',
        worktreeEnabled: true,
        worktreePreferenceCustomized: false,
      }),
    );
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().worktreeEnabled).toBe(false);
    expect(getDraft().worktreePreferenceCustomized).toBe(false);
  });

  it('附属窗口的过期草稿写入不会覆盖另一个窗口刚保存的 worktree 偏好', async () => {
    // 两次 import 模拟两个 Electron renderer:模块内存独立,localStorage 共享。
    const staleWindow = await loadModule();
    vi.resetModules();
    const activeWindow = await loadModule();

    activeWindow.setWorktreePreference(true);
    expect(staleWindow.getDraft().worktreeEnabled).toBe(false);

    // storage event 尚未送达时,旧窗口修改任意其它字段；写入前必须从共享持久值
    // rebase worktreeEnabled,不能把旧 false 随完整草稿快照覆盖回去。
    staleWindow.patchVendorPrefs('cc', { effort: 'high' });

    expect(staleWindow.getDraft().worktreeEnabled).toBe(true);
    expect(
      JSON.parse(memStorage.getItem(staleWindow.__STORAGE_KEY) ?? '{}'),
    ).toMatchObject({
      worktreeEnabled: true,
      worktreePreferenceCustomized: true,
    });
  });

  it('旧窗口的完整草稿写入不会覆盖另一窗口刚保存的默认模型组合', async () => {
    // 两个 renderer 的模块内存独立；旧窗口仍停在未自定义的 cc 草稿。
    const staleWindow = await loadModule();
    vi.resetModules();
    const activeWindow = await loadModule();

    activeWindow.markDefaultTupleCustomized();
    activeWindow.switchVendor('pi');
    activeWindow.patchVendorPrefs('pi', {
      model: 'grok-4.6',
      providerId: 'xai',
      effort: 'high',
    });
    activeWindow.setEffortForModel('grok-4.6', 'high');
    activeWindow.setFastModeForModel('grok-4.6', true);
    expect(staleWindow.getDraft().defaultTupleCustomized).toBe(false);

    // storage event 尚未送达时，旧窗口只改无关的工作目录。完整写入前必须把用户组合
    // 整体 rebase，不能只保住 marker 而丢 Harness / 来源 / 模型 / 深度 / Fast。
    staleWindow.patchDraft({ workingDir: '/projects/stale-window' });

    const expectedTuple = {
      vendor: 'pi',
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      modelChosenByVendor: { pi: true },
      effortByModel: { 'grok-4.6': 'high' },
      fastModeByModel: { 'grok-4.6': true },
      lastByVendor: {
        pi: expect.objectContaining({
          model: 'grok-4.6',
          providerId: 'xai',
          effort: 'high',
        }),
      },
    };
    expect(staleWindow.getDraft()).toMatchObject(expectedTuple);
    expect(staleWindow.getDraft().workingDir).toBe('/projects/stale-window');
    expect(
      JSON.parse(memStorage.getItem(staleWindow.__STORAGE_KEY) ?? '{}'),
    ).toMatchObject(expectedTuple);
  });

  it('旧窗口的无关写入不会复活另一窗口已恢复推荐的 tuple', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();
    expect(staleWindow.getDraft().defaultTupleCustomized).toBe(true);

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    const restoredTuple = {
      vendor: activeWindow.getDraft().vendor,
      defaultTupleCustomized: false,
      defaultTupleSelectionCustomized: false,
      modelChosenByVendor: {},
      effortByModel: {},
      fastModeByModel: {},
      lastByVendor: activeWindow.getDraft().lastByVendor,
    };

    // storage event 尚未到达 B；仅改工作目录时必须采用 A 已写入的完整恢复结果。
    staleWindow.patchDraft({ workingDir: '/projects/after-restore' });
    expect(staleWindow.getDraft()).toMatchObject(restoredTuple);
    expect(staleWindow.getDraft().workingDir).toBe('/projects/after-restore');
    expect(JSON.parse(memStorage.getItem(staleWindow.__STORAGE_KEY) ?? '{}')).toMatchObject(
      restoredTuple,
    );
  });

  it('旧窗口在恢复推荐后明确选模时，只写入这次新的 tuple 意图', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    staleWindow.patchVendorPrefs('cc', {
      model: 'claude-new-choice',
      providerId: 'anthropic',
      effort: 'xhigh',
    });

    expect(staleWindow.getDraft()).toMatchObject({
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      modelChosenByVendor: { cc: true },
      effortByModel: {},
      fastModeByModel: {},
      lastByVendor: {
        cc: expect.objectContaining({
          model: 'claude-new-choice',
          providerId: 'anthropic',
          effort: 'xhigh',
        }),
      },
    });
  });

  it('旧窗口在恢复推荐后切 Harness 时，不用旧闭包污染最新来源槽', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    activeWindow.applySuggestedDefaultTuple({
      vendor: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'medium',
    });

    // B 仍渲染着旧 cc tuple，但这次明确意图只有“切到 Codex”。切换前必须采用 A 的
    // 最新 Pi tuple，不能把旧 cc prefs 填进 Pi 槽。
    staleWindow.markDefaultTupleCustomized();
    staleWindow.switchVendor('codex');

    const expected = {
      vendor: 'codex',
      defaultTupleCustomized: true,
      lastByVendor: {
        pi: expect.objectContaining({
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
          effort: 'medium',
        }),
      },
    };
    expect(staleWindow.getDraft()).toMatchObject(expected);
    expect(JSON.parse(memStorage.getItem(staleWindow.__STORAGE_KEY) ?? '{}')).toMatchObject(
      expected,
    );
  });

  it('旧窗口选择界面所示 Harness 时，仍按最新持久状态执行切换', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();
    expect(staleWindow.getDraft().vendor).toBe('cc');

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    activeWindow.applySuggestedDefaultTuple({
      vendor: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'medium',
    });

    // B 仍显示 cc，用户明确点 cc。调用方必须始终进入 switchVendor，让它先看到真实 Pi
    // 再切回 cc；若用旧 draft.vendor 预判，这次明确意图会被错误跳过。
    staleWindow.switchVendor('cc');
    staleWindow.patchVendorPrefs('cc', {
      model: 'claude-new-choice',
      providerId: 'anthropic',
      effort: 'high',
    });

    expect(staleWindow.getDraft()).toMatchObject({
      vendor: 'cc',
      defaultTupleCustomized: true,
      modelChosenByVendor: { cc: true },
      lastByVendor: {
        cc: expect.objectContaining({
          model: 'claude-new-choice',
          providerId: 'anthropic',
        }),
        pi: expect.objectContaining({
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
        }),
      },
    });
  });

  it('旧窗口的内联控件按界面 Harness 写入，不串到最新持久 Harness', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();
    const renderedVendor = staleWindow.getDraft().vendor;
    expect(renderedVendor).toBe('cc');

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    activeWindow.applySuggestedDefaultTuple({
      vendor: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'medium',
    });

    // 模拟 classic/inline 回调：marker 会先 rebase 到 Pi，但后续必须按渲染时捕获的 cc
    // 执行切换并写 cc 槽，不能用 rebase 后的 currentDraft.vendor 把值串进 Pi。
    staleWindow.markDefaultTupleCustomized();
    staleWindow.switchVendor(renderedVendor);
    staleWindow.patchVendorPrefs(renderedVendor, {
      model: 'claude-inline-choice',
      providerId: 'anthropic',
      effort: 'xhigh',
    });

    expect(staleWindow.getDraft()).toMatchObject({
      vendor: 'cc',
      defaultTupleCustomized: true,
      modelChosenByVendor: { cc: true },
      lastByVendor: {
        cc: expect.objectContaining({
          model: 'claude-inline-choice',
          providerId: 'anthropic',
          effort: 'xhigh',
        }),
        pi: expect.objectContaining({
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
          effort: 'medium',
        }),
      },
    });
  });

  it('旧窗口切 Fast 时回到界面 Harness，并保留最新 Pi 默认', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();
    const renderedVendor = staleWindow.getDraft().vendor;

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    activeWindow.applySuggestedDefaultTuple({
      vendor: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'medium',
    });

    // 模拟 Fast handler：先标记调档，再确保当前 Harness 是用户仍看见的 cc，最后写模型记忆。
    staleWindow.markDefaultTupleCustomized(false);
    staleWindow.switchVendor(renderedVendor);
    staleWindow.setFastModeForModel('claude-visible-model', true);

    expect(staleWindow.getDraft()).toMatchObject({
      vendor: 'cc',
      defaultTupleCustomized: true,
      fastModeByModel: { 'claude-visible-model': true },
      lastByVendor: {
        pi: expect.objectContaining({
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
        }),
      },
    });
  });

  it('旧窗口改权限等非 tuple 字段时，只更新界面 Harness 槽', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    activeWindow.applySuggestedDefaultTuple({
      vendor: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'medium',
    });

    staleWindow.patchVendorPrefs('cc', { permissionMode: 'bypassPermissions' });

    expect(staleWindow.getDraft()).toMatchObject({
      vendor: 'pi',
      defaultTupleCustomized: false,
      lastByVendor: {
        cc: expect.objectContaining({ permissionMode: 'bypassPermissions' }),
        pi: expect.objectContaining({
          model: 'z-ai/glm-5.3-flash',
          providerId: 'xd',
        }),
      },
    });
  });

  it('preserving 活动同步基于恢复后的 tuple，不带回旧 marker 和调档', async () => {
    const activeWindow = await loadModule();
    activeWindow.setEffortForModel('legacy-model', 'high');
    activeWindow.markDefaultTupleCustomized(false);
    vi.resetModules();
    const staleWindow = await loadModule();

    activeWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: false,
    });
    staleWindow.patchVendorPrefsPreservingModelChoice('cc', { effort: 'medium' });

    expect(staleWindow.getDraft()).toMatchObject({
      defaultTupleCustomized: false,
      defaultTupleSelectionCustomized: false,
      modelChosenByVendor: {},
      effortByModel: {},
      fastModeByModel: {},
      lastByVendor: {
        cc: expect.objectContaining({ effort: 'medium' }),
      },
    });
  });

  it('旧窗口只清调档但未解锁时仍保住另一窗口的新默认组合', async () => {
    const staleWindow = await loadModule();
    staleWindow.setEffortForModel('legacy-model', 'high');
    vi.resetModules();
    const activeWindow = await loadModule();

    activeWindow.markDefaultTupleCustomized();
    activeWindow.switchVendor('pi');
    activeWindow.patchVendorPrefs('pi', {
      model: 'grok-4.6',
      providerId: 'xai',
      effort: 'high',
    });

    // staleWindow 自己仍是 false，所以这不是合法的 true → false 解锁；清理写入也必须 rebase。
    staleWindow.clearDefaultTupleTuningCustomization({
      modelId: 'legacy-model',
      hasExternalOverrides: true,
    });

    expect(staleWindow.getDraft()).toMatchObject({
      vendor: 'pi',
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      modelChosenByVendor: { pi: true },
      lastByVendor: {
        pi: expect.objectContaining({ model: 'grok-4.6', providerId: 'xai' }),
      },
    });
  });

  it('远程 worktree 广播不会让旧窗口回滚持久草稿或 main 偏好镜像', async () => {
    // 先让附属窗口持有旧的模型/目录，再由活跃窗口保存新值；两个模块实例模拟两个 renderer。
    const staleWindow = await loadModule();
    staleWindow.patchDraft({ workingDir: '/projects/stale' });
    staleWindow.patchVendorPrefs('cc', { model: 'claude-stale' });

    vi.resetModules();
    const activeWindow = await loadModule();
    activeWindow.patchDraft({ workingDir: '/projects/current' });
    activeWindow.patchVendorPrefs('cc', { model: 'claude-current' });

    expect(staleWindow.getDraft().workingDir).toBe('/projects/stale');
    expect(staleWindow.getDraft().lastByVendor.cc.model).toBe('claude-stale');

    // main 广播会让所有窗口依次执行 setter。每个窗口都只能基于共享持久对象合并布尔字段，
    // 不能把各自完整 currentDraft 写回。
    activeWindow.setWorktreePreference(true);
    staleWindow.setWorktreePreference(true);

    const persisted = JSON.parse(
      memStorage.getItem(staleWindow.__STORAGE_KEY) ?? '{}',
    ) as {
      workingDir?: string;
      worktreeEnabled?: boolean;
      worktreePreferenceCustomized?: boolean;
      lastByVendor?: { cc?: { model?: string } };
    };
    expect(persisted.workingDir).toBe('/projects/current');
    expect(persisted.lastByVendor?.cc?.model).toBe('claude-current');
    expect(persisted.worktreeEnabled).toBe(true);
    expect(persisted.worktreePreferenceCustomized).toBe(true);

    // 旧窗口的临时内存仍可保持不同，但 App 向 main 同步时必须读取同一份持久真相。
    expect(staleWindow.getDraft().workingDir).toBe('/projects/stale');
    expect(staleWindow.getDraftForPreferenceSync().workingDir).toBe('/projects/current');
    expect(staleWindow.getDraftForPreferenceSync().lastByVendor.cc.model).toBe(
      'claude-current',
    );
    expect(activeWindow.getDraftForPreferenceSync()).toEqual(
      staleWindow.getDraftForPreferenceSync(),
    );
  });

  it('worktree 单字段落盘失败时 main 只回退该布尔，不回退旧窗口整份草稿', async () => {
    const staleWindow = await loadModule();
    staleWindow.patchDraft({ workingDir: '/projects/stale' });
    staleWindow.patchVendorPrefs('cc', { model: 'claude-stale' });

    vi.resetModules();
    const activeWindow = await loadModule();
    activeWindow.patchDraft({ workingDir: '/projects/current' });
    activeWindow.patchVendorPrefs('cc', { model: 'claude-current' });

    vi.spyOn(memStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    staleWindow.setWorktreePreference(true);

    const syncDraft = staleWindow.getDraftForPreferenceSync();
    expect(syncDraft.worktreeEnabled).toBe(true);
    expect(syncDraft.worktreePreferenceCustomized).toBe(true);
    expect(syncDraft.workingDir).toBe('/projects/current');
    expect(syncDraft.lastByVendor.cc.model).toBe('claude-current');
    expect(staleWindow.getDraft().workingDir).toBe('/projects/stale');
  });

  it('storage event 会把其它窗口保存的 worktree 偏好同步进当前 store 并通知订阅者', async () => {
    let onStorage: ((event: StorageEvent) => void) | undefined;
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', {
      localStorage: memStorage,
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ) => {
        if (type === 'storage' && typeof listener === 'function') {
          onStorage = listener as (event: StorageEvent) => void;
        }
      },
      removeEventListener,
    });
    vi.resetModules();

    const draftStore = await loadModule();
    const subscriber = vi.fn();
    draftStore.subscribeDraft(subscriber);
    const serialized = JSON.stringify({
      ...draftStore.getDraft(),
      worktreeEnabled: true,
      worktreePreferenceCustomized: true,
      vendor: 'pi',
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      modelChosenByVendor: { pi: true },
      effortByModel: { 'grok-4.6': 'high' },
      fastModeByModel: { 'grok-4.6': true },
      lastByVendor: {
        ...draftStore.getDraft().lastByVendor,
        pi: {
          ...draftStore.getDraft().lastByVendor.pi,
          model: 'grok-4.6',
          providerId: 'xai',
          effort: 'high',
        },
      },
    });
    memStorage.setItem(draftStore.__STORAGE_KEY, serialized);

    onStorage?.({
      key: draftStore.__STORAGE_KEY,
      newValue: serialized,
    } as StorageEvent);

    expect(draftStore.getDraft().worktreeEnabled).toBe(true);
    expect(draftStore.getDraft().worktreePreferenceCustomized).toBe(true);
    expect(draftStore.getDraft()).toMatchObject({
      vendor: 'pi',
      defaultTupleCustomized: true,
      defaultTupleSelectionCustomized: true,
      modelChosenByVendor: { pi: true },
      effortByModel: { 'grok-4.6': 'high' },
      fastModeByModel: { 'grok-4.6': true },
      lastByVendor: {
        pi: expect.objectContaining({
          model: 'grok-4.6',
          providerId: 'xai',
          effort: 'high',
        }),
      },
    });
    expect(subscriber).toHaveBeenCalledTimes(1);

    // 旧 false 事件若迟到,当前 localStorage 的 true 仍是权威值,不得回滚内存或 main 镜像。
    subscriber.mockClear();
    onStorage?.({
      key: draftStore.__STORAGE_KEY,
      newValue: JSON.stringify({
        ...draftStore.getDraft(),
        worktreeEnabled: false,
        worktreePreferenceCustomized: true,
      }),
    } as StorageEvent);
    expect(draftStore.getDraft().worktreeEnabled).toBe(true);
    expect(subscriber).not.toHaveBeenCalled();
  });

  it('vendor 字段非合法值(非 cc/codex)→ 回退 cc', async () => {
    memStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify({ vendor: 'gemini' }));
    vi.resetModules();
    const { getDraft } = await loadModule();
    expect(getDraft().vendor).toBe('cc');
  });

  it('schema:fastModeByModel 只把 true 当作 enabled,其余值归一为 false', async () => {
    memStorage.setItem(
      'xdt:newMakerDraft:v1',
      JSON.stringify({
        fastModeByModel: {
          'gpt-5.5': true,
          'gpt-5.4': 'true',
          'claude-opus-4-7': 1,
        },
      }),
    );
    vi.resetModules();
    const { getDraft, getFastModeForModel } = await loadModule();
    expect(getFastModeForModel('gpt-5.5')).toBe(true);
    expect(getFastModeForModel('gpt-5.4')).toBe(false);
    expect(getFastModeForModel('claude-opus-4-7')).toBe(false);
    expect(getDraft().fastModeByModel).toEqual({
      'gpt-5.5': true,
      'gpt-5.4': false,
      'claude-opus-4-7': false,
    });
  });

  // #807:设备是独立于 workingDir 的一级维度。原先「workingDir 变 null 就无条件清设备」的
  // 不变量会把「选设备」这个动作本身打死 —— 选设备传的正是 { deviceId, workingDir: null }。
  describe('device-link 设备字段与 workingDir 的关系', () => {
    it('显式带设备 + workingDir=null(选设备)→ 设备必须保留', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: null,
      });
      expect(getDraft().deviceLinkDeviceId).toBe('dev-a');
      expect(getDraft().deviceLinkDeviceName).toBe('Studio Mac');
      expect(getDraft().workingDir).toBeNull();
    });

    it('显式带设备 + 具体 workingDir(选该设备上的项目)→ 两者都保留', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: '/host/proj' });
      expect(getDraft().deviceLinkDeviceId).toBe('dev-a');
      expect(getDraft().workingDir).toBe('/host/proj');
    });

    it('改 workingDir 但不带设备字段 → 仍按老规则清设备(防本地项目被误当远程)', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host/proj',
      });
      patchDraft({ workingDir: '/local/proj' });
      expect(getDraft().deviceLinkDeviceId).toBeNull();
      expect(getDraft().deviceLinkDeviceName).toBeNull();
    });

    it('清空 workingDir 且不带设备字段(发送后重置)→ 设备一并清掉', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });
      patchDraft({ workingDir: null, extraDirs: [] });
      expect(getDraft().deviceLinkDeviceId).toBeNull();
    });

    it('显式把设备清成 null(回落本机)→ 照常生效', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });
      patchDraft({ deviceLinkDeviceId: null, deviceLinkDeviceName: null, workingDir: null });
      expect(getDraft().deviceLinkDeviceId).toBeNull();
      expect(getDraft().deviceLinkDeviceName).toBeNull();
    });

    // 协同与项目/对话形态正交:切设备后落到该设备的对话态也不能静默关掉用户选择。
    it('选设备但没选项目(对话模式)→ 协同开关保留', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ workingDir: '/local/proj' });
      patchDraft({ collab: { enabled: true, worker: 'cc' } });
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });
      expect(getDraft().collab.enabled).toBe(true);
    });

    it('选设备上的项目 → 协同开关保留(不再被 device-link 一刀切关掉)', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ workingDir: '/local/proj' });
      patchDraft({ collab: { enabled: true, worker: 'cc' } });
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host/proj',
      });
      expect(getDraft().collab.enabled).toBe(true);
      expect(getDraft().collab.worker).toBe('cc');
    });

    // model / providerId / effort / fast 都是设备作用域:原样带到另一台机器会撞被控端的
    // 精确 preflight,协同静默降级成单会话 —— 正是 #1170 抱怨的「入口能点但走不完」。
    it('换目标设备 → 清掉 Worker 富配置,但保留协同开关与 worker 类型', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ workingDir: '/local/proj' });
      patchDraft({
        collab: {
          enabled: true,
          worker: 'codex',
          workerConfig: {
            role: 'developer',
            model: 'codex/gpt-5.5',
            effort: 'high',
            fast: false,
            providerId: 'prov-local',
            initialTask: '先跑一遍测试',
          },
        },
      });
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host/proj',
      });
      expect(getDraft().collab.enabled).toBe(true);
      expect(getDraft().collab.worker).toBe('codex');
      expect(getDraft().collab.workerConfig).toBeUndefined();
    });

    it('本机 → 设备 A → 设备 B 的每一跳都清 Worker 配置', async () => {
      const { getDraft, patchDraft, patchCollab } = await loadModule();
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host-a/proj',
      });
      patchCollab({
        enabled: true,
        worker: 'cc',
        workerConfig: { role: 'reviewer', model: 'claude-opus-4-7' },
      });
      expect(getDraft().collab.workerConfig?.model).toBe('claude-opus-4-7');
      patchDraft({
        deviceLinkDeviceId: 'dev-b',
        deviceLinkDeviceName: 'Laptop',
        workingDir: '/host-b/proj',
      });
      expect(getDraft().collab.workerConfig).toBeUndefined();
      expect(getDraft().collab.enabled).toBe(true);
    });

    it('同一台设备内换项目 → Worker 配置保留(模型目录没变)', async () => {
      const { getDraft, patchDraft, patchCollab } = await loadModule();
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host-a/proj',
      });
      patchCollab({
        enabled: true,
        worker: 'cc',
        workerConfig: { role: 'reviewer', model: 'claude-opus-4-7' },
      });
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: '/host-a/other' });
      expect(getDraft().collab.workerConfig?.model).toBe('claude-opus-4-7');
    });
  });
});
