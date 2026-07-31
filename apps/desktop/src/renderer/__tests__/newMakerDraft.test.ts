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
    // 种子模型不再写死在 store 里（原先是 'gpt-5.4'，与 modelDefinitions 写死的 'gpt-5.5'
    // 漂移，且两者在目录里都是默认隐藏的模型）。现在统一从 getDefaultModelForVendor 取，
    // capabilities 未加载时它给冷启动占位 id —— 这里只锁「非空且与那个入口同源」。
    const { coldStartModelIdForVendor } = await import('@/lib/modelDefinitions');
    expect(d.lastByVendor.codex.model).toBe(coldStartModelIdForVendor('codex'));
    expect(d.lastByVendor.cc.model).toBe(coldStartModelIdForVendor('cc'));
    expect(d.fastModeByModel).toEqual({});
    expect(d.effortByModel).toEqual({});
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
    });
    expect(wc?.initialTask).toBeUndefined();
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

  it('switchVendor:落地当前 vendor 的最新 prefs 后再切到目标 vendor', async () => {
    const { getDraft, switchVendor } = await loadModule();
    // 当前 vendor='cc',传入"模拟用户改过的 cc prefs"
    switchVendor('codex', {
      ...getDraft().lastByVendor.cc,
      model: 'claude-opus-4-7',
      effort: 'high',
      permissionMode: 'plan',
    });
    const d = getDraft();
    expect(d.vendor).toBe('codex');
    // 旧 vendor(cc)的 prefs 被落地为传入的值
    expect(d.lastByVendor.cc.model).toBe('claude-opus-4-7');
    expect(d.lastByVendor.cc.effort).toBe('high');
    expect(d.lastByVendor.cc.permissionMode).toBe('plan');
    // 新 vendor(codex)的 prefs 不变(等待用户在 codex 下继续操作)
    expect(d.lastByVendor.codex.permissionMode).toBe('auto');
  });

  it('switchVendor:相同 vendor 不变(no-op,避免误覆盖)', async () => {
    const { getDraft, switchVendor } = await loadModule();
    const before = getDraft().lastByVendor.cc;
    switchVendor('cc', { ...before, model: 'XX', effort: 'low', permissionMode: 'auto' });
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

  it('patchVendorPrefsPreservingModelChoice:会话同步草稿默认不打显式选择标记', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(m1.getDraft().lastByVendor.cc.effort).toBe('high');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');

    m1.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-opus-4-8');
  });

  it('patchVendorPrefsPreservingModelChoice:会话同步 model 会清掉旧显式选模标记', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('cc', { model: 'claude-sonnet-4-6' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });
    expect(m1.getPersistedVendorModel('cc')).toBe('claude-sonnet-4-6');

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    expect(m1.getDraft().lastByVendor.cc.model).toBe('claude-opus-4-8');
    expect(m1.getDraft().modelChosenByVendor).toEqual({});
    expect(m1.getPersistedVendorModel('cc')).toBe('');
  });

  it('patchVendorPrefsPreservingModelChoice:会话同步同一 model 保留旧显式选模标记', async () => {
    const m1 = await loadModule();
    m1.patchVendorPrefs('cc', { model: 'claude-opus-4-8' });
    expect(m1.getDraft().modelChosenByVendor).toEqual({ cc: true });

    m1.patchVendorPrefsPreservingModelChoice('cc', {
      model: 'claude-opus-4-8',
      effort: 'high',
    });

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

  it('schema:worktree root 字段不再持久化,读取时直接忽略', async () => {
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
      patchDraft({
        deviceLinkDeviceId: 'dev-a',
        deviceLinkDeviceName: 'Studio Mac',
        workingDir: '/host/proj',
      });
      expect(getDraft().deviceLinkDeviceId).toBe('dev-a');
      expect(getDraft().workingDir).toBe('/host/proj');
    });

    it('改 workingDir 但不带设备字段 → 仍按老规则清设备(防本地项目被误当远程)', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: '/host/proj' });
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

    // issue #1170:device-link 草稿曾被硬编码禁用协同,而同一个项目建成会话后入口又出现。
    // 现在草稿与会话页共用同一份判定(resolveCollabEntryPolicy),device-link **项目**可开协同;
    // 关掉协同的只剩「对话模式」这一条(workingDir == null)。
    it('选设备但没选项目(对话模式)→ 协同仍然关闭', async () => {
      const { getDraft, patchDraft } = await loadModule();
      patchDraft({ workingDir: '/local/proj' });
      patchDraft({ collab: { enabled: true, worker: 'cc' } });
      patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });
      expect(getDraft().collab.enabled).toBe(false);
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
