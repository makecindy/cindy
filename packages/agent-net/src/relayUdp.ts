/**
 * 经中继转发的数据报改走 UDP（docs/agent-net-session-plan.md 第 8 节；包格式与协议约定见 `@cindy/agent-net-relay` 的
 * udpRelay.ts 与 docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md）。
 *
 * 中继在 WebSocket 的 hello 里给了这条会话的 UDP 凭据时：先向中继的 UDP 端口登记本机地址；中继的确认里带一个地址凭证，
 * 之后的登记都带上它，中继据此认定这个地址真是本机的（确认说没认定时，马上带上新凭证再登记一次）。收到确认说明小包来回通。
 *
 * 登记只证明 50 字节小包能来回，不证明满长业务包能过（2026-11-22：VPN 透明代理吞大包；2026-11-25：仅靠端到端重传会把
 * 单台远端对端掉线/抖动误判成本机到中转的第 1 跳故障，连坐其他正常对端并锁进 30 分钟冷却）：
 * - 当中继支持满尺寸双向探测（`credentials.probe === true`，`udp-relay-probe-v1`）时：
 *   1. 地址被中继认定后，先发一个 1350 字节的 `UDP_RELAY_PROBE` 并收到中继回的 1342 字节 `UDP_RELAY_PROBE_ACK`，才启用中转 UDP；
 *   2. 运行中出现静默、请求超时或重传异常时，不直接熔断，先用满尺寸探测复核第 1 跳——中继秒回说明故障在对端（不熔断），
 *      探测超时才实锤第 1 跳故障、退回 WebSocket；
 *   3. 停用期间低频保持地址认定，冷却（15s → 30s → 60s → 120s）到期后先在 WebSocket 保护下做满尺寸探测，通了再切回 UDP。
 * - 当连接的是不支持探测的旧中继时，沿用端到端兜底检测，并修正两处误杀：
 *   1. 按对端连接分别统计中转重传：同期只要存在任意一台经中转对端在正常确认字节且无高重传，绝不因另一台掉线/抖动触发全局熔断；
 *      全员有确认推进但偶发重传时须连续两个窗口持续恶化才熔断（零确认的黑洞仍 5 秒内立即熔断）；
 *   2. 空闲采样窗口不打断健康恢复计时，累计跨过 60 秒的双向确认即清零退避档位（孤立单次确认或无确认发送仍不能清零）。
 * - 换网（`networkChanged`，例如关掉 VPN 或切 Wi-Fi/蜂窝）时立即清掉旧网络的冷却并重新登记、探测。
 * 和 STUN、直连共用核心的 UDP 端口；核心照常负责丢包重发和拥塞控制，这里不限速。
 */
import type { Address } from '@cindy/agent-net-core/node';
import {
  UDP_RELAY_DOWN, UDP_RELAY_PROBE_ACK, UDP_RELAY_REGISTER_ACK, encodeUdpProbe, encodeUdpRegister, encodeUdpUp, isUdpRelayPacket,
  udpRelayPeerHash, verifyUdpDown, verifyUdpProbeAck, verifyUdpRegisterAck, type UdpRelayCredentials,
} from '@cindy/agent-net-relay/client';
import { resolveUdpHost, splitHostPort } from './stun.js';

