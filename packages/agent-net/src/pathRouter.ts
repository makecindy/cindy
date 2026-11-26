/**
 * 直连与中转之间怎么选路（2026-11-22 #12175，自动 / 直连 / 中转、双路往返）：两种传输共用这一份，WASM 的 `transport.ts` 和原生引擎的
 * `nativeTransport.ts`（手机与 2026-11-23 起的 Desktop）各自只提供怎么探测、怎么测速、怎么改代价。这里不依赖 Node，手机也能用。
 *
 * - 测速只验证一条路径并量往返、不换数据路径（核心的 `measure`）；探测验证通过就按代价换过去（`probe`）。
 * - 直连时定期测中转、优先中转时测直连，详情页因此有两路往返，自动模式也能察觉线路变化。
 * - 自动模式（第一性原理：优先选明显更快的路，仅留最小防抖滞回）：
 *   直连比中转慢至少 clamp(25ms, 中转×25%, 50ms) 时切中转；直连恢复到比中转慢 ≤ 15ms 时切回直连；
 *   常规切换 30 秒冷却，若当前线路严重劣化（慢 ≥ 2 倍且差 ≥ 100ms）则跳过冷却立即切换。
 * - 两端的偏好经控制流同步（`{"pathPreference":…,"autoRelay":…}`）：一端指定了就按它，两端都自动时任一端要中转就走中转。
 */
import type { PathPreference, PeerPathMetrics } from './types.js';

/** 备用路径（直连时测中转，或优先中转时测直连）的首次与定期测速间隔。 */
export const STANDBY_INITIAL_MEASURE_MS = 2_000;
/** 备用路径测速结果超过这么久未更新就视为过期，不再在详情里展示旧值。 */
export const PATH_RTT_STALE_MS = 120_000;
/** 自动选路切中转的最小/最大收益门槛与比例：clamp(25ms, relay*25%, 50ms)。 */
export const AUTO_RELAY_MIN_DELTA_MS = 25;
export const AUTO_RELAY_MAX_DELTA_MS = 50;
export const AUTO_RELAY_RATIO_MARGIN = 0.25;
/** 自动选路回切直连的滞回容忍：直连比中转慢 ≤ 15ms（或更快）即切回直连。 */
export const AUTO_DIRECT_RECOVER_DELTA_MS = 15;
/** 常规切换防抖冷却期（ms）。 */
export const AUTO_SWITCH_COOLDOWN_MS = 30_000;
/** 严重劣化破冷却门槛：当前线路慢 ≥ 2 倍且差 ≥ 100ms 时立即切换，不等冷却期。 */
export const AUTO_EMERGENCY_RATIO = 2;
export const AUTO_EMERGENCY_DELTA_MS = 100;
/** 兼容旧导出名。 */
export const AUTO_RELAY_RATIO = 1 + AUTO_RELAY_RATIO_MARGIN;
export const AUTO_RELAY_DELTA_MS = AUTO_RELAY_MIN_DELTA_MS;
export const AUTO_DIRECT_RECOVER_RATIO = 1;
/** 核心一次最多同时验证 4 条路径，再多会把先开始的挤掉，所以每轮最多验这么多个，下一轮接着验后面的。 */
export const PROBES_PER_ROUND = 4;

export function autoRelaySwitchMarginMs(relayRttMs: number): number {
  return Math.min(
    AUTO_RELAY_MAX_DELTA_MS,
    Math.max(AUTO_RELAY_MIN_DELTA_MS, relayRttMs * AUTO_RELAY_RATIO_MARGIN),
  );
}

export function decideAutoPreferRelay(input: {
  currentPreferRelay: boolean;
  directRttMs: number | null;
  relayRttMs: number | null;
  msSinceLastSwitch: number;
}): boolean {
  const { currentPreferRelay, directRttMs, relayRttMs, msSinceLastSwitch } = input;
  if (directRttMs === null || relayRttMs === null) return currentPreferRelay;
  if (!currentPreferRelay) {
    const severe =
      directRttMs >= relayRttMs * AUTO_EMERGENCY_RATIO &&
      directRttMs - relayRttMs >= AUTO_EMERGENCY_DELTA_MS;
    if (!severe && msSinceLastSwitch < AUTO_SWITCH_COOLDOWN_MS) return false;
    return directRttMs - relayRttMs >= autoRelaySwitchMarginMs(relayRttMs);
  }
  const severe =
    relayRttMs >= directRttMs * AUTO_EMERGENCY_RATIO &&
    relayRttMs - directRttMs >= AUTO_EMERGENCY_DELTA_MS;
  if (!severe && msSinceLastSwitch < AUTO_SWITCH_COOLDOWN_MS) return true;
  return !(directRttMs <= relayRttMs + AUTO_DIRECT_RECOVER_DELTA_MS);
}

