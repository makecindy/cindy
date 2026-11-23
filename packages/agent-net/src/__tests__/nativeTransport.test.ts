import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, issueCertificate, verifyCertificate } from '@cindy/agent-net-relay';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../portableSocket.js';
import { NativeTransport, encodeNativeIo, type NativeEnginePort } from '../nativeTransport.js';
import type { PeerChannel } from '../types.js';

// Unit at the production NativeTransport IO boundary: a poll is still initializing
// an existing peer when another peer starts dialing. The old snapshot cannot
// declare that newer connection missing. The handover tests below never dial
// while a native command is suspended, so they cannot cover this ordering.
// Expiry remains independent of that snapshot, including a late established
// reply or initialization completing beyond the existing three-second deadline.
it.each(['ready', 'old-poll-timeout', 'late-established', 'slow-initialize'] as const)(
  'keeps newer native dials snapshot-safe and deadline-bounded: %s', async mode => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  let release!: () => void, entered!: () => void, connected!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const dialCreated = new Promise<void>(resolve => { connected = resolve; });
  const closed: number[] = [], received: number[] = [];
  let nextStream = 0, first = true, dialed = false, delayed = false;
  const state = (id: number) => ({ id, established: true, dead: false, closedByPeer: false,
    unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 });
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
      if (command.op === 'poll') {
        if (dialed && mode === 'late-established' && !delayed) { delayed = true; vi.advanceTimersByTime(3001); }
        value = { packets: [], connections: [state(1), ...(dialed ? [state(2)] : [])].filter(s => !closed.includes(s.id)) };
      }
      if (command.op === 'connect') { dialed = true; value = 2; connected(); }
      if (command.op === 'openStream') {
        if (first) { first = false; entered(); await blocked; }
        if (command.id === 2 && mode === 'slow-initialize' && !delayed) { delayed = true; vi.advanceTimersByTime(3001); }
        value = ++nextStream;
      }
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      if (command.op === 'close') closed.push(command.id as number);
      return value as T;
    }, async destroy() {},
  };
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: () => { received.push(1); } });
    const poll = vi.advanceTimersByTimeAsync(8);
    await initializing;
    let outcome: { channel: PeerChannel } | { error: unknown } | undefined;
    const result = transport.connect({ id: key, dial: { relayId: remote.deviceId } })
      .then(channel => ({ channel }), error => ({ error })).then(value => { outcome = value; return value; });
    await dialCreated;
    await vi.advanceTimersByTimeAsync(0); // Register the waiter after the bridge command returned.
    if (mode === 'old-poll-timeout') vi.advanceTimersByTime(3001);
    release(); await poll;
    await vi.advanceTimersByTimeAsync(0); // Finish this poll without starting the next eight-ms poll.
    if (mode === 'old-poll-timeout') {
      expect(outcome).toMatchObject({ error: new Error('NATIVE_CONNECT_TIMEOUT') });
      expect(closed).toContain(2);
      expect(received).toEqual([1]);
      return;
    }
    await vi.advanceTimersByTimeAsync(8);
    if (mode === 'ready') {
      expect(await result).toHaveProperty('channel');
      expect(closed).not.toContain(2);
    } else {
      expect(await result).toMatchObject({ error: new Error('NATIVE_CONNECT_TIMEOUT') });
      expect(closed).toContain(2);
    }
    expect(received).toEqual([1]);
  } finally { release?.(); await transport?.close(); vi.useRealTimers(); }
});

