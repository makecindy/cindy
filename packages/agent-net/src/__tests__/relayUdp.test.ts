/**
 * 测试价值
 * - 生产入口与结果：RelayUdpPath 是 transport.ts 决定中转数据报走 UDP 还是 WebSocket 的地方：`intercept` 认领的包不再
 *   交给核心，`send` 返回 false 时改走 WebSocket，登记包里的「收得到」和地址凭证决定中转往下发走哪条路。
 * - Bug／规则依据：2026-11-14 初版中转 UDP 的类型字节 0xA1–0xA4 与核心数据包首字节 0xA0–0xBF（`101` + 逐包确认位 +
 *   连接号高 4 位，见 agent-net-core/src/wire.rs、secure.rs）重叠，连接号高 4 位为 1–4 的直连包会被当成中转包丢掉。
 *   同版初稿要 40 秒没确认才判断 UDP 不通，中转也要 45 秒才退回 WebSocket，期间两个方向都往收不到的地方发
 *   （docs/dev-rules/remote-and-mobile-adaptation.md「中转数据报走 UDP」的故障半径三问）。
 *   2026-11-17 审查：重放或晚到的旧确认会让本机以为 UDP 还通；中转要地址凭证后，换了地址的设备要马上带上新凭证；
 *   中转地址启动时解析失败就一直不再解析。
 *   2026-11-18 用户要求：中转走 UDP 时远程连接页显示 UDP 的往返（`rttMs`，登记到确认），原来显示的是 WebSocket 心跳的。
 *   2026-11-22：VPN 透明代理接管了到中继 UDP 端口的流量，登记照常确认、会话数据几个小时一个都没回来，本机一直不退回
 *   WebSocket，与同账号所有设备的会话都超时；关掉 VPN 立即恢复。
 * - 覆盖缺口：中转集成测试只验证中转一侧；压测只交换公网地址，不会出现直连包；连接号随机，集成测试不一定撞上。
 * - 最小失败输入：首字节 0xA1 的核心数据包；确认中断 4 秒；一个过期的确认；一个没认定地址的确认；一次解析失败；
 *   一次登记晚 37 毫秒确认（往返要是 37，确认断了以后不再报旧值）；登记一直被确认、数据发了 4 次跨 3 秒却一个都没回来；
 *   对端一直重发（总有数据进来）而本机发往它的请求 60 秒内超时两次；本机只被控、请求一直进得来，自己发出的结果在
 *   中转连接上 5 秒里重传 10 个分片、占发出包数一半（审查 P1：只切控制端，被控端仍沿坏掉的上行回结果）；
 *   一条发过 1000 包、重传过 400 个分片的长期直连切到中转（审查 P2：生命周期累计不该算成最近 5 秒的中转重传）。
 *   2026-11-22 真机（Surge/Clash Fake-IP 透明网关）：系统 DNS 与普通 UDP/53 都把 `agent-net-stun.cindy.com.cn` 解析到
 *   `198.18.0.0/15`，STUN 走 Fake-IP 分配的外部端口与真实 IP 探测对端的 NAT 端口不同，对端在端口受限锥形 NAT 后无法直连。
 *   最小失败输入：`systemLookup` 返回 `198.18.38.213`，`resolveUdpHost` / `StunClient` 须改走真实 IP（拿不到再回退）。
 * - tier：unit；本机约 130 毫秒（假计时器）。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { UDP_RELAY_PROBE_BYTES, encodeUdpDown, encodeUdpProbeAck, encodeUdpRegisterAck, verifyUdpProbe, verifyUdpRegister, verifyUdpUp,
  type UdpRelayCredentials } from '@cindy/agent-net-relay';
import { UDP_RELAY_DOWN, UDP_RELAY_REGISTER_ACK, udpRelayPeerHash } from '@cindy/agent-net-relay/client';
import { RELAY_UDP_DATA_COOLDOWNS_MS, RELAY_UDP_PROBE_COOLDOWNS_MS, RelaySendCounters, RelayUdpPath, type RelayUdpOptions } from '../relayUdp.js';
import { StunClient, isFakeIp, parseDohIpv4, resolveUdpHost } from '../stun.js';
import { AUTO_SWITCH_COOLDOWN_MS, decideAutoPreferRelay } from '../transport.js';

const paths: RelayUdpPath[] = [];
afterEach(() => { for (const path of paths.splice(0)) path.close(); vi.useRealTimers(); });

function open(credentials: UdpRelayCredentials, options: Partial<RelayUdpOptions> = {}) {
  const sent: Uint8Array[] = [];
  const sentAt: number[] = [];
  const path = new RelayUdpPath({
    sendUdp: (_to, datagram) => { sent.push(datagram); sentAt.push(performance.now()); },
    server: '127.0.0.1:9',
    credentials: () => credentials,
    peers: () => ['member'],
    deliver: () => undefined,
    resolveHost: async (host) => host,
    ...options,
  });
  paths.push(path);
  const registrations = (from = 0) => sent.slice(from).map((packet, i) => {
    const registration = verifyUdpRegister(packet, credentials.key);
    return registration && { ...registration, at: sentAt[from + i] };
  }).filter((r) => r !== null);
  return { path, sent, registrations };
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
const COOKIE = Buffer.alloc(16, 3);

it('leaves every core and STUN packet to the core and claims only relay packets', () => {
  const { path } = open({ session: new Uint8Array(8), key: new Uint8Array(32) });
  const packet = (first: number) => { const bytes = new Uint8Array(64); bytes[0] = first; return bytes; };
  // 核心：握手 0x81–0x83（`100`），数据包 0xA0–0xBF（`101`）；STUN：首字节高两位为 0。
  const claimed = [];
  for (let first = 0x80; first <= 0xbf; first++) if (path.intercept(packet(first))) claimed.push(first.toString(16));
  for (let first = 0x00; first <= 0x03; first++) if (path.intercept(packet(first))) claimed.push(first.toString(16));
  expect(claimed).toEqual([]);
  expect(path.intercept(packet(UDP_RELAY_DOWN))).toBe(true);
  expect(path.intercept(packet(UDP_RELAY_REGISTER_ACK))).toBe(true);
});

it('falls back to the WebSocket within seconds when relay acks stop, tells the relay, and returns when they resume', async () => {
  fakeTimers();
  const credentials = { session: new Uint8Array(8).fill(7), key: new Uint8Array(32).fill(9) };
  const { path, registrations } = open(credentials);
  const ackFor = (counter: bigint) => encodeUdpRegisterAck(credentials, counter, true, COOKIE);
  const ackLatest = () => { const ack = ackFor(registrations().at(-1)!.counter); path.intercept(ack); return ack; };
  const datagram = new Uint8Array(100);

  await vi.waitFor(() => expect(registrations()).toHaveLength(1));
  expect(registrations()[0].receiving).toBe(false);
  expect(path.send('member', datagram)).toBe(false);
  ackLatest();
  // 刚通就马上告诉中继收得到，并带上中继给的地址凭证。
  expect(registrations().at(-1)).toMatchObject({ receiving: true, cookie: COOKIE });
  const lastAck = ackLatest();
  expect(path.send('member', datagram)).toBe(true);

  // 正在发数据：每 2–3 秒刷新一次登记；之后确认不再回来。
  vi.advanceTimersByTime(3_000);
  expect(path.send('member', datagram)).toBe(true);
  expect(registrations().length).toBeGreaterThan(2);
  vi.advanceTimersByTime(3_000);
  expect(path.send('member', datagram)).toBe(true);
  vi.advanceTimersByTime(3_000);
  expect(path.send('member', datagram)).toBe(false);
  vi.advanceTimersByTime(1_000);
  expect(registrations().at(-1)!.receiving).toBe(false);

  // 重放的旧确认、扣下来超过 4 秒才放的确认都不能让 UDP 看起来又通了（后面那次登记才发出 3.5 秒，认了就会显示通）。
  path.intercept(lastAck);
  expect(path.send('member', datagram)).toBe(false);
  vi.advanceTimersByTime(500);
  const late = registrations().find((r) => performance.now() - r.at >= 4_000 && performance.now() - r.at < 5_000)!;
  expect(registrations().some((r) => r.counter > late.counter && performance.now() - r.at < 4_000)).toBe(true);
  path.intercept(ackFor(late.counter));
  expect(path.send('member', datagram)).toBe(false);

  ackLatest();
  expect(registrations().at(-1)!.receiving).toBe(true);
  expect(path.send('member', datagram)).toBe(true);
});

it('measures the UDP round trip from each registration to its ack, and reports none once UDP is down (2026-11-18)', async () => {
  fakeTimers();
  const credentials = { session: new Uint8Array(8).fill(5), key: new Uint8Array(32).fill(6) };
  const { path, registrations } = open(credentials);
  await vi.waitFor(() => expect(registrations()).toHaveLength(1));
  expect(path.rttMs).toBeNull();
  const waited = performance.now() - registrations()[0].at;
  vi.advanceTimersByTime(37);
  path.intercept(encodeUdpRegisterAck(credentials, 1n, true, COOKIE));
  expect(path.rttMs).toBe(Math.round(waited + 37));
  // 刚通马上又登记一次（带「收得到」）；它 12 毫秒后确认，往返跟着更新。
  expect(registrations()).toHaveLength(2);
  vi.advanceTimersByTime(12);
  path.intercept(encodeUdpRegisterAck(credentials, 2n, true, COOKIE));
  expect(path.rttMs).toBe(12);
  // 之后的保活登记不再被确认：退回 WebSocket，不再报 UDP 的旧往返。
  vi.advanceTimersByTime(20_000);
  expect(path.send('member', new Uint8Array(100))).toBe(false);
  expect(path.rttMs).toBeNull();
});

it('registers again at once with the new cookie when the relay has not taken its new address', async () => {
  fakeTimers();
  const credentials = { session: new Uint8Array(8).fill(1), key: new Uint8Array(32).fill(2) };
  const { path, registrations } = open(credentials);
  await vi.waitFor(() => expect(registrations()).toHaveLength(1));
  path.intercept(encodeUdpRegisterAck(credentials, 1n, false, COOKIE));
  path.intercept(encodeUdpRegisterAck(credentials, 2n, true, COOKIE));
  expect(registrations()).toHaveLength(2);
  // 空闲保活时 NAT 换了端口：中继没认定新地址，给了新地址的凭证。
  vi.advanceTimersByTime(16_000);
  expect(registrations()).toHaveLength(3);
  const moved = Buffer.alloc(16, 4);
  path.intercept(encodeUdpRegisterAck(credentials, 3n, false, moved));
  expect(registrations()).toHaveLength(4);
  expect(registrations()[3].cookie).toEqual(moved);
  // 带着同一个凭证还没被认定：不来回空转，等下一次定时登记。
  path.intercept(encodeUdpRegisterAck(credentials, 4n, false, moved));
  expect(registrations()).toHaveLength(4);
});

it('preserves registration and upload counters when DNS points the same credentials to a new address', async () => {
  fakeTimers();
  const credentials = { session: new Uint8Array(8), key: new Uint8Array(32).fill(1) };
  let address = '192.0.2.1';
  const packets: { address: string; bytes: Uint8Array }[] = [];
  const { path } = open(credentials, {
    resolveHost: async () => address,
    sendUdp: (to, bytes) => { packets.push({ address: to.address, bytes }); },
  });
  await vi.advanceTimersByTimeAsync(0);
  const registerCounter = () => verifyUdpRegister(packets.at(-1)!.bytes, credentials.key)!.counter;
  path.intercept(encodeUdpRegisterAck(credentials, registerCounter(), true, COOKIE));
  expect(path.send('member', new Uint8Array(64))).toBe(true);
  const priorUpload = verifyUdpUp(packets.at(-1)!.bytes, credentials.key)!.counter;
  address = '192.0.2.2';
  await vi.advanceTimersByTimeAsync(29_000);
  const priorRegister = registerCounter();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(packets.at(-1)?.address).toBe(address);
  expect(registerCounter()).toBeGreaterThan(priorRegister);
  path.intercept(encodeUdpRegisterAck(credentials, registerCounter(), true, COOKIE));
  expect(path.send('member', new Uint8Array(64))).toBe(true);
  expect(verifyUdpUp(packets.at(-1)!.bytes, credentials.key)!.counter).toBeGreaterThan(priorUpload);
});

it('backs off early lookups when UDP is down and DNS cannot refresh the relay address', async () => {
  fakeTimers();
  const lookups: number[] = [];
  open({ session: new Uint8Array(8), key: new Uint8Array(32) }, {
    resolveHost: async () => {
      lookups.push(performance.now());
      if (lookups.length > 1) throw new Error('ENOTFOUND');
      return '192.0.2.1';
    },
  });
  await vi.advanceTimersByTimeAsync(39_000);
  expect(lookups).toEqual([0, 30_000, 32_000, 36_000]);
});

it('keeps resolving the relay address after a failed lookup and then registers', async () => {
  fakeTimers();
  let reachable = false;
  const lookups: string[] = [];
  const { registrations } = open({ session: new Uint8Array(8).fill(5), key: new Uint8Array(32).fill(6) }, {
    server: 'relay.example.test:3479',
    resolveHost: async (host) => { lookups.push(host); if (!reachable) throw new Error('ENOTFOUND'); return '192.0.2.7'; },
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(lookups.length).toBeGreaterThan(1);
  expect(registrations()).toEqual([]);
  reachable = true;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(registrations().length).toBeGreaterThan(0);
});

/** A relay whose UDP port answers every registration at once but never forwards data back (2026-11-22 VPN proxy). */
async function upWithAckingRelay(fill: number, options: Partial<RelayUdpOptions> = {}) {
  fakeTimers();
  const credentials = { session: new Uint8Array(8).fill(fill), key: new Uint8Array(32).fill(fill + 1) };
  const opened = open(credentials, options);
  let inspectedPackets = 0;
  const ackAll = () => {
    // Only decode new packets. A simulated cooldown can span thousands of timer steps.
    const pending = opened.registrations(inspectedPackets);
    inspectedPackets = opened.sent.length;
    for (const r of pending) {
      opened.path.intercept(encodeUdpRegisterAck(credentials, r.counter, true, COOKIE));
    }
  };
  const step = (ms: number) => { for (let t = 0; t < ms; t += 250) { vi.advanceTimersByTime(250); ackAll(); } };
  await vi.waitFor(() => expect(opened.registrations()).toHaveLength(1));
  ackAll();
  ackAll();
  expect(opened.path.send('member', new Uint8Array(100))).toBe(true);
  const reply = () => opened.path.intercept(encodeUdpDown(credentials.key, udpRelayPeerHash('member'), new Uint8Array(64)));
  return { ...opened, step, reply };
}
/** The core keeps resending an unanswered packet: three more sends across three seconds. */
function resendUnanswered(path: RelayUdpPath, step: (ms: number) => void) {
  for (let i = 0; i < 3; i++) { step(1_000); path.send('member', new Uint8Array(1_350)); }
}