/** 不通、或有登记还没确认时每秒登记一次；连续 10 秒不通后放慢到每 5 秒。 */
const REGISTER_RETRY_MS = 1_000;
const REGISTER_SLOW_RETRY_MS = 5_000;
const SLOW_RETRY_AFTER_MS = 10_000;
/** 通了以后：空闲时每 15 秒保活（中继 30 秒没收到就改回 WebSocket）；正在发数据时每 2 秒刷新，NAT 换端口能很快跟上。 */
const KEEPALIVE_MS = 15_000;
const ACTIVE_REFRESH_MS = 2_000;
const ACTIVE_WINDOW_MS = 5_000;
/** 一次登记发出后这么久还没确认，就认为这条路不通了；比这更晚到的确认也不再算数。 */
const UNACKED_DOWN_MS = 4_000;
/** 兜底：这么久没收到任何确认也算不通（计时器被挂起等情况）。 */
const ACK_FRESH_MS = 40_000;
/** 中继地址：解析成功后每 5 分钟重新解析；失败从 2 秒起按倍数退避到 1 分钟；UDP 连续 30 秒不通时也提前重新解析。 */
const RESOLVE_REFRESH_MS = 5 * 60_000;
const RESOLVE_RETRY_FIRST_MS = 2_000;
const RESOLVE_RETRY_MAX_MS = 60_000;
const RESOLVE_WHEN_DOWN_MS = 30_000;
/** 最多记着这么多个还没确认的登记或探测。 */
const MAX_PENDING_REGISTRATIONS = 16;
/** 满尺寸探测：发出后 1 秒重发一次，2.5 秒无回包判第 1 跳大包不通；3 秒内刚通过的不重复探。 */
const PROBE_RETRY_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_FRESH_MS = 3_000;
/** 经 UDP 发出数据后这么久一个经中继转来的数据报都没收到，且期间还在重发，就怀疑 UDP 只通登记、不通数据。 */
const DATA_SILENCE_MS = 4_000;
const DATA_SILENCE_MIN_RESENDS = 3;
const DATA_SILENCE_MIN_SPAN_MS = 1_000;
/** 走 UDP 时，会话层发往走中转的对端的请求在这段时间里超时这么多次，同样触发检查/熔断。 */
const STALL_WINDOW_MS = 60_000;
const STALL_COUNT = 2;
/** 走中转的连接上最近这么久的重传：至少这么多个分片、且占发出包数至少这个比例。 */
const RETRANSMIT_WINDOW_MS = 5_000;
const RETRANSMIT_MIN_SEGMENTS = 6;
const RETRANSMIT_MIN_SHARE = 0.25;
/** 无探针的旧中继：连续故障的冷却时长。恢复观测期间数据已经走 UDP，档位只决定下次故障要等多久。 */
export const RELAY_UDP_DATA_COOLDOWNS_MS = [30_000, 5 * 60_000, 30 * 60_000] as const;
/** 支持满尺寸探测的新中继：WS 期间按这些间隔发单包探测，通了立刻切回 UDP，无需干等 30 分钟。 */
export const RELAY_UDP_PROBE_COOLDOWNS_MS = [15_000, 30_000, 60_000, 120_000] as const;

export interface SendCounters {
  retransmitted: number;
  sent: number;
  acknowledgedBytes: number;
  /** 可选：各条走中转的连接累计计数（键为稳定连接序号），用于区分单对端故障与本机第 1 跳故障。 */
  peers?: ReadonlyMap<number, { retransmitted: number; sent: number; acknowledgedBytes: number }>;
}

export interface RelayUdpOptions {
  sendUdp(to: Address, datagram: Uint8Array): void;
  /** 中继的 UDP 地址，`host:port`。 */
  server: string;
  /** 当前中继会话的凭据；中继 WebSocket 重连后会换。 */
  credentials(): UdpRelayCredentials | null;
  /** 当前准入的对端在中继上的设备号；按来源摘要认人时只认这些。 */
  peers(): readonly string[];
  deliver(relayId: string, datagram: Uint8Array): void;
  /** 把主机名解析成 IPv4 地址；默认用系统 DNS。测试替换它。 */
  resolveHost?(host: string): Promise<string>;
  /** 走中转的连接上累计的重传数、发包数和对端确认的字节数。 */
  relayedSendCounters?(): SendCounters;
}

/**
 * 走中转的连接上的重传与发包累计。核心的连接统计是整条连接生命周期的累计，换路径（直连 ↔ 中转）不清零：只把两次采样之间
 * 一直在中转上的那段增长算进来，刚换到中转、第一次见到的连接只记基线（审查：长期直连切回中转时，它整个历史的重传会被当成
 * 最近 5 秒的中转重传，误把所有中转连接切到 WebSocket）。返回值只增不减。
 */
export class RelaySendCounters {
  private readonly last = new WeakMap<object, { id: number; relay: boolean; retransmitted: number; sent: number; acknowledgedBytes: number;
    relayRetransmitted: number; relaySent: number; relayAcknowledgedBytes: number }>();
  private nextId = 1;
  private retransmitted = 0;
  private sent = 0;
  private acknowledgedBytes = 0;

  sample(connections: Iterable<{ key: object; relay: boolean; retransmitted: number; sent: number; acknowledgedBytes: number }>): {
    retransmitted: number; sent: number; acknowledgedBytes: number;
  } {
    const { retransmitted, sent, acknowledgedBytes } = this.sampleDetailed(connections);
    return { retransmitted, sent, acknowledgedBytes };
  }

