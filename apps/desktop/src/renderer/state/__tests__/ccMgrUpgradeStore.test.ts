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

describe('ccMgrUpgradeStore agent-scoped clear (round 22-G4 HIGH)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upgradeListener = null;
  });

  it('set pi pending then clear pi → pi snapshot null, cc unaffected', async () => {
    installCcMgrUpgradeListener();
    // 等初始 snapshot 的退避 setTimeout 不干扰(它 500ms 后才跑, 测试不 await)。
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
  });
});
