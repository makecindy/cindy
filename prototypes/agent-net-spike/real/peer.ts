/**
 * 两台机器之间的真实网络测试。两端都先经中转（专用通道或 push 夹带）连上，再交换候选地址打洞。
 * - listen 端：回显、收上传、按要求发下载，一直运行到被关掉。
 * - dial 端：量往返、上传、下载，记录每个样本发出时走的是直连还是中转，最后打印 JSON 结果。
 * 运行：node peer.mjs <配置文件> listen|dial [agent-net|push] [udp|no-udp] [public-only]
 * `public-only` 只在发起端给：它只告诉对端自己的公网地址、也只验证对端的公网地址，两台机器在同一个局域网时强制走路由器之间的那条路。
 * 配置：{ relay: { url, servername, ca }, credentials: { "peer-a": …, "peer-b": … }, seeds: { a, b }, stun: […], devices?: { a, b } }。
 * `devices` 是两端在中转上的设备号，默认 `peer-a`、`peer-b`。
 * 输出不含 IP 地址。
 */
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicKeyOf } from '../../../packages/agent-net-core/wasm/node.mts';
import { connectAgentNetRelay, connectPushTunnel, type RelayTls } from '../relay-client.ts';
import { createCoreTransport } from '../transport-core.ts';
import type { PeerChannel } from '../transport.ts';

interface Config {
  relay: { url: string } & RelayTls;
  credentials: Record<string, string>;
  seeds: { a: string; b: string };
  stun?: string[];
  devices?: { a: string; b: string };
}

const [configPath, role, uplinkKind = 'agent-net', udpFlag = 'udp', candidateFlag = 'all'] = process.argv.slice(2);
if (!configPath || (role !== 'listen' && role !== 'dial')) throw new Error('usage: peer <config.json> listen|dial [agent-net|push] [udp|no-udp]');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const identityOf = (seed: string): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const me: 'a' | 'b' = role === 'listen' ? 'b' : 'a';
const other: 'a' | 'b' = me === 'a' ? 'b' : 'a';
const myIdentity = identityOf(config.seeds[me]);
const peerId = hex(publicKeyOf(identityOf(config.seeds[other])));
const relayId = (side: 'a' | 'b') => config.devices?.[side] ?? `peer-${side}`;

// 帧：[类型 1][长度 4，大端][内容]。
const ECHO = 1;
const ECHO_REPLY = 2;
const DATA = 3;
const DATA_END = 4;
const DATA_RECEIPT = 5;
const DOWNLOAD = 6;

function frame(type: number, payload: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function reader(onFrame: (type: number, payload: Buffer) => void): (bytes: Uint8Array) => void {
  let buffered = Buffer.alloc(0);
  return (bytes) => {
    buffered = Buffer.concat([buffered, bytes]);
    while (buffered.length >= 5) {
      const length = buffered.readUInt32BE(1);
      if (buffered.length < 5 + length) return;
      onFrame(buffered[0], buffered.subarray(5, 5 + length));
      buffered = buffered.subarray(5 + length);
    }
  };
}

const CHUNK = 60 * 1024;
function pattern(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i + 4 <= size; i += 4) bytes.writeUInt32LE((i * 2654435761) >>> 0, i);
  return bytes;
}

function sendBulk(channel: PeerChannel, size: number): string {
  const data = pattern(size);
  for (let offset = 0; offset < size; offset += CHUNK) channel.send(frame(DATA, data.subarray(offset, offset + CHUNK)));
  channel.send(frame(DATA_END, new Uint8Array()));
  return createHash('sha256').update(data).digest('hex');
}

function serve(channel: PeerChannel): void {
  let hash = createHash('sha256');
  let bytes = 0;
  channel.onData(
    reader((type, payload) => {
      if (type === ECHO) channel.send(frame(ECHO_REPLY, payload));
      else if (type === DATA) {
        hash.update(payload);
        bytes += payload.length;
      } else if (type === DATA_END) {
        channel.send(frame(DATA_RECEIPT, Buffer.from(JSON.stringify({ bytes, sha256: hash.digest('hex') }))));
        hash = createHash('sha256');
        bytes = 0;
      } else if (type === DOWNLOAD) {
        sendBulk(channel, JSON.parse(payload.toString('utf8')).bytes);
      }
    }),
  );
}

const credential = config.credentials[relayId(me)];
const uplink =
  uplinkKind === 'push'
    ? await connectPushTunnel(config.relay.url, credential, relayId(me), config.relay)
    : await connectAgentNetRelay(config.relay.url, credential, config.relay);
const startedAt = performance.now();
const transport = await createCoreTransport({
  identity: myIdentity,
  admit: (remoteId) => remoteId === peerId,
  relayIdOf: (remoteId) => (remoteId === peerId ? relayId(other) : undefined),
  onIncoming: (channel) => serve(channel),
  relay: { uplink, deviceId: relayId(me) },
  udp: udpFlag !== 'no-udp',
  bindAddress: '0.0.0.0',
  stunServers: config.stun ?? [],
  publicCandidatesOnly: candidateFlag === 'public-only',
  reprobeMs: 5_000,
});
const gatheredMs = Math.round(performance.now() - startedAt);