  sampleDetailed(connections: Iterable<{ key: object; relay: boolean; retransmitted: number; sent: number; acknowledgedBytes: number }>): SendCounters {
    const peers = new Map<number, { retransmitted: number; sent: number; acknowledgedBytes: number }>();
    for (const { key, relay, retransmitted, sent, acknowledgedBytes } of connections) {
      const before = this.last.get(key);
      const id = before?.id ?? this.nextId++;
      let relayRetransmitted = before?.relayRetransmitted ?? 0;
      let relaySent = before?.relaySent ?? 0;
      let relayAcknowledgedBytes = before?.relayAcknowledgedBytes ?? 0;
      if (before?.relay && relay) {
        const dRetrans = Math.max(0, retransmitted - before.retransmitted);
        const dSent = Math.max(0, sent - before.sent);
        const dAck = Math.max(0, acknowledgedBytes - before.acknowledgedBytes);
        this.retransmitted += dRetrans;
        this.sent += dSent;
        this.acknowledgedBytes += dAck;
        relayRetransmitted += dRetrans;
        relaySent += dSent;
        relayAcknowledgedBytes += dAck;
      }
      this.last.set(key, { id, relay, retransmitted, sent, acknowledgedBytes, relayRetransmitted, relaySent, relayAcknowledgedBytes });
      if (relay) peers.set(id, { retransmitted: relayRetransmitted, sent: relaySent, acknowledgedBytes: relayAcknowledgedBytes });
    }
    return { retransmitted: this.retransmitted, sent: this.sent, acknowledgedBytes: this.acknowledgedBytes, peers };
  }
}

/** UDP 因「只通登记、不通数据」或「满尺寸探测失败」被停用时的说明，随路由一起报给日志。 */
export interface RelayUdpSuspension { reason: 'data-silence' | 'request-timeouts' | 'unacked-sends' | 'probe-failed'; cooldownMs: number }

export class RelayUdpPath {
  private server: Address | null = null;
  private credentials: UdpRelayCredentials | null = null;
  private counter = 0n;
  /** 上行包的计数器，和登记的分开；中继按窗口丢掉重放的上行包。 */
  private upCounter = 0n;
  /** 满尺寸探测的计数器，单调递增，防止重放。 */
  private probeCounter = 0n;
  /** 中继最近一次确认里给的地址凭证。 */
  private cookie: Uint8Array | null = null;
  /** 发出了、还没确认的登记：计数器 → 发出时刻与带的凭证。确认一个就删掉它和更早的，所以重放的确认找不到登记，不算数。 */
  private readonly pending = new Map<bigint, { at: number; cookie: Uint8Array | null }>();
  /** 发出了、还没确认的满尺寸探测：计数器 → 发出时刻。 */
  private readonly pendingProbes = new Map<bigint, number>();
  private ackedAt = Number.NEGATIVE_INFINITY;
  /** 最近一次收到中继合法 UDP 回包（登记确认、探测确认或验签通过的下行包）的单调时刻，供传输层识别套接字黑洞。 */
  private lastVerifiedAt = Number.NEGATIVE_INFINITY;
  /** 最近一次登记已被中继认定为本机来源地址（`proven: true`），此时中继才会回应满尺寸探测。 */
  private provenAddress = false;
  /** 支持满尺寸探测的中继下，是否已通过至少一次满尺寸双向探测。 */
  private probeVerified = false;
  private probeAckedAt = Number.NEGATIVE_INFINITY;
  private probeStartedAt: number | null = null;
  private probeLastSentAt = Number.NEGATIVE_INFINITY;
  /** 最近一次被认下的登记或探测从发出到确认的毫秒数；换会话、换中继地址后清空。 */
  private rtt: number | null = null;
  /** 上次确认之后发出的第一次登记的时刻；全部确认了就是 null。 */
  private unackedSince: number | null = null;
  private registeredAt = Number.NEGATIVE_INFINITY;
  private sentAt = Number.NEGATIVE_INFINITY;
  private readonly hashes = new Map<string, Buffer>();
  private bySource = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private resolving = false;
  private resolvedAt = Number.NEGATIVE_INFINITY;
  private nextResolveAt = Number.NEGATIVE_INFINITY;
  private resolveRetryMs = RESOLVE_RETRY_FIRST_MS;
  /** 上次收到经中继转来的数据报之后，第一次经 UDP 发数据的时刻、之后又发了几次、最后一次的时刻。 */
  private silentSince: number | null = null;
  private silentResends = 0;
  private silentLastSend = Number.NEGATIVE_INFINITY;
  /** 判定只通登记、不通数据后，在这个时刻之前不走 UDP。 */
  private suspendedUntil = Number.NEGATIVE_INFINITY;
  private suspendedFor = 0;
  private suspensionReason: RelayUdpSuspension['reason'] = 'data-silence';
  private suspensions = 0;
  /** 走 UDP 期间会话请求超时的时刻（只记最近 STALL_WINDOW_MS 内的）。 */
  private stalls: number[] = [];
  private receivedUdpDatagrams = 0;
  private healthySince: number | null = null;
  private lastHealthyProgressAt = Number.NEGATIVE_INFINITY;
  private healthyProgressWindows = 0;
  private lastHealthyPeerAt = Number.NEGATIVE_INFINITY;
  private unackedStreakAt = Number.NEGATIVE_INFINITY;
  private readonly sendSamples: (SendCounters & { at: number; received: number })[] = [];