// Unit at the native engine IO boundary: real NativeTransport/NativeChannel and
// PortableSocket admission, framing and replies; no fake PeerChannel.close.
it.each(['late-frame', 'late-response', 'revoked', 'rotated', 'abort', 'deadline'] as const)(
  'keeps native retired receive bounded and authorized: %s', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const local = generateIdentity('z-native'), remote = generateIdentity('a-guest');
    const { root, bootstrap } = createPrivateNetwork('native handover', local);
    const member = (identity: typeof remote) => ({ certificate: issueCertificate(root, {
      networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member',
    }), name: 'Guest', online: false, remoteControlEnabled: true, capabilities: [] });
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [member(remote)],
      delegations: [], send() {}, presence() {}, onDatagram() {}, close() {} });
    const frame = (id: string, kind = 'link-open') => {
      const body = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, kind, id, dst: local.deviceId, payload: {} }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix, body]).toString('base64url');
    };
    const state = (id: number, data: string[] = [], opening = false) => ({ id, established: true, dead: false,
      closedByPeer: false, unacked: false, remoteKey: remote.transportKey, events: opening ? [{ kind: 'open', stream: 71 }] : [],
      data: data.map(data => ({ stream: 71, data })), rttUs: 0, sent: 0, received: 0, rotations: 0 });
    let states = [state(1, [Buffer.from([0x44]).toString('base64url')], true)], nextStream = 0;
    const closed = new Set<number>(), writes: Array<{ id: number; bytes: Buffer }> = [];
    const finishes: number[] = [], channels: PeerChannel[] = [];
    const engine: NativeEnginePort = {
      async command<T>(command: Record<string, unknown>): Promise<T> {
        let value: unknown;
        if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
        if (command.op === 'poll') { value = { packets: [], connections: states.filter(s => !closed.has(s.id)) }; states = states.map(s => ({ ...s, events: [], data: [] })); }
        if (command.op === 'openStream') value = ++nextStream;
        if (command.op === 'write') { const bytes = Buffer.from(command.data as string, 'base64url'); writes.push({ id: command.id as number, bytes }); value = bytes.length; }
        if (command.op === 'finish') finishes.push(command.id as number);
        if (command.op === 'close') closed.add(command.id as number);
        return value as T;
      }, async destroy() {},
    };
    let socket: AgentNetSocket | undefined;
    try {
      socket = await AgentNetSocket.openWithBindings({ client: { base: 'https://relay.example.test',
        rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect: async () => uplink },
        userId: bootstrap.ownerCertificate.subject,
        bindings: { verifyCertificate, createTransport: options => NativeTransport.create(engine, { ...options,
          onIncoming(channel) { channels.push(channel); options.onIncoming(channel); } }) } });
      const received: string[] = [];
      socket.on('message', raw => {
        const f = JSON.parse(raw.toString());
        if (f.kind === 'invoke-result') received.push(f.id);
        if (f.kind === 'link-open') { received.push(f.id); socket!.send(JSON.stringify({ v: PROTOCOL_VERSION,
          kind: 'link-accept', id: f.id, dst: f.src, payload: { appVersion: 'test', allowlistHash: 'test' } })); }
      });
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
        deviceName: 'Native', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false,
      } }));
      await vi.advanceTimersByTimeAsync(8);
      if (mode === 'late-response') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'invoke',
        id: 'old-in-flight', dst: remote.deviceId, payload: { channel: 'test:echo', args: [] } }));
      // New authenticated inbound is admitted before an already-written old
      // request arrives. Both endpoints have the same direction and identity.
      states = [state(2, [Buffer.from([0x44]).toString('base64url')], true), state(1)];
      await vi.advanceTimersByTimeAsync(8);
      expect(channels).toHaveLength(2);
      expect(finishes).toContain(1);
      if (mode === 'revoked') { uplink.devices = []; uplink.emit('directory'); }
      if (mode === 'rotated') { uplink.devices = [member(generateIdentity(remote.deviceId))]; uplink.emit('directory'); }
      if (mode === 'abort') channels[0].close({ drain: false });
      // Outgoing ACK completion must not cut off receive before the deadline.
      await vi.advanceTimersByTimeAsync(mode === 'deadline' ? 2000 : 24);
      states = [state(2), state(1, [frame('old-in-flight', mode === 'late-response' ? 'invoke-result' : 'link-open')])];
      await vi.advanceTimersByTimeAsync(16);
      if (mode === 'late-frame' || mode === 'late-response') {
        expect(received).toContain('old-in-flight');
        if (mode === 'late-frame') expect(writes.some(w => w.id === 2 && w.bytes.length > 4 && w.bytes.subarray(4).toString().includes('old-in-flight'))).toBe(true);
        // Late old close must leave the selected native channel usable.
        channels[0].close({ drain: false });
        states = [state(2, [frame('new-request')])];
        await vi.advanceTimersByTimeAsync(16);
        expect(received).toContain('new-request');
      } else expect(received).not.toContain('old-in-flight');
      if (mode === 'deadline' || mode === 'abort') expect(closed.has(1)).toBe(true);
    } finally { socket?.close(); await Promise.resolve(); vi.useRealTimers(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 向原生引擎发 poll 的频率。连接空闲时每 50 毫秒一次，不再每 8 毫秒一次；
 *   空闲时要发数据，当场写进引擎，不等下一次轮询、也不经过计时器（2026-11-21：React Native 的零延时计时器要等下一帧，
 *   真机上晚 7–20 毫秒）；数据在动时回到每 8 毫秒一次。
 * - Bug 依据：2026-11-20 真机，开着 Agent-Net 什么都不做时 JS 线程占 51%（关掉 1%）；没有东西要收发时，每 8 毫秒轮询
 *   一次仍占 22–33%，每 50 毫秒一次 7–18%，不轮询 0–4%。
 * - 现有覆盖缺口：上面的测试都在数据流动时推进 8 毫秒，没有覆盖空闲时的频率和空闲后第一次发送。
 * - 最小失败输入：一条已建立、没有数据的连接，空闲两秒，再发一次数据。tier：unit，真实 NativeTransport/NativeChannel，引擎用替身。
 */
it('polls the engine slowly while idle and at once when there is something to send', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const ops: string[] = [];
  let nextStream = 0, unacked = false, sending = false;
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      ops.push(command.op as string);
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
      if (command.op === 'poll') value = { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false,
        unacked, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] };
      if (command.op === 'openStream') value = ++nextStream;
      if (command.op === 'write') { value = Buffer.from(command.data as string, 'base64url').length; unacked = sending; }
      return value as T;
    }, async destroy() {},
  };
  const channels: PeerChannel[] = [];
  let transport: NativeTransport | undefined;
  const polls = () => ops.filter(op => op === 'poll').length;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: channel => { channels.push(channel); } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(channels).toHaveLength(1);
    const idleStart = polls();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls() - idleStart).toBeLessThanOrEqual(21);
    const writes = ops.filter(op => op === 'write').length;
    sending = true;
    channels[0].send(Uint8Array.of(1, 2, 3));
    // No timer runs here, not even a zero one: on a phone those wait for the next display frame (7–20 ms measured, 2026-11-21).
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(ops.filter(op => op === 'write').length).toBe(writes + 1);
    // Unacknowledged data: fast again.
    const busyStart = polls();
    await vi.advanceTimersByTimeAsync(100);
    expect(polls() - busyStart).toBeGreaterThanOrEqual(10);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 把准入名册镜像给原生引擎（`admit` 命令）。名册没变时不再每次 poll 都重算一遍；
 *   socket 的准入版本一变，下一次 poll 就把新名册交给引擎；版本不变也每秒重算一次，覆盖证书、授权到期这类随时间失效的情况。
 * - Bug 依据：2026-11-21 真机，账号里 28 台设备时每次 poll 重算名册约占 JS 线程 8 毫秒，比 poll 本身（约 2 毫秒）还多；
 *   每 8 毫秒轮询时 JS 线程因此接近占满，请求比 Device Link 慢 30–60 毫秒。
 * - 现有覆盖缺口：现有用例只验证名册变化后会镜像，不看没变化时算了多少次。
 * - 最小失败输入：一台已准入的对端，连续轮询半秒；改名册并改版本；再让版本不变过一秒。tier：unit，引擎用替身。
 */
it('works out the admitted peers again only when the roster changed or a second passed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), first = generateIdentity('first'), second = generateIdentity('second');
  const hex = (key: string) => Buffer.from(key, 'base64url').toString('hex');
  let version = 1, roster = [{ id: hex(first.transportKey), relayId: first.deviceId }], computed = 0;
  const admitted: number[] = [];
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      if (command.op === 'identity') return { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null } as T;
      if (command.op === 'admit') admitted.push((command.peers as unknown[]).length);
      if (command.op === 'poll') return { packets: [], connections: [] } as T;
      return undefined as T;
    }, async destroy() {},
  };
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true, admissionVersion: () => version,
      admittedPeers: () => { computed += 1; return roster; }, relayIdOf: (id) => roster.find(peer => peer.id === id)?.relayId,
      onIncoming: () => undefined });
    expect(admitted).toEqual([1]);
    const afterCreate = computed;
    await vi.advanceTimersByTimeAsync(500);
    // Dozens of polls, the roster untouched.
    expect(computed).toBe(afterCreate);
    roster = [...roster, { id: hex(second.transportKey), relayId: second.deviceId }];
    version = 2;
    await vi.advanceTimersByTimeAsync(60);
    expect(admitted).toEqual([1, 2]);
    // Nothing the socket reports changes, but admission can lapse with time: looked at again within a second.
    const settled = computed;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(computed).toBeGreaterThan(settled);
    expect(computed - settled).toBeLessThanOrEqual(2);
    expect(admitted).toEqual([1, 2]);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 在原生库带 `native-wait` 时怎么驱动引擎。不再用计时器轮询：引擎说有东西可读时
 *   才 poll；要发数据时立刻 poll，不等引擎；引擎空手回来时只在它镜像的东西（准入版本）变了、或距上次 poll 满 1 秒时才 poll；
 *   等待失败时退回计时器，连接照常。
 * - Bug 依据：2026-11-20 真机，手机每个请求比 Device Link 慢 30–60 毫秒、空闲时 JS 线程占 9–22%：React Native 的计时器按屏幕帧走，
 *   请求交给引擎、取回应答各等一帧，空闲时每 50 毫秒仍要过一次桥。
 * - 现有覆盖缺口：上面的用例都是没有 `wait` 的引擎，靠推进计时器驱动。
 * - 最小失败输入：一条已建立的连接；等待先后以「没东西」「有东西」返回，中间发一次数据、改一次准入版本，最后等待失败一次。
 * - tier：unit，真实 NativeTransport/NativeChannel，引擎用替身；等待由用例手动放行。
 */
