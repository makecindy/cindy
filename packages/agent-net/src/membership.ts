/**
 * 官方 Agent-Net 上不认 Device Link 里已经删掉的设备（docs/dev-rules/protocol-compatibility/agent-net-device-removal.md）。
 *
 * Device Link 删设备后，那台设备要在它上面重新登录才能再连上（服务端留删除记录，登录时间晚于删除才恢复登记）。官方
 * Agent-Net 不看这条记录：它的证书照样有效、照样能续签，同账号的电脑照样和它建会话。撤销 Agent-Net 证书又是永久的
 * （之后再也注册不上），和「重新登录就恢复」不一致。所以由每台电脑自己把关：本账号 Agent-Net 名册里、但 Device Link
 * 设备列表里没有的设备，不拨、不收，等它重新登录、回到列表里再自动放行。规则（列表本身，加上本机刚删的）交给 Agent-Net
 * 连接（AgentNetSocket.restrictPeers），由它在每份名册到达时当场判断，被删的设备连一瞬间也连不上。
 *
 * - 列表是权威：名册里的设备不在最近一次读到的列表里就拦。名册里出现列表里没有的设备（新加入的、刚重新登录的）就再读一次，
 *   所以一台新设备第一次出现时最多晚一个读取间隔才连得上；安全优先，不给删掉的设备留空窗。
 * - 读不到列表（离线、出错）时沿用上一次的结论；从没读到过就不拦，免得 Device Link 服务出问题时连 Agent-Net 一起不能用。
 * - 本机刚删掉的设备马上拦，不等下一次读列表；删除之后开始读的列表才能把它放回来。
 * - 读列表：同一时间只读一次，两次之间至少隔 MEMBERSHIP_READ_MIN_INTERVAL_MS，间隔没到的请求排到间隔一到再读一次；
 *   设备列表界面、上线补名字等已有的读取顺带交给这里（noteDeviceList），不另外读。
 * - 别的电脑上删掉的设备，这台没有任何通知：Agent-Net 连着时在后台定期再读（MEMBERSHIP_PERIODIC_MS，带随机错开）。
 *   还没读到过列表时按退避重试；有被拦的设备在线时（可能刚重新登录、登记还没生效）按退避确认，最慢回到定期的间隔。
 *   连接不在（Agent-Net 关着、换了账号）时一次也不读（`active`）。
 * 只用于官方 Agent-Net 网络；自建中转删设备时直接在 Agent-Net 上撤销（可以重新配对加回来），不走这里。
 * 不依赖 Electron 与 Node：Desktop、Node Host 与手机共用。
 */
import type { PeerRule } from './socketPorts.js';

export interface AgentNetMembershipPorts {
  /** 本账号 Device Link 设备列表里的设备号（官方服务）；现在读不到时回 null 或抛错。 */
  readDeviceLinkDeviceIds(): Promise<readonly string[] | null>;
  /** 把规则交给当前的 Agent-Net 连接（AgentNetSocket.restrictPeers）。 */
  apply(rule: PeerRule): void;
  /** 现在有这个账号的 Agent-Net 连接：没有时后台不读。 */
  active(): boolean;
  now?(): number;
  /** 0 到 1 的随机数（定期读取的错开）。 */
  random?(): number;
  log?: { info(message: string): void };
}

/** 两次读列表之间至少隔这么久。 */
export const MEMBERSHIP_READ_MIN_INTERVAL_MS = 10_000;
/** 被拦的设备又上线（可能重新登录了）时去确认，最多这么久一次：一台一直掉线重连的删掉的设备不会让这里一直读。 */
export const MEMBERSHIP_RECHECK_INTERVAL_MS = 60_000;
/** 连着 Agent-Net 时多久再读一次列表（别的电脑上删掉的设备最晚这么久后不认），实际在 ±20% 内错开。 */
export const MEMBERSHIP_PERIODIC_MS = 5 * 60_000;
/** 没读到过列表、或有被拦的设备在线时，退避重试的第一步。 */
export const MEMBERSHIP_RETRY_FIRST_MS = 10_000;