  constructor(private readonly options: RelayUdpOptions) {
    void this.resolve();
    this.timer = setInterval(() => this.tick(), REGISTER_RETRY_MS);
    this.timer.unref?.();
  }

  private get probeSupported(): boolean {
    return this.credentials?.probe === true;
  }

  /** 两个方向都通：登记确认有效、未停用，且中继支持满尺寸探测时已通过探测。 */
  get up(): boolean {
    const now = performance.now();
    return this.server !== null && this.credentials !== null && this.credentials === this.options.credentials()
      && now - this.ackedAt < ACK_FRESH_MS && (this.unackedSince === null || now - this.unackedSince < UNACKED_DOWN_MS)
      && now >= this.suspendedUntil
      && (!this.probeSupported || this.probeVerified);
  }

  /** 正在因「只通登记、不通数据」或「满尺寸探测失败」停用 UDP 时给出原因与本次冷却时长，否则为 null。 */
  get suspension(): RelayUdpSuspension | null {
    return performance.now() < this.suspendedUntil ? { reason: this.suspensionReason, cooldownMs: this.suspendedFor } : null;
  }

  /** 最近一次收到中继合法 UDP 回包的单调时刻；从未收到时为 `-Infinity`。 */
  get verifiedAt(): number { return this.lastVerifiedAt; }

  /** 当前中继会话下，最近一轮登记已连续未收到确认的毫秒数；没有在途未确认登记或未连接时为 0。 */
  unackedDurationMs(now = performance.now()): number {
    if (this.closed || !this.server || !this.credentials || this.credentials !== this.options.credentials()) return 0;
    return this.unackedSince === null ? 0 : Math.max(0, now - this.unackedSince);
  }

  /** 立即发一次轻量登记以确认底层 UDP 套接字是否还能收发（不改动冷却或启用状态）。 */
  probeRegistrationNow(): void {
    if (this.closed || !this.server || !this.credentials || this.credentials !== this.options.credentials()) return;
    const now = performance.now();
    if (now - this.registeredAt < REGISTER_RETRY_MS) return;
    this.register();
  }

  /**
   * 本机换了网络（例如关掉 VPN 或切 Wi-Fi / 蜂窝）：旧网络的停用与地址认定作废，立即重新登记并做满尺寸探测。
   * 支持满尺寸探测时，`probeVerified` 清零，业务流量继续留在 WebSocket 直到新网络实测大包通过。
   */
  networkChanged(): void {
    if (this.closed) return;
    const now = performance.now();
    this.suspendedUntil = Number.NEGATIVE_INFINITY;
    this.suspensions = 0;
    this.stalls = [];
    this.silentSince = null;
    this.silentResends = 0;
    this.provenAddress = false;
    this.probeVerified = false;
    this.probeAckedAt = Number.NEGATIVE_INFINITY;
    this.probeStartedAt = null;
    this.pendingProbes.clear();
    this.pending.clear();
    this.ackedAt = Number.NEGATIVE_INFINITY;
    this.rtt = null;
    this.unackedSince = null;
    this.registeredAt = Number.NEGATIVE_INFINITY;
    this.cookie = null;
    this.resolveRetryMs = RESOLVE_RETRY_FIRST_MS;
    this.resetSendWindow();
    this.nextResolveAt = now;
    void this.resolve();
    if (this.server && this.credentials) this.register();
  }

  /**
   * 会话层发往一个走中转的对端的请求超时了。走 UDP 时 60 秒内第二次，支持探测时先发满尺寸探针复核第 1 跳，
   * 不支持探测时直接按原冷却退回 WebSocket。
   */
  noteStall(): void {
    if (!this.up) return;
    const now = performance.now();
    this.clearHealthyProgress();
    this.stalls = this.stalls.filter((at) => now - at < STALL_WINDOW_MS);
    this.stalls.push(now);
    if (this.stalls.length >= STALL_COUNT) this.reportAnomaly('request-timeouts', now);
  }

  /** 任一承载送来的数据都结束静默；只有 UDP 数据参与双向恢复判定。 */
  noteInbound(viaUdp: boolean): void {
    this.silentSince = null;
    this.silentResends = 0;
    if (viaUdp) this.receivedUdpDatagrams++;
  }

  /**
   * 经 UDP 到中继的往返毫秒数：最近一次登记或探测到它的确认。UDP 不通时为 null。
   * 远程连接页在中转走 UDP 时显示它，而不是 WebSocket 心跳的往返（2026-11-18 用户要求：走 UDP 就显示 UDP 的延迟）。
   */
  get rttMs(): number | null { return this.up ? this.rtt : null; }

