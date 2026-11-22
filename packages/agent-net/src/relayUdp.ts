/**
 * 经中继转发的数据报改走 UDP（docs/agent-net-session-plan.md 第 8 节；包格式与协议约定见 `@cindy/agent-net-relay` 的
 * udpRelay.ts 与 docs/dev-rules/protocol-compatibility/agent-net-udp-relay.md）。
 *
 * 中继在 WebSocket 的 hello 里给了这条会话的 UDP 凭据时：先向中继的 UDP 端口登记本机地址；中继的确认里带一个地址凭证，
 * 之后的登记都带上它，中继据此认定这个地址真是本机的（确认说没认定时，马上带上新凭证再登记一次）。收到确认说明两个方向都通，
 * 之后发往中继的数据报走 UDP，并在登记里告诉中继「收得到」，中继也把发给本机的数据报经 UDP 送来。
 * 一次登记 4 秒还没确认（UDP 被挡、NAT 换了端口），两个方向都退回 WebSocket：本机不再经 UDP 发，下一次登记告诉
 * 中继「收不到」；之后继续登记，确认恢复就再切回 UDP。凭据还没拿到、中继地址还没解析出来时走 WebSocket；解析失败按退避重试，
 * 之后定期重新解析，离线启动或中继换了 IP 都能回到 UDP。
 * 每个确认只认一次，且只认最近发出、还在等的登记：重放或扣下来晚放的旧确认不能让本机以为 UDP 还通。
 * 登记只证明小包能来回。经 UDP 发出数据后 4 秒内一个经中继转来的数据报都没收到，而且这期间核心还在反复重发（至少再发
 * 3 次、跨过 1 秒；单个不需要回应的确认包不算），说明这条 UDP 只通登记、不通数据（2026-11-22：VPN 的透明代理接管了
 * 到中继 UDP 端口的流量，登记照常确认，会话数据几个小时一个都没回来）。这时按「不通」处理：两个方向退回 WebSocket，
 * 登记照常发并告诉中继「收不到」，冷却 30 秒、5 分钟、30 分钟后再试 UDP；经 UDP 收到数据后冷却档位清零。
 * 本机还收得到、只是发出去的丢了时（对端一直在重发，所以总有数据进来），上面的判断看不出来。另有两条：会话层发往走中转的
 * 对端的请求 60 秒内超时两次（noteStall，本机是发请求的一方）；走中转的连接上本机发出的数据迟迟得不到确认——最近 5 秒
 * 重传了至少 6 个分片、占发出包数的四分之一以上（本机只被控、自己不发请求时也看得到）。都按同样处理。
 * 和 STUN、直连共用核心的 UDP 端口；核心照常负责丢包重发和拥塞控制，这里不限速。
 */
import { lookup } from 'node:dns/promises';
import type { Address } from '@cindy/agent-net-core/node';
import {
  UDP_RELAY_DOWN, UDP_RELAY_REGISTER_ACK, encodeUdpRegister, encodeUdpUp, isUdpRelayPacket, udpRelayPeerHash,
  verifyUdpDown, verifyUdpRegisterAck, type UdpRelayCredentials,
} from '@cindy/agent-net-relay/client';
import { splitHostPort } from './stun.js';

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
/** 最多记着这么多个还没确认的登记。 */
const MAX_PENDING_REGISTRATIONS = 16;
/** 经 UDP 发出数据后这么久一个经中继转来的数据报都没收到，且期间还在重发，就判定 UDP 只通登记、不通数据。 */
const DATA_SILENCE_MS = 4_000;
const DATA_SILENCE_MIN_RESENDS = 3;
const DATA_SILENCE_MIN_SPAN_MS = 1_000;
/** 走 UDP 时，会话层发往走中转的对端的请求在这段时间里超时这么多次，同样判定 UDP 不通数据。 */
const STALL_WINDOW_MS = 60_000;
const STALL_COUNT = 2;
/** 走中转的连接上最近这么久的重传：至少这么多个分片、且占发出包数至少这个比例，判定本机发出的数据到不了。 */
const RETRANSMIT_WINDOW_MS = 5_000;
const RETRANSMIT_MIN_SEGMENTS = 6;
const RETRANSMIT_MIN_SHARE = 0.25;
/** 判定不通数据后停用 UDP 的时长，逐次加长；经 UDP 收到数据后回到第一档。 */
export const RELAY_UDP_DATA_COOLDOWNS_MS = [30_000, 5 * 60_000, 30 * 60_000] as const;

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
  /** 走中转的连接上累计重传的分片数与发出的包数（RelaySendCounters）；计数变小时从头算。 */
  relayedSendCounters?(): { retransmitted: number; sent: number };
}