it('leaves relay UDP when registrations are acked but no data comes back, tells the relay, and retries after a growing cooldown', async () => {
  const { path, registrations, step } = await upWithAckingRelay(3);
  resendUnanswered(path, step);
  // Checked on the 1 s tick: a 4 s silence is acted on within 5 s of the first unanswered send.
  step(2_000);
  expect(path.send('member', new Uint8Array(100))).toBe(false);
  expect(path.suspension).toEqual({ reason: 'data-silence', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });
  expect(registrations().at(-1)!.receiving).toBe(false);

  // While suspended the acks must not bounce registrations back and forth at round-trip speed.
  const before = registrations().length;
  step(10_000);
  expect(registrations().length - before).toBeLessThanOrEqual(1);

  step(RELAY_UDP_DATA_COOLDOWNS_MS[0]);
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  expect(registrations().at(-1)!.receiving).toBe(true);

  // Still no data: the next cooldown is longer.
  resendUnanswered(path, step);
  step(2_000);
  expect(path.suspension?.cooldownMs).toBe(RELAY_UDP_DATA_COOLDOWNS_MS[1]);
});

it('stays on relay UDP for an unanswered pure ACK, and while replies keep arriving over UDP or the WebSocket', async () => {
  const { path, step, reply } = await upWithAckingRelay(5);
  // A single packet nobody answers (an ACK-only datagram) is not evidence of a broken path.
  step(10_000);
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  expect(path.suspension).toBeNull();

  // Replies coming back over UDP, or relayed over the WebSocket instead, keep UDP in use.
  for (let i = 0; i < 8; i++) {
    step(1_000);
    path.send('member', new Uint8Array(1_350));
    if (i % 2 === 0) reply(); else path.noteInbound(false);
  }
  step(1_000);
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  expect(path.suspension).toBeNull();
});