  /** 走 UDP 发出去了返回 true；否则调用方改走 WebSocket。 */
  send(relayId: string, datagram: Uint8Array): boolean {
    if (!this.up) return false;
    const now = performance.now();
    this.sentAt = now;
    if (this.silentSince === null) { this.silentSince = now; this.silentResends = 0; } else this.silentResends += 1;
    this.silentLastSend = now;
    this.upCounter += 1n;
    this.options.sendUdp(this.server!, encodeUdpUp(this.credentials!, this.upCounter, this.hash(relayId), datagram));
    return true;
  }

  /** 核心收到 UDP 包时先问这里；是中继转发包就自己处理（包括验证失败的丢弃），返回 true。 */
  intercept(datagram: Uint8Array): boolean {
    if (!isUdpRelayPacket(datagram)) return false;
    const credentials = this.credentials;
    if (!credentials) return true;
    if (datagram[0] === UDP_RELAY_REGISTER_ACK) {
      const ack = verifyUdpRegisterAck(datagram, credentials);
      if (!ack) return true;
      this.acknowledge(ack.counter, ack.proven, ack.cookie);
      return true;
    }
    if (datagram[0] === UDP_RELAY_PROBE_ACK) {
      const ack = verifyUdpProbeAck(datagram, credentials);
      if (!ack) return true;
      this.acknowledgeProbe(ack.counter);
      return true;
    }
    if (datagram[0] === UDP_RELAY_DOWN) {
      const down = verifyUdpDown(datagram, credentials.key);
      if (!down) return true;
      this.lastVerifiedAt = performance.now();
      const source = this.peerFor(down.srcHash.toString('hex'));
      if (source) { this.noteInbound(true); this.options.deliver(source, down.datagram); }
    }
    return true;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }

  /** 中继确认了第 `counter` 次登记。只认还在等、发出不到 UNACKED_DOWN_MS 的登记，每个只认一次。 */
  private acknowledge(counter: bigint, proven: boolean, cookie: Buffer): void {
    const now = performance.now();
    const sent = this.pending.get(counter);
    // 晚于 UNACKED_DOWN_MS 才到：那时已经判断这条路不通，扣下来再放的旧确认不能让它看起来又通了。
    if (!sent || now - sent.at >= UNACKED_DOWN_MS) return;
    const wasUp = this.up;
    let oldest: number | null = null;
    for (const [pendingCounter, registration] of this.pending) {
      if (pendingCounter <= counter) this.pending.delete(pendingCounter);
      else if (oldest === null || registration.at < oldest) oldest = registration.at;
    }
    this.ackedAt = now;
    this.lastVerifiedAt = now;
    this.rtt = Math.round(now - sent.at);
    this.unackedSince = oldest;
    this.cookie = cookie;
    this.provenAddress = proven;
    // 重新启用 UDP 后第一笔计数只记基线，不能把 WebSocket 上的进展算进来。
    if (!wasUp && this.up) this.resetSendWindow();
    const sameCookie = !!sent.cookie && Buffer.from(sent.cookie).equals(cookie);
    // 支持满尺寸探测时：地址一经认定、且尚未通过大包探测（含冷却到期后），立刻发 1350B 探针验证第 1 跳。
    if (this.probeSupported && proven && !this.probeVerified && now >= this.suspendedUntil && this.probeStartedAt === null) {
      this.startProbe(now);
      return;
    }
    // 刚通：马上告诉中继收得到，不等下一次定时登记。中继没认定这个地址而给了新凭证：马上带上它再登记，
    // 让中继认定来源地址（支持探测时，哪怕正在冷却也要先证明新地址，冷却结束才能直接发探针）。
    // 停用期间且已认定时不立刻再登记，免得来回空转。
    if (!proven && !sameCookie) this.register();
    else if (now >= this.suspendedUntil && !wasUp && this.up) this.register();
  }

  /** 中继确认了第 `counter` 次满尺寸探测：实锤第 1 跳上下行大包均通。 */
  private acknowledgeProbe(counter: bigint): void {
    const now = performance.now();
    const sentAt = this.pendingProbes.get(counter);
    if (sentAt === undefined || now - sentAt >= PROBE_TIMEOUT_MS) return;
    const wasUp = this.up;
    this.pendingProbes.clear();
    this.probeStartedAt = null;
    this.probeAckedAt = now;
    this.lastVerifiedAt = now;
    this.rtt = Math.round(now - sentAt);
    this.probeVerified = true;
    this.suspendedUntil = Number.NEGATIVE_INFINITY;
    this.suspensions = 0;
    this.silentSince = null;
    this.silentResends = 0;
    this.stalls = [];
    this.unackedStreakAt = Number.NEGATIVE_INFINITY;
    this.resetSendWindow();
    // 刚由探测验证放行：马上告诉中继「收得到」，把下行也切到 UDP。
    if (!wasUp && this.up) this.register();
  }

