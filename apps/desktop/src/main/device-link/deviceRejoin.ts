/**
 * 「重新加入」：这台设备在 Cindy 里被移除过（Device Link 以 4410 断开它，或 Agent-Net 拒绝它的身份），用户在这台设备上
 * 要它回来。不需要重新登录，也不需要别的设备批准——被移除的设备可以自己回来是用户的决定（2026-11-23）；只能让自己这台
 * 回来（服务端只认账号令牌里的设备号）。只用于官方网络，自建中转仍按它自己的配对。
 *
 * 顺序：先恢复 Device Link 登记（官方网络上其他电脑只认账号设备列表里的设备，packages/agent-net/src/membership.ts），
 * 再解除 Agent-Net 的撤销，最后只重连本机自己的连接。都在用户点击时各发一次，不自动重试、不轮询。
 * 协议约定见 docs/dev-rules/protocol-compatibility/agent-net-device-removal.md。
 */
import { ServerApiError } from '../serverApiClient.js';

export type AgentNetRejoinOutcome = 'rejoined' | 'skipped' | 'failed';

export interface DeviceRejoinPorts {
  /** 选了自建中转时不适用。 */
  selfHostedRelaySelected(): boolean;
  /** 官方 Device Link REST（账号令牌、401 刷新）。 */
  officialFetch(path: string, opts: { method: 'POST'; body: Record<string, never>; timeoutMs: number }): Promise<unknown>;
  /** 解除官方 Agent-Net 的撤销；这台没用过 Agent-Net 时 'skipped'。 */
  rejoinAgentNet(): Promise<'rejoined' | 'skipped'>;
  /** 「仅使用 Agent-Net」：Agent-Net 回不来就整台连不上。 */
  agentNetRequired(): boolean;
  /** 重建本机自己的连接（清掉「已移除」状态后重新连）。 */
  restartConnection(): void;
  /**
   * 点击时的账号与中转是否仍是当前的；变了就抛错。每个等待点之后都核对：中途切了账号，后面的入网与重连不能落到
   * 新账号上（2026-11-23 review）。
   */
  assertCurrent(): void;
  warn(message: string, error?: unknown): void;
}

export const DEVICE_REJOIN_PATH = '/api/device-link/rejoin';

export async function rejoinRemovedDevice(ports: DeviceRejoinPorts): Promise<{ agentNet: AgentNetRejoinOutcome }> {
  if (ports.selfHostedRelaySelected()) throw new Error('DEVICE_REJOIN_OFFICIAL_ONLY');
  try {
    await ports.officialFetch(DEVICE_REJOIN_PATH, { method: 'POST', body: {}, timeoutMs: 10_000 });
  } catch (error) {
    ports.assertCurrent();
    // 还没有这个接口的服务端：照旧只能退出后重新登录。
    if (error instanceof ServerApiError && error.statusCode === 404) throw new Error('DEVICE_REJOIN_UNSUPPORTED');
    throw error;
  }
  ports.assertCurrent();
  let agentNet: AgentNetRejoinOutcome;
  try {
    agentNet = await ports.rejoinAgentNet();
  } catch (error) {
    ports.assertCurrent();
    // Device Link 已经回来了：不是「仅使用 Agent-Net」时照常走 Device Link，下次重新加入再试 Agent-Net。
    ports.warn('agent-net rejoin failed; this device keeps its Device Link registration', error);
    agentNet = 'failed';
  }
  ports.assertCurrent();
  ports.restartConnection();
  if (agentNet === 'failed' && ports.agentNetRequired()) throw new Error('AGENT_NET_REJOIN_FAILED');
  return { agentNet };
}
