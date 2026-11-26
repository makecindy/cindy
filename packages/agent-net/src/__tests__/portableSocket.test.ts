/** Production entry: PortableSocket.openWithBindings/dial with injected I/O.
 * Agent-Net recovery rule: a stale LAN candidate must not strand an authorized
 * peer while its relay is healthy. The encrypted network integration covers
 * working addresses, not a deterministic first-handshake failure. Minimal input:
 * one signed peer, one discovered address, and one failed UDP connection attempt.
 * Unit tier: real socket routing and certificates, in-memory transport only.
 */
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createPrivateNetwork, generateIdentity, issueCertificate, verifyCertificate } from '@cindy/agent-net-relay';
import type { DeviceView } from '@cindy/agent-net-protocol';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { DeviceLinkClient, SERVER_CAPABILITY_NOTIFY } from '@cindy/device-link';
import { AgentNetSocket } from '../portableSocket.js';
import { SessionLanes } from '../session/lanes.js';
import { AGENT_NET_SESSION_V2, type PeerChannel, type RosterEntry, type TransportOptions } from '../types.js';

// A simultaneous dial can replace an admitted channel while its first link-open
// is still in flight. Exercise real frame admission, routing and reply handling;
// an already-established-channel test cannot expose this controlled ordering.
it.each(['before', 'in-flight', 'revoked', 'rotated', 'stale-presence', 'replacement-closed', 'guest-restart', 'preferred-inbound-restart'] as const)(
  'handles %s frames during simultaneous-dial channel replacement', async mode => {
    const sameDirection = mode === 'guest-restart' || mode === 'preferred-inbound-restart';
    const local = generateIdentity(mode === 'preferred-inbound-restart' ? 'z-host' : 'a-host'), remote = generateIdentity('b-controller');
    const { root, bootstrap } = createPrivateNetwork('Channel handover', local);
    const member = (identity: typeof remote): DeviceView => ({
      certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }),
      name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [],
    });
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [member(remote)], delegations: [],
      send() {}, presence() {}, onDatagram() {}, close() {} });
    const makeChannel = () => {
      let receive!: (bytes: Uint8Array) => void;
      let finish: () => void = () => undefined;
      const sent: Array<{ kind: string; id?: string }> = [];
      const channel: PeerChannel = {
        remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'),
        send(bytes) { sent.push(JSON.parse(Buffer.from(bytes).subarray(4).toString())); },
        onData(handler) { receive = handler; }, onClose(handler) { finish = handler; },
        // A graceful core close drains already-written bytes; they may arrive
        // after the replacement is admitted. No artificial delay or retry.
        close() {}, path: () => 'relay',
      };
      return { channel, sent, finish() { finish(); }, deliver(frame: object) {
        const body = Buffer.from(JSON.stringify(frame)), header = Buffer.alloc(4); header.writeUInt32BE(body.length);
        receive(Buffer.concat([header, body]));
      } };
    };
    const old = makeChannel(), preferred = makeChannel();
    let transport!: TransportOptions;
    const socket = await AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey,
        certificate: bootstrap.ownerCertificate, identity: local, connect: async () => uplink },
      userId: bootstrap.ownerCertificate.subject,
      bindings: { verifyCertificate, createTransport: async options => {
        transport = options;
        return { id: 'local', dial: {}, connect: async () => preferred.channel, close: async () => undefined };
      } },
    });
    const received: string[] = [];
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); received.push(frame.kind);
      if (frame.kind === 'link-open') socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'link-accept',
        id: frame.id, dst: frame.src, payload: { appVersion: 'test', allowlistHash: 'test' } }));
    });
    const request = { v: PROTOCOL_VERSION, kind: 'link-open', id: 'in-flight-open', dst: local.deviceId, payload: {} };
    try {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
        deviceName: 'Host', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false,
      } }));
      // The preferred outgoing handshake is already in progress when the
      // incoming nonpreferred connection is admitted first.
      const preferredDial = sameDirection ? undefined : socket.dial(remote.deviceId);
      transport.onIncoming(old.channel);
      if (mode === 'before') old.deliver(request);
      if (sameDirection) transport.onIncoming(preferred.channel);
      await preferredDial;
      received.length = 0;
      if (mode === 'revoked') { uplink.devices = []; uplink.emit('directory'); }
      if (mode === 'rotated') { uplink.devices = [member(generateIdentity(remote.deviceId))]; uplink.emit('directory'); }
      if (mode === 'replacement-closed') preferred.finish();
      if (mode === 'stale-presence') old.deliver({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: { online: true } });
      else if (mode !== 'before') old.deliver(request);
      if (sameDirection) {
        // A late old close cannot delete the replacement; new RPCs and the
        // already-written old request both get replies on the selected channel.
        old.finish();
        preferred.deliver({ ...request, id: 'restarted-open' });
        expect(preferred.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: 'restarted-open' }));
        expect(preferred.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: request.id }));
      }
      else if (mode === 'before') expect(old.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: request.id }));
      else if (mode === 'in-flight') expect(preferred.sent).toContainEqual(expect.objectContaining({ kind: 'link-accept', id: request.id }));
      else {
        expect(received).not.toContain(mode === 'stale-presence' ? 'presence-changed' : 'link-open');
        expect(preferred.sent.some(frame => frame.kind === 'link-accept')).toBe(false);
      }
    } finally { socket.close(); }
  });

// Mixed-version protocol, unit: real signed roster and length-prefixed peer
// frames through openWithBindings/dial. Existing recovery tests sent no peer
// presence; an old frame must not overwrite the App learned from the directory.
it('fills a legacy online presence from the directory and publishes later App updates', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('App routing', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Friend Mac', app: 'cindy-friend', online: false,
    remoteControlEnabled: false, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  let receive!: (bytes: Uint8Array) => void;
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send() {},
    onData(callback) { receive = callback; }, onClose() {}, close() {}, path: () => 'relay' };
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate,
      identity: local, connect: async () => uplink }, userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect: async () => channel, close: async () => undefined }) },
  });
  const delivered: Array<{ kind: string; payload?: { deviceId?: string; online?: boolean; app?: string } }> = [];
  socket.on('message', message => delivered.push(JSON.parse(message.toString())));
  const legacyPresence = () => {
    const body = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-changed', payload: {
      deviceName: 'Friend Mac', platform: 'darwin', online: true, remoteControlEnabled: false, busy: false, lastSeenAt: 1,
    } }));
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    receive(Buffer.concat([header, body]));
  };
  const lastPresence = () => delivered.filter(frame => frame.kind === 'presence-changed' && frame.payload?.online).at(-1)?.payload;
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: {
      deviceName: 'Local', platform: 'test', app: 'cindy', appVersion: '1', remoteControlEnabled: true, busy: false,
    } }));
    await socket.dial(remote.deviceId);
    legacyPresence();
    expect(lastPresence()).toMatchObject({ deviceId: remote.deviceId, online: true, app: 'cindy-friend' });
    uplink.devices = [{ ...device, app: 'future-app' }]; uplink.emit('directory');
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
    legacyPresence();
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
    uplink.devices = [{ ...device, app: undefined }]; uplink.emit('directory');
    legacyPresence();
    expect(lastPresence()).toMatchObject({ app: 'future-app' });
  } finally { socket.close(); }
});

