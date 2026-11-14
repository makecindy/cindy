/**
 * 离线对端的出站调用闸门（控制端本地，不改 wire 协议）。
 *
 * 背景（2026-11-14 个人版日志）：一台对端整夜离线时，控制端的任务侧栏、Git 状态、
 * 子代理列表等轮询每次 invoke 都先发 link-open，relay 每次回 DEVICE_OFFLINE（约每 30 秒
 * 一轮，每小时 120 次以上），还把每个轮询各自的失败都打成错误日志。
 *
 * 规则：
 * - 只有 relay 明确判定离线（DEVICE_OFFLINE 路由信号，或 presence online=false 且没有
 *   保留的直连）才关闸；单次超时、背压、无响应都不算。
 * - 关闸期间的 invoke 在本地直接以同一个 DEVICE_OFFLINE 错误结束，调用方看到的结果与
 *   relay 回绝完全一致，只是不再触网。
 * - 每个退避窗口放行一次真实请求作为探测（15 s 起倍增，最长 120 s），即使 presence
 *   推送丢失，对端上线后最迟 120 s 也能恢复。
 * - presence online=true、收到该对端的任何路由帧、建立直连、relay 重连时立即开闸，
 *   上线后的第一笔调用就走真实链路，不会被退避拖住。
 */

export const PEER_OFFLINE_PROBE_BASE_MS = 15_000;
export const PEER_OFFLINE_PROBE_MAX_MS = 120_000;

interface GateState {
  /** 已放行的探测次数，决定下一个窗口长度。 */
  probes: number;
  /** 下一次允许真实请求触网的单调时刻。 */
  nextProbeAt: number;
}

export type PeerOfflineGateDecision = 'open' | 'probe' | 'blocked';

export class PeerOfflineGate {
  private readonly peers = new Map<string, GateState>();

  constructor(private readonly now: () => number) {}

  /** relay 判定离线：未关闸时关闸并开始第一个窗口；已关闸时保持原窗口（重复信号不延长等待）。 */
  markOffline(deviceId: string): void {
    if (this.peers.has(deviceId)) return;
    this.peers.set(deviceId, { probes: 0, nextProbeAt: this.now() + PEER_OFFLINE_PROBE_BASE_MS });
  }

  /** 对端重新可达的任何证据都立即开闸。 */
  markReachable(deviceId: string): boolean {
    return this.peers.delete(deviceId);
  }

  /** relay 连接重建后旧的离线判断失效；hello 后的 presence 会重新告知在线对端。 */
  clear(): void {
    this.peers.clear();
  }

  isGated(deviceId: string): boolean {
    return this.peers.has(deviceId);
  }

  /**
   * 出站前判定。窗口到期时只放行一笔探测并立刻推后下一个窗口，同一时刻多个轮询
   * 不会一起触网；探测成功由入站帧开闸，失败由 DEVICE_OFFLINE 保持关闸。
   */
  admit(deviceId: string): PeerOfflineGateDecision {
    const state = this.peers.get(deviceId);
    if (!state) return 'open';
    const now = this.now();
    if (now < state.nextProbeAt) return 'blocked';
    state.probes += 1;
    state.nextProbeAt = now + Math.min(
      PEER_OFFLINE_PROBE_MAX_MS,
      PEER_OFFLINE_PROBE_BASE_MS * 2 ** state.probes,
    );
    return 'probe';
  }
}
