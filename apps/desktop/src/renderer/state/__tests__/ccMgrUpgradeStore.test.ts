/**
 * ccMgrUpgradeStore — 轮 22-G4 HIGH 回归测试:
 *   clear 路径(payload.available=null)必须按 payload.agent 定位, 清对应
 *   agent 的 pending —— 修复前 next?.agent ?? 'cc' 在 null 时永远清 'cc',
 *   ${hostId}:pi 残留导致 pi banner 不消失、重复升级入口。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// 捕获 onCcMgrUpgradeAvailable 注册的 listener, 测试里手动触发。
let upgradeListener: ((payload: {
  hostId: string;
  available: { currentVersion: string; availableVersion: string } | null;
  agent: 'cc' | 'pi';
}) => void) | null = null;

vi.stubGlobal('window', {
  electronAPI: {
    remoteSsh: {
      ccMgrListPendingUpgrades: vi.fn(async () => ({ pending: [] })),
      onCcMgrUpgradeAvailable: vi.fn((cb: typeof upgradeListener) => {
        upgradeListener = cb;
        return () => { upgradeListener = null; };
      }),
      ccMgrForceUpgrade: vi.fn(async () => ({ ok: true as const, daemonReady: true })),
      ccMgrDismissPendingUpgrade: vi.fn(async () => ({ ok: true as const })),
    },
  },
});

import {
  installCcMgrUpgradeListener,
  getCcMgrUpgradeSnapshot,
} from '../ccMgrUpgradeStore.js';

beforeEach(() => {
  vi.clearAllMocks();
  upgradeListener = null;
});

describe('ccMgrUpgradeStore agent-scoped clear (round 22-G4 HIGH)', () => {
  it('set pi pending then clear pi → pi snapshot null, cc unaffected', async () => {
    const dispose = installCcMgrUpgradeListener();
    expect(upgradeListener).not.toBeNull();

    // set pi pending
    upgradeListener!({
      hostId: 'h1',
      available: { currentVersion: '0.1.1', availableVersion: '0.1.2' },
      agent: 'pi',
    });
    expect(getCcMgrUpgradeSnapshot('h1', 'pi')).toEqual({
      currentVersion: '0.1.1',
      availableVersion: '0.1.2',
      agent: 'pi',
    });
    expect(getCcMgrUpgradeSnapshot('h1', 'cc')).toBeNull();

    // clear pi pending(available=null + agent='pi')
    upgradeListener!({ hostId: 'h1', available: null, agent: 'pi' });
    expect(getCcMgrUpgradeSnapshot('h1', 'pi')).toBeNull();

    // cc 的 pending 独立:set cc 后 clear pi 不影响 cc
    upgradeListener!({
      hostId: 'h1',
      available: { currentVersion: '1.0.0', availableVersion: '1.0.1' },
      agent: 'cc',
    });
    upgradeListener!({ hostId: 'h1', available: null, agent: 'pi' });
    expect(getCcMgrUpgradeSnapshot('h1', 'cc')).toEqual({
      currentVersion: '1.0.0',
      availableVersion: '1.0.1',
      agent: 'cc',
    });
    // 清 cc 后 cc 也消失
    upgradeListener!({ hostId: 'h1', available: null, agent: 'cc' });
    expect(getCcMgrUpgradeSnapshot('h1', 'cc')).toBeNull();
    dispose();
  });
});

// Cold-start regression: install only after EnvCheckGuard has passed. The ready
// caller must see the pending snapshot without a guessed delay; a late response
// must not revive a dismissed banner or update an unmounted window. Existing
// coverage exercised push-only clears, never an in-flight snapshot (unit tier).
type UpgradeSnapshot = Awaited<ReturnType<typeof window.electronAPI.remoteSsh.ccMgrListPendingUpgrades>>;

function pendingSnapshot() {
  let resolveSnapshot!: (value: UpgradeSnapshot) => void;
  const snapshot = new Promise<UpgradeSnapshot>((resolve) => { resolveSnapshot = resolve; });
  return { snapshot, resolveSnapshot };
}

describe('ccMgrUpgradeStore ready snapshot lifecycle', () => {
  it('loads immediately after registration and preserves newer pushes', async () => {
    const { snapshot, resolveSnapshot } = pendingSnapshot();
    vi.mocked(window.electronAPI.remoteSsh.ccMgrListPendingUpgrades).mockReturnValueOnce(snapshot);
    const dispose = installCcMgrUpgradeListener();
    try {
      expect(window.electronAPI.remoteSsh.ccMgrListPendingUpgrades).toHaveBeenCalledTimes(1);
      upgradeListener!({ hostId: 'snapshot-cleared', agent: 'cc', available: null });
      resolveSnapshot({
        pending: ['snapshot-cleared', 'snapshot-kept'].map(hostId => ({
          hostId, agent: 'cc' as const, currentVersion: '1', availableVersion: '2',
        })),
      });
      await snapshot;
      expect(getCcMgrUpgradeSnapshot('snapshot-cleared')).toBeNull();
      expect(getCcMgrUpgradeSnapshot('snapshot-kept')?.availableVersion).toBe('2');
    } finally {
      dispose();
    }
  });

  it('ignores a pending response after teardown', async () => {
    const { snapshot, resolveSnapshot } = pendingSnapshot();
    vi.mocked(window.electronAPI.remoteSsh.ccMgrListPendingUpgrades).mockReturnValueOnce(snapshot);
    const dispose = installCcMgrUpgradeListener();
    dispose();
    resolveSnapshot({
      pending: [{ hostId: 'snapshot-disposed', agent: 'cc', currentVersion: '1', availableVersion: '2' }],
    });
    await snapshot;
    expect(getCcMgrUpgradeSnapshot('snapshot-disposed')).toBeNull();
  });
});