it('retires a failed LAN candidate and retries only that peer through the relay', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Unit network', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  let disconnected: () => void = () => undefined;
  const send = vi.fn();
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send,
    onData() {}, onClose(callback) { disconnected = callback; }, close() {}, path: () => 'relay' };
  const connect = vi.fn(async (entry: RosterEntry) => {
    if ((entry.dial as { preferUdp?: boolean }).preferUdp) throw new Error('handshake timed out');
    return channel;
  });
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: {
      verifyCertificate,
      createTransport: async () => ({ id: 'local', dial: { udp: { port: 1 } }, connect, close: async () => undefined }),
      createDiscovery: options => ({ start() { options.onCandidate('remote', { address: '127.0.0.1', port: 1 }); }, close() {} }),
    },
  });
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.waitFor(() => expect(socket.supports('remote')).toBe(true));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0][0].dial).toMatchObject({ preferUdp: true });
    expect(connect.mock.calls[1][0].dial).toEqual({ relayId: 'remote' });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'remote', payload: { channel: 'test:echo', args: ['relay recovered'] } }));
    expect(send.mock.calls.some(([bytes]) => Buffer.from(bytes).subarray(4).toString().includes('relay recovered'))).toBe(true);
    disconnected();
    await socket.dial('remote');
    expect(connect.mock.calls[2][0].dial).toEqual({ relayId: 'remote' });
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 和本账号一台设备的连接断了、目录里它还在线：负责拨号的一端（设备号小的）过一会儿自己再拨，
 *   连接回来，不等下一次调用或目录更新。
 * - Bug 依据：2026-11-17 审查，连接断开（路径丢了、NAT 换了映射）以后只有下一次调用、目录更新才会再拨；这期间对方显示离线，
 *   「仅使用 Agent-Net」时空闲的账号可以一直这样。
 * - 最小失败输入：目录里在线的一台设备，连上后连接断开。tier：unit，假定时器推进重拨的等待。 */
