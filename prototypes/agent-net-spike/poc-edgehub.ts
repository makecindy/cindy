/**
 * 验证：真实 DeviceLinkClient 不改一行、不连任何中转，能否经 EdgeHub 工作。
 * 运行：npx tsx --tsconfig tsconfig.json poc-edgehub.ts [core|quic]
 * 默认 core（自研传输，第 6 步）；quic 是第 0 阶段的 iroh 对照，要先 npm install。两种传输跑同一套 12 项检查。
 * 能看到线上数据报的传输另加一项附加检查：抓到的包里没有业务明文。
 */
import assert from 'node:assert/strict';
import {
  DeviceLinkClient,
  PROTOCOL_VERSION,
  type Envelope,
  type InvokePayload,
} from '../../packages/device-link/src/index';
import { EdgeHub } from './edgehub.ts';
import type { TransportKind } from './transport.ts';
import { nowMs, sleep, summarize } from './util.mjs';

const transport = (process.argv[2] ?? 'core') as TransportKind;
if (transport !== 'core' && transport !== 'quic') throw new Error(`unknown transport ${transport}`);
const roster = new Map();
const results: Array<{ check: string; ok: boolean; extra?: boolean; detail?: string }> = [];

async function check(name: string, run: () => Promise<string | void>, extra = false) {
  try {
    const detail = await run();
    results.push({ check: name, ok: true, extra, ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ check: name, ok: false, extra, detail: String((error as Error).message ?? error).slice(0, 200) });
  }
}

/** 抓包：线上每个数据报都留一份，最后找业务明文。只有自研传输能看到数据报。 */
const datagrams: Buffer[] = [];
const tap = transport === 'core' ? (datagram: Uint8Array) => void datagrams.push(Buffer.from(datagram)) : undefined;

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
      requestTimeoutMs: 4_000,
      pingIntervalMs: 1_000,
      pongMissLimit: 3,
      transportRetryIntervalMs: 100,
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

const userId = 'spike-account';
const hubOptions = { userId, transport, ...(tap ? { tap } : {}) };
const hubHost = await EdgeHub.create({ deviceId: 'h-host', roster, ...hubOptions });
const hubA = await EdgeHub.create({ deviceId: 'a-phone', roster, ...hubOptions });
const hubC = await EdgeHub.create({ deviceId: 'c-laptop', roster, ...hubOptions });
// 流氓节点知道所有人的地址，但自己不在别人的名册里。
const rogue = await EdgeHub.create({ deviceId: 'rogue', roster: new Map(roster), ...hubOptions });

const host = makeClient(hubHost, 'h-host', true);
const a = makeClient(hubA, 'a-phone', false);
const c = makeClient(hubC, 'c-laptop', false);
const executions = serve(host.client);

await check('真实 DeviceLinkClient 在没有中转时进入 online', async () => {
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

await check('全程没有任何中转连接', async () => {
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
      const bytes = datagrams.reduce((sum, datagram) => sum + datagram.length, 0);
      assert.ok(datagrams.length > 1000, `只抓到 ${datagrams.length} 个包`);
      const hits = needles.filter((needle) => datagrams.some((datagram) => datagram.includes(needle)));
      assert.deepEqual(hits, []);
      return `${datagrams.length} 个包，${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
  `\n传输：${transport}。${passed(required)}/${required.length} 通过` +
    (extras.length ? `，附加 ${passed(extras)}/${extras.length}` : ''),
);
a.client.stop();
c.client.stop();
host.client.stop();
await Promise.allSettled([hubA.close(), hubC.close(), hubHost.close(), rogue.close()]);
process.exit(failed ? 1 : 0);
