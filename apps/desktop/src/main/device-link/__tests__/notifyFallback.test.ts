/** 测试价值
 * - 生产入口与可观察结果：notifyOutsideAgentNet（index.ts sendNotifyToPhones 用它决定 Agent-Net 主连接之外还要经 Device Link 补发哪几份推送）。
 *   每台手机恰好收到一份：Agent-Net 覆盖的手机不再经 Device Link 收第二份，没覆盖的补发；Agent-Net 一台都没覆盖或没发出去时，
 *   和只有 Device Link 时一样不指定设备发一份。
 * - Bug／规则依据：2026-11-17 排查，开着 Agent-Net 时推送只发给在 Agent-Net 上登记了推送的设备，没开 Agent-Net 的手机收不到；
 *   docs/product-rules/agent-net.md「只更新一端不能让任何功能失效」。
 * - 现有覆盖缺口：新规则。
 * - 最小失败输入：指定一台已覆盖 / 未覆盖的手机；不指定时零覆盖、部分覆盖；主连接没发出去。
 * - tier：unit，纯函数，无 IO。 */
import { describe, expect, it } from 'vitest';
import type { NotifyPayload } from '@cindy/device-link';
import { notifyOutsideAgentNet } from '../notifyFallback';

const push = { category: 'session-done', title: 'Task', deepLink: 'cindy://x', collapseId: 'c' } as NotifyPayload;

describe('notifyOutsideAgentNet', () => {
  it('sends each phone the push once: Agent-Net covers some, Device Link the rest, as before when Agent-Net covers none', () => {
    const covered = new Set(['phone-a']);
    const phones = ['phone-a', 'phone-b', 'self'];
    // Agent-Net did not send it: one untargeted copy, as with Device Link alone.
    expect(notifyOutsideAgentNet(push, false, covered, phones, 'self')).toEqual([push]);
    // A push for one phone: only if Agent-Net does not cover it.
    expect(notifyOutsideAgentNet({ ...push, targetDeviceId: 'phone-a' }, true, covered, phones, 'self')).toEqual([]);
    expect(notifyOutsideAgentNet({ ...push, targetDeviceId: 'phone-b' }, true, covered, phones, 'self'))
      .toEqual([{ ...push, targetDeviceId: 'phone-b' }]);
    // Untargeted: each known phone Agent-Net does not cover, never this device.
    expect(notifyOutsideAgentNet(push, true, covered, phones, 'self')).toEqual([{ ...push, targetDeviceId: 'phone-b' }]);
    // Agent-Net covers nobody: the server's own fan-out to every phone, exactly as Device Link.
    expect(notifyOutsideAgentNet(push, true, new Set(), phones, 'self')).toEqual([push]);
    // Every phone covered: nothing more.
    expect(notifyOutsideAgentNet(push, true, new Set(['phone-a', 'phone-b']), phones, 'self')).toEqual([]);
  });
});
