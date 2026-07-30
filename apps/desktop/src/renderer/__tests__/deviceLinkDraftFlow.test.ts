/**
 * deviceLinkDraftFlow.test.ts —— 「先选设备再选工作区」的端到端状态迁移(#807)。
 *
 * 为什么要有这一层:单独测 store 的不变量、单独测 buildDeviceLinkCreateArgs 都通过,链条依然可能
 * 是断的 —— review 抓到的正是这种情况:store 里「workingDir 变 null 就清设备」的旧不变量让
 * 「选设备」这个动作本身失效(选设备传的就是 { deviceId, workingDir: null }),于是设备刚设上
 * 就被清成 null、整条流程静默退回本机执行。单点测试都绿,功能却完全不工作。
 *
 * 所以这里按**真实 UI 顺序**串起来跑:设备 pill 选设备 → 工作区 pill 选对话/项目 → 组装建会话
 * 参数,断言每一步之后 draft 与 create args 的真实形状。patch 形状与 NewMakerDraftRoute 里
 * handleDeviceChange / handleWorkingDirChange 实际下发的保持一致。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

class Mem {
  private s = new Map<string, string>();
  getItem(k: string) { return this.s.has(k) ? (this.s.get(k) as string) : null; }
  setItem(k: string, v: string) { this.s.set(k, v); }
  removeItem(k: string) { this.s.delete(k); }
  clear() { this.s.clear(); }
}
beforeEach(() => {
  const m = new Mem();
  vi.stubGlobal('window', { localStorage: m });
  vi.stubGlobal('localStorage', m);
  vi.resetModules();
});

describe('#807 端到端状态迁移', () => {
  it('选对端设备 → 停在对话 → 建出 dialogue 参数(会话落对端)', async () => {
    const { getDraft, patchDraft } = await import('@/state/newMakerDraft');
    const { buildDeviceLinkCreateArgs } = await import('@/features/cc-agent/deviceLinkCreateArgs');

    // 1) 设备 pill 选「工作室 Mac Studio」(handleDeviceChange 的 patch 形状)
    patchDraft({
      deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac',
      workingDir: null, remoteHostId: null, extraDirs: [],
    });
    expect(getDraft().deviceLinkDeviceId).toBe('dev-a');

    // 2) isDeviceLinkDraft 只看 deviceId → 该草稿要走对端
    const d = getDraft();
    expect(d.deviceLinkDeviceId != null).toBe(true);

    // 3) 建会话参数:无 workingDir → dialogue,且不带 workingDir
    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc', workingDir: d.workingDir ?? undefined,
      model: 'm', effort: 'medium', permissionMode: 'auto', fastMode: false,
    });
    expect(args.workspaceKind).toBe('dialogue');
    expect('workingDir' in args).toBe(false);
  });

  it('选对端设备 → 再选它的项目 → 建出 project 参数,设备不丢', async () => {
    const { getDraft, patchDraft } = await import('@/state/newMakerDraft');
    const { buildDeviceLinkCreateArgs } = await import('@/features/cc-agent/deviceLinkCreateArgs');

    patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null, remoteHostId: null, extraDirs: [] });
    // handleWorkingDirChange(path) 的 patch 形状(显式回传设备)
    const cur = getDraft();
    patchDraft({
      workingDir: '/host/proj', remoteHostId: null,
      deviceLinkDeviceId: cur.deviceLinkDeviceId, deviceLinkDeviceName: cur.deviceLinkDeviceName,
    });
    const d = getDraft();
    expect(d.deviceLinkDeviceId).toBe('dev-a');
    expect(d.workingDir).toBe('/host/proj');

    const args = buildDeviceLinkCreateArgs({
      agentKind: 'cc', workingDir: d.workingDir ?? undefined,
      model: 'm', effort: 'medium', permissionMode: 'auto', fastMode: false,
    });
    expect(args.workspaceKind).toBe('project');
    expect(args.workingDir).toBe('/host/proj');
  });

  it('对端项目 → 切回「对话」→ 设备仍在,变成该设备的 dialogue', async () => {
    const { getDraft, patchDraft } = await import('@/state/newMakerDraft');
    patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: '/host/proj' });
    const cur = getDraft();
    patchDraft({
      workingDir: null, remoteHostId: null, extraDirs: [],
      deviceLinkDeviceId: cur.deviceLinkDeviceId, deviceLinkDeviceName: cur.deviceLinkDeviceName,
    });
    expect(getDraft().deviceLinkDeviceId).toBe('dev-a');
    expect(getDraft().workingDir).toBeNull();
  });

  it('切回本机 → 设备清空,回本机创建', async () => {
    const { getDraft, patchDraft } = await import('@/state/newMakerDraft');
    patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });
    patchDraft({ deviceLinkDeviceId: null, deviceLinkDeviceName: null, workingDir: null, remoteHostId: null, extraDirs: [] });
    expect(getDraft().deviceLinkDeviceId).toBeNull();
  });

  // #807 review 第二轮:唯一对端被解除配对时列表合法变空 —— 回落必须仍然触发,否则草稿会
  // 永久指着一台已消失的设备,而 pill 因为没设备而消失,用户在 UI 上再也切不回本机。
  it('已加载的空列表 → 回落判据成立(不是靠「列表非空」)', async () => {
    const { getDraft, patchDraft } = await import('@/state/newMakerDraft');
    patchDraft({ deviceLinkDeviceId: 'dev-a', deviceLinkDeviceName: 'Studio Mac', workingDir: null });

    // 复刻 effect 的判据:loaded 且当前设备不在列表里 → 回落。
    const shouldFallBack = (loaded: boolean, devices: { deviceId: string }[], cur: string | null) =>
      cur != null && loaded && !devices.some((d) => d.deviceId === cur);

    const cur = getDraft().deviceLinkDeviceId;
    // 已加载 + 空列表(设备被解除配对)→ 必须回落
    expect(shouldFallBack(true, [], cur)).toBe(true);
    // 未加载(首帧 / device-link 不可用)+ 空列表 → 绝不能动草稿
    expect(shouldFallBack(false, [], cur)).toBe(false);
    // 已加载且设备仍在(含离线,离线设备照样留在列表里)→ 不回落
    expect(shouldFallBack(true, [{ deviceId: 'dev-a' }], cur)).toBe(false);

    // 回落本身:清空设备与工作区,回到本机
    patchDraft({
      deviceLinkDeviceId: null, deviceLinkDeviceName: null,
      workingDir: null, remoteHostId: null, extraDirs: [],
    });
    expect(getDraft().deviceLinkDeviceId).toBeNull();
  });
});