// A failed first handshake has no channel to emit a close event. Exercise both recovery entries.
it.each(['initial failure', 'fresh directory', 'channel close'])('redials an online device after %s', async failure => {
  const local = generateIdentity('a-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Redial after drop', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    probeRelay: vi.fn(), send() {}, presence() {}, onDatagram() {}, close() {} });
  const remoteId = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const drops: Array<() => void> = [];
  const connect = vi.fn(async (): Promise<PeerChannel> => ({ remoteId, send() {}, onData() {}, onClose(callback) { drops.push(callback); },
    close() {}, path: () => 'relay' }));
  if (failure !== 'channel close') connect.mockRejectedValueOnce(new Error('handshake timed out'));
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect, close: async () => undefined }) },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledOnce();
    expect(uplink.probeRelay).toHaveBeenCalledTimes(failure === 'channel close' ? 0 : 1);
    if (failure === 'channel close') drops[0]();
    expect(socket.pathTo('b-remote')).toBeNull();
    if (failure === 'fresh directory') uplink.emit('directory');
    await vi.advanceTimersByTimeAsync(700);
    expect(connect).toHaveBeenCalledTimes(failure === 'fresh directory' ? 2 : 1);
    await vi.advanceTimersByTimeAsync(600);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(socket.pathTo('b-remote')).toBe('relay');
  } finally { vi.useRealTimers(); socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket.openWithBindings 到业务层第一条 hello（Desktop worker、Node Host 与手机共用）。
 *   刚打开的一方不等任何计时器就拨目录里在线的设备，不论设备号大小；打开时中转连不上的，等第一份实时目录到了再拨；
 *   这一轮拨完以后恢复「设备号小的先拨」。
 * - Bug／规则依据：2026-11-21 真机（Redmi K40，设备号比账号下七台电脑都大）：冷启动、后台超过 10 秒回前台，每次都要等满
 *   LATE_DIAL_MS（0.8 到 1.2 秒）才自己拨，期间七台电脑没有一台拨进来（它们还抱着上一个进程的连接）；设备号小的手机不用等。
 * - 现有覆盖缺口：上一条覆盖已经开着的一方；没有「刚打开」这一轮，也没有打开时中转不通的情形。
 * - 最小失败输入：一台在线、设备号更小的同账号设备；打开时中转可用或不可用。
 * - tier：unit，真实路由与证书，内存传输，计时器用替身（不推进）；两行合计约 30 毫秒。 */
it.each([['the relay is there', true], ['the relay comes back later', false]] as const)(
  'dials every online device at once after opening, whatever the ids, when %s', async (_name, relayUp) => {
    const local = generateIdentity('z-local'), remote = generateIdentity('b-remote'), later = generateIdentity('c-later');
    const { root, bootstrap } = createPrivateNetwork('Arrival dial', local);
    const view = (identity: typeof remote, online: boolean): DeviceView => ({
      certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }),
      name: identity.deviceId, online, remoteControlEnabled: true, capabilities: [] });
    const device = view(remote, true), second = view(later, false);
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device, second], delegations: [],
      send() {}, presence() {}, onDatagram() {}, close() {} });
    const keyOf = (identity: typeof remote) => Buffer.from(identity.transportKey, 'base64url').toString('hex');
    const connect = vi.fn(async (entry: RosterEntry): Promise<PeerChannel> => ({ remoteId: entry.id, send() {}, onData() {}, onClose() {}, close() {}, path: () => 'relay' }));
    let attempts = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = await AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
        connect: async () => { if (!relayUp && attempts++ === 0) throw new Error('offline'); return uplink; } },
      userId: bootstrap.ownerCertificate.subject, cachedDirectory: [device, second], directoryExpiresAt: Date.now() + 60_000,
      bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect, close: async () => undefined }) },
    });
    try {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
      if (!relayUp) {
        // The cached directory says nothing about who is online now: nothing to dial until the relay answers.
        expect(connect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(connect.mock.calls.map(([entry]) => entry.id)).toEqual([keyOf(remote)]);
      expect(socket.pathTo('b-remote')).toBe('relay');
      // Past that first round a device that comes online is the one that dials (the lower id); this side only if it does not.
      uplink.devices = [device, { ...second, online: true }];
      uplink.emit('directory');
      await vi.advanceTimersByTimeAsync(700);
      expect(connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      expect(connect.mock.calls.map(([entry]) => entry.id)).toEqual([keyOf(remote), keyOf(later)]);
    } finally { vi.useRealTimers(); socket.close(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket.openWithBindings 接中转数据包的入口。传输层建好之前中转送来的包，建好后原样交给传输层，
 *   最多留 EARLY_DATAGRAMS 个；建好以后的包直接交。
 * - Bug／规则依据：中转在本机连上的那一刻就向其它设备通告本机上线（`agent-net-relay` 的 `announce`），按通告拨过来的设备，
 *   第一个握手包在传输层建好之前（手机上约 50 毫秒）就到了。原来这个包被丢掉，对方要等核心 200 毫秒后重发；
 *   刚打开的一方现在自己也立刻拨，留下这个包两边才在第一个来回就落到同一条连接上。
 * - 现有覆盖缺口：集成测试两端几乎同时打开，没有「一端的包先到、传输层后建好」的顺序。
 * - 最小失败输入：传输层建好之前到的 40 个包，建好之后到的 1 个包。
 * - tier：unit，内存传输，无计时器；约 10 毫秒。 */
it('hands the transport the datagrams that arrived before it existed', async () => {
  const local = generateIdentity('z-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Early datagrams', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  let fromRelay: (id: string, data: Uint8Array) => void = () => undefined;
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const,
    devices: [{ certificate, name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [] } as DeviceView], delegations: [],
    send() {}, presence() {}, onDatagram(handler: typeof fromRelay) { fromRelay = handler; }, close() {} });
  const got: number[] = [];
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async (request) => {
      for (let i = 0; i < 40; i++) fromRelay('b-remote', Uint8Array.of(i));
      expect(got).toEqual([]);
      request.relay!.uplink.onDatagram((id, data) => { if (id === 'b-remote') got.push(data[0]!); });
      return { id: 'local', dial: {}, connect: async () => { throw new Error('unused'); }, close: async () => undefined };
    } },
  });
  try {
    expect(got).toEqual(Array.from({ length: 32 }, (_, i) => i));
    fromRelay('b-remote', Uint8Array.of(99));
    expect(got.at(-1)).toBe(99);
    expect(got).toHaveLength(33);
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 在名册里看到同账号设备在线后的拨号（Desktop worker、Node Host 与手机共用）。
 *   已经开着的一方看到设备号更小的设备上线，平时不拨；对方的拨号迟迟不来时自己拨过去，对方按时拨进来时一次也不拨。
 * - Bug／规则依据：2026-11-21 真机，手机被强杀后重启，设备号比手机小、只能经中转的电脑抱着旧连接不再拨，
 *   手机这边也不拨，这台电脑在手机上离线 20 秒到 15 分钟。
 * - 现有覆盖缺口：上一条只覆盖设备号小的一方在连接断开后重拨，没有「该对方拨、对方不拨」的情形。
 * - 最小失败输入：本机先开着，之后目录里一台设备号更小的同账号设备上线，以及它拨进来或不拨进来两种情况。
 * - tier：unit，真实路由与证书，内存传输，计时器用替身推进；两行合计约 30 毫秒。 */
it.each([['never comes', false], ['comes in time', true]] as const)(
  'dials the lower-id device that came online later itself only when that device\'s dial %s', async (_name, dialsIn) => {
    const local = generateIdentity('z-local'), remote = generateIdentity('b-remote');
    const { root, bootstrap } = createPrivateNetwork('Late dial', local);
    const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
    const device: DeviceView = { certificate, name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [] };
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
      send() {}, presence() {}, onDatagram() {}, close() {} });
    const remoteId = Buffer.from(remote.transportKey, 'base64url').toString('hex');
    const channel = (): PeerChannel => ({ remoteId, send() {}, onData() {}, onClose() {}, close() {}, path: () => 'relay' });
    const connect = vi.fn(async () => channel());
    let incoming: (channel: PeerChannel) => void = () => undefined;
    const socket = await AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
        connect: async () => uplink },
      userId: bootstrap.ownerCertificate.subject,
      bindings: { verifyCertificate, createTransport: async (request) => {
        incoming = request.onIncoming;
        return { id: 'local', dial: {}, connect, close: async () => undefined };
      } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
      uplink.devices = [{ ...device, online: true }];
      uplink.emit('directory');
      if (dialsIn) incoming(channel());
      // Not before the other side had its chance: the delay is LATE_DIAL_MS within ±20%.
      await vi.advanceTimersByTimeAsync(700);
      expect(connect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(connect).toHaveBeenCalledTimes(dialsIn ? 0 : 1);
      expect(socket.pathTo('b-remote')).toBe('relay');
    } finally { vi.useRealTimers(); socket.close(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket.openWithBindings 读目录、交给传输层的准入名单（`admittedPeers`）、拨号与入站连接的归属
 *   （Desktop worker、Node Host 与手机共用）。目录里同账号两张证书带同一把传输密钥时，只认签发晚的那一张：准入名单里这把密钥只出现一次，
 *   用这把密钥建的连接记在那台设备名下，另一个设备号像不在目录里的设备一样连不上，但仍记作 Agent-Net 设备（不因此改走 Device Link）；
 *   带本机自己密钥的别的设备号不算对端。
 * - Bug／规则依据：2026-11-21 真机，账号目录 26 台设备里有两个设备号带同一把传输密钥（同一台设备换了设备号重新登记，旧证书还在）。
 *   手机的原生引擎按密钥准入，遇到重复就拒收整份名单（`DUPLICATE_PEER`），手机每次打开 Agent-Net 都失败；电脑上连接被记到排在前面的旧设备号名下。
 * - 现有覆盖缺口：没有任何用例的目录里有重复的传输密钥；原生引擎的 `DUPLICATE_PEER` 只在名单本身出错时测过。
 * - 最小失败输入：一台设备的两张证书（不同设备号、不同签发时间、同一把密钥），先旧后新或先新后旧；再加一张带本机密钥的别的设备号的证书。
 * - tier：unit，真实证书与路由，内存传输；三行合计约 40 毫秒。 */
it.each([['listed first', true], ['listed last', false]] as const)(
  'keeps only the latest certificate of a transport key when the earlier one is %s', async (_name, staleFirst) => {
    const local = generateIdentity('a-local'), device = generateIdentity('m-renamed-device');
    const { root, bootstrap } = createPrivateNetwork('Duplicate transport key', local);
    const issued = Date.now();
    const view = (identity: Pick<typeof device, 'deviceId' | 'signingKey' | 'transportKey'>, now: number, online: boolean): DeviceView => ({
      certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member', now }),
      name: identity.deviceId, online, remoteControlEnabled: true, capabilities: [] });
    const stale = view({ ...device, deviceId: 'm-earlier-device-id' }, issued - 60_000, false), current = view(device, issued, true);
    // Another device id carrying this device's own key is this device as it was, whenever it was issued: never a peer.
    const impostor = view({ ...local, deviceId: 'z-carries-the-local-key' }, issued, true);
    const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const,
      devices: staleFirst ? [stale, current, impostor] : [impostor, current, stale], delegations: [],
      send() {}, presence() {}, onDatagram() {}, close() {} });
    const key = Buffer.from(device.transportKey, 'base64url').toString('hex');
    const connect = vi.fn(async (entry: RosterEntry): Promise<PeerChannel> => ({ remoteId: entry.id, send() {}, onData() {}, onClose() {}, close() {}, path: () => 'relay' }));
    let transport!: TransportOptions;
    const socket = await AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
        connect: async () => uplink },
      userId: bootstrap.ownerCertificate.subject,
      bindings: { verifyCertificate, createTransport: async (options) => { transport = options; return { id: 'local', dial: {}, connect, close: async () => undefined }; } },
    });
    try {
      const admitted = transport.admittedPeers!();
      expect(admitted.filter(peer => peer.id === key).map(peer => peer.relayId)).toEqual(['m-renamed-device']);
      expect(new Set(admitted.map(peer => peer.id)).size).toBe(admitted.length);
      expect(admitted.map(peer => peer.relayId)).not.toContain('z-carries-the-local-key');
      expect(transport.relayIdOf!(key)).toBe('m-renamed-device');
      expect([socket.supports('m-renamed-device'), socket.supports('m-earlier-device-id'), socket.supports('z-carries-the-local-key')]).toEqual([true, false, false]);
      // Left out, not forgotten: a device this socket has seen on Agent-Net is not handed to Device Link instead.
      expect([socket.knowsPeer('m-renamed-device'), socket.knowsPeer('m-earlier-device-id'), socket.knowsPeer('z-carries-the-local-key')]).toEqual([true, true, true]);
      socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
      await vi.waitFor(() => expect(socket.pathTo('m-renamed-device')).toBe('relay'));
      expect(socket.pathTo('m-earlier-device-id')).toBeNull();
      expect(connect).toHaveBeenCalledOnce();
    } finally { socket.close(); }
  });

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 的拨号与入站连接（Desktop worker 与手机共用）；对端重建节点后再拨进来，
 *   本机立刻换用新连接、帧写到新连接上；同时拨号时仍只留一条。
 * - Bug／规则依据：docs/benchmarks/agent-net-session-2026-11-13 卡死复测，控制端重建节点后被控端拒收新连接，
 *   直到旧连接约 30 秒后超时才恢复。
 * - 现有覆盖缺口：集成测试只覆盖首次握手，没有「旧连接还在、对端换了端点」的时序。
 * - 最小失败输入：已建立 10 秒以上的出站连接 + 同一对端的一条入站连接。
 * - tier：unit，真实路由与证书，内存传输，单调时钟用替身推进。 */
it('takes over a peer redial once the existing connection is past the simultaneous-dial window', async () => {
  const local = generateIdentity('a-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Redial takeover', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const remoteId = Buffer.from(remote.transportKey, 'base64url').toString('hex');
  const makeChannel = () => {
    const send = vi.fn(), close = vi.fn();
    const channel: PeerChannel = { remoteId, send, onData() {}, onClose() {}, close, path: () => 'relay' };
    return { channel, send, close };
  };
  const first = makeChannel();
  let incoming: (channel: PeerChannel) => void = () => undefined;
  let now = 1_000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: {
      verifyCertificate,
      createTransport: async (request) => {
        incoming = request.onIncoming;
        return { id: 'local', dial: {}, connect: async () => first.channel, close: async () => undefined };
      },
    },
  });
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    // 本机 ID 排在前面，hello 后由本机拨出；等这条出站连接真正接上。
    await vi.waitFor(() => expect(socket.peerSnapshot('b-remote')).toMatchObject({ path: 'relay' }));
    // 同时拨号：本机是首选拨号方，刚建立的出站连接留下，对端那条关掉。
    const racing = makeChannel();
    incoming(racing.channel);
    expect(racing.close).toHaveBeenCalled();
    expect(first.close).not.toHaveBeenCalled();
    // 对端重建了节点，很久之后再拨进来：旧连接立即换掉，不等它超时。
    now += 10_000;
    const redial = makeChannel();
    incoming(redial.channel);
    expect(redial.close).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalled();
    expect(socket.supports('b-remote')).toBe(true);
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'b-remote', payload: { channel: 'test:echo', args: ['after redial'] } }));
    expect(redial.send.mock.calls.some(([bytes]) => Buffer.from(bytes).toString().includes('after redial'))).toBe(true);
  } finally { clock.mockRestore(); socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket（Desktop worker 与手机共用）的 `onDrain`；连接积压越过 128 KB 后再回落到它以下时
 *   通知一次，上层（Agent-Net 会话层的流量控制）据此续写，不用轮询。
 * - Bug／规则依据：docs/benchmarks/agent-net-session-2026-11-13 大块传输复测，靠定时器重看积压时上传断流；
 *   每次核心写出都通知又让下载慢 2.6 倍，所以只在越过水位时通知。
 * - 现有覆盖缺口：集成测试不看积压通知的时机。
 * - 最小失败输入：一次写把积压推过 128 KB，之后通道回落三次（仍高于水位、低于水位、再次低于水位），再一次没越过水位的写。
 * - tier：unit，真实路由与证书，内存传输。 */
it('reports drain once each time the backlog falls back under the low watermark', async () => {
  const local = generateIdentity('a-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Drain watermark', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  let backlog = 0, afterWrite = 0;
  let coreDrained: () => void = () => undefined;
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'),
    get bufferedAmount() { return backlog; }, send() { backlog = afterWrite; },
    onData() {}, onClose() {}, onDrain(handler) { coreDrained = handler; }, close() {}, path: () => 'relay' };
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect: async () => channel, close: async () => undefined }) },
  });
  const drained = vi.fn();
  socket.onDrain(drained);
  const push = (text: string) => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'b-remote', payload: { channel: 'test:echo', args: [text] } }));
  const coreTook = (left: number) => { backlog = left; coreDrained(); };
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.waitFor(() => expect(socket.peerSnapshot('b-remote')).toMatchObject({ path: 'relay' }));
    coreTook(0);
    expect(drained).not.toHaveBeenCalled();
    afterWrite = 300 * 1024; push('large');
    coreTook(200 * 1024);
    expect(drained).not.toHaveBeenCalled();
    coreTook(100 * 1024);
    expect(drained).toHaveBeenCalledOnce();
    coreTook(0);
    expect(drained).toHaveBeenCalledOnce();
    afterWrite = 64 * 1024; push('small');
    coreTook(0);
    expect(drained).toHaveBeenCalledOnce();
    afterWrite = 300 * 1024; push('large again');
    coreTook(0);
    expect(drained).toHaveBeenCalledTimes(2);
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 的对端授权；证书到期以后，发往这台对端的帧被拒绝，不再写进连接。
 * - Bug／规则依据：2026-11-14 证书签名验证改为按对象缓存（每个数据报、每块数据一次 Ed25519 验证限住了吞吐），
 *   缓存不能让验证过的证书在到期后继续可用。
 * - 现有覆盖缺口：集成测试只覆盖撤销（证书从名册里移走），没有缓存过的证书自然到期。
 * - 最小失败输入：一张 60 秒的证书、一次成功发送、时钟拨过到期时刻后再发一次。
 * - tier：unit，真实证书与签名，内存传输，Date.now 用替身推进。 */