export function isPathPreference(value: unknown): value is PathPreference {
  return value === 'auto' || value === 'direct' || value === 'relay';
}

/** A direct UDP address. */
export interface DirectAddress { address: string; port: number }
const sameAddress = (a: DirectAddress | null, b: DirectAddress | null): boolean =>
  a !== null && b !== null && a.address === b.address && a.port === b.port;

/**
 * What a transport's channel gives the router. `R` is how that transport names the relay path (the WASM driver's link address,
 * the engine's `{ link }`); direct paths are UDP addresses on both.
 */
export interface PathRoutePort<R> {
  /** The channel or its connection is closed: nothing more is sent. */
  closed(): boolean;
  path(): 'direct' | 'relay' | null;
  /** The peer's UDP address while the data path is direct. */
  directAddress(): DirectAddress | null;
  /** The data path's smoothed round trip, in ms. */
  activeRttMs(): number | null;
  /** This peer's relay path, when there is a relay. */
  relayAddress(): R | null;
  /** Validate a path and move data onto it when it passes and costs no more. */
  probe(address: DirectAddress | R): void;
  /** Validate a path and measure its round trip without moving data (a `probe-rtt` sample comes back). */
  measure(address: DirectAddress | R): void;
  /** Make the relay path cheaper than direct ones (or not), for this connection. */
  setPreferRelay(prefer: boolean): void;
  /** One line on the control stream. */
  writeControl(line: string): void;
}