/** UDP 因「只通登记、不通数据」被停用时的说明，随路由一起报给日志。 */
/**
 * 走中转的连接上的重传与发包累计。核心的连接统计是整条连接生命周期的累计，换路径（直连 ↔ 中转）不清零：只把两次采样之间
 * 一直在中转上的那段增长算进来，刚换到中转、第一次见到的连接只记基线（审查：长期直连切回中转时，它整个历史的重传会被当成
 * 最近 5 秒的中转重传，误把所有中转连接切到 WebSocket）。返回值只增不减。
 */
export class RelaySendCounters {
  private readonly last = new WeakMap<object, { retransmitted: number; sent: number; relay: boolean }>();
  private retransmitted = 0;
  private sent = 0;

  sample(connections: Iterable<{ key: object; relay: boolean; retransmitted: number; sent: number }>): { retransmitted: number; sent: number } {
    for (const connection of connections) {
      const before = this.last.get(connection.key);
      this.last.set(connection.key, { retransmitted: connection.retransmitted, sent: connection.sent, relay: connection.relay });
      if (!before?.relay || !connection.relay) continue;
      this.retransmitted += Math.max(0, connection.retransmitted - before.retransmitted);
      this.sent += Math.max(0, connection.sent - before.sent);
    }
    return { retransmitted: this.retransmitted, sent: this.sent };
  }
}

export interface RelayUdpSuspension { reason: 'data-silence' | 'request-timeouts' | 'unacked-sends'; cooldownMs: number }

export class RelayUdpPath {
  private server: Address | null = null;
  private credentials: UdpRelayCredentials | null = null;
  private counter = 0n;
  /** 上行包的计数器，和登记的分开；中继按窗口丢掉重放的上行包。 */
  private upCounter = 0n;
  /** 中继最近一次确认里给的地址凭证。 */
  private cookie: Uint8Array | null = null;
  /** 发出了、还没确认的登记：计数器 → 发出时刻与带的凭证。确认一个就删掉它和更早的，所以重放的确认找不到登记，不算数。 */
  private readonly pending = new Map<bigint, { at: number; cookie: Uint8Array | null }>();
  private ackedAt = Number.NEGATIVE_INFINITY;
  /** 最近一次被认下的登记从发出到确认的毫秒数；换会话、换中继地址后清空。 */
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
  /** 走 UDP 期间每次 tick 取的重传与发包计数，按时间先后。 */
  private sendSamples: { at: number; retransmitted: number; sent: number }[] = [];

  constructor(private readonly options: RelayUdpOptions) {
    void this.resolve();
    this.timer = setInterval(() => this.tick(), REGISTER_RETRY_MS);
    this.timer.unref?.();
  }

  /** 两个方向都通：确认对应的是当前这条中继会话，最近收到过，没有登记卡着不被确认，且没有因不通数据被停用。 */
  get up(): boolean {
    const now = performance.now();
    return this.server !== null && this.credentials !== null && this.credentials === this.options.credentials()
      && now - this.ackedAt < ACK_FRESH_MS && (this.unackedSince === null || now - this.unackedSince < UNACKED_DOWN_MS)
      && now >= this.suspendedUntil;
  }

  /** 正在因「只通登记、不通数据」停用 UDP 时给出原因与本次冷却时长，否则为 null。 */
  get suspension(): RelayUdpSuspension | null {
    return performance.now() < this.suspendedUntil ? { reason: this.suspensionReason, cooldownMs: this.suspendedFor } : null;
  }

  /**
   * 会话层发往一个走中转的对端的请求超时了。走 UDP 时 60 秒内第二次，就和数据不回来一样停用 UDP：这能抓住「收得到、
   * 发不出去」——对端一直重发，本机总有数据进来，单看收不收得到判断不出来。
   */
  noteStall(): void {
    if (!this.up) return;
    const now = performance.now();
    this.stalls = this.stalls.filter((at) => now - at < STALL_WINDOW_MS);
    this.stalls.push(now);
    if (this.stalls.length >= STALL_COUNT) this.suspend('request-timeouts', now);
  }

  /**
   * 收到一个经中继转来的数据报（UDP 或中继 WebSocket）：数据能回来，清掉等待。`viaUdp` 时 UDP 确实送到了数据，冷却档位清零。
   */
  noteInbound(viaUdp: boolean): void {
    this.silentSince = null;
    this.silentResends = 0;
    if (viaUdp) this.suspensions = 0;
  }