it('stops authorizing a peer once its cached certificate expires', async () => {
  const local = generateIdentity('a-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Certificate expiry', local);
  const issuedAt = Date.now();
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote,
    role: 'member', now: issuedAt, lifetimeMs: 60_000 });
  const device: DeviceView = { certificate, name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [] };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const send = vi.fn();
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send,
    onData() {}, onClose() {}, close() {}, path: () => 'relay' };
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect: async () => channel, close: async () => undefined }) },
  });
  const errors: string[] = [];
  socket.on('message', (data: { toString(): string }) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind === 'relay-error') errors.push(frame.payload.code);
  });
  const push = (text: string) => socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: 'b-remote', payload: { channel: 'test:echo', args: [text] } }));
  const wrote = (text: string) => send.mock.calls.some(([bytes]) => Buffer.from(bytes).toString().includes(text));
  let clock: { mockRestore(): void } | undefined;
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.waitFor(() => expect(socket.peerSnapshot('b-remote')).toMatchObject({ path: 'relay' }));
    push('before expiry');
    expect(wrote('before expiry')).toBe(true);
    clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 61_000);
    push('after expiry');
    expect(wrote('after expiry')).toBe(false);
    expect(errors).toContain('DEVICE_OFFLINE');
  } finally { clock?.mockRestore(); socket.close(); }
});

/** An offline cached start bypasses the successful-handshake path exercised by
 * the integration suite. Notification capability must recover on this same app
 * socket; reconnecting it would discard otherwise healthy direct peers. */
