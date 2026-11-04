// 验证离线局域网发现：不连任何服务器，靠 UDP 组播在真实网卡上互相发现并建立 QUIC。
// 信标只带账号派生的轮换标签，不带账号或设备明文，其它账号的节点认不出来。
// 用法：node poc-lan.mjs        主流程（自动拉起对端）
//      node poc-lan.mjs peer <secret> <name>
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { ALPN, addrOf, bindEndpoint, nowMs, sleep, summarize } from './lib.mjs';

const GROUP = '239.255.67.68';
const PORT = 53547;

const rotatingTag = (secret, slot) =>
  createHmac('sha256', secret).update(`agent-net-beacon/${slot}`).digest('base64url').slice(0, 16);
const currentSlot = () => Math.floor(Date.now() / 3_600_000);

function startDiscovery({ secret, endpoint, onPeer }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const port = Number(endpoint.boundSockets()[0].split(':').pop());
  const beacon = () => {
    // 身份放进轮换标签的 HMAC 里：同账号的节点能核对，旁观者只看到随机值。
    const nonce = randomBytes(8).toString('base64url');
    const id = endpoint.id().toString();
    const proof = createHmac('sha256', secret).update(`${nonce}/${id}/${port}`).digest('base64url').slice(0, 22);
    const body = JSON.stringify({ v: 1, tag: rotatingTag(secret, currentSlot()), nonce, id, port, proof });
    socket.send(body, PORT, GROUP);
  };
  socket.on('message', (data, remote) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.v !== 1 || frame.id === endpoint.id().toString()) return;
    if (frame.tag !== rotatingTag(secret, currentSlot())) return;
    const proof = createHmac('sha256', secret).update(`${frame.nonce}/${frame.id}/${frame.port}`).digest('base64url').slice(0, 22);
    if (proof !== frame.proof) return;
    onPeer({ id: frame.id, address: `${remote.address}:${frame.port}` });
  });
  socket.bind(PORT, () => {
    socket.addMembership(GROUP);
    socket.setMulticastLoopback(true);
    socket.setMulticastTTL(1);
    beacon();
  });
  const timer = setInterval(beacon, 300);
  return () => { clearInterval(timer); socket.close(); };
}

if (process.argv[2] === 'peer') {
  const endpoint = await bindEndpoint({ bindAddr: '0.0.0.0:0' });
  startDiscovery({ secret: process.argv[3], endpoint, onPeer() {} });
  console.log('ready');
  for (;;) {
    const incoming = await endpoint.acceptNext();
    if (!incoming) break;
    const connection = await (await incoming.accept()).connect();
    (async () => {
      const stream = await connection.acceptBi();
      for (;;) {
        const data = await stream.recv.readExact(64).catch(() => null);
        if (!data) return;
        await stream.send.writeAll(data);
      }
    })().catch(() => undefined);
  }
  process.exit(0);
}

const secret = randomBytes(32).toString('base64url');
const launch = async (peerSecret, name) => {
  const child = spawn(process.execPath, ['poc-lan.mjs', 'peer', peerSecret, name], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] });
  await once(createInterface({ input: child.stdout }), 'line');
  return child;
};

const sameAccount = await launch(secret, 'same');
const otherAccount = await launch(randomBytes(32).toString('base64url'), 'other');
const endpoint = await bindEndpoint({ bindAddr: '0.0.0.0:0' });
const found = new Map();
const started = nowMs();
let firstFoundMs = null;
const stop = startDiscovery({
  secret,
  endpoint,
  onPeer(peer) {
    firstFoundMs ??= nowMs() - started;
    found.set(peer.id, peer);
  },
});
await sleep(1_500);
stop();

const lines = [];
const check = (name, ok, detail) => lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
check('同账号节点被发现，另一账号的节点被忽略', found.size === 1, `发现 ${found.size} 个，耗时 ${Math.round(firstFoundMs ?? -1)}ms`);
const peer = [...found.values()][0];
if (peer) {
  const start = nowMs();
  const connection = await endpoint.connect(addrOf(peer.id, [peer.address]), ALPN);
  const connectMs = nowMs() - start;
  const stream = await connection.openBi();
  const body = Array.from({ length: 64 }, (_, i) => i);
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const t = nowMs();
    await stream.send.writeAll(body);
    await stream.recv.readExact(64);
    samples.push(nowMs() - t);
  }
  const paths = connection.paths().map((p) => `${p.remoteAddr}${p.isSelected ? '*' : ''}`);
  check('经发现到的地址建立 QUIC', true, `建连 ${Math.round(connectMs)}ms，RTT ${JSON.stringify(summarize(samples))}，路径 ${paths.join(' ')}`);
  connection.close(0n, []);
}
for (const line of lines) console.log(line);
sameAccount.kill();
otherAccount.kill();
await endpoint.close();
process.exit(lines.some((line) => line.startsWith('FAIL')) ? 1 : 0);