  private startProbe(now: number): void {
    if (!this.server || !this.credentials || !this.probeSupported) return;
    this.probeStartedAt = now;
    this.sendProbe(now);
  }

  private sendProbe(now: number): void {
    if (!this.server || !this.credentials) return;
    this.probeLastSentAt = now;
    this.probeCounter += 1n;
    this.pendingProbes.set(this.probeCounter, now);
    if (this.pendingProbes.size > MAX_PENDING_REGISTRATIONS) this.pendingProbes.delete(this.pendingProbes.keys().next().value!);
    this.options.sendUdp(this.server, encodeUdpProbe(this.credentials, this.probeCounter));
  }

  /** 端到端发现疑似第 1 跳故障：支持满尺寸探测时先直接测本机 ↔ 中转，避免替抖动/离线对端背锅。 */
  private reportAnomaly(reason: Exclude<RelayUdpSuspension['reason'], 'probe-failed'>, now: number): void {
    if (!this.probeSupported) {
      // 旧中继下：如果最近一个采样窗内有其他走中转的对端在正常确认字节，说明本机第 1 跳健康，
      // 单个对端的请求超时不连坐整机。
      if (reason === 'request-timeouts' && now - this.lastHealthyPeerAt <= RETRANSMIT_WINDOW_MS) {
        this.stalls = [];
        return;
      }
      this.suspend(reason, now);
      return;
    }
    this.silentSince = null;
    this.silentResends = 0;
    this.stalls = [];
    this.unackedStreakAt = Number.NEGATIVE_INFINITY;
    // 刚刚实测过第 1 跳大包双向正常：故障一定在对端，不重复探、不熔断。
    if (now - this.probeAckedAt < PROBE_FRESH_MS) {
      this.resetSendWindow();
      return;
    }
    if (this.probeStartedAt === null) this.startProbe(now);
  }