it('refreshes notification capability when a cached offline startup reconnects', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Notification recovery', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [],
    notificationKey: { v: 2, networkId: certificate.networkId, deviceId: remote.deviceId, encryptionKey: remote.transportKey, signature: 'unit' } };
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], notifications: true,
    delegations: [], send() {}, presence() {}, onDatagram() {}, close() {} });
  const first = makeUplink(), second = makeUplink();
  const connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(first).mockResolvedValue(second);
  const notify = vi.fn(async () => undefined), createWebSocket = vi.fn(async () => AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject, cachedDirectory: [device], directoryExpiresAt: Date.now() + 60_000,
    bindings: { verifyCertificate, notify, createTransport: async () => ({ id: 'local', dial: {},
      connect: async () => { throw new Error('No peer dial needed'); }, close: async () => undefined }) },
  }));
  const client = new DeviceLinkClient({ getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'unit-marker',
    getHello: () => ({ deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
    createWebSocket, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const payload = { category: 'session-done' as const, title: 'Completed', deepLink: '/sessions/unit', collapseId: 'unit', targetDeviceId: 'remote' };
  try {
    client.start(); await client.waitUntilOnline(1000);
    expect(client.sendNotify(payload)).toBe(false);
    await vi.waitFor(() => expect(client.hasServerCapability(SERVER_CAPABILITY_NOTIFY)).toBe(true), { timeout: 1500 });
    expect(client.sendNotify(payload)).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    first.emit('close', 1006);
    expect(client.sendNotify(payload)).toBe(false);
    await vi.waitFor(() => expect(client.hasServerCapability(SERVER_CAPABILITY_NOTIFY)).toBe(true), { timeout: 1500 });
    expect(client.sendNotify(payload)).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(createWebSocket).toHaveBeenCalledOnce();
    expect(client.getStatus()).toBe('online');
  } finally { client.stop(); }
});

/** 测试价值
 * - 生产入口与可观察结果：Desktop 的手机推送经 PortableSocket 发出（DeviceLinkClient.sendNotify）。上一条还在逐台发时来的下一条排队、
 *   按顺序发出，两条都送到，连接上不回 BACKPRESSURE。
 * - Bug 依据：2026-11-17 审查，任务 A 完成的推送还在发时任务 B 要回复，第二条被拒、没人重发（Desktop 已记为发过）；Device Link 两条都收。
 * - 最小失败输入：第一条推送卡在发送中，再发一条。tier：unit。
 */
it('queues a phone push made while the previous one is still being delivered', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Notification queue', local);
  const certificate = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' });
  const device: DeviceView = { certificate, name: 'Phone', online: false, remoteControlEnabled: true, capabilities: [],
    notificationKey: { v: 2, networkId: certificate.networkId, deviceId: remote.deviceId, encryptionKey: remote.transportKey, signature: 'unit' } };
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], notifications: true,
    delegations: [], send() {}, presence() {}, onDatagram() {}, close() {} });
  let release!: () => void;
  const delivered: string[] = [];
  const notify = vi.fn(async (_to: unknown, payload: { title: string }) => {
    if (delivered.length === 0) await new Promise<void>((resolve) => { release = resolve; });
    delivered.push(payload.title);
  });
  const client = new DeviceLinkClient({ getWsUrl: () => 'ws://local-node.invalid', getToken: async () => 'unit-marker',
    getHello: () => ({ deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false }),
    createWebSocket: async () => AgentNetSocket.openWithBindings({
      client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
        connect: vi.fn().mockResolvedValue(uplink) },
      userId: bootstrap.ownerCertificate.subject,
      bindings: { verifyCertificate, notify: notify as never, createTransport: async () => ({ id: 'local', dial: {},
        connect: async () => { throw new Error('No peer dial needed'); }, close: async () => undefined }) },
    }) as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const errors: string[] = [];
  client.onFrame((frame) => { if (frame.kind === 'relay-error') errors.push(String((frame.payload as { code?: unknown } | undefined)?.code)); });
  const push = (title: string) => ({ category: 'session-done' as const, title, deepLink: '/sessions/unit', collapseId: title, targetDeviceId: 'remote' });
  try {
    client.start(); await client.waitUntilOnline(1000);
    await vi.waitFor(() => expect(client.hasServerCapability(SERVER_CAPABILITY_NOTIFY)).toBe(true), { timeout: 1500 });
    expect(client.sendNotify(push('A done'))).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(client.sendNotify(push('B needs a reply'))).toBe(true);
    release();
    await vi.waitFor(() => expect(delivered).toEqual(['A done', 'B needs a reply']));
    expect(errors).toEqual([]);
  } finally { client.stop(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 的在线状态往哪发（Desktop worker 用的就是它）。两台都启用会话、都声明在线状态走会话时，
 *   在线状态只在会话上来回，这条连接上一帧 Device Link 都没有；对端还没声明时先等，不先发帧；从不声明的老版本对端等过以后照样收到帧。
 *   对端在会话上发来的在线状态按连接身份交给本机 Device Link 客户端，不信它自报的设备号。
 * - Bug／规则依据：2026-11-16 用户要求「Agent-Net 全走 Agent-Net」，两台新版电脑之间线上不再有 Device Link 的帧，同时不能影响老版本。
 * - 现有覆盖缺口：会话的集成测试只看业务消息；在线状态之前一直是 Device Link 的帧。
 * - 最小失败输入：一台会声明的新对端、一台从不声明的老对端；连上、改一次忙碌状态、新对端发来自报别的设备号的在线状态。
 * - tier：unit，真实路由、证书与会话分帧，内存传输，等待用假计时器。 */
it('keeps presence on the session with a new peer and still sends the frame to an older one', async () => {
  const local = generateIdentity('a-local'), fresh = generateIdentity('b-new'), older = generateIdentity('c-old');
  const { root, bootstrap } = createPrivateNetwork('Session presence', local);
  const view = (identity: typeof local): DeviceView => ({ name: identity.deviceId, online: true, remoteControlEnabled: true, capabilities: [],
    certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }) });
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [view(fresh), view(older)], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const declared: Record<string, readonly string[]> = {}, onSession: string[] = [];
  const sessionFrames: Array<{ m: { t: string; payload?: { busy?: boolean } } }> = [];
  let peerDeclares: () => void = () => undefined, toLocal: (lane: 'control' | 'normal' | 'background', bytes: Uint8Array) => void = () => undefined;
  const channels = new Map<string, { channel: PeerChannel; send: ReturnType<typeof vi.fn> }>();
  for (const identity of [fresh, older]) {
    const send = vi.fn();
    let capable = false, pending: (() => void) | null = null;
    channels.set(identity.deviceId, { send, channel: {
      remoteId: Buffer.from(identity.transportKey, 'base64url').toString('hex'), send, onData() {}, onClose() {}, close() {}, path: () => 'relay',
      declareSessions(features = []) { declared[identity.deviceId] = features; },
      onSessionCapable(handler) { if (capable) handler(); else pending = handler; },
      sessionFeatures: () => (capable ? ['presence-v1'] : []),
      sessionWire: () => (capable ? { bufferedAmount: 0, write: (_lane, bytes) => { sessionFrames.push(JSON.parse(Buffer.from(bytes).subarray(4).toString())); },
        onData: (handler) => { toLocal = handler; } } : null),
    } });
    // Only the new peer ever declares sessions; the older one never sends that line.
    if (identity === fresh) peerDeclares = () => { capable = true; pending?.(); };
  }
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, close: async () => undefined,
      connect: async (entry: RosterEntry) => channels.get((entry.dial as { relayId: string }).relayId)!.channel }) },
  });
  const delivered: Array<{ kind: string; payload?: { deviceId?: string; busy?: boolean } }> = [];
  socket.on('message', (raw) => delivered.push(JSON.parse(raw.toString())));
  const presenceFrames = (deviceId: string) => channels.get(deviceId)!.send.mock.calls
    .map(([bytes]) => JSON.parse(Buffer.from(bytes as Uint8Array).subarray(4).toString())).filter((frame) => frame.kind === 'presence-changed');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    socket.useSessions({ laneFor: () => 'normal', handlers: (key) => { onSession.push(key); return {}; } });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(declared).toEqual({ 'b-new': ['presence-v1'], 'c-old': ['presence-v1'] });
    expect(presenceFrames('b-new')).toEqual([]); expect(presenceFrames('c-old')).toEqual([]);
    peerDeclares();
    expect(onSession).toEqual(['b-new']);
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'presence-set', payload: { busy: true } }));
    expect(sessionFrames.filter((frame) => frame.m.t === 'presence').map((frame) => frame.m.payload?.busy)).toEqual([false, true]);
    const remote = new SessionLanes({ write: (lane, bytes) => toLocal(lane, bytes), deliver() {}, onError(error) { throw error; } });
    remote.send('control', 'control', { t: 'presence', payload: { deviceId: 'someone-else', deviceName: 'b-new', busy: true, remoteControlEnabled: true } });
    expect(delivered.filter((frame) => frame.kind === 'presence-changed' && frame.payload?.busy)).toMatchObject([{ payload: { deviceId: 'b-new', busy: true } }]);
    vi.advanceTimersByTime(1500);
    expect(presenceFrames('c-old')).toMatchObject([{ payload: { deviceId: 'a-local', busy: true } }]);
    expect(channels.get('b-new')!.send).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); socket.close(); }
});