it('lets a native-wait engine wake it instead of polling on timers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const ops: string[] = [];
  const waits: Array<{ maxMs: number; resolve(work: boolean): void; reject(error: Error): void }> = [];
  let nextStream = 0, version = 1;
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      ops.push(command.op as string);
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null, features: ['native-wait'] };
      if (command.op === 'poll') value = { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false,
        unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] };
      if (command.op === 'openStream') value = ++nextStream;
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      return value as T;
    },
    wait: (maxMs) => new Promise<boolean>((resolve, reject) => { waits.push({ maxMs, resolve, reject }); }),
    async destroy() {},
  };
  const channels: PeerChannel[] = [];
  let transport: NativeTransport | undefined;
  const polls = () => ops.filter(op => op === 'poll').length;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  /** Let the engine's current wait return; the transport then issues the next one. */
  const finishWait = async (work: boolean) => { waits.shift()!.resolve(work); await settle(); };
  try {
    transport = await NativeTransport.create(engine, { admit: () => true, admissionVersion: () => version,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: channel => { channels.push(channel); } });
    await settle();
    // The new channel's first bytes go to the engine over a few polls; then it only waits.
    for (let i = 0; i < 8 && waits[0]?.maxMs === 8; i++) await finishWait(false);
    expect(channels).toHaveLength(1);
    expect(waits).toHaveLength(1);
    expect(waits[0].maxMs).toBe(250);
    // No timer polls: time passing alone does nothing.
    const idle = polls();
    await vi.advanceTimersByTimeAsync(600);
    expect(polls()).toBe(idle);
    // The engine comes back empty and nothing changed: no bridge round trip, it just waits again.
    await finishWait(false);
    expect(polls()).toBe(idle);
    expect(waits).toHaveLength(1);
    // The engine has something to read.
    await finishWait(true);
    expect(polls()).toBe(idle + 1);
    // Something to send goes to the engine at once, without the engine waking JS.
    const writes = ops.filter(op => op === 'write').length;
    channels[0].send(Uint8Array.of(1, 2, 3));
    await settle();
    expect(ops.filter(op => op === 'write').length).toBe(writes + 1);
    const afterWrite = polls();
    expect(afterWrite).toBeGreaterThan(idle + 1);
    // The wait the write superseded returns empty and is ignored; the current one decides.
    while (waits.length > 1) await finishWait(false);
    expect(polls()).toBe(afterWrite);
    // What JS mirrors into the engine changed: poll, so the engine gets the new admission.
    version = 2;
    await finishWait(false);
    expect(polls()).toBe(afterWrite + 1);
    // A second without a poll: one full poll for paths, round trips and admission that lapses with time.
    await vi.advanceTimersByTimeAsync(1_000);
    await finishWait(false);
    expect(polls()).toBe(afterWrite + 2);
    // The binary cannot wait after all: the timers take over.
    waits.shift()!.reject(new Error('AGENT_NET_COMMAND_FAILED'));
    await settle();
    const onTimers = polls();
    await vi.advanceTimersByTimeAsync(200);
    expect(polls()).toBeGreaterThan(onTimers);
    expect(waits).toHaveLength(0);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 在原生库带 `binary-io`（与 `native-wait`）时怎么驱动引擎。等待的那次 `io` 调用把引擎
 *   随后读到的东西一并带回，连接收到的就是对端发来的原始字节；等待调用在外时，要发的数据走另一次不读的 `io`（带 `kick`），同一时刻
 *   只有一次调用在读，读到的东西不会乱序；引擎只收下一部分时，剩下的字节下一轮接着发、顺序不变。
 * - Bug／规则依据：2026-11-21 真机（Redmi K40，CPU 降频时）每次异步过桥 3–4 毫秒、2 KB 回包 base64 解码 3.8 毫秒，一个应答要过三次桥
 *   （remote-and-mobile-adaptation.md，会话层方案 10.2 v2-4 的二进制桥）。两次调用同时读，流数据会乱序；部分写入若从头重发，对端收到重复字节。
 * - 现有覆盖缺口：其余用例的引擎替身都没有 `io`；真实 C ABI 的集成用例走通了整条路，但等待调用与写入同时在外的先后不受控。
 * - 最小失败输入：一条已建立的连接；等待调用在外时发 5 个字节、引擎只收 2 个；随后等待调用带回对端一条新流上的 3 个字节；最后一次等待调用失败。
 * - tier：unit，真实 NativeTransport/NativeChannel，引擎用替身，等待调用由用例手动放行；约 10 毫秒。
 */
it('reads in the call that waited and writes beside it on a binary-io engine', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const ops: string[] = [], written: number[][] = [], kicks: boolean[] = [];
  const waiting: Array<{ maxMs: number; answer(arrived?: [number, Uint8Array]): void; fail(error: Error): void }> = [];
  let nextStream = 0, accept = Infinity, readers = 0, mostReaders = 0;
  const read = (arrived?: [number, Uint8Array]) => ({
    value: { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false, unacked: false, remoteKey: remote.transportKey,
      events: arrived ? [{ kind: 'open', stream: arrived[0] }] : [], data: arrived ? [{ stream: arrived[0], len: arrived[1].length }] : [],
      rttUs: 0, sent: 0, received: 0, rotations: 0 }] },
    payload: arrived ? [arrived[1]] : [],
  });
  const answer = (taken: number[], poll: ReturnType<typeof read> | null) =>
    encodeNativeIo({ ok: true, value: { written: taken, poll: poll?.value ?? null } }, poll?.payload ?? []);
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      ops.push(command.op as string);
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null, features: ['native-wait', 'binary-io'] };
      if (command.op === 'openStream') value = ++nextStream;
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      return value as T;
    },
    wait: () => new Promise<boolean>(() => {}),
    io: (input, waitMs = 0, kick = false) => {
      const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, true);
      const header = JSON.parse(Buffer.from(input.subarray(4, 4 + length)).toString()) as { writes?: number[][]; poll: boolean };
      let offset = 4 + length;
      const taken = (header.writes ?? []).map(([, , size]) => {
        written.push([...input.subarray(offset, offset + size)]); offset += size;
        const took = Math.min(size, accept); accept = Infinity;
        return took;
      });
      if (!header.poll) { kicks.push(kick); return Promise.resolve(answer(taken, null)); }
      readers++; mostReaders = Math.max(mostReaders, readers);
      if (!waitMs) { readers--; return Promise.resolve(answer(taken, read())); }
      return new Promise<Uint8Array>((resolve, reject) => waiting.push({ maxMs: waitMs, answer: (arrived) => {
        readers--; resolve(arrived ? answer([], read(arrived)) : new Uint8Array(0));
      }, fail: (error) => { readers--; reject(error); } }));
    },
    kick: () => {},
    async destroy() {},
  };
  const channels: PeerChannel[] = [], received: number[][] = [];
  let transport: NativeTransport | undefined;
  const settle = () => vi.advanceTimersByTimeAsync(0);
  try {
    transport = await NativeTransport.create(engine, { admit: () => true, admissionVersion: () => 1,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: channel => { channels.push(channel); channel.onData(bytes => received.push([...bytes])); } });
    await settle();
    // The first turn read the established connection; then one call waits in the engine.
    expect(channels).toHaveLength(1);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].maxMs).toBe(250);
    // Something to send while that call waits: written beside it, without reading.
    accept = 2;
    channels[0].send(Uint8Array.of(1, 2, 3, 4, 5));
    await settle();
    expect(written).toEqual([[1, 2, 3, 4, 5]]);
    expect(kicks).toEqual([true]);
    expect(waiting).toHaveLength(1);
    // The waiting call comes back with the peer's bytes; the three the engine did not take follow, in order.
    waiting.shift()!.answer([9, Uint8Array.of(0x44, 7, 8, 9)]);
    await settle();
    expect(received).toEqual([[7, 8, 9]]);
    expect(written).toEqual([[1, 2, 3, 4, 5], [3, 4, 5]]);
    expect(mostReaders).toBe(1);
    expect(waiting).toHaveLength(1);
    // Nothing went through the base64 commands after the connection's first bytes.
    expect(ops.filter(op => op === 'poll' || op === 'datagram')).toEqual([]);
    expect(ops.filter(op => op === 'write')).toHaveLength(2);
    // A waiting call fails: what it read may be lost to JS, so the transport closes rather than go on with a gap.
    let closed = false;
    channels[0].onClose(() => { closed = true; });
    waiting.shift()!.fail(new Error('AGENT_NET_COMMAND_FAILED'));
    await settle();
    expect(closed).toBe(true);
    expect(waiting).toHaveLength(0);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 在原生库带 `binary-io` 时，一轮要写的条数超过原生 `io` 一次收的上限（1024 条）时
 *   分几轮写完，连接一条都不断。
 * - Bug／规则依据：PR #12036 审阅。原来一轮只按字节数限，129 条连接各排 8 条小消息就是 1032 条写入，原生拒收整帧，传输层随之关掉，
 *   所有连接一起断。
 * - 现有覆盖缺口：上面的 `binary-io` 用例只有一条连接、几次写入。
 * - 最小失败输入：130 条已建立的连接各排 8 条 1 字节的消息；引擎替身照原生的规矩拒收超过 1024 条写入的调用。
 * - tier：unit，真实 NativeTransport/NativeChannel，引擎用替身（没有 `native-wait`，按计时器驱动）；约 0.3 秒。
 */