  /**
   * 经 UDP 到中继的往返毫秒数：最近一次登记到它的确认（登记本来就定时发，不另发包）。UDP 不通时为 null。
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
    if (datagram[0] === UDP_RELAY_DOWN) {
      const down = verifyUdpDown(datagram, credentials.key);
      if (!down) return true;
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
    this.rtt = Math.round(now - sent.at);
    this.unackedSince = oldest;
    this.cookie = cookie;
    // 刚通：马上告诉中继收得到，不等下一次定时登记。中继没认定这个地址（刚换了地址、凭证过期）而给了新凭证：马上带上它再登记，
    // 中继认定后才往这里发。凭证和这次登记带的一样还没认定时不重发，免得来回空转。
    const sameCookie = !!sent.cookie && Buffer.from(sent.cookie).equals(cookie);
    // 停用期间 up 恒为 false：不能每个确认都立刻再登记，否则登记和确认按往返速度来回空转。
    if (now >= this.suspendedUntil && (!wasUp || (!proven && !sameCookie))) this.register();
  }

  private async resolve(): Promise<void> {
    if (this.closed || this.resolving) return;
    const [host, port] = splitHostPort(this.options.server);
    // 地址本身写错了：一直走 WebSocket，不重试。
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) { this.nextResolveAt = Number.POSITIVE_INFINITY; return; }
    this.resolving = true;
    try {
      const address = this.options.resolveHost ? await this.options.resolveHost(host) : (await lookup(host, { family: 4 })).address;
      if (this.closed) return;
      const now = performance.now();
      this.resolvedAt = now;
      this.nextResolveAt = now + RESOLVE_REFRESH_MS;
      this.resolveRetryMs = RESOLVE_RETRY_FIRST_MS;
      if (this.server?.address === address && this.server.port === port) return;
      // 中继换了地址：之前的登记、确认和凭证都对应旧地址，重新来过。
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
    this.silentSince = null;
    this.silentResends = 0;
    this.cookie = null;
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
      // 中继 WebSocket 重连换了会话：旧会话的登记、确认和凭证都作废。
      this.credentials = current;
      this.counter = 0n;
      this.upCounter = 0n;
      this.resetRegistration();
    }
    if (!current) return;
    const suspended = now < this.suspendedUntil;
    if (!suspended && this.silentSince !== null && this.up && now - this.silentSince >= DATA_SILENCE_MS
      && this.silentResends >= DATA_SILENCE_MIN_RESENDS && this.silentLastSend - this.silentSince >= DATA_SILENCE_MIN_SPAN_MS) {
      this.suspend('data-silence', now);
      return;
    }
    if (!suspended && this.up && this.unackedSendsAt(now)) {
      this.suspend('unacked-sends', now);
      return;
    }
    if (suspended) {
      // 停用期间照常低频登记（收不到），让中转记着本机地址；冷却结束后的第一次 tick 马上登记「收得到」。
      if (now - this.registeredAt >= KEEPALIVE_MS) this.register();
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
   */
  private unackedSendsAt(now: number): boolean {
    const counters = this.options.relayedSendCounters?.();
    if (!counters) return false;
    const last = this.sendSamples.at(-1);
    // 连接关了计数变小：从这里重新算。
    if (last && (counters.retransmitted < last.retransmitted || counters.sent < last.sent)) this.sendSamples = [];
    this.sendSamples.push({ at: now, ...counters });
    while (this.sendSamples.length > 1 && now - this.sendSamples[1].at >= RETRANSMIT_WINDOW_MS) this.sendSamples.shift();
    const first = this.sendSamples[0];
    if (now - first.at < RETRANSMIT_WINDOW_MS) return false;
    const retransmitted = counters.retransmitted - first.retransmitted;
    const sent = counters.sent - first.sent;
    return retransmitted >= RETRANSMIT_MIN_SEGMENTS && retransmitted >= RETRANSMIT_MIN_SHARE * Math.max(sent, 1);
  }

  /** 只通登记、不通数据：停用 UDP，并马上告诉中继收不到，让发给本机的数据报也改走 WebSocket。 */
  private suspend(reason: RelayUdpSuspension['reason'], now: number): void {
    this.suspendedFor = RELAY_UDP_DATA_COOLDOWNS_MS[Math.min(this.suspensions, RELAY_UDP_DATA_COOLDOWNS_MS.length - 1)];
    this.suspensionReason = reason;
    this.suspensions += 1;
    this.suspendedUntil = now + this.suspendedFor;
    this.silentSince = null;
    this.silentResends = 0;
    this.stalls = [];
    this.sendSamples = [];
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