/** 测试价值（会话 v2 的协商）
 * - 生产入口与可观察结果：PortableSocket 给每个对端宣告的会话能力，和大结果怎么发。本机通道能读独立的流（`sessionBodies`）时宣告
 *   agent-net-session-v2；对端也宣告了，大结果走自己的流（`openBody`），通道上只有占位；对端是不认这种流的老版本，或者本机这条
 *   通道不能读，大结果照 v1 整条写在通道上。
 * - Bug／规则依据：docs/dev-rules/protocol-compatibility/agent-net-session.md「会话 v2」：老节点收到不认识的流类型会断开整条连接，
 *   所以只有两端都宣告了才开流。
 * - 现有覆盖缺口：会话层的单元测试直接给 `openBody`；真实核心的集成测试两端都是新版，不覆盖和老版本混连。
 * - 最小失败输入：一个宣告了 v2 的新对端、一个只宣告 presence-v1 的老对端、一条本机不能读流的通道（对端宣告了 v2）；
 *   三个对端各要一个 100 KB 的结果。
 * - tier：unit，真实路由、证书与会话分帧，内存传输。 */
it('opens body streams only to a peer that declared session v2, on a channel that reads them', async () => {
  const local = generateIdentity('a-local'), fresh = generateIdentity('b-new'), older = generateIdentity('c-old'), plain = generateIdentity('d-plain');
  const { root, bootstrap } = createPrivateNetwork('Session v2 negotiation', local);
  const view = (identity: typeof local): DeviceView => ({ name: identity.deviceId, online: true, remoteControlEnabled: true, capabilities: [],
    certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }) });
  const peers = [fresh, older, plain];
  const uplink = Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: peers.map(view), delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const declared: Record<string, readonly string[]> = {}, laneBytes: Record<string, number> = {}, opened: Record<string, number> = {};
  const toLocal: Record<string, (lane: 'control' | 'normal' | 'background', bytes: Uint8Array) => void> = {};
  const channels = new Map<string, PeerChannel>();
  for (const identity of peers) {
    const id = identity.deviceId;
    laneBytes[id] = 0; opened[id] = 0;
    channels.set(id, {
      remoteId: Buffer.from(identity.transportKey, 'base64url').toString('hex'), send() {}, onData() {}, onClose() {}, close() {}, path: () => 'relay',
      ...(identity === plain ? {} : { sessionBodies: true }),
      declareSessions(features = []) { declared[id] = features; },
      onSessionCapable(handler) { handler(); },
      sessionFeatures: () => (identity === older ? ['presence-v1'] : ['presence-v1', AGENT_NET_SESSION_V2]),
      sessionWire: () => ({ bufferedAmount: 0, write: (_lane, bytes) => { laneBytes[id] += bytes.length; },
        onData: (handler) => { toLocal[id] = handler; },
        openBody: () => { opened[id]++; return { write() {}, finish() {}, abandon() {} }; } }),
    });
  }
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local,
      connect: async () => uplink },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, close: async () => undefined,
      connect: async (entry: RosterEntry) => channels.get((entry.dial as { relayId: string }).relayId)! }) },
  });
  try {
    socket.useSessions({ laneFor: () => 'normal', handlers: (key) => ({
      onRequest: (request) => { socket.session(key)!.respond(request.id, { ok: true, result: 'r'.repeat(100_000) }); },
    }) });
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(declared).toEqual({ 'b-new': ['presence-v1', AGENT_NET_SESSION_V2], 'c-old': ['presence-v1', AGENT_NET_SESSION_V2], 'd-plain': ['presence-v1'] });
    for (const identity of peers) {
      const remote = new SessionLanes({ write: (lane, bytes) => toLocal[identity.deviceId](lane, bytes), deliver() {}, onError(error) { throw error; } });
      const before = laneBytes[identity.deviceId];
      remote.send('normal', 'request', { t: 'invoke', id: 'list-' + identity.deviceId, channel: 'test:list', args: [] });
      await Promise.resolve();
      laneBytes[identity.deviceId] -= before;
    }
    expect(opened).toEqual({ 'b-new': 1, 'c-old': 0, 'd-plain': 0 });
    expect(laneBytes['b-new']).toBeLessThan(1024);
    expect(laneBytes['c-old']).toBeGreaterThan(100_000);
    expect(laneBytes['d-plain']).toBeGreaterThan(100_000);
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：PortableSocket 的中转重连与 networkChanged（手机换网事件、Desktop 网络监听经 worker 都走这里）。
 *   中转断着、正在等退避时网络变了，马上重连，不等退避；连上后再通知一次传输层，断网期间发出的包立刻重发。
 *   正在进行的连接尝试不被打断；中转好好的时候换网只通知传输层，不重连。
 * - 规则依据：和 Device Link 客户端收到网络变化时的做法一致（绕过退避、不打断进行中的连接）。2026-11-20 真机换网
 *   22 次中转重连都在 0.2–3.6 秒内按原退避连上，没有遇到连续失败；连续失败时退避会翻倍到 15 秒，新网络通了也要等。
 * - 现有覆盖缺口：之前没有测试覆盖中转重连和网络变化的交互。
 * - 最小失败输入：中转断开、重连失败三次（下一次在 4 秒后），这时来一次网络变化。tier：unit，真实路由与证书，内存中转，假计时器。
 */
it('reconnects the relay at once when the network changes during its backoff', async () => {
  const local = generateIdentity('local'), remote = generateIdentity('remote');
  const { root, bootstrap } = createPrivateNetwork('Relay after network change', local);
  const device: DeviceView = { name: 'Remote', online: false, remoteControlEnabled: true, capabilities: [],
    certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' }) };
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const first = makeUplink(), second = makeUplink();
  let pending: ((uplink: ReturnType<typeof makeUplink>) => void) | null = null;
  const connect = vi.fn().mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(() => new Promise((resolve) => { pending = resolve; }));
  const networkChanged = vi.fn();
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, networkChanged, close: async () => undefined,
      connect: async () => { throw new Error('No peer dial needed'); } }) },
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    // The relay is up: a network change moves the transport only.
    socket.networkChanged();
    expect(networkChanged).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    // Lost, then three failed attempts (0.5 s, 1 s, 2 s): the next one would wait 4 s.
    first.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(500 + 1000 + 2000);
    expect(connect).toHaveBeenCalledTimes(4);
    socket.networkChanged();
    expect(connect).toHaveBeenCalledTimes(5);
    // A second change while that attempt is in flight keeps it.
    socket.networkChanged();
    expect(connect).toHaveBeenCalledTimes(5);
    expect(networkChanged).toHaveBeenCalledTimes(3);
    pending!(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(networkChanged).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：`AgentNetSocket` 的中转重连。① 中转连接一连上就断（本机拒收它发来的一帧、中转马上关掉）时，重连间隔
 *   照常翻倍（0.5、1、2 秒……），撑过 10 秒的连接断了才从 0.5 秒重来；② `restartRelay`（Desktop Main 的兜底）把还当作中转连接的
 *   死连接关掉并重连，正在进行却一直没结果的连接尝试也不再挡着。对端连接不受影响。
 * - Bug 依据：2026-11-25 一台 Mac 的中转连接被本机关掉后这一层没收到关闭、再没重连，4.5 小时后重启才恢复。修好以后同样的情况会
 *   重连；原来每次连上都把间隔重置成 0.5 秒，若中转每次连上都发来同样一帧，就会每半秒连一次。
 * - 现有覆盖缺口：「reconnects the relay at once …」只覆盖连接尝试失败时的退避，没有连上又马上断的；此前没有从外部让中转重连的入口。
 * - 最小失败输入：三条连上即断的连接，再一条撑过 10 秒的；一条从不报关闭的连接与一次永不返回的连接尝试。
 * - tier：unit，真实路由与证书，内存中转，假计时器。 */
it('backs off a relay connection that keeps ending as it opens, and restarts a relay connection on request', async () => {
  const local = generateIdentity('local');
  const { bootstrap } = createPrivateNetwork('Relay restart', local);
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close: vi.fn() });
  const uplinks = Array.from({ length: 6 }, makeUplink);
  const connect = vi.fn();
  for (const uplink of uplinks) connect.mockResolvedValueOnce(uplink);
  connect.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(makeUplink());
  vi.useFakeTimers();
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, close: async () => undefined,
      connect: async () => { throw new Error('No peer dial needed'); } }) },
  });
  try {
    // Ended as soon as each opened: 0.5 s, then 1 s, then 2 s.
    for (const [index, delay] of [500, 1000, 2000].entries()) {
      uplinks[index].emit('close', 1006, 'INVALID_CONTROL');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(connect).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(index + 2);
    }
    // One that lasted starts over at 0.5 s.
    await vi.advanceTimersByTimeAsync(10_000);
    uplinks[3].emit('close', 1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(5);
    expect(socket.relayConnected()).toBe(true);
    // A relay connection whose close never arrives: the socket still counts it until told to restart.
    await vi.advanceTimersByTimeAsync(10_000);
    socket.restartRelay();
    expect(uplinks[4].close).toHaveBeenCalledOnce();
    expect(socket.relayConnected()).toBe(false);
    // After the current backoff (1 s here, doubled when the 0.5 s reconnect was scheduled), as any other reconnect.
    await vi.advanceTimersByTimeAsync(999);
    expect(connect).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(6);
    // An attempt that never settles no longer holds the next one back.
    await vi.advanceTimersByTimeAsync(10_000);
    uplinks[5].emit('close', 1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(7);
    socket.restartRelay();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(8);
    expect(socket.relayConnected()).toBe(true);
  } finally { vi.useRealTimers(); socket.close(); }
});

