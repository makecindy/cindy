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
 * - 覆盖缺口：中转集成测试只验证中转一侧；压测只交换公网地址，不会出现直连包；连接号随机，集成测试不一定撞上。
 * - 最小失败输入：首字节 0xA1 的核心数据包；确认中断 4 秒；一个过期的确认；一个没认定地址的确认；一次解析失败；
 *   一次登记晚 37 毫秒确认（往返要是 37，确认断了以后不再报旧值）。
 * - tier：unit；本机约 130 毫秒（假计时器）。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { encodeUdpRegisterAck, verifyUdpRegister, verifyUdpUp, type UdpRelayCredentials } from '@cindy/agent-net-relay';
import { UDP_RELAY_DOWN, UDP_RELAY_REGISTER_ACK } from '@cindy/agent-net-relay/client';
import { RelayUdpPath, type RelayUdpOptions } from '../relayUdp.js';

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
  const registrations = () => sent.map((packet, i) => {
    const registration = verifyUdpRegister(packet, credentials.key);
    return registration && { ...registration, at: sentAt[i] };
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
