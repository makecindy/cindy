import { describe, expect, it } from 'vitest';
import {
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  REMOTE_INVOKE_ALLOWLIST,
} from '@cindy/device-link';
import {
  buildDeviceResponsivenessProbeArgs,
  DEVICE_RESPONSIVENESS_PROBE_CHANNEL,
} from '@/device-link/unresponsiveDevicesStore';

describe('DEVICE_RESPONSIVENESS_PROBE_CHANNEL 契约', () => {
  it('探测通道在 allowlist 内(被控端不会以 CHANNEL_NOT_ALLOWED 拒绝)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST).toContain(DEVICE_RESPONSIVENESS_PROBE_CHANNEL);
  });

  it('探测通道不是 dispatch 在 runInvoke 之前特判的通道(review P1:必须穿过 IPC/DB 路径)', () => {
    // link-accept / subscribe / unsubscribe 在被控端 dispatch 里于 runInvoke 之前
    // 特判应答:IPC/DB 子系统卡死时它们照常回包,不能作为熔断恢复证据。
    expect(DEVICE_RESPONSIVENESS_PROBE_CHANNEL).not.toBe(DL_SUBSCRIBE_CHANNEL);
    expect(DEVICE_RESPONSIVENESS_PROBE_CHANNEL).not.toBe(DL_UNSUBSCRIBE_CHANNEL);
    // local-db 前缀 = 走 dispatchLocalInvoke 的真实 DB 读,正是事故里卡死的路径。
    expect(DEVICE_RESPONSIVENESS_PROBE_CHANNEL.startsWith('local-db:')).toBe(true);
  });

  it('探测参数是最小读:limit=1,与 devices 页正常拉取同一参数形状', () => {
    expect(buildDeviceResponsivenessProbeArgs()).toEqual([1, 'all', { includePinned: true }]);
    // 每次新数组,调用方可安全透传给 invoke(不共享可变引用)。
    expect(buildDeviceResponsivenessProbeArgs()).not.toBe(buildDeviceResponsivenessProbeArgs());
  });
});