it('splits a turn of many small writes across io calls instead of losing every connection', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native');
  const peers = Array.from({ length: 130 }, (_, index) => generateIdentity('peer-' + index));
  const hex = (key: string) => Buffer.from(key, 'base64url').toString('hex');
  const writesPerCall: number[] = [];
  let nextStream = 0, dataBytes = 0;
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null, features: ['binary-io'] };
      if (command.op === 'openStream') value = ++nextStream;
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      return value as T;
    },
    io: async (input) => {
      const length = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(0, true);
      const header = JSON.parse(Buffer.from(input.subarray(4, 4 + length)).toString()) as { writes?: number[][]; poll: boolean };
      const writes = header.writes ?? [];
      // As engine.rs `io`: a call with more than MAX_IO_WRITES is refused whole.
      if (writes.length > 1024) return encodeNativeIo({ ok: false, code: 'INVALID_NATIVE_IO' });
      writesPerCall.push(writes.length);
      dataBytes += writes.reduce((sum, [, , size]) => sum + size, 0);
      const connections = peers.map((peer, index) => ({ id: index + 1, established: true, dead: false, closedByPeer: false, unacked: false,
        remoteKey: peer.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }));
      return encodeNativeIo({ ok: true, value: { written: writes.map(([, , size]) => size), poll: header.poll ? { packets: [], connections } : null } });
    },
    async destroy() {},
  };
  const channels: PeerChannel[] = [];
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true, admissionVersion: () => 1,
      admittedPeers: () => peers.map(peer => ({ id: hex(peer.transportKey), relayId: peer.deviceId })),
      relayIdOf: (id) => peers.find(peer => hex(peer.transportKey) === id)?.deviceId, onIncoming: channel => { channels.push(channel); } });
    await vi.advanceTimersByTimeAsync(50);
    expect(channels).toHaveLength(peers.length);
    let closed = 0;
    for (const channel of channels) channel.onClose(() => { closed++; });
    writesPerCall.length = 0; dataBytes = 0;
    for (const channel of channels) for (let message = 0; message < 8; message++) channel.send(Uint8Array.of(message));
    await vi.advanceTimersByTimeAsync(200);
    expect(closed).toBe(0);
    expect(dataBytes).toBe(peers.length * 8);
    expect(Math.max(...writesPerCall)).toBeLessThanOrEqual(512);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport 把要发的字节交给原生引擎的顺序（引擎收到的命令序列）。socket 没有报告准入变化时，
 *   写入排在轮询前面；每秒一次的「按时间复查准入」到期也不拦写入；socket 报告准入变了，先把新名单交给引擎再写；
 *   对端此刻已不被准入，一个字节也不写。
 * - Bug／规则依据：2026-11-21 真机（Redmi K40，连着 7 台电脑）。引擎收到写入就发包，而请求原来要先等一次轮询往返（约 2.6 毫秒）
 *   和轮询后把每条连接过一遍（约 6 毫秒）才写；撞上每秒一次的准入复查时再多等 8–17 毫秒。线路往返只有 4 毫秒。
 *   同时「准入变化先于任何写入交给引擎」这条原有规则不能因此松动。
 * - 现有覆盖缺口：现有用例只断言「发数据后有一次写入、有一次轮询」，不看先后，也没有准入在发数据前变化的情形。
 * - 最小失败输入：一条已建立的连接，发 3 个字节；发之前分别：什么都不变、过 1.1 秒、换名单并改版本、把对端判为不准入。
 * - tier：unit，真实 NativeTransport/NativeChannel，引擎用替身，等待由用例手动放行；四行合计约 20 毫秒。
 */
