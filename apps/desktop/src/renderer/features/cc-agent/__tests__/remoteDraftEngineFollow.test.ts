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

  it('keeps an engine the user picked before the defaults arrived', () => {
    nextRemoteDraftEngine({ ...base, deviceId: 'studio', currentVendor: 'pi' });
    expect(nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'codex', defaultsReady: true, selectedAgentKind: 'claude-code',
    })).toBeNull();
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'codex' })).toBeNull();
  });

  it('does not restore over an engine the user changed while targeting the remote computer', () => {
    nextRemoteDraftEngine({
      ...base, deviceId: 'studio', currentVendor: 'pi', defaultsReady: true, selectedAgentKind: 'claude-code',
    });
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'codex' })).toBeNull();
  });

  it('leaves the engine alone for an older target that does not report one', () => {
    expect(nextRemoteDraftEngine({ ...base, deviceId: 'old', currentVendor: 'pi', defaultsReady: true })).toBeNull();
    expect(nextRemoteDraftEngine({ ...base, deviceId: null, currentVendor: 'pi' })).toBeNull();
  });
});