/** 生产入口：AgentNetSocket 收到中转 4409。仅使用 Agent-Net 时外层 socket 不关闭，
 * 宿主仍须收到事件；仅在确认身份冲突后延长中转重连，换网不提前重连。
 * 最小输入：同一设备身份接管前后各一次。tier：unit，内存中转、假时钟。 */
it('reports relay replacement and backs off only after the host confirms the identity conflict', async () => {
  const local = generateIdentity('local');
  const { bootstrap } = createPrivateNetwork('Duplicate identity', local);
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {} });
  const first = makeUplink(), second = makeUplink(), third = makeUplink();
  const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(third);
  const onRelayReplaced = vi.fn();
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject, onRelayReplaced,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, close: async () => undefined,
      connect: async () => { throw new Error('No peer dial needed'); } }) },
  });
  const closed = vi.fn();
  socket.on('close', closed);
  vi.useFakeTimers();
  try {
    first.emit('close', 4409);
    expect(onRelayReplaced).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(2);
    socket.setDuplicateIdentityCooldown(true);
    second.emit('close', 4409);
    socket.networkChanged();
    expect(onRelayReplaced).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_499);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_501);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(closed).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机物理换网时的 `replaceRelayConnection`（DeviceLinkContext → notifyMobileAgentNetNetworkChanged）。
 *   旧的中转连接被关掉、马上连新的，传输层被告知换网（中转回来后再告知一次）；和对端的加密连接不关、照常可用。
 *   中转本来就断着、正有一次连接在进行时不另起一次。
 * - Bug 依据：#11770 审查。手机换网不再重建 Agent-Net 主连接以后，旧网络上半开的中转 WebSocket 没人替换（React Native 的
 *   WebSocket 不能 ping，Device Link 的心跳由这个 socket 本地回答），只能等 TCP 自己报错，经 WebSocket 中转的消息一直卡住。
 * - 现有覆盖缺口：上一条只覆盖中转已经断开的情况。
 * - 最小失败输入：中转在线、已连上一台对端时换网一次；中转断开、连接进行中时再换网一次。tier：unit，真实路由与证书，内存中转与传输。
 */
it('replaces only the relay connection when the phone changes networks', async () => {
  const local = generateIdentity('a-local'), remote = generateIdentity('b-remote');
  const { root, bootstrap } = createPrivateNetwork('Relay on a route change', local);
  const device: DeviceView = { name: 'Remote', online: true, remoteControlEnabled: true, capabilities: [],
    certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: remote, role: 'member' }) };
  const makeUplink = () => Object.assign(new EventEmitter(), { kind: 'agent-net' as const, devices: [device], delegations: [],
    send() {}, presence() {}, onDatagram() {}, close: vi.fn() });
  const first = makeUplink(), second = makeUplink();
  let pending: ((uplink: ReturnType<typeof makeUplink>) => void) | null = null;
  const connect = vi.fn().mockResolvedValueOnce(first).mockImplementation(() => new Promise((resolve) => { pending = resolve; }));
  const networkChanged = vi.fn(), channelClose = vi.fn();
  const channel: PeerChannel = { remoteId: Buffer.from(remote.transportKey, 'base64url').toString('hex'), send() {}, onData() {},
    onClose() {}, close: channelClose, path: () => 'relay' };
  const socket = await AgentNetSocket.openWithBindings({
    client: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local, connect },
    userId: bootstrap.ownerCertificate.subject,
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, networkChanged, close: async () => undefined,
      connect: async () => channel }) },
  });
  try {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Local', platform: 'test', appVersion: '1', remoteControlEnabled: true, busy: false } }));
    await vi.waitFor(() => expect(socket.pathTo('b-remote')).toBe('relay'));
    socket.replaceRelayConnection();
    expect(first.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(networkChanged).toHaveBeenCalledOnce();
    // A second change while the new relay connection is still being made keeps that attempt.
    socket.replaceRelayConnection();
    expect(connect).toHaveBeenCalledTimes(2);
    pending!(second);
    await vi.waitFor(() => expect(networkChanged).toHaveBeenCalledTimes(3));
    expect(channelClose).not.toHaveBeenCalled();
    expect(socket.pathTo('b-remote')).toBe('relay');
  } finally { socket.close(); }
});

