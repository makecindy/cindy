/**
 * 验证：真实 DeviceLinkClient 不改一行、不连任何中转，能否经 EdgeHub 工作。
 * 运行：npx tsx --tsconfig tsconfig.json poc-edgehub.ts [core|relay|push|punch|quic]
 * - core：自研传输走本机 UDP（第 6 步）。
 * - relay：UDP 全被挡，全部经本机起的自建中转的专用通道（第 7 步，`agent-net-relay-v1`）。
 * - push：UDP 全被挡，全部夹带在现有中转的 push 消息里（官方中转也能用的那条路）。
 * - punch：先经中转专用通道连上，交换候选地址后打洞换到直连。
 * - quic：第 0 阶段的 iroh 对照，要先 npm install。
 * 每种都跑同一套 12 项检查；自研传输另加附加检查：抓到的包里没有业务明文，以及这种方式该走的路径。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DeviceLinkClient,
  PROTOCOL_VERSION,
  type Envelope,
  type InvokePayload,
} from '../../packages/device-link/src/index';
import { EdgeHub } from './edgehub.ts';
import { connectAgentNetRelay, connectPushTunnel } from './relay-client.ts';
import { startRelay } from './relay-fixture.ts';
import { startV2Relay } from './relay-v2-fixture.ts';
import type { TransportKind } from './transport.ts';
import { nowMs, sleep, summarize } from './util.mjs';

type Mode = 'core' | 'relay' | 'push' | 'punch' | 'quic' | 'v2' | 'v2-punch';
const mode = (process.argv[2] ?? 'core') as Mode;
if (!['core', 'relay', 'push', 'punch', 'quic', 'v2', 'v2-punch'].includes(mode)) throw new Error(`unknown mode ${mode}`);
const transport: TransportKind = mode === 'quic' ? 'quic' : 'core';
const v2 = mode === 'v2' || mode === 'v2-punch';
const relayed = mode === 'relay' || mode === 'push' || mode === 'punch' || v2;
if (v2) {
  const localFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (new URL(String(input)).hostname !== '127.0.0.1') throw new Error('OFFICIAL_NETWORK_DISABLED_IN_V2_TEST');
    return localFetch(input, init);
  };
}
const roster = new Map();
const userId = 'spike-account';
const results: Array<{ check: string; ok: boolean; extra?: boolean; detail?: string }> = [];

async function check(name: string, run: () => Promise<string | void>, extra = false) {
  try {
    const detail = await run();
    results.push({ check: name, ok: true, extra, ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ check: name, ok: false, extra, detail: String((error as Error).message ?? error).slice(0, 200) });
  }
}

/** 抓包：线上每个数据报（经 UDP 或经中转）都留一份，最后找业务明文、看走了哪条路。只有自研传输能看到数据报。 */
const captured: Array<{ bytes: Buffer; via: 'udp' | 'relay' }> = [];
const datagrams = () => captured.map((entry) => entry.bytes);
const tap = transport === 'core' ? (datagram: Uint8Array, via: 'udp' | 'relay') => void captured.push({ bytes: Buffer.from(datagram), via }) : undefined;

// 中转上的设备号和 EdgeHub 的设备号不同：中转只按自己的设备号转发。流氓节点也加入了中转，只是不在别人的 agent-net 名册里。
const relayIds: Record<string, string> = { 'h-host': 'hub-host', 'a-phone': 'hub-phone', 'c-laptop': 'hub-laptop', rogue: 'hub-rogue' };
// 设了 AGENT_NET_RELAY_CONFIG 就用远端已经起好的中转（真实网络测试，见 real/README.md）：{ relay: { url, servername, ca }, credentials }。
const remote = !v2 && relayed && process.env.AGENT_NET_RELAY_CONFIG ? JSON.parse(readFileSync(process.env.AGENT_NET_RELAY_CONFIG, 'utf8')) : null;
const v2Fixture = v2 ? await startV2Relay(Object.values(relayIds)) : null;
const fixture = v2Fixture ?? (relayed ? (remote ? { url: remote.relay.url, credentials: new Map(Object.entries(remote.credentials as Record<string, string>)), close: async () => undefined } : await startRelay(Object.values(relayIds))) : null);
const tls = remote ? { servername: remote.relay.servername, ca: remote.relay.ca } : undefined;
if (v2Fixture) {
  const directory = await v2Fixture.clients.get(relayIds['h-host'])!.directory();
  for (const [nodeId, relayId] of Object.entries(relayIds)) {
    if (nodeId === 'rogue') continue; // The negative admission case intentionally lacks a local grant.
    const certificate = directory.find((device) => device.certificate.deviceId === relayId)?.certificate;
    assert.ok(certificate && certificate.expiresAt > Date.now(), 'missing valid V2 directory binding');
    roster.set(nodeId, { id: Buffer.from(certificate.transportKey, 'base64url').toString('hex'), dial: { relayId } });
  }
}

