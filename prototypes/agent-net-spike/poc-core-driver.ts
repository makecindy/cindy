/**
 * 验证自研核心的 Node 驱动（`packages/agent-net-core/wasm/node.mts`）里 EdgeHub 检查碰不到的部分：
 * 大块数据完整、IPv6 地址、传输途中换本地端口（告诉和不告诉连接两种）、握手被拒绝、等确认后再关。
 * 本机回环上的真实 UDP 和真实时钟，不访问外网。
 * 运行：cargo build --release -p agent-net-wasm --target wasm32-unknown-unknown（在 packages/agent-net-core 下），
 * 然后 npx tsx --tsconfig tsconfig.json poc-core-driver.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Endpoint, generateIdentity, isLinkAddress, type Address, type Connection, type RecvStream } from '../../packages/agent-net-core/wasm/node.mts';
import { mibPerSecond, nowMs, sleep } from './util.mjs';

const PROLOGUE = 'agent-net-spike/driver/1';
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];

async function check(name: string, run: () => Promise<string | void>) {
  try {
    const detail = await run();
    results.push({ check: name, ok: true, ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ check: name, ok: false, detail: String((error as Error).message ?? error).slice(0, 200) });
  }
}

function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) bytes.writeUInt32LE((i * 2654435761) >>> 0, i);
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** 数据现在发往的 UDP 地址；走通道或者还不知道时是 `null`。 */
function udpPeer(connection: Connection): Address | null {
  const address = connection.peerAddress();
  return address && !isLinkAddress(address) ? address : null;
}

/** 等对端开的第一条流收完，返回内容的哈希、长度和用时。 */
function receiveStream(server: Endpoint): Promise<{ hash: string; size: number; ms: number; connection: Connection }> {
  return new Promise((resolve) => {
    server.once('connection', (connection: Connection) => {
      connection.on('stream', (stream: RecvStream) => {
        const hash = createHash('sha256');
        let size = 0;
        const start = nowMs();
        stream.on('data', (bytes: Uint8Array) => {
          hash.update(bytes);
          size += bytes.length;
        });
        stream.on('end', () => resolve({ hash: hash.digest('hex'), size, ms: nowMs() - start, connection }));
      });
    });
  });
}

