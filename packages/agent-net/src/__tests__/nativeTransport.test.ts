import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, issueCertificate, verifyCertificate } from '@cindy/agent-net-relay';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { AgentNetSocket } from '../portableSocket.js';
import { NativeTransport, type NativeEnginePort } from '../nativeTransport.js';
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