it.each(['nothing changed', 'the timed recheck is due', 'the admitted peers changed', 'the peer is no longer admitted'] as const)(
  'writes before it polls unless the engine must hear of an admission change first: %s', async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const local = generateIdentity('native'), remote = generateIdentity('remote'), other = generateIdentity('other');
    const hex = (key: string) => Buffer.from(key, 'base64url').toString('hex');
    const key = hex(remote.transportKey);
    let version = 1, admitted = true, computed = 0, nextStream = 0;
    let roster = [{ id: key, relayId: remote.deviceId }];
    const ops: string[] = [], computedAtWrite: number[] = [];
    const waits: Array<{ maxMs: number; resolve(work: boolean): void }> = [];
    const engine: NativeEnginePort = {
      async command<T>(command: Record<string, unknown>): Promise<T> {
        ops.push(command.op as string);
        let value: unknown;
        if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null, features: ['native-wait'] };
        if (command.op === 'poll') value = { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false,
          unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] };
        if (command.op === 'openStream') value = ++nextStream;
        if (command.op === 'write') { computedAtWrite.push(computed); value = Buffer.from(command.data as string, 'base64url').length; }
        return value as T;
      },
      wait: (maxMs) => new Promise<boolean>((resolve) => { waits.push({ maxMs, resolve }); }),
      async destroy() {},
    };
    const channels: PeerChannel[] = [];
    let transport: NativeTransport | undefined;
    const settle = () => vi.advanceTimersByTimeAsync(0);
    try {
      transport = await NativeTransport.create(engine, { admit: (id) => admitted && roster.some(peer => peer.id === id), admissionVersion: () => version,
        admittedPeers: () => { computed += 1; return roster; }, relayIdOf: (id) => roster.find(peer => peer.id === id)?.relayId,
        onIncoming: channel => { channels.push(channel); } });
      await settle();
      // The new channel's first bytes go to the engine over a few polls; then the engine is left waiting.
      for (let i = 0; i < 8 && waits[0]?.maxMs === 8; i++) { waits.shift()!.resolve(false); await settle(); }
      expect(channels).toHaveLength(1);
      let closed = false;
      channels[0].onClose(() => { closed = true; });
      if (mode === 'the timed recheck is due') await vi.advanceTimersByTimeAsync(1_100);
      if (mode === 'the admitted peers changed') { roster = [...roster, { id: hex(other.transportKey), relayId: other.deviceId }]; version = 2; }
      if (mode === 'the peer is no longer admitted') admitted = false;
      const from = ops.length, computedBefore = computed, writesBefore = computedAtWrite.length;
      channels[0].send(Uint8Array.of(1, 2, 3));
      await settle();
      const after = ops.slice(from);
      expect(after).toContain('poll');
      if (mode === 'nothing changed' || mode === 'the timed recheck is due') {
        expect(after.indexOf('write')).toBeGreaterThanOrEqual(0);
        expect(after.indexOf('write')).toBeLessThan(after.indexOf('poll'));
        // Written before the admitted peers were worked out again.
        expect(computedAtWrite[writesBefore]).toBe(computedBefore);
        expect(closed).toBe(false);
      } else if (mode === 'the admitted peers changed') {
        expect(after.indexOf('admit')).toBeGreaterThanOrEqual(0);
        expect(after.indexOf('admit')).toBeLessThan(after.indexOf('write'));
        expect(after.indexOf('poll')).toBeLessThan(after.indexOf('write'));
        expect(closed).toBe(false);
      } else {
        expect(after).not.toContain('write');
        expect(closed).toBe(true);
      }
    } finally { await transport?.close(); vi.useRealTimers(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：手机的 NativeTransport.connect 经中转拨号。中转发了 UDP 凭据、UDP 通道还没就绪时，
 *   拨号命令等到就绪才交给引擎；一直不就绪也只等 RELAY_UDP_DIAL_WAIT_MS；中转没发凭据时不等。
 * - Bug／规则依据：2026-11-21 真机，手机每次启动、每次重连的第一批拨号在 UDP 通道就绪前经 WebSocket 发出握手，
 *   收不到回应，等核心 200 毫秒后重发，拨号 230–240 毫秒；通道就绪后发出的同一个握手 30–45 毫秒就有回应。
 * - 现有覆盖缺口：现有用例的引擎替身没有 UDP 端口，也没有中转凭据，走不到中转 UDP 这段。
 * - 最小失败输入：一个带 `relay-udp-v2` 的引擎替身、一份中转凭据、一次经中转的拨号，以及就绪／不就绪／没有凭据三种情况。
 * - tier：unit，引擎用替身，计时器用替身推进；三行合计约 30 毫秒。 */
it.each(['comes up', 'never comes up', 'was not offered', 'was up for the previous credentials'] as const)(
  'holds a relay dial while the relay UDP path is coming up: the path %s', async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const local = generateIdentity('native'), remote = generateIdentity('remote');
    const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
    const ops: string[] = [];
    let up = false, nextStream = 0;
    const engine: NativeEnginePort = {
      async command<T>(command: Record<string, unknown>): Promise<T> {
        ops.push(command.op as string);
        let value: unknown;
        if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: 40000, features: ['relay-udp-v2'] };
        if (command.op === 'poll') value = { packets: [], relayUdp: up, connections: ops.includes('connect') ? [{ id: 7, established: true, dead: false,
          closedByPeer: false, unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] : [] };
        if (command.op === 'connect') value = 7;
        if (command.op === 'openStream') value = ++nextStream;
        return value as T;
      }, async destroy() {},
    };
    let credentials = mode === 'was not offered' ? null : { session: Uint8Array.of(1), key: Uint8Array.of(2) };
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, send() {}, onDatagram() {}, close() {} });
    let transport: NativeTransport | undefined;
    try {
      transport = await NativeTransport.create(engine, { admit: () => true, admittedPeers: () => [{ id: key, relayId: remote.deviceId }],
        relayIdOf: () => remote.deviceId, onIncoming: () => undefined,
        relay: { deviceId: local.deviceId, uplink: uplink as never, udpCredentials: () => credentials as never }, relayUdpServer: 'relay.example.test:3478' }, undefined, true);
      if (mode === 'was up for the previous credentials') {
        // The relay reconnected after its UDP path had been up for a while: new credentials, whose path is not up yet.
        up = true;
        await vi.advanceTimersByTimeAsync(1_100);
        credentials = { session: Uint8Array.of(3), key: Uint8Array.of(4) };
        up = false;
      }
      const dial = transport.connect({ id: key, dial: { relayId: remote.deviceId } });
      await vi.advanceTimersByTimeAsync(20);
      // The engine has the credentials; the dial itself has not gone to it unless there was nothing to wait for.
      if (mode !== 'was not offered') expect(ops.includes('relayUdp')).toBe(true);
      expect(ops.includes('connect')).toBe(mode === 'was not offered');
      if (mode === 'comes up' || mode === 'was up for the previous credentials') { up = true; await vi.advanceTimersByTimeAsync(60); }
      else await vi.advanceTimersByTimeAsync(190);
      expect(ops.includes('connect')).toBe(true);
      await vi.advanceTimersByTimeAsync(60);
      await expect(dial).resolves.toBeDefined();
    } finally { await transport?.close(); vi.useRealTimers(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：手机 `NativeTransport.connect` 自定义 `timeoutMs` 与 `NativeChannel.directAddress` / `onPathChange`。
 *   ① 记忆的局域网候选拨号按传入的 `timeoutMs`（350 ms）超时结束，不等满默认 3 秒；
 *   ② 连接先经中转建立、随后打洞切到 UDP 直连时，触发 `onPathChange('direct')` 并返回验证后的 `{ address, port }`。
 * - Bug／规则依据：手机前台快恢复要求失效记忆地址在 350 ms 内回退中转，且打洞成功后必须记录直连地址供下次前台恢复复用。
 * - 现有覆盖缺口：已有测试只覆盖默认 3 秒拨号超时与初次建立路径，未覆盖自定义短预算与运行中路径切换通知。
 * - 最小失败输入：1 次带 `timeoutMs: 350` 的未完成 UDP 拨号 + 1 条由 `{ link: 1 }` 切到 `{ address, port }` 的连接。
 * - tier：unit，内存引擎桩 + 假计时器；约 15 毫秒。 */
it('honors a custom dial timeoutMs budget and reports directAddress updates when a channel switches paths', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native-fast'), remote = generateIdentity('remote-fast');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  let mode: 'stall' | 'relay' | 'direct' = 'stall';
  let nextStream = 0;
  const closedIds: number[] = [];
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      if (command.op === 'identity') return { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: 40000 } as T;
      if (command.op === 'connect') return (mode === 'stall' ? 11 : 12) as T;
      if (command.op === 'openStream') return (++nextStream) as T;
      if (command.op === 'close') { closedIds.push(command.id as number); return true as T; }
      if (command.op === 'poll') {
        if (mode === 'stall') {
          return { packets: [], connections: [{ id: 11, established: false, dead: false, closedByPeer: false, unacked: true,
            remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] } as T;
        }
        return { packets: [], connections: [{ id: 12, established: true, dead: false, closedByPeer: false, unacked: false,
          remoteKey: remote.transportKey, path: mode === 'relay' ? { link: 1 } : { address: '192.168.1.10', port: 41000 },
          events: [], data: [], rttUs: 2000, sent: 1, received: 1, rotations: 0 }] } as T;
      }
      return true as T;
    },
    async destroy() {},
  };
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, {
      admit: () => true,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }],
      relayIdOf: () => remote.deviceId,
      onIncoming: () => undefined,
    }, undefined, true);
    const fastDial = transport.connect({ id: key, dial: { relayId: remote.deviceId, udp: { address: '192.168.1.20', port: 42000 }, preferUdp: true, timeoutMs: 350 } });
    const rejected = fastDial.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(200);
    expect(closedIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await rejected).toMatchObject({ message: 'NATIVE_CONNECT_TIMEOUT' });
    expect(closedIds).toContain(11);

    mode = 'relay';
    const connected = transport.connect({ id: key, dial: { relayId: remote.deviceId } });
    await vi.advanceTimersByTimeAsync(20);
    const channel = await connected;
    const paths: Array<'direct' | 'relay' | null> = [];
    channel.onPathChange!(path => paths.push(path));
    expect(channel.path!()).toBe('relay');
    expect(channel.directAddress!()).toBeNull();

    mode = 'direct';
    await vi.advanceTimersByTimeAsync(20);
    expect(paths).toEqual(['direct']);
    expect(channel.path!()).toBe('direct');
    expect(channel.directAddress!()).toEqual({ address: '192.168.1.10', port: 41000 });
  } finally {
    await transport?.close();
    vi.useRealTimers();
  }
});