export class AgentNetMembership {
  /** 名册里的设备与是否在线。 */
  private directory = new Map<string, boolean>();
  /** 最近一次读到的设备列表，at 是开始读的时间。 */
  private listed: { ids: ReadonlySet<string>; at: number } | null = null;
  /** 本机删掉的设备与删除时间，直到删除之后开始读的列表接手。 */
  private removedHere = new Map<string, number>();
  private excludedIds: ReadonlySet<string> = new Set();
  private current: PeerRule = { allowed: null, refused: [] };
  private reading: Promise<void> | null = null;
  private lastReadAt = Number.NEGATIVE_INFINITY;
  private deferred: ReturnType<typeof setTimeout> | null = null;
  private lastRecheckAt = Number.NEGATIVE_INFINITY;
  /** The next background read (scheduleBackground), its retry step and whether the last read failed. */
  private background: ReturnType<typeof setTimeout> | null = null;
  private retryMs = MEMBERSHIP_RETRY_FIRST_MS;
  private lastReadFailed = false;
  private epoch = 0;

  constructor(private readonly ports: AgentNetMembershipPorts) {}

  private now(): number { return this.ports.now?.() ?? Date.now(); }

  /** 名册里现在被拦的设备（设备列表界面不列出它们）。 */
  excluded(): ReadonlySet<string> { return this.excludedIds; }

  /** 交给 Agent-Net 连接的规则：只认列表里的（没读到过列表就都认），不认本机刚删的。 */
  rule(): PeerRule { return this.current; }

  /** 读到过设备列表（这之前不拦任何设备）。 */
  hasDeviceList(): boolean { return this.listed !== null; }

  /** 名册变了。出现了列表里没有的设备（新加入的、刚重新登录的或删掉的）就去读一次列表；被拦的设备刚上线，最多每分钟确认一次。 */
  noteDirectory(members: Iterable<{ deviceId: string; online: boolean }>): void {
    const next = new Map<string, boolean>();
    let check = false, recheck = false;
    for (const { deviceId, online } of members) {
      const was = this.directory.get(deviceId);
      next.set(deviceId, online);
      if (was === undefined && !this.listed?.ids.has(deviceId)) check = true;
      if (online && was === false && this.excludedIds.has(deviceId)) recheck = true;
    }
    this.directory = next;
    this.recompute();
    if (!check && recheck && this.now() - this.lastRecheckAt >= MEMBERSHIP_RECHECK_INTERVAL_MS) { this.lastRecheckAt = this.now(); check = true; }
    if (check) this.requestRead();
    // 正在读的那次读完会排下一次；这里再排会白白用掉一步退避。
    if (!this.background && !this.reading) this.scheduleBackground();
  }

  /**
   * A connection is about to open: read the list now unless one was read within the minimum interval, and keep reading in
   * the background while connected. Resolves when the read started here (or one already running) is done.
   */
  prime(): Promise<void> {
    this.requestRead();
    if (!this.background && !this.reading) this.scheduleBackground();
    return this.reading ?? Promise.resolve();
  }

  /** 别处刚读到的本账号设备列表；startedAt 是开始读的时间（不传就算现在）。 */
  noteDeviceList(ids: Iterable<string>, startedAt = this.now()): void {
    if (this.listed && this.listed.at > startedAt) return;
    this.listed = { ids: new Set(ids), at: startedAt };
    this.lastReadAt = Math.max(this.lastReadAt, startedAt);
    this.lastReadFailed = false;
    for (const [id, removedAt] of this.removedHere) if (removedAt < startedAt) this.removedHere.delete(id);
    this.recompute();
  }

  /** 本机在 Device Link 里删掉了这台设备。 */
  noteRemoved(deviceId: string): void {
    this.removedHere.set(deviceId, this.now());
    this.recompute();
  }

  /** 读一次列表（正在读就等那一次）；读不到时沿用之前的结论。 */
  refresh(): Promise<void> {
    if (this.reading) return this.reading;
    if (this.deferred) { clearTimeout(this.deferred); this.deferred = null; }
    const startedAt = this.now();
    this.lastReadAt = startedAt;
    const epoch = this.epoch;
    const reading = (async () => {
      let ids: readonly string[] | null = null;
      try { ids = await this.ports.readDeviceLinkDeviceIds(); } catch { ids = null; }
      if (epoch !== this.epoch) return;
      this.lastReadFailed = !ids;
      if (ids) this.noteDeviceList(ids, startedAt);
    })().finally(() => {
      if (this.reading === reading) this.reading = null;
      if (epoch === this.epoch) this.scheduleBackground();
    });
    this.reading = reading;
    return reading;
  }