async function hubOptions(deviceId: string) {
  const base = { userId, transport, ...(tap ? { tap } : {}) };
  if (!fixture) return base;
  const relayId = relayIds[deviceId];
  if (v2Fixture) {
    return { ...base, relay: { uplink: await v2Fixture.clients.get(relayId)!.connect(), deviceId: relayId },
      identity: v2Fixture.identities.get(relayId)!.transportPrivateKey, udp: mode === 'v2-punch',
      stunServers: [v2Fixture.stunServer], reprobeMs: 2_000 };
  }
  const credential = fixture.credentials.get(relayId)!;
  const uplink = mode === 'push' ? await connectPushTunnel(fixture.url, credential, deviceId, tls) : await connectAgentNetRelay(fixture.url, credential, tls);
  return { ...base, relay: { uplink, deviceId: relayId }, udp: mode === 'punch', reprobeMs: 2_000 };
}

function makeClient(hub: EdgeHub, id: string, host: boolean) {
  const statuses: string[] = [];
  const client = new DeviceLinkClient({
    getWsUrl: () => 'edge://local',
    getToken: async () => 'no-account-token-needed',
    getHello: () => ({
      deviceName: id,
      platform: host ? 'darwin' : 'ios',
      appVersion: 'spike',
      remoteControlEnabled: host,
      busy: false,
    }),
    createWebSocket: () => hub.createSocket(),
    peerFailurePolicy: host ? 'legacy' : 'isolate-peer',
    timing: {
      reconnectBaseMs: 30,
      reconnectMaxMs: 100,
      // 本机回环上 4 秒足够；经真实中转时用产品的默认值：测试用的云主机出口只有约 5.8 Mbit/s，3 MiB 光传就要 4 秒多。
      requestTimeoutMs: remote ? 30_000 : 4_000,
      pingIntervalMs: 1_000,
      pongMissLimit: 3,
      // 同上：经真实中转时用产品的 2 秒。100 毫秒在慢路径上确认还没回来就整窗重发，上面这层可靠传输会把线路堵死。
      transportRetryIntervalMs: remote ? 2_000 : 100,
      transportMaxRetryAttempts: 5,
      congestionBackoffBaseMs: 300,
      congestionBackoffMaxMs: 600,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client.onStatusChange((status) => statuses.push(status));
  client.start();
  return { client, statuses };
}

function serve(client: DeviceLinkClient) {
  const executions = new Map<string, number>();
  const large = 'x'.repeat(3 * 1024 * 1024);
  client.onFrame((env: Envelope) => {
    if (!env.src || !env.id) return;
    if (env.kind === 'link-open') {
      client.sendLinkAccept(env.src, env.id, { appVersion: 'spike', allowlistHash: 'fixture' });
      return;
    }
    if (env.kind !== 'invoke') return;
    const { channel, args } = env.payload as InvokePayload;
    executions.set(env.id, (executions.get(env.id) ?? 0) + 1);
    if (channel === 'fixture:echo') client.sendInvokeResult(env.src, env.id, { ok: true, result: args[0] });
    else if (channel === 'fixture:large') client.sendInvokeResult(env.src, env.id, { ok: true, result: large });
    else {
      client.sendInvokeResult(env.src, env.id, {
        ok: false,
        error: { code: 'CHANNEL_NOT_ALLOWED', message: 'fixture' },
      });
    }
  });
  return executions;
}

const openPayload = { controllerName: 'spike', protocolVersion: PROTOCOL_VERSION, appVersion: 'spike' };

async function waitFor(test: () => boolean, ms = 4_000) {
  const start = nowMs();
  while (!test()) {
    if (nowMs() - start > ms) throw new Error('timed out');
    await sleep(10);
  }
}

const hubHost = await EdgeHub.create({ deviceId: 'h-host', roster, ...(await hubOptions('h-host')) });
const hubA = await EdgeHub.create({ deviceId: 'a-phone', roster, ...(await hubOptions('a-phone')) });
const hubC = await EdgeHub.create({ deviceId: 'c-laptop', roster, ...(await hubOptions('c-laptop')) });
// 流氓节点知道所有人的地址，但自己不在别人的名册里。
const rogue = await EdgeHub.create({ deviceId: 'rogue', roster: new Map(roster), ...(await hubOptions('rogue')) });

const host = makeClient(hubHost, 'h-host', true);
const a = makeClient(hubA, 'a-phone', false);
const c = makeClient(hubC, 'c-laptop', false);
const executions = serve(host.client);

await check('真实 DeviceLinkClient 通过本机节点进入 online', async () => {
  await Promise.all([
    a.client.waitUntilOnline(3_000),
    host.client.waitUntilOnline(3_000),
    c.client.waitUntilOnline(3_000),
  ]);
  assert.equal(a.client.getStatus(), 'online');
  return `selfId=${a.client.getSelfDeviceId()}`;
});

await hubA.dial('h-host');
await hubC.dial('h-host');

await check('在线状态由点对点连接合成', async () => {
  const seen = new Promise<boolean>((resolve) => {
    const off = a.client.onPresenceChanged((snap) => {
      if (snap.deviceId === 'h-host' && snap.online && snap.remoteControlEnabled) {
        off();
        resolve(true);
      }
    });
  });
  host.client.sendPresence({ busy: false });
  assert.equal(await Promise.race([seen, sleep(2_000).then(() => false)]), true);
});

await check('link-open / link-accept 与可靠传输协商', async () => {
  await a.client.openLink('h-host', openPayload);
  await c.client.openLink('h-host', openPayload);
  await waitFor(() => a.client.isLinkReady('h-host') && c.client.isLinkReady('h-host'));
});

await check('invoke 往返', async () => {
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = nowMs();
    const reply = await a.client.invoke('h-host', { channel: 'fixture:echo', args: [i] });
    assert.equal(reply.ok && reply.result, i);
    samples.push(nowMs() - start);
  }
  return `ms ${JSON.stringify(summarize(samples))}`;
});

await check('3 MiB 结果经可靠分片完整送达', async () => {
  const start = nowMs();
  const reply = await a.client.invoke('h-host', { channel: 'fixture:large', args: [] });
  assert.equal(reply.ok && (reply.result as string).length, 3 * 1024 * 1024);
  return `${Math.round(nowMs() - start)}ms`;
});

await check('push 经可靠链路到达控制端', async () => {
  const got = new Promise<unknown>((resolve) => {
    const off = a.client.onFrame((env: Envelope) => {
      const payload = env.payload as { channel?: string; payload?: unknown } | undefined;
      if (env.kind === 'push' && payload?.channel === 'fixture:event') {
        off();
        resolve(payload.payload);
      }
    });
  });
  host.client.sendPush('a-phone', 'fixture:event', { hello: 1 });
  assert.deepEqual(await Promise.race([got, sleep(2_000).then(() => 'timeout')]), { hello: 1 });
});

await check('名册外的节点被传输层拒绝', async () => {
  const before = hubHost.stats.rejected;
  await rogue.dial('h-host').catch(() => undefined);
  await waitFor(() => hubHost.stats.rejected === before + 1);
  assert.deepEqual(hubHost.peerIds().sort(), ['a-phone', 'c-laptop']);
});

await check('伪造帧内 src 无效，来源取自已认证连接', async () => {
  const got = new Promise<Envelope>((resolve) => {
    const off = host.client.onFrame((env: Envelope) => {
      const payload = env.payload as { channel?: string } | undefined;
      if (env.kind === 'push' && payload?.channel === 'fixture:forged') {
        off();
        resolve(env);
      }
    });
  });
  hubC.injectRaw('h-host', {
    v: PROTOCOL_VERSION,
    kind: 'push',
    src: 'a-phone',
    dst: 'h-host',
    payload: { channel: 'fixture:forged', payload: 1 },
  });
  const env = await Promise.race([got, sleep(1_500).then(() => null)]);
  assert.ok(env === null || env.src === 'c-laptop', `src=${env?.src}`);
  return env ? `src=${env.src}` : '客户端丢弃了裸帧';
});

await check('远控开关关闭时由目标节点拒绝 invoke', async () => {
  host.client.sendPresence({ remoteControlEnabled: false });
  await sleep(100);
  const outcome = await a.client
    .invoke('h-host', { channel: 'fixture:echo', args: ['x'] })
    .then(() => 'resolved', (error) => (error as { code?: string }).code ?? 'rejected');
  host.client.sendPresence({ remoteControlEnabled: true });
  await sleep(100);
  assert.equal(outcome, 'REMOTE_DISABLED');
  return outcome;
});

await check('故障半径：一台控制端静默，另一台零感知', async () => {
  const hostStatusCount = host.statuses.length;
  hubA.muted = true;
  const pending = a.client.invoke('h-host', { channel: 'fixture:echo', args: ['lost'] }).catch(() => 'failed');
  host.client.sendPush('a-phone', 'fixture:silent', {});
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) {
    const start = nowMs();
    const reply = await c.client.invoke('h-host', { channel: 'fixture:echo', args: [i] });
    assert.equal(reply.ok && reply.result, i);
    samples.push(nowMs() - start);
    await sleep(10);
  }
  assert.equal(host.statuses.length, hostStatusCount, '被控端连接状态不应变化');
  assert.ok(c.client.isLinkReady('h-host'));
  hubA.muted = false;
  await pending;
  return `另一台 invoke ms ${JSON.stringify(summarize(samples))}`;
});

await check('点对点连接断开后重连，请求不重复执行', async () => {
  await hubA.dropPeer('h-host');
  await waitFor(() => !hubHost.peerIds().includes('a-phone'));
  await sleep(50);
  await hubA.dial('h-host');
  await a.client.openLink('h-host', openPayload);
  const reply = await a.client.invoke('h-host', { channel: 'fixture:echo', args: ['again'] });
  assert.equal(reply.ok && reply.result, 'again');
  assert.ok([...executions.values()].every((count) => count === 1), '存在重复执行');
  return `总执行 ${executions.size} 次，全部恰好一次`;
});

await check('业务层全程未建立 V1 中转连接', async () => {
  const hubs = [hubA, hubC, hubHost];
  assert.equal(hubs.reduce((sum, hub) => sum + hub.stats.relayConnections, 0), 0);
  const out = hubs.reduce((sum, hub) => sum + hub.stats.routedOut, 0);
  const inbound = hubs.reduce((sum, hub) => sum + hub.stats.routedIn, 0);
  return `路由帧 出 ${out} 入 ${inbound}`;
});

if (tap) {
  await check(
    '抓到的包里没有业务明文',
    async () => {
      // 设备号、通道名、帧字段名，以及 3 MiB 结果里的一段内容，任何一个出现在线上都说明有明文。
      const needles = ['"kind"', 'fixture:', 'h-host', 'a-phone', 'c-laptop', 'presence-changed', 'invoke', 'x'.repeat(16)];
      const all = datagrams();
      const bytes = all.reduce((sum, datagram) => sum + datagram.length, 0);
      assert.ok(all.length > 1000, `只抓到 ${all.length} 个包`);
      const hits = needles.filter((needle) => all.some((datagram) => datagram.includes(needle)));
      assert.deepEqual(hits, []);
      return `${all.length} 个包，${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    },
    true,
  );
}

const count = (via: 'udp' | 'relay') => captured.filter((entry) => entry.via === via).length;
if (mode === 'relay' || mode === 'push' || mode === 'v2') {
  await check(
    'UDP 全被挡时所有数据报都经 WebSocket 中转',
    async () => {
      assert.equal(count('udp'), 0);
      assert.ok(count('relay') > 1000, `经中转只有 ${count('relay')} 个包`);
      return `经中转 ${count('relay')} 个包，UDP 0 个`;
    },
    true,
  );
}
if (mode === 'punch' || mode === 'v2-punch') {
  await check(
    '先经中转连上，交换地址后换到直连',
    async () => {
      // 重连检查之后 a-phone 刚经中转重新连上，等它打洞完成。
      await waitFor(() => hubA.pathTo('h-host') === 'direct' && hubC.pathTo('h-host') === 'direct' && hubHost.pathTo('a-phone') === 'direct');
      assert.ok(count('relay') > 0 && count('udp') > count('relay'), `经中转 ${count('relay')} 个，UDP ${count('udp')} 个`);
      return `经中转 ${count('relay')} 个包，直连 ${count('udp')} 个`;
    },
    true,
  );
}

for (const result of results) {
  const label = result.ok ? 'PASS' : 'FAIL';
  console.log(`${label}  ${result.extra ? '附加：' : ''}${result.check}${result.detail ? `  (${result.detail})` : ''}`);
}
const required = results.filter((result) => !result.extra);
const extras = results.filter((result) => result.extra);
const failed = results.filter((result) => !result.ok).length;
const passed = (list: typeof results) => list.filter((result) => result.ok).length;
console.log(
  `\n方式：${mode}。${passed(required)}/${required.length} 通过` +
    (extras.length ? `，附加 ${passed(extras)}/${extras.length}` : ''),
);
a.client.stop();
c.client.stop();
host.client.stop();
await Promise.allSettled([hubA.close(), hubC.close(), hubHost.close(), rogue.close()]);
await fixture?.close();
process.exit(failed ? 1 : 0);