/** 测试价值（会话 v2 在手机上）
 * - 生产入口与可观察结果：手机 NativeChannel 的会话 v2 流（`sessionWire().openBody` / `onBody`），引擎收到的命令。一条大消息开一条
 *   自己的流，先写 0x33 和键，写完就结束；调用方放弃时这里排着的不再写，流随即结束（`abandon`，连已经交给核心、还没发出的
 *   也不发），已经结束的流补一个 `abandon`；引擎暂时开不出流
 *   （`STREAM_LIMIT`）时这条连接照常，下一轮再开。还没交给引擎的字节算在会话积压里。对端的流：键分在两片里到也认得出，
 *   流结束时报 `null`。引擎没有 `probe-grants`（核心回探测只带两条流的额度）时不用正文流，照 v1 走通道。
 * - Bug／规则依据：docs/agent-net-session-plan.md 第 7 节 v2-2；开流失败原来会关掉整条连接（plan 里的异常）；2026-11-22 CI：
 *   没有 `probe-grants` 的核心上正文流（第 6 条流）停在 128 个分片。
 * - 现有覆盖缺口：原生集成测试只走正常写完的流，不覆盖放弃、开流失败和分片的键。
 * - 最小失败输入：200 KB 的消息写完；写之前就放弃；结束后再放弃；第一次开流报 `STREAM_LIMIT`；
 *   对端一条流的头五个字节分成 3 + 2 到达；本端没宣告 v2 时对端开正文流（同旧节点，关连接）；本端会话还没挂上时对端开 200 条
 *   只有键和结束的流，再来一条正好让「字节 + 每个事件 64」超过 16 MiB 的（审查 #12063：结束事件原来不计，可以无限堆）；
 *   引擎只少 `probe-grants` 时开正文流。
 * - tier：unit，真实 NativeTransport/NativeChannel，引擎用替身，假计时器。 */