if (role === 'listen') {
  console.log(JSON.stringify({ role, ready: true, uplink: uplinkKind, udp: udpFlag, gatherMs: gatheredMs }));
} else {
  const summary = await runDialer(gatheredMs);
  console.log(JSON.stringify(summary, null, 1));
  await transport.close();
  process.exit(0);
}

async function runDialer(gatherMs: number) {
  const dialStart = performance.now();
  const channel = await transport.connect({ id: peerId, dial: { relayId: relayId(other) } });
  const connectMs = Math.round(performance.now() - dialStart);
  const pending = new Map<number, (value: number) => void>();
  let receipt: ((value: { bytes: number; sha256: string }) => void) | null = null;
  let download: { hash: ReturnType<typeof createHash>; bytes: number; done: (value: { bytes: number; sha256: string }) => void } | null = null;
  channel.onData(
    reader((type, payload) => {
      if (type === ECHO_REPLY) pending.get(payload.readUInt32BE(0))?.(performance.now());
      else if (type === DATA_RECEIPT) receipt?.(JSON.parse(payload.toString('utf8')));
      else if (type === DATA && download) {
        download.hash.update(payload);
        download.bytes += payload.length;
      } else if (type === DATA_END && download) download.done({ bytes: download.bytes, sha256: download.hash.digest('hex') });
    }),
  );
  const timeline: Array<{ atMs: number; path: string | null }> = [];
  let lastPath: string | null = null;
  const watch = setInterval(() => {
    const path = channel.path?.() ?? null;
    if (path !== lastPath) {
      timeline.push({ atMs: Math.round(performance.now() - dialStart), path });
      lastPath = path;
    }
  }, 5);

  let sequence = 0;
  const echoOnce = async () => {
    const id = sequence++;
    const path = channel.path?.() ?? null;
    const id4 = Buffer.alloc(4);
    id4.writeUInt32BE(id);
    const replied = new Promise<number>((resolve) => pending.set(id, resolve));
    const sentAt = performance.now();
    channel.send(frame(ECHO, id4));
    const repliedAt = await Promise.race([replied, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3_000))]);
    pending.delete(id);
    return { path, rttMs: repliedAt < 0 ? null : repliedAt - sentAt };
  };
  const sampleEcho = async (count: number, gapMs: number) => {
    const samples: Array<{ path: string | null; rttMs: number | null }> = [];
    for (let i = 0; i < count; i++) {
      samples.push(await echoOnce());
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    return samples;
  };
  const early = await sampleEcho(150, 20);
  const bulk = 16 * 1024 * 1024;
  const uploadStart = performance.now();
  const uploadPath = channel.path?.() ?? null;
  const expectedUpload = sendBulk(channel, bulk);
  const uploaded = await new Promise<{ bytes: number; sha256: string }>((resolve) => (receipt = resolve));
  const uploadMs = performance.now() - uploadStart;
  const downloadStart = performance.now();
  const downloadPath = channel.path?.() ?? null;
  const downloaded = await new Promise<{ bytes: number; sha256: string }>((resolve) => {
    download = { hash: createHash('sha256'), bytes: 0, done: resolve };
    channel.send(frame(DOWNLOAD, Buffer.from(JSON.stringify({ bytes: bulk }))));
  });
  const downloadMs = performance.now() - downloadStart;
  const late = await sampleEcho(100, 20);
  clearInterval(watch);
  const describe = (samples: Array<{ path: string | null; rttMs: number | null }>) => {
    const groups: Record<string, number[]> = {};
    let lost = 0;
    for (const sample of samples) {
      if (sample.rttMs === null) lost += 1;
      else (groups[sample.path ?? 'none'] ??= []).push(sample.rttMs);
    }
    const out: Record<string, unknown> = { lost };
    for (const [path, values] of Object.entries(groups)) {
      values.sort((a, b) => a - b);
      const at = (p: number) => Math.round(values[Math.min(values.length - 1, Math.floor(p * values.length))] * 100) / 100;
      out[path] = { n: values.length, p50: at(0.5), p95: at(0.95), max: at(1) };
    }
    return out;
  };
  const expectedDownload = createHash('sha256').update(pattern(bulk)).digest('hex');
  return {
    uplink: uplinkKind,
    udp: udpFlag,
    candidates: candidateFlag,
    gatherMs,
    connectMs,
    timeline,
    echoFirst150: describe(early),
    echoAfterBulk: describe(late),
    upload: { path: uploadPath, mbitPerSecond: Math.round(((bulk * 8) / (uploadMs / 1000) / 1e6) * 10) / 10, intact: uploaded.bytes === bulk && uploaded.sha256 === expectedUpload },
    download: { path: downloadPath, mbitPerSecond: Math.round(((bulk * 8) / (downloadMs / 1000) / 1e6) * 10) / 10, intact: downloaded.bytes === bulk && downloaded.sha256 === expectedDownload },
    relayDatagramsSent: uplink.sent,
    directAddressKind: channel.addressKind?.() ?? null,
    stats: channel.stats?.() ?? null,
  };
}
