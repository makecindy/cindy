import { beforeEach, describe, expect, it } from 'vitest';
import { resetRemoteDraftEngineFollow, nextRemoteDraftEngine } from '../remoteDraftEngineFollow';

// 控制端新装、引擎默认 Pi；被控端自己的新建任务用 Claude。远程草稿曾显示被控端 Pi 槽里的
// 旧选择(本地千问 + 自动审批)，而不是被控端真正在用的 Claude 选择。
const base = { ownerId: 'owner', selectedAgentKind: undefined, defaultsReady: false } as const;

describe('remote draft engine follows the target computer', () => {
  beforeEach(() => resetRemoteDraftEngineFollow());

  it('switches to the target engine once its defaults arrive, and restores the local engine on return', () => {
    expect(nextRemoteDraftEngine({ ...base, deviceId: 'studio', currentVendor: 'pi' })).toBeNull();
    expect(nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'pi', defaultsReady: true, selectedAgentKind: 'claude-code',
    })).toBe('cc');
    // 切过去之后不再重复切。
    expect(nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'cc', defaultsReady: true, selectedAgentKind: 'claude-code',
    })).toBeNull();
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'cc' })).toBe('pi');
  });

  it('keeps an engine the user picked before the defaults arrived, but only on that computer', () => {
    nextRemoteDraftEngine({ ...base, deviceId: 'studio', currentVendor: 'pi' });
    expect(nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'codex', defaultsReady: true, selectedAgentKind: 'claude-code',
    })).toBeNull();
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'codex' })).toBe('pi');
  });

  // 每台电脑记自己的选择：在远程电脑上换的引擎写回那台，回到本机恢复本机上次用的。
  // 最小失败输入：本机 Pi → studio 跟随到 Claude → 手动换 Codex → 回本机，应回到 Pi。
  it('restores the local engine after the user changed engines while targeting the remote computer', () => {
    nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'pi', defaultsReady: true, selectedAgentKind: 'claude-code',
    });
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'codex' })).toBe('pi');
  });

  it('keeps the original local engine across remote computers and follows each one', () => {
    nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'pi', defaultsReady: true, selectedAgentKind: 'claude-code',
    });
    // 在 studio 上手动换成 Codex 后去 laptop：laptop 按自己的选择跟随，回本机仍是 Pi。
    nextRemoteDraftEngine({ ...base, deviceId: 'laptop', currentVendor: 'codex' });
    expect(nextRemoteDraftEngine({
      ...base, deviceId: 'laptop', currentVendor: 'codex', defaultsReady: true, selectedAgentKind: 'claude-code',
    })).toBe('cc');
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'cc' })).toBe('pi');
  });

  it('leaves the engine alone for an older target that does not report one', () => {
    expect(nextRemoteDraftEngine({ ...base, deviceId: 'old', currentVendor: 'pi', defaultsReady: true })).toBeNull();
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'pi' })).toBeNull();
  });
});