it.each(['finish', 'abandon-first', 'abandon-after-end', 'stream-limit', 'undeclared', 'early-budget', 'without-probe-grants'] as const)(
  'opens, ends and gives up session v2 body streams on the native engine: %s', async mode => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const ops: Array<{ op: string; stream?: number }> = [], written = new Map<number, Buffer[]>();
  let nextStream = 0, limited = mode === 'stream-limit';
  let inbound: { events: unknown[]; data: Array<{ stream: number; data: string }> } = { events: [{ kind: 'open', stream: 71 }],
    data: [{ stream: 71, data: Buffer.from([0x43, ...Buffer.from(JSON.stringify({ session: ['agent-net-session-v1', 'agent-net-session-v2'] }) + '\n')]).toString('base64url') }] };
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      ops.push({ op: command.op as string, stream: command.stream as number | undefined });
      let value: unknown;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null,
        features: ['stream-levels', 'stream-retired', ...(mode === 'without-probe-grants' ? [] : ['probe-grants'])] };
      if (command.op === 'poll') {
        value = { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false, unacked: false,
          remoteKey: remote.transportKey, ...inbound, rttUs: 0, sent: 0, received: 0, rotations: 0 }] };
        inbound = { events: [], data: [] };
      }
      if (command.op === 'openStream') {
        // Data, control, then the control and normal lanes; the fifth open is the body's (the background lane's comes after).
        if (limited && nextStream === 4) { limited = false; throw new Error('STREAM_LIMIT'); }
        value = ++nextStream;
      }
      if (command.op === 'write') {
        const bytes = Buffer.from(command.data as string, 'base64url');
        written.set(command.stream as number, [...(written.get(command.stream as number) ?? []), bytes]);
        value = bytes.length;
      }
      if (command.op === 'abandon') value = 0;
      return value as T;
    }, async destroy() {},
  };
  const channels: PeerChannel[] = [];
  let transport: NativeTransport | undefined;
  try {
    transport = await NativeTransport.create(engine, { admit: () => true,
      admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
      onIncoming: channel => { channels.push(channel); } });
    await vi.advanceTimersByTimeAsync(100);
    const channel = channels[0], wire = channel.sessionWire!()!;
    expect(channel.sessionBodies).toBe(mode !== 'without-probe-grants');
    const peerBody = (stream: number, key: number, bytes: Buffer = Buffer.alloc(0)) => [{ stream, data: Buffer.concat([Buffer.from([0x33]),
      Buffer.from(Uint32Array.of(key).buffer).reverse(), bytes]).toString('base64url') }];
    if (mode === 'undeclared') {
      inbound = { events: [{ kind: 'open', stream: 72 }], data: peerBody(72, 9, Buffer.from('{}')) };
      await vi.advanceTimersByTimeAsync(20);
      expect(ops.filter(op => op.op === 'close')).toHaveLength(1);
      return;
    }
    if (mode === 'without-probe-grants') {
      expect(wire.openBody!('normal', 1)).toBeNull();
      return;
    }
    channel.declareSessions!(['agent-net-session-v2']);
    if (mode === 'early-budget') {
      for (let round = 0; round < 2; round++) {
        const streams = Array.from({ length: 100 }, (_, index) => 100 + round * 100 + index);
        inbound = { events: [...streams.map(stream => ({ kind: 'open', stream })), ...streams.map(stream => ({ kind: 'finish', stream }))],
          data: streams.flatMap(stream => peerBody(stream, stream)) };
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(ops.filter(op => op.op === 'close')).toEqual([]);
      inbound = { events: [{ kind: 'open', stream: 300 }], data: peerBody(300, 300, Buffer.alloc(16 * 1024 * 1024 - 201 * 64 + 1)) };
      await vi.advanceTimersByTimeAsync(20);
      expect(ops.filter(op => op.op === 'close')).toHaveLength(1);
      return;
    }
    const received: Array<[number, string | null]> = [];
    wire.onData(() => {});
    wire.onBody!((bodyKey, bytes) => { received.push([bodyKey, bytes && Buffer.from(bytes).toString()]); });
    const content = Buffer.alloc(200_000, 0x61);
    const body = wire.openBody!('normal', 0x01020304)!;
    if (mode === 'abandon-first') body.abandon();
    body.write(new Uint8Array(content));
    body.finish();
    // Counted in the session's backlog until the engine took it (this stand-in reports nothing left in the core).
    if (mode !== 'abandon-first') expect(wire.bufferedAmount).toBeGreaterThanOrEqual(content.length);
    await vi.advanceTimersByTimeAsync(100);
    expect(wire.bufferedAmount).toBe(0);
    const opened = ops.filter(op => op.op === 'openStream').length;
    const stream = [...written].find(([, chunks]) => chunks[0][0] === 0x33)?.[0];
    const ends = () => ops.filter(op => op.op === 'finish' || op.op === 'abandon').map(op => [op.op, op.stream]);
    expect(ops.filter(op => op.op === 'close')).toEqual([]);
    if (mode === 'abandon-first') {
      // Given up before its stream opened: nothing of it reaches the engine.
      expect(stream).toBeUndefined();
      expect(ends()).toEqual([]);
      expect(opened).toBe(5);
    } else {
      expect(Buffer.concat(written.get(stream!)!)).toEqual(Buffer.concat([Buffer.from([0x33, 1, 2, 3, 4]), content]));
      expect(ends()).toEqual([['finish', stream]]);
      // Data, control, three lanes, the body's refused open, then its open on the next turn.
      expect(opened).toBe(mode === 'stream-limit' ? 7 : 6);
    }
    if (mode === 'abandon-after-end') {
      body.abandon();
      await vi.advanceTimersByTimeAsync(100);
      expect(ends()).toEqual([['finish', stream], ['abandon', stream]]);
    }
    // The peer's body stream, its kind and key split over two chunks.
    inbound = { events: [{ kind: 'open', stream: 72 }], data: [{ stream: 72, data: Buffer.from([0x33, 0, 0]).toString('base64url') },
      { stream: 72, data: Buffer.from([0, 9, 0x7b, 0x7d]).toString('base64url') }] };
    await vi.advanceTimersByTimeAsync(20);
    inbound = { events: [{ kind: 'finish', stream: 72 }], data: [] };
    await vi.advanceTimersByTimeAsync(20);
    expect(received).toEqual([[9, '{}'], [9, null]]);
  } finally { await transport?.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：电脑端改用原生引擎后，远程连接页读 `relayRoute()`（经中转的数据报走 UDP 还是 WebSocket、往返、为什么停用
 *   UDP），会话超时经 `relayStalled()` 交给引擎判断中转 UDP 是否只通登记，UDP 流量表读 `udpTraffic` 计数。
 * - Bug 依据：2026-11-23 迁移前审计，NativeTransport 没有 `relayRoute`/`relayStalled`，引擎也不报 UDP 字节：电脑端会显示走
 *   WebSocket（实际走 UDP）、请求超时不再触发退回、UDP 流量一直为 0。
 * - 现有覆盖缺口：手机端从不读这三项；Rust 单测（udp_paths.rs tests）只覆盖引擎内的判断，不覆盖 JS 怎么读、怎么报。
 * - 最小失败输入：引擎报 `relayRoute` 与 `udpTraffic` 的一次 poll；一次 `relayStalled()`；没有 `relay-udp-health` 的旧引擎。
 *   tier：unit，引擎用替身。
 */
it.each([true, false])('reports the relay route, request timeouts and UDP traffic from an engine with relay-udp-health: %s', async (health) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native');
  const ops: string[] = [];
  const credentials = { session: new Uint8Array(8), key: new Uint8Array(32) };
  let route: unknown = { via: 'udp', rttMs: 37 };
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      ops.push(command.op as string);
      let value: unknown = null;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: 4000,
        features: ['stun', 'relay-udp-v2', ...(health ? ['relay-udp-health'] : [])] };
      if (command.op === 'poll') value = { packets: [], connections: [], relayUdp: (route as { via: string }).via === 'udp',
        ...(health ? { relayRoute: route, udpTraffic: [1_234, 5_678] } : {}) };
      return value as T;
    }, async destroy() {},
  };
  const udpTraffic = new BigUint64Array(2);
  const transport = await NativeTransport.create(engine, { admit: () => true, admittedPeers: () => [], onIncoming: () => undefined,
    relayUdpServer: '127.0.0.1:9', udpTraffic,
    relay: { deviceId: local.deviceId, udpCredentials: () => credentials,
      uplink: { kind: 'agent-net', send: () => undefined, onDatagram: () => undefined, close: () => undefined } } });
  try {
    await vi.advanceTimersByTimeAsync(1_100);
    expect(transport.relayRoute()).toEqual({ via: 'udp', rttMs: health ? 37 : null });
    expect(Array.from(udpTraffic, Number)).toEqual(health ? [1_234, 5_678] : [0, 0]);
    transport.relayStalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(ops.includes('relayStalled')).toBe(health);
    route = { via: 'websocket', rttMs: null, udpSuspension: { reason: 'request-timeouts', cooldownMs: 30_000 } };
    await vi.advanceTimersByTimeAsync(1_100);
    expect(transport.relayRoute()).toEqual(health
      ? { via: 'websocket', rttMs: null, udpSuspension: { reason: 'request-timeouts', cooldownMs: 30_000 } }
      : { via: 'websocket', rttMs: null });
  } finally { await transport.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：NativeTransport 的连接在引擎收走排队字节时调 `onDrain`；PortableSocket 据此在整体积压回落到 128 KB
 *   以下时发 drain，电脑端 Main 的 Device Link 马上发下一大帧（worker.ts `reportBuffered`）。
 * - Bug 依据：2026-11-23 迁移前审计：原生连接只在自己的积压从 128 KB 以上落到以下时才调；几条连接各自不到 128 KB、加起来超过时，
 *   哪条都不会越线，socket 一直不发 drain，Main 要等每秒一次的状态快照。WASM 连接在核心每次收走字节时都调。
 * - 现有覆盖缺口：portableSocket.test.ts 用替身连接测 socket 的判断，不测原生连接什么时候调。
 * - 最小失败输入：一条连接排了 100 KB（低于水位），引擎全部收下。tier：unit，引擎用替身。
 */
it('tells the socket whenever the engine takes queued bytes, also from a connection below the low watermark', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const local = generateIdentity('native'), remote = generateIdentity('remote');
  const key = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  let nextStream = 0;
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      let value: unknown = null;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: null };
      if (command.op === 'poll') value = { packets: [], connections: [{ id: 1, established: true, dead: false, closedByPeer: false,
        unacked: false, remoteKey: remote.transportKey, events: [], data: [], rttUs: 0, sent: 0, received: 0, rotations: 0 }] };
      if (command.op === 'openStream') value = ++nextStream;
      if (command.op === 'write') value = Buffer.from(command.data as string, 'base64url').length;
      return value as T;
    }, async destroy() {},
  };
  const channels: PeerChannel[] = [];
  const transport = await NativeTransport.create(engine, { admit: () => true,
    admittedPeers: () => [{ id: key, relayId: remote.deviceId }], relayIdOf: () => remote.deviceId,
    onIncoming: channel => { channels.push(channel); } });
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(channels).toHaveLength(1);
    const drained = vi.fn();
    channels[0].onDrain!(drained);
    channels[0].send(new Uint8Array(100_000));
    await vi.advanceTimersByTimeAsync(100);
    expect(channels[0].bufferedAmount).toBe(0);
    expect(drained).toHaveBeenCalled();
  } finally { await transport.close(); vi.useRealTimers(); }
});