  private async resolve(): Promise<void> {
    if (this.closed || this.resolving) return;
    const [host, port] = splitHostPort(this.options.server);
    // 地址本身写错了：一直走 WebSocket，不重试。
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) { this.nextResolveAt = Number.POSITIVE_INFINITY; return; }
    this.resolving = true;
    try {
      const address = this.options.resolveHost ? await this.options.resolveHost(host) : await resolveUdpHost(host);
      if (this.closed) return;
      const now = performance.now();
      this.resolvedAt = now;
      this.nextResolveAt = now + RESOLVE_REFRESH_MS;
      this.resolveRetryMs = RESOLVE_RETRY_FIRST_MS;
      if (this.server?.address === address && this.server.port === port) return;
      // 中继换了地址：之前的登记、确认、探测和凭证都对应旧地址，重新来过。
      this.server = { address, port };
      this.resetRegistration();
      this.tick();
    } catch {
      // 解析不了（离线启动、DNS 暂时不通）：先走 WebSocket，按退避重试。
      this.nextResolveAt = performance.now() + this.resolveRetryMs;
      this.resolveRetryMs = Math.min(RESOLVE_RETRY_MAX_MS, this.resolveRetryMs * 2);
    } finally { this.resolving = false; }
  }

  private resetRegistration(): void {
    this.resetSendWindow();
    this.silentSince = null;
    this.silentResends = 0;
    this.cookie = null;
    this.provenAddress = false;
    this.probeVerified = false;
    this.probeAckedAt = Number.NEGATIVE_INFINITY;
    this.probeStartedAt = null;
    this.pendingProbes.clear();
    this.pending.clear();
    this.ackedAt = Number.NEGATIVE_INFINITY;
    this.rtt = null;
    this.unackedSince = null;
    this.registeredAt = Number.NEGATIVE_INFINITY;
  }

  private tick(): void {
    if (this.closed) return;
    const now = performance.now();
    // UDP 一直不通时，中继可能换了 IP：提前重新解析。
    const downTooLong = this.server !== null && this.credentials !== null && !this.up && now - this.resolvedAt >= RESOLVE_WHEN_DOWN_MS
      && (this.unackedSince === null || now - this.unackedSince >= RESOLVE_WHEN_DOWN_MS);
    // An outage can accelerate the periodic refresh, but cannot bypass DNS failure backoff.
    const canRefreshEarly = downTooLong && this.resolveRetryMs === RESOLVE_RETRY_FIRST_MS;
    if (!this.resolving && (now >= this.nextResolveAt || canRefreshEarly)) void this.resolve();
    if (!this.server) return;
    const current = this.options.credentials();
    if (current !== this.credentials) {
      // 中继 WebSocket 重连换了会话：旧会话的登记、确认、探测和凭证都作废。
      this.credentials = current;
      this.counter = 0n;
      this.upCounter = 0n;
      this.probeCounter = 0n;
      this.resetRegistration();
    }
    if (!current) return;
    // 在途的满尺寸探测：超时则实锤第 1 跳大包不通；未超时按 1s 补发一次。
    if (this.probeStartedAt !== null) {
      if (now - this.probeStartedAt >= PROBE_TIMEOUT_MS) {
        this.probeStartedAt = null;
        this.pendingProbes.clear();
        this.suspend('probe-failed', now);
        return;
      }
      if (now - this.probeLastSentAt >= PROBE_RETRY_MS) this.sendProbe(now);
    }
    if (this.silentSince !== null && this.up && now - this.silentSince >= DATA_SILENCE_MS
      && this.silentResends >= DATA_SILENCE_MIN_RESENDS && this.silentLastSend - this.silentSince >= DATA_SILENCE_MIN_SPAN_MS) {
      this.reportAnomaly('data-silence', now);
      if (!this.up) return;
    }
    if (this.up) this.observeSendWindow(now);
    if (now < this.suspendedUntil) {
      // 停用期间照常低频登记（收不到），让中转记着本机地址；冷却结束后立刻探测或登记「收得到」。
      if (now - this.registeredAt >= KEEPALIVE_MS) this.register();
      return;
    }
    // 支持探测时：冷却结束或地址刚认定但尚未过检，先在 WebSocket 保护下发满尺寸探测，不盲目放行 UDP。
    if (this.probeSupported && !this.probeVerified) {
      const regInterval = this.unackedSince !== null || !this.provenAddress
        ? (this.unackedSince !== null && now - this.unackedSince >= SLOW_RETRY_AFTER_MS ? REGISTER_SLOW_RETRY_MS : REGISTER_RETRY_MS)
        : KEEPALIVE_MS;
      if (now - this.registeredAt >= regInterval) this.register();
      if (this.provenAddress && now - this.ackedAt < KEEPALIVE_MS && this.probeStartedAt === null) this.startProbe(now);
      return;
    }
    if (this.suspendedUntil > Number.NEGATIVE_INFINITY && this.registeredAt < this.suspendedUntil) {
      this.register();
      return;
    }
    const interval = this.unackedSince !== null || !this.up
      ? (this.unackedSince !== null && now - this.unackedSince >= SLOW_RETRY_AFTER_MS ? REGISTER_SLOW_RETRY_MS : REGISTER_RETRY_MS)
      : now - this.sentAt < ACTIVE_WINDOW_MS ? ACTIVE_REFRESH_MS : KEEPALIVE_MS;
    if (now - this.registeredAt >= interval) this.register();
  }

  /**
   * 走中转的连接上本机发出的数据最近得不到确认：核心一直在重传。这条看的是本机自己的发送，所以本机只是被控、
   * 请求一直进得来（静默判断被清掉）、自己又不发请求（没有超时可报）时也能发现上行坏了。
   * - 有任意一台走中转的对端在同一窗口内正常推进确认且未高重传时，说明第 1 跳正常，不因另一台对端掉线/抖动连坐整机；
   * - 零确认推进时立即触发复核/熔断；有确认推进但持续高重传时，需连续两个窗口持续才触发，过滤单次突发抖动。
   */
  private observeSendWindow(now: number): void {
    const counters = this.options.relayedSendCounters?.();
    if (!counters) return;
    const last = this.sendSamples.at(-1);
    // 休眠、掉线或计数归零后，第一笔只记基线。
    if (last && (now - last.at >= RETRANSMIT_WINDOW_MS || counters.retransmitted < last.retransmitted
      || counters.sent < last.sent || counters.acknowledgedBytes < last.acknowledgedBytes)) {
      this.resetSendWindow();
    }
    this.sendSamples.push({ at: now, received: this.receivedUdpDatagrams, ...counters });
    while (this.sendSamples.length > 1 && now - this.sendSamples[1].at >= RETRANSMIT_WINDOW_MS) this.sendSamples.shift();
    const first = this.sendSamples[0];
    if (now - first.at < RETRANSMIT_WINDOW_MS) return;
    const retransmitted = counters.retransmitted - first.retransmitted;
    const sent = counters.sent - first.sent;
    const acked = counters.acknowledgedBytes - first.acknowledgedBytes;
    const anotherPeerHealthy = this.hasHealthyRelayedPeer(first.peers, counters.peers);
    if (anotherPeerHealthy) this.lastHealthyPeerAt = now;
    const highRetransmit = retransmitted >= RETRANSMIT_MIN_SEGMENTS && retransmitted >= RETRANSMIT_MIN_SHARE * Math.max(sent, 1);
    if (highRetransmit && !anotherPeerHealthy) {
      if (acked === 0) {
        this.reportAnomaly('unacked-sends', now);
        return;
      }
      if (this.unackedStreakAt === Number.NEGATIVE_INFINITY) {
        this.unackedStreakAt = now;
      } else if (now - this.unackedStreakAt >= RETRANSMIT_WINDOW_MS) {
        this.unackedStreakAt = Number.NEGATIVE_INFINITY;
        this.reportAnomaly('unacked-sends', now);
        return;
      }
    } else {
      this.unackedStreakAt = Number.NEGATIVE_INFINITY;
    }
    if (this.suspensions === 0) return;
    // 无确认推进的发送窗口（单向可达、对端一直重传）必须打断恢复计时；纯空闲窗口（本机没发包）不打断。
    if (sent > 0 && acked === 0) {
      this.clearHealthyProgress();
      return;
    }
    const bidirectionalProgress = this.sentAt > first.at && this.receivedUdpDatagrams > first.received && acked > 0;
    if (!bidirectionalProgress) return;
    this.healthySince ??= now;
    this.lastHealthyProgressAt = now;
    this.healthyProgressWindows += 1;
    // 需至少跨过完整观察期且不止一笔孤立确认，间歇轮询与持续传通都能重置，单次迟到确认不会误重置。
    if (this.healthyProgressWindows >= 2 && this.lastHealthyProgressAt - this.healthySince >= STALL_WINDOW_MS) {
      this.suspensions = 0;
      this.clearHealthyProgress();
    }
  }

  private hasHealthyRelayedPeer(
    first: SendCounters['peers'],
    current: SendCounters['peers'],
  ): boolean {
    if (!first || !current || current.size < 2) return false;
    for (const [id, nowPeer] of current) {
      const prevPeer = first.get(id);
      if (!prevPeer) continue;
      const dAck = nowPeer.acknowledgedBytes - prevPeer.acknowledgedBytes;
      if (dAck <= 0) continue;
      const dRetrans = nowPeer.retransmitted - prevPeer.retransmitted;
      const dSent = nowPeer.sent - prevPeer.sent;
      if (!(dRetrans >= RETRANSMIT_MIN_SEGMENTS && dRetrans >= RETRANSMIT_MIN_SHARE * Math.max(dSent, 1))) return true;
    }
    return false;
  }

  private clearHealthyProgress(): void {
    this.healthySince = null;
    this.lastHealthyProgressAt = Number.NEGATIVE_INFINITY;
    this.healthyProgressWindows = 0;
  }

  private resetSendWindow(): void {
    this.sendSamples.length = 0;
    this.lastHealthyPeerAt = Number.NEGATIVE_INFINITY;
    this.unackedStreakAt = Number.NEGATIVE_INFINITY;
    this.clearHealthyProgress();
  }

  /** 只通登记、不通数据或满尺寸探测失败：停用 UDP，并马上告诉中继收不到，让发给本机的数据报也改走 WebSocket。 */
  private suspend(reason: RelayUdpSuspension['reason'], now: number): void {
    const cooldowns = this.probeSupported ? RELAY_UDP_PROBE_COOLDOWNS_MS : RELAY_UDP_DATA_COOLDOWNS_MS;
    this.suspendedFor = cooldowns[Math.min(this.suspensions, cooldowns.length - 1)];
    this.suspensionReason = reason;
    this.suspensions += 1;
    this.suspendedUntil = now + this.suspendedFor;
    this.probeVerified = false;
    this.probeStartedAt = null;
    this.pendingProbes.clear();
    this.silentSince = null;
    this.silentResends = 0;
    this.stalls = [];
    this.resetSendWindow();
    this.register();
  }

  private register(): void {
    if (!this.server || !this.credentials) return;
    const now = performance.now();
    const receiving = this.up;
    this.registeredAt = now;
    this.unackedSince ??= now;
    this.counter += 1n;
    this.pending.set(this.counter, { at: now, cookie: this.cookie });
    if (this.pending.size > MAX_PENDING_REGISTRATIONS) this.pending.delete(this.pending.keys().next().value!);
    this.options.sendUdp(this.server, encodeUdpRegister(this.credentials, this.counter, receiving, this.cookie));
  }

  private hash(relayId: string): Buffer {
    let hash = this.hashes.get(relayId);
    if (!hash) { hash = udpRelayPeerHash(relayId); this.hashes.set(relayId, hash); }
    return hash;
  }

  private peerFor(sourceHex: string): string | undefined {
    const known = this.bySource.get(sourceHex);
    if (known !== undefined) return known;
    // 名册变了才会落空：按当前准入的对端重建一次。
    const next = new Map<string, string>();
    for (const id of this.options.peers()) next.set(this.hash(id).toString('hex'), id);
    this.bySource = next;
    return next.get(sourceHex);
  }
}