/** 测试价值
 * - 生产入口与可观察结果：手机回前台时的 `AgentNetSocket.openWithBindings({ initialCandidates, deferRelay: true })`、
 *   `canConnectSession`、`connectSession` 与 `presence-changed` 投递。
 *   ① 无需等中转 WebSocket 建好即返回并按 350 ms 预算直拨记忆的局域网 UDP 候选，存活对端立即直连成功并上报 `onDirectAddress`；
 *   ② 拨号进行中及 `openingRelay` 未返回前不向业务层误发 `presence-changed { online: false }`，仅对确认离线或拨号最终失败的对端报离线；
 *   ③ 多对端故障隔离：某台记忆候选失效（端口变化）只退役该候选并回退中转重拨，不影响另一台已建立的直连。
 * - Bug／规则依据：2026-11-21 真机（Redmi K40）后台 20s 回前台：① 丢弃上次验证过的直连地址导致每次串行等待中转握手；
 *   ② `hello` 与 `dialRoster` 对正在首拨的对端先发 `online: false` 污染 `peerOfflineGate` 触发同步 `DEVICE_OFFLINE`。
 * - 现有覆盖缺口：已有测试未覆盖 `deferRelay` 并行中转握手、350 ms 记忆候选超时回退，以及首拨期间不误报离线的多对端隔离。
 * - 最小失败输入：存活直连 `b-live`、失效候选回退中转 `c-stale`、真实离线 `d-offline`、首拨失败 `e-fail` 四台对端。
 * - tier：unit，真实证书与路由，内存传输，无真实等待；约 15 毫秒。 */
it('dials remembered UDP candidates before the relay finishes, suppresses false initial offline events, and isolates stale candidates per peer', async () => {
  const local = generateIdentity('m-phone');
  const livePeer = generateIdentity('b-live');
  const stalePeer = generateIdentity('c-stale');
  const offlinePeer = generateIdentity('d-offline');
  const failPeer = generateIdentity('e-fail');
  const { root, bootstrap } = createPrivateNetwork('Fast resume socket', local);
  const makeView = (identity: typeof livePeer, online: boolean): DeviceView => ({
    certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }),
    name: identity.deviceId, online, remoteControlEnabled: true, capabilities: [],
  });
  const cached = [makeView(livePeer, false), makeView(stalePeer, false), makeView(offlinePeer, false), makeView(failPeer, false)];
  const liveDirectory = [makeView(livePeer, true), makeView(stalePeer, true), makeView(offlinePeer, false), makeView(failPeer, true)];
  let resolveRelay!: (uplink: any) => void;
  const uplink = Object.assign(new EventEmitter(), {
    kind: 'agent-net' as const, devices: liveDirectory, delegations: [],
    send() {}, presence() {}, onDatagram() {}, close() {},
  });
  const keyOf = (identity: typeof livePeer) => Buffer.from(identity.transportKey, 'base64url').toString('hex');
  let rejectStaleUdp!: (error: Error) => void;
  let rejectFailDial!: (error: Error) => void;
  const liveClose = vi.fn();
  const connect = vi.fn((entry: RosterEntry): Promise<PeerChannel> => {
    const dial = entry.dial as { relayId?: string; udp?: { address: string; port: number }; preferUdp?: boolean; timeoutMs?: number };
    if (entry.id === keyOf(livePeer)) {
      return Promise.resolve({
        remoteId: entry.id, send() {}, onData() {}, onClose() {}, close: liveClose,
        path: () => 'direct', directAddress: () => ({ address: '192.168.1.10', port: 41000 }),
      });
    }
    if (entry.id === keyOf(stalePeer) && dial.preferUdp) {
      return new Promise((_, reject) => { rejectStaleUdp = reject; });
    }
    if (entry.id === keyOf(stalePeer)) {
      return Promise.resolve({ remoteId: entry.id, send() {}, onData() {}, onClose() {}, close() {}, path: () => 'relay' });
    }
    if (entry.id === keyOf(failPeer)) {
      return new Promise((_, reject) => { rejectFailDial = reject; });
    }
    throw new Error('Unexpected dial: ' + entry.id);
  });
  const recordedDirect = new Map<string, { address: string; port: number }>();
  const socket = await AgentNetSocket.openWithBindings({
    client: {
      base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey,
      certificate: bootstrap.ownerCertificate, identity: local,
      connect: () => new Promise(resolve => { resolveRelay = resolve; }),
    },
    userId: bootstrap.ownerCertificate.subject,
    cachedDirectory: cached,
    directoryExpiresAt: Date.now() + 60_000,
    initialCandidates: new Map([
      ['b-live', { address: '192.168.1.10', port: 41000 }],
      ['c-stale', { address: '192.168.1.20', port: 42000 }],
    ]),
    deferRelay: true,
    onDirectAddress: (id, address) => { recordedDirect.set(id, address); },
    bindings: { verifyCertificate, createTransport: async () => ({ id: 'local', dial: {}, connect, close: async () => undefined }) },
  });
  const offlineEvents: string[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.kind === 'presence-changed' && frame.payload?.online === false) offlineEvents.push(frame.payload.deviceId);
  });
  try {
    await vi.waitFor(() => expect(socket.pathTo('b-live')).toBe('direct'));
    expect(recordedDirect.get('b-live')).toEqual({ address: '192.168.1.10', port: 41000 });
    expect(connect).toHaveBeenCalledWith({ id: keyOf(livePeer), dial: { relayId: 'b-live', udp: { address: '192.168.1.10', port: 41000 }, preferUdp: true, timeoutMs: 350 } });
    expect(connect).toHaveBeenCalledWith({ id: keyOf(stalePeer), dial: { relayId: 'c-stale', udp: { address: '192.168.1.20', port: 42000 }, preferUdp: true, timeoutMs: 350 } });
    expect(socket.supports('b-live')).toBe(true);
    expect(socket.supports('c-stale')).toBe(false);
    expect(socket.canConnectSession('c-stale')).toBe(true);
    expect(socket.canConnectSession('d-offline')).toBe(true);

    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'hello', payload: { deviceName: 'Phone', platform: 'test', appVersion: '1', remoteControlEnabled: false, busy: false } }));
    expect(offlineEvents).toEqual([]);

    resolveRelay(uplink);
    await vi.waitFor(() => expect(offlineEvents).toEqual(['d-offline']));
    expect(socket.canConnectSession('d-offline')).toBe(false);

    rejectStaleUdp(new Error('NATIVE_CONNECT_TIMEOUT'));
    await vi.waitFor(() => expect(socket.pathTo('c-stale')).toBe('relay'));
    expect(connect).toHaveBeenCalledWith({ id: keyOf(stalePeer), dial: { relayId: 'c-stale' } });
    expect(socket.pathTo('b-live')).toBe('direct');
    expect(liveClose).not.toHaveBeenCalled();
    expect(offlineEvents).toEqual(['d-offline']);

    rejectFailDial(new Error('NATIVE_CONNECT_TIMEOUT'));
    await vi.waitFor(() => expect(offlineEvents).toEqual(['d-offline', 'e-fail']));
  } finally {
    socket.close();
  }
});