it('leaves relay UDP after two session request timeouts within a minute even while data keeps arriving', async () => {
  const { path, registrations, step, reply } = await upWithAckingRelay(7);
  // Peers keep resending, so data arrives; only this side's requests go unanswered (2026-11-22: rx 30 MB, tx 2.6 MB).
  const arriving = () => { for (let i = 0; i < 4; i++) { step(1_000); path.send('member', new Uint8Array(1_350)); reply(); } };
  arriving();
  path.noteStall();
  arriving();
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  // Two timeouts more than a minute apart do not count together.
  step(60_000);
  path.noteStall();
  expect(path.suspension).toBeNull();
  path.noteStall();
  expect(path.send('member', new Uint8Array(100))).toBe(false);
  expect(path.suspension).toEqual({ reason: 'request-timeouts', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });
  expect(registrations().at(-1)!.receiving).toBe(false);
  // A timeout reported while UDP is not in use is not about UDP.
  path.noteStall();
  expect(path.suspension?.cooldownMs).toBe(RELAY_UDP_DATA_COOLDOWNS_MS[0]);
});

// Unit regression: a peer can keep sending UDP data while every upload times out. Exercise the
// second outage and recovery through the relay path; checking just the first fallback misses the loop.
it('backs off repeated uplink loss despite incoming UDP, then resets after sustained acknowledged traffic', async () => {
  const counters = { retransmitted: 0, sent: 0, acknowledgedBytes: 0 };
  const { path, registrations, step, reply } = await upWithAckingRelay(9, { relayedSendCounters: () => ({ ...counters }) });
  // Requests keep arriving (so the silence check stays clear) and this side never sends a request of its own.
  const receiving = (retransmitted: number, sent: number) => {
    for (let i = 0; i < 6; i++) {
      step(1_000); reply(); path.send('member', new Uint8Array(1_350));
      counters.retransmitted += retransmitted; counters.sent += sent;
    }
  };
  // Lossy but working: 10 resent in 5 s is enough segments, yet only a tenth of what was sent, so UDP stays.
  receiving(2, 20);
  expect(path.suspension).toBeNull();
  // A connection closing makes the sums drop: start counting again rather than reading a negative delta.
  counters.retransmitted = 0; counters.sent = 0;
  step(1_000);
  expect(path.suspension).toBeNull();
  // The results this host sends back are never acknowledged: the core resends half of what it sends.
  receiving(2, 4);
  expect(path.send('member', new Uint8Array(100))).toBe(false);
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });
  expect(registrations().at(-1)!.receiving).toBe(false);

  // A late UDP datagram and work completed on the fallback WebSocket cannot bless the next UDP attempt.
  reply();
  counters.acknowledgedBytes += 32_000;
  step(RELAY_UDP_DATA_COOLDOWNS_MS[0]);
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  // Registration works and the peer keeps sending for longer than the recovery window,
  // but only one old acknowledgement makes it through.
  for (let i = 0; i < 12; i++) receiving(0, 1);
  counters.acknowledgedBytes += 100;
  receiving(0, 1);
  receiving(2, 4);
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[1] });
  expect(path.send('member', new Uint8Array(100))).toBe(false);

  const exchangeAcknowledgedTraffic = (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      expect(path.send('member', new Uint8Array(1_350))).toBe(true);
      counters.sent++;
      counters.acknowledgedBytes += 1_350;
      reply();
      step(1_000);
    }
  };

  // One healthy window isn't enough. Thirty seconds of confirmed traffic
  // followed by another outage must still advance to the longest cooldown.
  step(RELAY_UDP_DATA_COOLDOWNS_MS[1]);
  exchangeAcknowledgedTraffic(30);
  receiving(2, 4);
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[2] });

  step(RELAY_UDP_DATA_COOLDOWNS_MS[2]);
  exchangeAcknowledgedTraffic(70);
  receiving(2, 4);
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });
});

