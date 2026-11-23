/**
 * 测试价值
 * - 生产入口与可观察结果：rejoinRemovedDevice（设置页「重新加入」经 IPC 调它）；对服务端发出的请求及顺序、是否重连、
 *   交给界面的结果或错误。
 * - Bug／规则依据：2026-11-23 被移除的设备再也回不到官方 Agent-Net；docs/dev-rules/protocol-compatibility/agent-net-device-removal.md
 *   「重新加入」一节（先恢复 Device Link 登记，再解除 Agent-Net 撤销，一次点击各一次请求）。
 * - 现有覆盖缺口：新流程；relay.integration.test.ts 只验证中转放行，agentNetOfficial.test.ts 只验证入网请求。
 * - 最小失败输入：旧服务端回 404；「仅使用 Agent-Net」时 Agent-Net 没能回来；选了自建中转。
 * - tier：unit，端口注入，无网络与计时。
 * - 实测耗时：见 PR 描述。
 */
import { describe, expect, it, vi } from 'vitest';
import { ServerApiError } from '../../serverApiClient.js';
import { DEVICE_REJOIN_PATH, rejoinRemovedDevice, type DeviceRejoinPorts } from '../deviceRejoin.js';

function ports(overrides: Partial<DeviceRejoinPorts> = {}) {
  const calls: string[] = [];
  const value: DeviceRejoinPorts = {
    selfHostedRelaySelected: () => false,
    officialFetch: vi.fn(async (path: string) => { calls.push('device-link ' + path); return { rejoined: true }; }),
    rejoinAgentNet: vi.fn(async () => { calls.push('agent-net'); return 'rejoined' as const; }),
    agentNetRequired: () => false,
    restartConnection: vi.fn(() => { calls.push('restart'); }),
    assertCurrent: () => undefined,
    warn: vi.fn(),
    ...overrides,
  };
  return { value, calls };
}

describe('rejoinRemovedDevice', () => {
  it('restores the Device Link registration first, then Agent-Net, then reconnects once', async () => {
    const { value, calls } = ports();
    await expect(rejoinRemovedDevice(value)).resolves.toEqual({ agentNet: 'rejoined' });
    expect(calls).toEqual(['device-link ' + DEVICE_REJOIN_PATH, 'agent-net', 'restart']);
    expect(value.officialFetch).toHaveBeenCalledWith(DEVICE_REJOIN_PATH, expect.objectContaining({ method: 'POST', body: {} }));
  });

  it('reports an older server without the rejoin endpoint and leaves Agent-Net and the connection alone', async () => {
    const { value, calls } = ports({ officialFetch: vi.fn(async () => { throw new ServerApiError('NOT_FOUND', 404, 'Not Found'); }) });
    await expect(rejoinRemovedDevice(value)).rejects.toThrow('DEVICE_REJOIN_UNSUPPORTED');
    expect(calls).toEqual([]);
  });

  it.each([
    [false, { agentNet: 'failed' }],
    [true, 'AGENT_NET_REJOIN_FAILED'],
  ] as const)('when Agent-Net cannot come back (Agent-Net only: %s) still reconnects on Device Link', async (agentNetOnly, outcome) => {
    const { value, calls } = ports({
      rejoinAgentNet: vi.fn(async () => { throw Object.assign(new Error('refused'), { status: 403 }); }),
      agentNetRequired: () => agentNetOnly,
    });
    const result = rejoinRemovedDevice(value);
    if (typeof outcome === 'string') await expect(result).rejects.toThrow(outcome);
    else await expect(result).resolves.toEqual(outcome);
    expect(calls).toEqual(['device-link ' + DEVICE_REJOIN_PATH, 'restart']);
  });

  // Review (Greptile P1, 2026-11-23): switching accounts while the Device Link request is in flight must not lift the
  // removal for, or reconnect, the account that is current afterwards.
  it('stops before Agent-Net and the reconnection when the account changes during the request', async () => {
    let switched = false;
    const { value, calls } = ports({
      officialFetch: vi.fn(async () => { calls.push('device-link'); switched = true; return {}; }),
      assertCurrent: () => { if (switched) throw new Error('DEVICE_REJOIN_SCOPE_CHANGED'); },
    });
    await expect(rejoinRemovedDevice(value)).rejects.toThrow('DEVICE_REJOIN_SCOPE_CHANGED');
    expect(calls).toEqual(['device-link']);
  });

  it('does not touch the official service while a self-hosted relay is selected', async () => {
    const { value, calls } = ports({ selfHostedRelaySelected: () => true });
    await expect(rejoinRemovedDevice(value)).rejects.toThrow('DEVICE_REJOIN_OFFICIAL_ONLY');
    expect(calls).toEqual([]);
  });
});