/** 测试价值
 * - 生产入口与可观察结果：电脑端原生引擎的 NativeTransport 把 STUN 与中转 UDP 的 `host:port` 先经 `resolveUdpServer` 解析再交给引擎
 *   （`stun`、`relayUdp` 命令里的地址），换网后重新解析，地址变了就让引擎改到新地址。
 * - Bug 依据：#12175（2026-11-22）给 WASM 传输加了透明代理 Fake-IP（198.18.0.0/15）避让：往 Fake-IP 发 STUN 和中转 UDP 会走代理的分流，
 *   端口和真实 IP 不同，对端端口受限时永远打不通。原生引擎自己用系统 DNS 解析，电脑改跑原生引擎后会回到这个问题。
 * - 现有覆盖缺口：stun.ts 的单测只测解析函数本身；没有测原生传输把解析结果交给引擎、并在换网后更新。
 * - 最小失败输入：中转 UDP 主机名解析成一个地址；换网后解析成另一个。tier：unit，引擎用替身。
 */
it('hands the engine the STUN and relay UDP addresses resolveUdpServer gives, and the new one after a network change', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const local = generateIdentity('native');
  const commands: Record<string, unknown>[] = [];
  const engine: NativeEnginePort = {
    async command<T>(command: Record<string, unknown>): Promise<T> {
      commands.push(command);
      let value: unknown = null;
      if (command.op === 'identity') value = { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: 4000, features: ['stun', 'relay-udp-v2'] };
      if (command.op === 'poll') value = { packets: [], connections: [], relayUdp: false };
      return value as T;
    }, async destroy() {},
  };
  let answer = '203.0.113.9';
  const transport = await NativeTransport.create(engine, { admit: () => true, admittedPeers: () => [], onIncoming: () => undefined,
    relayUdpServer: 'relay.example:3478', stunServers: ['relay.example:3478'],
    resolveUdpServer: async (server) => server.replace('relay.example', answer),
    relay: { deviceId: local.deviceId, udpCredentials: () => ({ session: new Uint8Array(8), key: new Uint8Array(32) }),
      uplink: { kind: 'agent-net', send: () => undefined, onDatagram: () => undefined, close: () => undefined } } });
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(commands.filter(c => c.op === 'stun').at(-1)).toMatchObject({ servers: ['203.0.113.9:3478'] });
    expect(commands.filter(c => c.op === 'relayUdp').at(-1)).toMatchObject({ server: '203.0.113.9:3478' });
    answer = '198.51.100.7';
    transport.networkChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(commands.filter(c => c.op === 'stun').at(-1)).toMatchObject({ servers: ['198.51.100.7:3478'] });
    expect(commands.filter(c => c.op === 'relayUdp').at(-1)).toMatchObject({ server: '198.51.100.7:3478' });
  } finally { await transport.close(); vi.useRealTimers(); }
});