it('counts only the growth a connection made while it stayed on the relay, not its history from a direct path', () => {
  const counters = new RelaySendCounters();
  const relayed = {}, direct = {};
  // The core's per-connection stats are lifetime totals and survive a path change.
  const onRelay = { key: relayed, relay: true, retransmitted: 3, sent: 100, acknowledgedBytes: 800 };
  const offRelay = { key: direct, relay: false, retransmitted: 400, sent: 1_000, acknowledgedBytes: 4_000 };
  expect(counters.sample([onRelay, offRelay])).toEqual({ retransmitted: 0, sent: 0, acknowledgedBytes: 0 });
  expect(counters.sample([
    { ...onRelay, retransmitted: 4, sent: 120, acknowledgedBytes: 850 },
    { ...offRelay, retransmitted: 410, sent: 1_050, acknowledgedBytes: 5_000 },
  ])).toEqual({ retransmitted: 1, sent: 20, acknowledgedBytes: 50 });
  // The long-lived direct connection falls back to the relay: its 400+ past resends must not land in the window.
  const switched = { ...offRelay, relay: true, retransmitted: 410, sent: 1_060, acknowledgedBytes: 5_100 };
  const steady = { ...onRelay, retransmitted: 4, sent: 140, acknowledgedBytes: 850 };
  expect(counters.sample([steady, switched])).toEqual({ retransmitted: 1, sent: 40, acknowledgedBytes: 50 });
  // From then on its growth on the relay counts; once it leaves the relay it stops counting.
  expect(counters.sample([{ ...steady, sent: 160 }, { ...switched, retransmitted: 418, sent: 1_070, acknowledgedBytes: 5_140 }]))
    .toEqual({ retransmitted: 9, sent: 70, acknowledgedBytes: 90 });
  expect(counters.sample([{ ...steady, sent: 180 }, { ...switched, relay: false, retransmitted: 500, sent: 1_200, acknowledgedBytes: 8_000 }]))
    .toEqual({ retransmitted: 9, sent: 90, acknowledgedBytes: 90 });
});

