import { describe, expect, it } from 'vitest';
import {
  DeviceLinkError,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  REMOTE_INVOKE_ALLOWLIST,
  type DeviceLinkErrorCode,
} from '@cindy/device-link';
import {
  BREAKER_NEUTRAL_INVOKE_CHANNELS,
  buildDeviceResponsivenessProbeArgs,
  classifyDeviceSendSuccess,
  classifyLinkOpenFailure,
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

describe('classifyDeviceSendSuccess(成功回包 → 熔断信号分类)', () => {
  it('dispatch 特判通道(media / voice)成功按不定论,不作恢复证据(review P1)', () => {
    // 这四条在被控端 runInvoke 里、dispatchLocalInvoke 之前特判应答,IPC/DB
    // 卡死时照常成功;half-open 时抢到探测席位不得误关熔断。
    expect([...BREAKER_NEUTRAL_INVOKE_CHANNELS].sort()).toEqual([
      'device-link:media:fetch',
      'device-link:voice:credential-sync',
      'device-link:voice:dictionary-learning',
      'device-link:voice:transcribe',
    ]);
    for (const channel of BREAKER_NEUTRAL_INVOKE_CHANNELS) {
      expect(classifyDeviceSendSuccess(channel)).toBe('inconclusive');
    }
  });

  it('代表性探测与业务 DB 通道的成功仍是有效恢复证据(闭合态)', () => {
    expect(classifyDeviceSendSuccess(DEVICE_RESPONSIVENESS_PROBE_CHANNEL)).toBe('responded');
    expect(classifyDeviceSendSuccess('local-db:messages:list')).toBe('responded');
    expect(classifyDeviceSendSuccess('maker:send')).toBe('responded');
    expect(classifyDeviceSendSuccess('file-browser:remote-op')).toBe('responded');
  });

  it('持有探测席位时只有指定探测通道能关熔断(review P1:纯内存 IPC handler 不算)', () => {
    // maker:list-agent-commands 等 handler 是同步内存实现,DB 卡死时照常应答;
    // 半开窗口里凑巧抢到探测席位的成功不能作恢复证据。
    expect(classifyDeviceSendSuccess(DEVICE_RESPONSIVENESS_PROBE_CHANNEL, true)).toBe('responded');
    expect(classifyDeviceSendSuccess('maker:list-agent-commands', true)).toBe('inconclusive');
    expect(classifyDeviceSendSuccess('local-db:messages:list', true)).toBe('inconclusive');
    // 闭合态(非探测)不受影响
    expect(classifyDeviceSendSuccess('maker:list-agent-commands', false)).toBe('responded');
  });
});

describe('classifyLinkOpenFailure(openLink 失败 → 熔断信号分类)', () => {
  const err = (code: DeviceLinkErrorCode) => new DeviceLinkError(code, code);

  it('终态 relay 应答(开关关闭 / 不在线 / 版本不符)按真实应答关熔断(review P1)', () => {
    // 设备状态已由 relay 明确回答,「响应性」判定失去意义:继续 unresponsive
    // 会让设备被永远探测,横幅还压着更可操作的错误态(如「已关闭远程控制」)。
    expect(classifyLinkOpenFailure(err('REMOTE_DISABLED'))).toBe('responded');
    expect(classifyLinkOpenFailure(err('DEVICE_OFFLINE'))).toBe('responded');
    expect(classifyLinkOpenFailure(err('VERSION_MISMATCH'))).toBe('responded');
  });

  it('传输层失败维持不定论,超时仍计失败', () => {
    expect(classifyLinkOpenFailure(err('NOT_CONNECTED'))).toBe('inconclusive');
    expect(classifyLinkOpenFailure(err('LINK_NOT_OPEN'))).toBe('inconclusive');
    expect(classifyLinkOpenFailure(err('INVOKE_TIMEOUT'))).toBe('timeout');
    expect(classifyLinkOpenFailure(new Error('boom'))).toBe('inconclusive');
  });
});