function established(connection: Connection, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timed out')), ms);
    connection.once('established', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pair(address = '127.0.0.1', admit = () => true) {
  const server = await Endpoint.create({
    identity: generateIdentity(),
    prologue: PROLOGUE,
    bind: { address },
    accept: { admit },
  });
  const client = await Endpoint.create({ identity: generateIdentity(), prologue: PROLOGUE, bind: { address } });
  return { server, client };
}

await check('32 MiB 完整送达，线上没有明文', async () => {
  const marker = Buffer.from('agent-net-plaintext-marker');
  const payload = pattern(32 * 1024 * 1024);
  for (let i = 0; i < payload.length; i += 65_536) marker.copy(payload, i);
  let leaked = 0;
  let seen = 0;
  const tap = (_direction: 'in' | 'out', datagram: Uint8Array) => {
    seen += 1;
    if (Buffer.from(datagram).includes(marker)) leaked += 1;
  };
  const server = await Endpoint.create({ identity: generateIdentity(), prologue: PROLOGUE, bind: { address: '127.0.0.1' }, accept: { admit: () => true }, tap });
  const client = await Endpoint.create({ identity: generateIdentity(), prologue: PROLOGUE, bind: { address: '127.0.0.1' }, tap });
  const received = receiveStream(server);
  const connection = client.connect(server.publicKey, server.address());
  const stream = connection.openStream();
  stream.write(payload);
  stream.finish();
  const result = await received;
  client.close();
  server.close();
  assert.equal(result.size, payload.length);
  assert.equal(result.hash, sha(payload));
  assert.equal(leaked, 0);
  return `${mibPerSecond(payload.length, result.ms)} MiB/s（收发两端同一个线程），抓到 ${seen} 个包`;
});

await check('IPv6 回环上握手和收发', async () => {
  const { server, client } = await pair('::1');
  const received = receiveStream(server);
  const connection = client.connect(server.publicKey, server.address());
  await established(connection);
  const payload = pattern(256 * 1024);
  const stream = connection.openStream();
  stream.write(payload);
  stream.finish();
  const result = await received;
  const peer = udpPeer(result.connection);
  const port = client.address().port;
  client.close();
  server.close();
  assert.equal(result.hash, sha(payload));
  assert.equal(peer?.port, port);
  assert.ok(peer?.address.endsWith(':1'), `peer=${peer?.address}`);
  return `对端地址 [${peer?.address}]:${peer?.port}`;
});

for (const notify of [true, false]) {
  await check(`传输途中换本地端口（${notify ? '告诉' : '不告诉'}连接），数据完整`, async () => {
    const { server, client } = await pair();
    const received = receiveStream(server);
    const connection = client.connect(server.publicKey, server.address());
    await established(connection);
    const payload = pattern(16 * 1024 * 1024);
    const stream = connection.openStream();
    const before = client.address().port;
    // 一半先写进去，换端口，再写另一半。
    stream.write(payload.subarray(0, payload.length / 2));
    await sleep(100);
    await client.rebind({}, notify);
    const after = client.address().port;
    stream.write(payload.subarray(payload.length / 2));
    stream.finish();
    const result = await received;
    const stats = result.connection.stats();
    const clientStats = connection.stats();
    const peer = udpPeer(result.connection);
    client.close();
    server.close();
    assert.notEqual(before, after);
    assert.equal(result.hash, sha(payload));
    assert.equal(peer?.port, after, '服务端的数据没有换到新端口');
    assert.ok((stats?.migrations ?? 0) >= 1);
    assert.ok((stats?.connectionIdRotations ?? 0) >= 1, '服务端没有给新路径换连接号');
    assert.ok((clientStats?.connectionIdRotations ?? 0) >= 1, '客户端没有换连接号');
    assert.ok((stats?.connectionIdsRetired ?? 0) >= 1, '服务端没有作废旧连接号');
    return `端口 ${before} → ${after}，服务端换路径 ${stats?.migrations} 次、换号 ${stats?.connectionIdRotations} 次，用时 ${Math.round(result.ms)}ms`;
  });
}

await check('接受规则说不，握手请求得不到任何回复', async () => {
  let asked = 0;
  const { server, client } = await pair('127.0.0.1', () => {
    asked += 1;
    return false;
  });
  const connection = client.connect(server.publicKey, server.address());
  const outcome = await established(connection, 1_000).then(
    () => 'established',
    () => 'timeout',
  );
  const serverStats = server.stats();
  const clientStats = client.stats();
  connection.close();
  client.close();
  server.close();
  assert.equal(outcome, 'timeout');
  assert.ok(asked >= 1);
  assert.equal(serverStats.datagramsSent, 0);
  assert.equal(clientStats.datagramsReceived, 0);
  return `服务端拒绝 ${serverStats.rejectedInitiations} 个请求，发出 0 个包`;
});

await check('结束流后等对端确认再关，对端收到完整数据和结束', async () => {
  const { server, client } = await pair();
  const received = receiveStream(server);
  const connection = client.connect(server.publicKey, server.address());
  const payload = pattern(4 * 1024 * 1024);
  const stream = connection.openStream();
  stream.write(payload);
  stream.finish();
  // 不等握手、不等发完，马上要求“确认后再关”。
  const closing = connection.closeWhenDrained(5_000);
  const result = await received;
  await closing;
  client.close();
  server.close();
  assert.equal(result.hash, sha(payload));
  assert.ok(connection.closed);
});

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.check}${result.detail ? `  (${result.detail})` : ''}`);
}
const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