it('detects RFC 2544 Fake-IP addresses and parses real IPv4 answers from DoH JSON', () => {
  expect([
    isFakeIp('198.18.0.1'),
    isFakeIp('198.18.38.213'),
    isFakeIp('198.19.255.254'),
    isFakeIp('198.17.255.255'),
    isFakeIp('198.20.0.1'),
    isFakeIp('106.15.77.85'),
    isFakeIp('not-an-ip'),
  ]).toEqual([true, true, true, false, false, false, false]);

  expect(parseDohIpv4(JSON.stringify({
    Status: 0,
    Answer: [
      { type: 5, data: 'nlb.example.test.' },
      { type: 1, data: '198.18.0.2' },
      { type: 1, data: '106.15.77.85' },
      { type: 1, data: '47.102.146.103' },
    ],
  }))).toBe('106.15.77.85');
  expect(parseDohIpv4(JSON.stringify({ Status: 3, Answer: [{ type: 1, data: '106.15.77.85' }] }))).toBeNull();
  expect(parseDohIpv4('{bad-json')).toBeNull();
});

it('bypasses Fake-IP via real-IP lookup, deduplicates concurrent lookups, and falls back when unavailable', async () => {
  const resolveReal = vi.fn(async () => '47.102.146.103');
  const systemLookup = vi.fn(async () => '106.15.77.85');
  // IPv4 literal and normal DNS answers never touch the DoH path.
  expect(await resolveUdpHost('106.15.77.85', { systemLookup, resolveReal })).toBe('106.15.77.85');
  expect(systemLookup).not.toHaveBeenCalled();
  expect(await resolveUdpHost('stun.example.test', { systemLookup, resolveReal })).toBe('106.15.77.85');
  expect(resolveReal).not.toHaveBeenCalled();

  // Fake-IP triggers real-IP lookup, shared between concurrent STUN + relay UDP calls for the same host.
  let release!: (ip: string | null) => void;
  const concurrentReal = vi.fn(() => new Promise<string | null>((resolve) => { release = resolve; }));
  const fakeLookup = async () => '198.18.38.213';
  const a = resolveUdpHost('agent-net-stun.example.test', { systemLookup: fakeLookup, resolveReal: concurrentReal });
  const b = resolveUdpHost('agent-net-stun.example.test', { systemLookup: fakeLookup, resolveReal: concurrentReal });
  await vi.waitFor(() => expect(concurrentReal).toHaveBeenCalledTimes(1));
  release('47.102.146.103');
  expect(await Promise.all([a, b])).toEqual(['47.102.146.103', '47.102.146.103']);

  // Unreachable DoH or a Fake-IP answer falls back to the system result without breaking private relays.
  expect(await resolveUdpHost('private.lan', { systemLookup: fakeLookup, resolveReal: async () => null })).toBe('198.18.38.213');
  expect(await resolveUdpHost('private.lan', { systemLookup: fakeLookup, resolveReal: async () => '198.19.1.2' })).toBe('198.18.38.213');
});

