// QUIC 基准：建连、往返、吞吐，以及大流量时另一条流的交互延迟（队头阻塞）。
// 用法：node bench-quic.mjs [bulkMiB] [peerBind] [relayUrl]
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { addrOf, ALPN, bindEndpoint, mibPerSecond, nowMs, sleep, summarize } from './lib.mjs';

const bulkMiB = Number(process.argv[2] ?? 64);
const peerBind = process.argv[3] ?? '127.0.0.1:0';
const relay = process.argv[4] ?? null;
const CHUNK = 256 * 1024;

const peer = spawn(process.execPath, ['quic-peer.mjs', peerBind, relay ?? '-'], {
  cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'],
});
const [line] = await once(createInterface({ input: peer.stdout }), 'line');
const info = JSON.parse(line);

const bindStart = nowMs();
const local = await bindEndpoint({ relay, bindAddr: peerBind.startsWith('127.') ? '127.0.0.1:0' : '0.0.0.0:0' });
const bindMs = nowMs() - bindStart;
if (relay) await local.online();

// 走中继时故意不给直连地址，确保测到的是中继路径。
const target = () => addrOf(info.id, relay ? [] : info.sockets, relay ? info.relay ?? relay : null);

const connectSamples = [];
for (let i = 0; i < 20; i++) {
  const start = nowMs();
  const connection = await local.connect(target(), ALPN);
  connectSamples.push(nowMs() - start);
  connection.close(0n, []);
  await sleep(20);
}

const connection = await local.connect(target(), ALPN);

async function openEcho() {
  const stream = await connection.openBi();
  await stream.send.writeAll([...Buffer.from('E')]);
  return stream;
}
async function pingOnce(stream, body) {
  const start = nowMs();
  await stream.send.writeAll(body);
  await stream.recv.readExact(64);
  return nowMs() - start;
}

const body = Array.from({ length: 64 }, (_, i) => i);
const echo = await openEcho();
const rtt = [];
for (let i = 0; i < 500; i++) rtt.push(await pingOnce(echo, body));

async function bulk() {
  const stream = await connection.openBi();
  await stream.send.writeAll([...Buffer.from('S')]);
  const chunk = Array.from({ length: CHUNK }, (_, i) => i & 0xff);
  const total = bulkMiB * 1024 * 1024;
  const start = nowMs();
  for (let sent = 0; sent < total; sent += CHUNK) await stream.send.writeAll(chunk);
  await stream.send.finish();
  const reply = Buffer.from(await stream.recv.readToEnd(32)).toString();
  return { ms: nowMs() - start, received: Number(reply), total };
}

const alone = await bulk();
const underLoad = [];
await echo.send.setPriority(10);
let bulkDone = false;
const loaded = bulk().finally(() => { bulkDone = true; });
while (!bulkDone) {
  underLoad.push(await pingOnce(echo, body));
  await sleep(2);
}
const withPing = await loaded;

const paths = connection.paths().map((p) => ({
  selected: p.isSelected, relay: p.isRelay, ip: p.isIp, rttMs: p.rttMs,
  lost: p.stats.lostPackets, mtu: p.stats.currentMtu,
}));
console.log(JSON.stringify({
  transport: relay ? 'quic-relay' : 'quic-direct',
  peerBind, bulkMiB,
  bindMs: Math.round(bindMs * 10) / 10,
  connectMs: summarize(connectSamples),
  rttMs: summarize(rtt),
  throughputMiBs: mibPerSecond(alone.total, alone.ms),
  integrity: alone.received === alone.total && withPing.received === withPing.total,
  rttUnderLoadMs: summarize(underLoad),
  throughputWithPingMiBs: mibPerSecond(withPing.total, withPing.ms),
  paths,
  stats: connection.stats(),
}, null, 1));
connection.close(0n, []);
await local.close();
peer.kill();
process.exit(0);