export class PathRouter<R> {
  private candidates: DirectAddress[] = [];
  /** 下一轮从第几个候选地址验起。 */
  private nextCandidate = 0;
  private lastDirectAddress: DirectAddress | null = null;
  private lastObservedPath: 'direct' | 'relay' | null = null;
  private measuredDirectRttMs: number | null = null;
  private measuredDirectAt = 0;
  private measuredRelayRttMs: number | null = null;
  private measuredRelayAt = 0;
  private localPreference: PathPreference = 'auto';
  private peerPreference: PathPreference = 'auto';
  private autoPreferRelay = false;
  private peerAutoPreferRelay = false;
  private lastAutoSwitchAt = Number.NEGATIVE_INFINITY;
  private reprobe: ReturnType<typeof setInterval> | null = null;
  private standbyMeasure: ReturnType<typeof setInterval> | null = null;
  private initialStandbyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly port: PathRoutePort<R>, private readonly reprobeMs: number, private readonly now: () => number = () => performance.now()) {}

  /** 还在走中转时每隔一阵再验证一轮，并定期轻测备用路径往返。连接关闭时调 `stop`。 */
  start(): void {
    this.reprobe = setInterval(() => {
      if (this.localPreference === 'auto') this.evaluateAutoRoute(true);
      if (this.port.path() === 'relay' && !this.effectivePreferRelay()) this.probeCandidates();
    }, this.reprobeMs);
    (this.reprobe as { unref?: () => void }).unref?.();
    const standbyMs = this.reprobeMs * 3;
    this.initialStandbyTimer = setTimeout(() => {
      this.initialStandbyTimer = null;
      this.measureStandbyPath();
    }, Math.min(STANDBY_INITIAL_MEASURE_MS, standbyMs));
    (this.initialStandbyTimer as { unref?: () => void }).unref?.();
    this.standbyMeasure = setInterval(() => this.measureStandbyPath(), standbyMs);
    (this.standbyMeasure as { unref?: () => void }).unref?.();
  }
  stop(): void {
    if (this.reprobe) clearInterval(this.reprobe);
    this.reprobe = null;
    if (this.standbyMeasure) clearInterval(this.standbyMeasure);
    this.standbyMeasure = null;
    if (this.initialStandbyTimer) clearTimeout(this.initialStandbyTimer);
    this.initialStandbyTimer = null;
  }

  /** The peer's candidate addresses, already filtered and ordered (public first). */
  setCandidates(candidates: DirectAddress[]): void {
    this.candidates = candidates;
    this.nextCandidate = 0;
    // 对端换网或重新公布候选时，若当前未走直连且旧直连地址已不在新候选列表里，清掉旧缓存以便立即探测新候选。
    if (this.port.path() !== 'direct' && this.lastDirectAddress && !this.candidates.some((c) => sameAddress(c, this.lastDirectAddress))) {
      this.lastDirectAddress = null;
    }
    if (this.effectivePreferRelay()) this.measureStandbyPath();
    else this.probeCandidates();
  }

  /** A control-stream message: the peer's preference (`pathPreference`, `autoRelay`); other fields are not the router's. */
  onPeerPreference(message: { pathPreference?: unknown; autoRelay?: unknown }): void {
    if (!isPathPreference(message.pathPreference) && typeof message.autoRelay !== 'boolean') return;
    if (isPathPreference(message.pathPreference)) this.peerPreference = message.pathPreference;
    if (typeof message.autoRelay === 'boolean') this.peerAutoPreferRelay = message.autoRelay;
    this.applyRoutePreference(true);
  }

  private announcePathPreference(): void {
    if (this.port.closed()) return;
    this.port.writeControl(`${JSON.stringify({ pathPreference: this.localPreference, autoRelay: this.autoPreferRelay })}\n`);
  }

  effectivePreferRelay(): boolean {
    if (this.localPreference !== 'auto') return this.localPreference === 'relay';
    if (this.peerPreference !== 'auto') return this.peerPreference === 'relay';
    return this.autoPreferRelay || this.peerAutoPreferRelay;
  }

  private freshRtt(value: number | null, at: number, now: number): number | null {
    return value !== null && now - at <= PATH_RTT_STALE_MS ? value : null;
  }

  pathMetrics(): PeerPathMetrics {
    const now = this.now();
    const active = this.port.path();
    const activeRtt = this.port.activeRttMs();
    const pathChanged = active !== null && active !== this.lastObservedPath;
    if (active !== null) this.lastObservedPath = active;
    if (active === 'direct') {
      const addr = this.port.closed() ? null : this.port.directAddress();
      if (addr) this.lastDirectAddress = addr;
      if (activeRtt !== null) {
        this.measuredDirectRttMs = activeRtt;
        this.measuredDirectAt = now;
      }
      const relayRttMs = this.freshRtt(this.measuredRelayRttMs, this.measuredRelayAt, now);
      if (pathChanged && relayRttMs === null) this.measureStandbyPath();
      return {
        directRttMs: activeRtt ?? this.freshRtt(this.measuredDirectRttMs, this.measuredDirectAt, now),
        relayRttMs,
        preference: this.localPreference,
      };
    }
    if (active === 'relay') {
      if (activeRtt !== null) {
        this.measuredRelayRttMs = activeRtt;
        this.measuredRelayAt = now;
      }
      const directRttMs = this.freshRtt(this.measuredDirectRttMs, this.measuredDirectAt, now);
      if (pathChanged && this.effectivePreferRelay() && directRttMs === null) this.measureStandbyPath();
      return {
        directRttMs,
        relayRttMs: activeRtt ?? this.freshRtt(this.measuredRelayRttMs, this.measuredRelayAt, now),
        preference: this.localPreference,
      };
    }
    return {
      directRttMs: this.freshRtt(this.measuredDirectRttMs, this.measuredDirectAt, now),
      relayRttMs: this.freshRtt(this.measuredRelayRttMs, this.measuredRelayAt, now),
      preference: this.localPreference,
    };
  }

  setPathPreference(preference: PathPreference): void {
    if (this.port.closed()) return;
    this.localPreference = preference;
    this.lastAutoSwitchAt = Number.NEGATIVE_INFINITY;
    if (preference !== 'auto') {
      this.autoPreferRelay = false;
    } else {
      this.evaluateAutoRoute(false);
    }
    this.announcePathPreference();
    this.applyRoutePreference(true);
  }

  /** 本机换网或重建 UDP 套接字后：清掉旧网络的直连测速缓存与自动切路冷却，若此刻走中转则立即重新探测直连。 */
  onLocalNetworkChanged(): void {
    if (this.port.closed()) return;
    this.lastAutoSwitchAt = Number.NEGATIVE_INFINITY;
    this.measuredDirectRttMs = null;
    this.measuredDirectAt = 0;
    this.nextCandidate = 0;
    if (this.port.path() === 'relay') {
      if (this.effectivePreferRelay()) this.measureStandbyPath();
      else this.probeCandidates();
    }
  }

  /** A `probe-rtt` sample: the round trip a validation measured on `address` (`relay`: it is this peer's relay path). */
  onProbeRtt(address: DirectAddress | R, relay: boolean, rttUs: number): void {
    if (this.port.closed()) return;
    const now = this.now();
    const rttMs = Math.max(0.1, rttUs / 1000);
    if (relay) {
      this.measuredRelayRttMs = rttMs;
      this.measuredRelayAt = now;
    } else {
      const direct = address as DirectAddress;
      const existingFresh = this.freshRtt(this.measuredDirectRttMs, this.measuredDirectAt, now);
      // 同一轮多候选测速里保留更快的直连地址，避免慢公网回包覆盖刚测出的局域网低延迟直连。
      const keepExisting =
        this.lastDirectAddress !== null &&
        !sameAddress(this.lastDirectAddress, direct) &&
        existingFresh !== null &&
        now - this.measuredDirectAt < this.reprobeMs &&
        existingFresh < rttMs;
      if (!keepExisting) {
        this.lastDirectAddress = direct;
        this.measuredDirectRttMs = rttMs;
        this.measuredDirectAt = now;
      }
    }
    const autoChanged = this.evaluateAutoRoute(true);
    // 正在中转且自动模式测出直连不比中转明显慢：马上发起真正切换。
    if (!autoChanged && !relay && this.port.path() === 'relay' && !this.effectivePreferRelay()) {
      this.port.probe(this.lastDirectAddress ?? (address as DirectAddress));
    }
  }

  private evaluateAutoRoute(applyAndNotify: boolean): boolean {
    if (this.localPreference !== 'auto') return false;
    const { directRttMs, relayRttMs } = this.pathMetrics();
    const now = this.now();
    const next = decideAutoPreferRelay({
      currentPreferRelay: this.autoPreferRelay,
      directRttMs,
      relayRttMs,
      msSinceLastSwitch: now - this.lastAutoSwitchAt,
    });
    if (next === this.autoPreferRelay) return false;
    this.autoPreferRelay = next;
    this.lastAutoSwitchAt = now;
    if (applyAndNotify) {
      this.announcePathPreference();
      this.applyRoutePreference(true);
    }
    return true;
  }

  private pickDirectTargets(): DirectAddress[] {
    const now = this.now();
    if (this.lastDirectAddress && this.freshRtt(this.measuredDirectRttMs, this.measuredDirectAt, now) === null) {
      this.lastDirectAddress = null;
    }
    const targets: DirectAddress[] = [];
    if (this.lastDirectAddress) targets.push(this.lastDirectAddress);
    const total = this.candidates.length;
    if (total > 0 && targets.length < PROBES_PER_ROUND) {
      let checked = 0;
      while (checked < total && targets.length < PROBES_PER_ROUND) {
        const candidate = this.candidates[this.nextCandidate % total];
        this.nextCandidate = (this.nextCandidate + 1) % total;
        checked++;
        if (!targets.some((item) => sameAddress(item, candidate))) targets.push(candidate);
      }
    }
    return targets;
  }

  private applyRoutePreference(triggerSwitch: boolean): void {
    if (this.port.closed()) return;
    const preferRelay = this.effectivePreferRelay();
    this.port.setPreferRelay(preferRelay);
    if (!triggerSwitch) return;
    const current = this.port.path();
    if (preferRelay && current === 'direct') {
      const relay = this.port.relayAddress();
      if (relay) this.port.probe(relay);
    } else if (!preferRelay && current === 'relay') {
      for (const target of this.pickDirectTargets()) this.port.probe(target);
    }
  }

  private measureStandbyPath(): void {
    if (this.port.closed()) return;
    const current = this.port.path();
    if (current === 'direct') {
      const relay = this.port.relayAddress();
      if (relay) this.port.measure(relay);
    } else if (current === 'relay' && this.effectivePreferRelay()) {
      for (const target of this.pickDirectTargets()) this.port.measure(target);
    }
  }

  probeCandidates(): void {
    if (this.port.closed()) return;
    // 公网地址排在前面（查公网地址得到的那些），内网地址在后。装了 Docker 之类的机器有很多内网地址，
    // 2026-11-05 真实网络测试里公网地址排在第 9 个，被截掉了，两台本来能直连的电脑一直走中转。
    const count = Math.min(PROBES_PER_ROUND, this.candidates.length);
    // 自动模式且走在中转上时，先仅测速验证直连往返，拿到 RTT 确认直连不明显慢于中转后再切，避免切到慢直连抖一下。
    const measureFirst = this.localPreference === 'auto' && this.port.path() === 'relay' && this.port.relayAddress() !== null;
    for (let i = 0; i < count; i++) {
      const target = this.candidates[(this.nextCandidate + i) % this.candidates.length];
      if (measureFirst) this.port.measure(target);
      else this.port.probe(target);
    }
    this.nextCandidate = (this.nextCandidate + count) % Math.max(1, this.candidates.length);
  }
}