it('sends STUN binding requests to the resolved real IP instead of a Fake-IP and parses XOR-MAPPED-ADDRESS', async () => {
  const sentTo: Array<{ address: string; port: number }> = [];
  let client!: StunClient;
  client = new StunClient((to, datagram) => {
    sentTo.push(to);
    // Reply with a minimal RFC 5389 Binding Success carrying XOR-MAPPED-ADDRESS = 114.86.77.98:18024.
    const reply = Buffer.alloc(32);
    reply.writeUInt16BE(0x0101, 0);
    reply.writeUInt16BE(12, 2);
    reply.writeUInt32BE(0x2112a442, 4);
    Buffer.from(datagram.buffer, datagram.byteOffset + 8, 12).copy(reply, 8);
    reply.writeUInt16BE(0x0020, 20);
    reply.writeUInt16BE(8, 22);
    reply[25] = 0x01;
    reply.writeUInt16BE(18024 ^ 0x2112, 26);
    reply.writeUInt32BE(((114 << 24) | (86 << 16) | (77 << 8) | 98) >>> 0 ^ 0x2112a442, 28);
    queueMicrotask(() => client.intercept(reply));
  }, (host) => resolveUdpHost(host, {
    systemLookup: async () => '198.18.38.213',
    resolveReal: async () => '106.15.77.85',
  }));

  const mapped = await client.query('agent-net-stun.example.test:3479');
  expect(sentTo).toEqual([{ address: '106.15.77.85', port: 3479 }]);
  expect(mapped).toEqual({ address: '114.86.77.98', port: 18024 });
  client.close();
});

