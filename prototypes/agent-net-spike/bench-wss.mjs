// 基线：模拟 v1 的路径形状。A → 中转 → B 共用一条连接，
// 大块数据按 128 KiB 目标大小切片、base64 进 JSON，和交互消息排在同一条 FIFO 里。
// 本地不开 TLS，对 WSS 一侧是有利条件；真实 v1 还要多一层加解密。
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
import { mibPerSecond, nowMs, sleep, summarize } from './lib.mjs';

const bulkMiB = Number(process.argv[2] ?? 64);
const CHUNK = 128 * 1024;

if (process.argv[2] === '--relay') {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 4 * 1024 * 1024 });
  const peers = new Map();
  server.on('connection', (socket, request) => {
    const id = new URL(request.url, 'http://x').searchParams.get('id');
    peers.set(id, socket);
    socket.on('message', (data) => {
      // 与 hub.ts 相同：解析路由头，覆写 src，再序列化转发。
      const frame = JSON.parse(data.toString());
      peers.get(frame.dst)?.send(JSON.stringify({ ...frame, src: id }));
    });
  });
  await once(server, 'listening');
  process.send({ port: server.address().port });
} else if (process.argv[2] === '--peer') {
  const socket = new WebSocket(`ws://127.0.0.1:${process.argv[3]}/?id=b`);
  await once(socket, 'open');
  let total = 0;
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind === 'ping') socket.send(JSON.stringify({ kind: 'pong', dst: 'a', id: frame.id, payload: frame.payload }));
    if (frame.kind === 'bulk') total += Buffer.from(frame.payload, 'base64').length;
    if (frame.kind === 'bulk-end') socket.send(JSON.stringify({ kind: 'bulk-done', dst: 'a', payload: total }));
    if (frame.kind === 'bulk-end') total = 0;
  });
  process.send({ ready: true });
} else {
  const relay = fork(import.meta.filename, ['--relay']);
  const [{ port }] = await once(relay, 'message');
  const peer = fork(import.meta.filename, ['--peer', String(port)]);
  await once(peer, 'message');

  const connectSamples = [];
  for (let i = 0; i < 20; i++) {
    const start = nowMs();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?id=probe${i}`);
    await once(socket, 'open');
    connectSamples.push(nowMs() - start);
    socket.close();
  }

  // 可选瓶颈：LINK="Mbit 单向ms 队列ms"，放在 A 与中转之间，和 QUIC 组用同一段链路。
  let dialPort = port;
  let shaper = null;
  if (process.env.LINK) {
    shaper = spawn(process.env.SHAPER, ['shape-tcp', '127.0.0.1:0', `127.0.0.1:${port}`, ...process.env.LINK.split(' ')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const [line] = await once(createInterface({ input: shaper.stdout }), 'line');
    dialPort = JSON.parse(line).port;
  }
  const socket = new WebSocket(`ws://127.0.0.1:${dialPort}/?id=a`);
  await once(socket, 'open');
  const waiting = new Map();
  let bulkResolve = null;
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.kind === 'pong') waiting.get(frame.id)?.();
    if (frame.kind === 'bulk-done') bulkResolve?.(frame.payload);
  });
  let seq = 0;
  const pingBody = 'x'.repeat(64);
  const ping = () => new Promise((resolve) => {
    const id = ++seq;
    const start = nowMs();
    waiting.set(id, () => { waiting.delete(id); resolve(nowMs() - start); });
    socket.send(JSON.stringify({ kind: 'ping', dst: 'b', id, payload: pingBody }));
  });
  const rtt = [];
  for (let i = 0; i < 500; i++) rtt.push(await ping());

  const piece = Buffer.alloc(CHUNK, 7).toString('base64');
  async function bulk() {
    const total = bulkMiB * 1024 * 1024;
    const start = nowMs();
    const done = new Promise((resolve) => { bulkResolve = resolve; });
    for (let sent = 0; sent < total; sent += CHUNK) {
      socket.send(JSON.stringify({ kind: 'bulk', dst: 'b', payload: piece }));
      // v1 的背压：本地缓冲超过 128 KiB 时暂停数据写入。
      while (socket.bufferedAmount > 128 * 1024) await sleep(1);
    }
    socket.send(JSON.stringify({ kind: 'bulk-end', dst: 'b' }));
    const received = await done;
    return { ms: nowMs() - start, received, total };
  }
  const alone = await bulk();
  const underLoad = [];
  let bulkDone = false;
  const loaded = bulk().finally(() => { bulkDone = true; });
  while (!bulkDone) {
    underLoad.push(await ping());
    await sleep(20);
  }
  const withPing = await loaded;
  console.log(JSON.stringify({
    transport: 'wss-relay-shape (no TLS, loopback)', bulkMiB,
    connectMs: summarize(connectSamples),
    rttMs: summarize(rtt),
    throughputMiBs: mibPerSecond(alone.total, alone.ms),
    integrity: alone.received >= alone.total && withPing.received >= withPing.total,
    rttUnderLoadMs: summarize(underLoad),
    throughputWithPingMiBs: mibPerSecond(withPing.total, withPing.ms),
  }, null, 1));
  socket.close(); relay.kill(); peer.kill(); shaper?.kill();
  process.exit(0);
}