  /** 换了账号或网络：之前的结论都不算。 */
  reset(): void {
    this.epoch++;
    if (this.deferred) { clearTimeout(this.deferred); this.deferred = null; }
    if (this.background) { clearTimeout(this.background); this.background = null; }
    this.retryMs = MEMBERSHIP_RETRY_FIRST_MS;
    this.lastReadFailed = false;
    this.directory.clear();
    this.listed = null;
    this.removedHere.clear();
    this.reading = null;
    this.lastReadAt = Number.NEGATIVE_INFINITY;
    this.lastRecheckAt = Number.NEGATIVE_INFINITY;
    this.recompute();
  }

  /** 要确认一次：间隔到了马上读，没到就排到间隔一到（只排一次）；正在读的那次读完后间隔到了再读。 */
  private requestRead(): void {
    if (this.deferred) return;
    const wait = this.lastReadAt + MEMBERSHIP_READ_MIN_INTERVAL_MS - this.now();
    if (wait <= 0 && !this.reading) { void this.refresh(); return; }
    const epoch = this.epoch;
    this.deferred = setTimeout(() => {
      this.deferred = null;
      if (epoch !== this.epoch) return;
      if (this.reading) { void this.reading.then(() => { if (epoch === this.epoch) this.requestRead(); }); return; }
      void this.refresh();
    }, Math.max(wait, 0));
    (this.deferred as { unref?: () => void }).unref?.();
  }

  /**
   * The next background read while connected: with no list yet, after a failed read, or while a refused member is online
   * (it may have just signed in again), back off from MEMBERSHIP_RETRY_FIRST_MS; otherwise every MEMBERSHIP_PERIODIC_MS ±20%.
   * Not connected: nothing is scheduled; the next directory or `prime` starts it again.
   */
  private scheduleBackground(): void {
    if (this.background) { clearTimeout(this.background); this.background = null; }
    if (!this.ports.active()) return;
    const refusedOnline = [...this.excludedIds].some((id) => this.directory.get(id) === true);
    let delay: number;
    if (!this.listed || this.lastReadFailed || refusedOnline) {
      delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, MEMBERSHIP_PERIODIC_MS);
    } else {
      this.retryMs = MEMBERSHIP_RETRY_FIRST_MS;
      delay = MEMBERSHIP_PERIODIC_MS * (0.8 + 0.4 * (this.ports.random?.() ?? Math.random()));
    }
    const epoch = this.epoch;
    this.background = setTimeout(() => {
      this.background = null;
      if (epoch !== this.epoch || !this.ports.active()) return;
      if (this.reading) { void this.reading.then(() => { if (epoch === this.epoch && !this.background) this.scheduleBackground(); }); return; }
      void this.refresh();
    }, Math.max(delay, MEMBERSHIP_READ_MIN_INTERVAL_MS));
    (this.background as { unref?: () => void }).unref?.();
  }

  private recompute(): void {
    const listed = this.listed;
    const refused = [...this.removedHere].filter(([, removedAt]) => !listed || listed.at <= removedAt).map(([id]) => id);
    const rule: PeerRule = { allowed: listed ? [...listed.ids] : null, refused };
    const accepted = (id: string) => !refused.includes(id) && (!listed || listed.ids.has(id));
    const next = new Set([...this.directory.keys()].filter((id) => !accepted(id)));
    const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
      a === b || (!!a && !!b && a.length === b.length && a.every((id) => b.includes(id)));
    if (sameList(rule.allowed, this.current.allowed) && sameList(rule.refused, this.current.refused)) { this.excludedIds = next; return; }
    const added = [...next].filter((id) => !this.excludedIds.has(id)), released = [...this.excludedIds].filter((id) => !next.has(id));
    this.excludedIds = next;
    this.current = rule;
    if (added.length || released.length) {
      this.ports.log?.info(`agent-net membership: refusing ${next.size} device(s) not in the Device Link device list`
        + (added.length ? ` added=${added.map((id) => id.slice(0, 8)).join(',')}` : '')
        + (released.length ? ` released=${released.map((id) => id.slice(0, 8)).join(',')}` : ''));
    }
    this.ports.apply(rule);
  }
}