// 2026-11-22 真机跨国直连（上海电信 163 ↔ 新加坡 StarHub 220ms vs 阿里云上海中转 86ms）：
// 自动选路只在直连明显慢于中转（>1.5x 且慢 >=40ms）时选中转，并用滞回+冷却防止来回抖动。tier: unit。
it('selects relay in auto mode only when direct is significantly slower, with hysteresis and cooldown', () => {
  expect(decideAutoPreferRelay({ currentPreferRelay: false, directRttMs: 220, relayRttMs: null, msSinceLastSwitch: Infinity })).toBe(false);
  expect(decideAutoPreferRelay({ currentPreferRelay: true, directRttMs: null, relayRttMs: 86, msSinceLastSwitch: Infinity })).toBe(true);
  expect(decideAutoPreferRelay({ currentPreferRelay: false, directRttMs: 25, relayRttMs: 15, msSinceLastSwitch: Infinity })).toBe(false);
  expect(decideAutoPreferRelay({ currentPreferRelay: false, directRttMs: 95, relayRttMs: 86, msSinceLastSwitch: Infinity })).toBe(false);
  expect(decideAutoPreferRelay({ currentPreferRelay: false, directRttMs: 120, relayRttMs: 86, msSinceLastSwitch: Infinity })).toBe(false);
  expect(decideAutoPreferRelay({ currentPreferRelay: false, directRttMs: 220, relayRttMs: 86, msSinceLastSwitch: Infinity })).toBe(true);
  expect(decideAutoPreferRelay({ currentPreferRelay: true, directRttMs: 60, relayRttMs: 86, msSinceLastSwitch: AUTO_SWITCH_COOLDOWN_MS - 1 })).toBe(true);
  expect(decideAutoPreferRelay({ currentPreferRelay: true, directRttMs: 140, relayRttMs: 86, msSinceLastSwitch: AUTO_SWITCH_COOLDOWN_MS })).toBe(true);
  expect(decideAutoPreferRelay({ currentPreferRelay: true, directRttMs: 105, relayRttMs: 86, msSinceLastSwitch: AUTO_SWITCH_COOLDOWN_MS })).toBe(false);
});

// 测试价值（2026-11-25 治本回归：满尺寸第 1 跳探针与单对端隔离）
// - 生产入口与可观察结果：RelayUdpPath（transport.ts）在支持 udp-relay-probe-v1 时于准入、异常复核与恢复期直测 1350B UDP；
//   不支持探针的旧中继下按连接隔离重传，并允许间歇正常流量重置退避档位。
// - Bug／规则依据：2026-11-25 Lizi 真机日志（50B 登记正常、本机 UDP 健康，但单台经中转对端抖动/离线触发全局 unacked-sends，
//   且空闲窗口清空 healthySince 导致退避一路锁死 1800s WS）。
// - 现有覆盖缺口：原有用例仅测无探针的旧中继全员断流与连续 70s 持续流量，未覆盖满尺寸探针、单对端健康否决与间歇轮询清零。
// - 最小失败输入：1) 50B 登记全通但 1350B 探针被吞（VPN 黑洞）；2) 1350B 探针秒回时出现静默/超时/重传（对端问题）；
//   3) 旧中继下两台经中转设备一台健康、一台重传；4) 间隔 15s 空闲的双向确认跨过 60s。tier: unit（假计时器）。
it('gates relay UDP admission on full-size probe, never blames hop 1 when probe passes, and recovers via probe or networkChanged', async () => {
  fakeTimers();
  const credentials: UdpRelayCredentials = { session: new Uint8Array(8).fill(11), key: new Uint8Array(32).fill(12), probe: true };
  let answerProbes = false;
  const counters = { retransmitted: 0, sent: 0, acknowledgedBytes: 0 };
  const { path, sent, registrations } = open(credentials, { relayedSendCounters: () => ({ ...counters }) });
  let cursor = 0;
  const pump = () => {
    const batch = sent.slice(cursor);
    cursor = sent.length;
    for (const packet of batch) {
      const reg = verifyUdpRegister(packet, credentials.key);
      if (reg) {
        const proven = !!reg.cookie && Buffer.from(reg.cookie).equals(COOKIE);
        path.intercept(encodeUdpRegisterAck(credentials, reg.counter, proven, COOKIE));
        continue;
      }
      const probe = verifyUdpProbe(packet, credentials.key);
      if (probe && answerProbes) {
        expect(probe.size).toBe(UDP_RELAY_PROBE_BYTES);
        path.intercept(encodeUdpProbeAck(credentials, probe.counter, probe.size));
      }
    }
  };
  const step = (ms: number) => { for (let t = 0; t < ms; t += 250) { vi.advanceTimersByTime(250); pump(); } };

  // VPN swallows 1350B packets while answering 50B registrations: never enters broken UDP, suspends with probe-failed.
  await vi.waitFor(() => expect(registrations().length).toBeGreaterThanOrEqual(1));
  pump(); pump();
  expect(path.send('member', new Uint8Array(100))).toBe(false);
  step(3_000);
  expect(path.suspension).toEqual({ reason: 'probe-failed', cooldownMs: RELAY_UDP_PROBE_COOLDOWNS_MS[0] });
  expect(registrations().at(-1)!.receiving).toBe(false);

  // When probe starts succeeding at cooldown expiry, UDP turns on seamlessly without dumping traffic blindly.
  answerProbes = true;
  step(RELAY_UDP_PROBE_COOLDOWNS_MS[0] + 1_000);
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  expect(registrations().at(-1)!.receiving).toBe(true);

  // Wait past PROBE_FRESH_MS, then simulate peer-side silence, timeouts, and retransmits while hop-1 probe succeeds: UDP stays up.
  step(4_000);
  for (let i = 0; i < 4; i++) { path.send('member', new Uint8Array(1_200)); step(1_000); }
  step(2_000);
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);

  step(4_000);
  path.noteStall(); path.noteStall();
  step(1_000);
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);

  step(4_000);
  for (let i = 0; i < 6; i++) {
    step(1_000);
    path.send('member', new Uint8Array(1_200));
    counters.retransmitted += 2; counters.sent += 4;
  }
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);

  // Now hop 1 actually breaks (VPN enabled mid-session): anomaly triggers probe, probe fails -> switches to WS immediately.
  answerProbes = false;
  step(4_000);
  path.noteStall(); path.noteStall();
  step(3_000);
  expect(path.suspension).toEqual({ reason: 'probe-failed', cooldownMs: RELAY_UDP_PROBE_COOLDOWNS_MS[0] });
  expect(path.send('member', new Uint8Array(100))).toBe(false);

  // Turning VPN off (networkChanged) immediately clears suspension and re-probes back to UDP within 1s.
  answerProbes = true;
  path.networkChanged();
  step(1_000);
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);
});

