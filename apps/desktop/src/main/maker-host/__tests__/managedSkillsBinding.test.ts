/**
 * 测试价值
 * - 可观察结果：managed-skills.ts 求值时 cindy-brain/index.js 的三个导出还没就绪（两者互相
 *   import，打包后 managed-skills 先求值的情形），之后就绪，列托管 Skill 仍然调到这三个函数。
 * - 规则依据：桌面绑定的端口在调用时解析，不在模块加载时取引用（m1-cp6 审核）。
 * - 最小失败输入：createManagedSkills({ listAvailableGhosts: listAvailableGhostsAsync, ... })
 *   这种加载时直接传引用的写法。
 * - tier：unit（mock 掉插件注册表与内置 Skill，不读写真实 profile）。
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ready: false, calls: [] as string[] }));

vi.mock('../../cindy-brain/index.js', () => ({
  // Not ready while managed-skills.ts is being evaluated.
  get listAvailableGhostsAsync() {
    return state.ready ? async () => { state.calls.push('list'); return []; } : undefined;
  },
  get getGhostManager() {
    return state.ready ? () => { state.calls.push('manager'); return { verifyApprovedSkillSnapshot: async () => true }; } : undefined;
  },
  get loadGhostFirstPartyFactsForGhost() {
    return state.ready ? () => { state.calls.push('facts'); return { kind: 'missing' }; } : undefined;
  },
}));
vi.mock('../built-in-skills.js', () => ({
  sharedBuiltInSkillsRoot: (root: string) => root,
  builtInSkillDescriptorsAsync: async () => [],
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner',
  getActiveAppSession: () => ({ dataOwnerId: 'owner' }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../authBoundaryQuarantine.js', () => ({
  withSharedGlobalSkillProjectionMutation: async (_owner: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('../../userDataPath.js', () => ({ getUserDataDir: () => '/unused', getAppDataDir: () => '/unused' }));

describe('the desktop managed Skill binding', () => {
  it('resolves the plugin registry when listing, not when the module loads', async () => {
    const { listCindyManagedSkills } = await import('../managed-skills.js');
    state.ready = true;
    await expect(listCindyManagedSkills()).resolves.toEqual([]);
    expect(state.calls).toEqual(['manager', 'list']);
  });
});