it('does not suspend legacy relay UDP when one peer stalls while another relayed peer acknowledges cleanly, and resets backoff across idle gaps', async () => {
  const relaySends = new RelaySendCounters();
  const healthyPeer = {}, dyingPeer = {};
  const healthy = { key: healthyPeer, relay: true, retransmitted: 0, sent: 0, acknowledgedBytes: 0 };
  const dying = { key: dyingPeer, relay: true, retransmitted: 0, sent: 0, acknowledgedBytes: 0 };
  const { path, step, reply } = await upWithAckingRelay(15, {
    relayedSendCounters: () => relaySends.sampleDetailed([healthy, dying]),
  });

  // Dying peer retransmits 100% with 0 ACK while healthy peer keeps acknowledging cleanly -> hop 1 is healthy, no suspension.
  for (let i = 0; i < 8; i++) {
    step(1_000);
    reply();
    path.send('member', new Uint8Array(1_200));
    healthy.sent += 4; healthy.acknowledgedBytes += 4_800;
    dying.sent += 4; dying.retransmitted += 4;
  }
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);

  // Even two request timeouts on the dying peer must not suspend legacy relay UDP while the healthy peer is acknowledging.
  path.noteStall();
  path.noteStall();
  expect(path.suspension).toBeNull();
  expect(path.send('member', new Uint8Array(100))).toBe(true);

  // Both peers stop acknowledging (real hop-1 outage) -> suspends after 5s window.
  for (let i = 0; i < 6; i++) {
    step(1_000);
    reply();
    path.send('member', new Uint8Array(1_200));
    healthy.sent += 2; healthy.retransmitted += 2;
    dying.sent += 2; dying.retransmitted += 2;
  }
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });

  // After cooldown, intermittent bidirectional traffic with 15s idle gaps across 65s must reset cooldown back to tier 0.
  step(RELAY_UDP_DATA_COOLDOWNS_MS[0]);
  expect(path.send('member', new Uint8Array(100))).toBe(true);
  const poll = () => {
    for (let i = 0; i < 6; i++) {
      step(1_000);
      reply();
      path.send('member', new Uint8Array(1_200));
      healthy.sent += 2; healthy.acknowledgedBytes += 2_400;
    }
  };
  poll();
  step(15_000); // Purely idle window must not erase healthy progress.
  poll();
  step(45_000);
  poll();

  // Next outage must start at the shortest cooldown (30s), not escalate to 300s.
  for (let i = 0; i < 6; i++) {
    step(1_000);
    reply();
    path.send('member', new Uint8Array(1_200));
    healthy.sent += 2; healthy.retransmitted += 2;
    dying.sent += 2; dying.retransmitted += 2;
  }
  expect(path.suspension).toEqual({ reason: 'unacked-sends', cooldownMs: RELAY_UDP_DATA_COOLDOWNS_MS[0] });
});
