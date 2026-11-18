/**
 * 经中转吞吐的瓶颈定位（docs/agent-net-session-plan.md 第 7 节第 7 项）。
 *
 * 同一条限速线路上，被控端向控制端传 1 MiB，两种走法对照：
 *  - deviceLink：今天的生产路径，DeviceLinkClient 的可靠传输回传一条 invoke 结果；
 *  - raw：绕过 Device Link，把同样 1 MiB 作为一帧直接写进 Agent-Net 连接。
 * raw 快、deviceLink 慢，瓶颈在 Device Link 的发送控制；两个都慢，瓶颈在 Agent-Net 核心或中转路径。
 * worker（Desktop 独立线程 + Main 代理）与 portable（当前线程）各跑一遍，区分线程间转发的开销。
 *
 * 每 100 ms 采样：被控端上行的线路字节、被控端 socket 缓冲字节、Device Link 发往对端的待确认队列与阻塞原因、
 * 核心的往返与带宽估计（portable 读完整统计，worker 只能读往返）。
 *
 * 运行（仓库根目录）：
 *   pnpm --filter @cindy/agent-net run prepare-core
 *   node --import tsx packages/agent-net/bench/throughput-probe.ts [--profiles unshaped,fast,slow] [--modes worker,portable] [--reps 2] [--out probe.json]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PROTOCOL_VERSION } from '@cindy/device-link';
import { PROFILES, BULK_BYTES, BULK_CHANNEL, TAP_CHANNEL, argument, setup, sleep, type Fixture, type SocketMode, type LinkProfile } from './harness.js';

const TRANSFER_TIMEOUT_MS = 120_000;
const RAW_CHANNEL = 'bench:raw';

interface Sample {
  t: number;
  wire: number;
  socketBuffered: number;
  dlPending: number | null;
  dlPendingBytes: number | null;
  dlLocalPressure: boolean | null;
  dlBlockedBy: Record<string, number> | null;
  rttMs: number | null;
  bandwidthBps: number | null;
  retransmitted: number | null;
  packetsSent: number | null;
}

/** down：被控端发、控制端收；up：控制端发、被控端收。 */
type Direction = 'down' | 'up';
const sender = (direction: Direction) => direction === 'down'
  ? { role: 'host' as const, peer: 'b-controller', receiverRole: 'controller' as const }
  : { role: 'controller' as const, peer: 'a-host', receiverRole: 'host' as const };
const senderWire = (f: Fixture, direction: Direction) => direction === 'down' ? f.meters.hostUp.bytes : f.meters.controllerUp.bytes;

/** 只读诊断：私有字段，不改任何状态。采样的是发送一方。 */
function sample(f: Fixture, direction: Direction, t0: number, wireBase: number): Sample {
  const side = sender(direction);
  const socket = f.socket(side.role) as unknown as {
    bufferedAmount?: number;
    peerSnapshot?(id: string): { rttMs?: number } | null;
    peers?: Map<string, { channel?: { stats?(): Record<string, number> | null } }>;
  };
  const core = socket.peers?.get(side.peer)?.channel?.stats?.() ?? null;
  const dl = (side.role === 'host' ? f.host : f.controller) as unknown as {
    peerTransport?: Map<string, { pending?: Map<number, { lastBlockedBy?: string }>; pendingBytes?: number }>;
    localSendPressure?: boolean;
  };
  const peer = dl.peerTransport?.get(side.peer);
  let blockedBy: Record<string, number> | null = null;
  if (peer?.pending) {
    blockedBy = {};
    for (const pending of peer.pending.values()) {
      const key = pending.lastBlockedBy ?? 'none';
      blockedBy[key] = (blockedBy[key] ?? 0) + 1;
    }
  }
  return {
    t: Math.round(performance.now() - t0),
    wire: senderWire(f, direction) - wireBase,
    socketBuffered: socket.bufferedAmount ?? 0,
    dlPending: peer?.pending?.size ?? null,
    dlPendingBytes: peer?.pendingBytes ?? null,
    dlLocalPressure: dl.localSendPressure ?? null,
    dlBlockedBy: blockedBy,
    rttMs: core ? core.srttUs / 1000 : socket.peerSnapshot?.(side.peer)?.rttMs ?? null,
    bandwidthBps: core ? core.bandwidth : null,
    retransmitted: core ? core.retransmittedSegments : null,
    packetsSent: core ? core.packetsSent : null,
  };
}

/** `--taps`：传输期间每 500 ms 发一个小的交互请求（和基线一样），看小消息会不会拖慢大传输。 */
const WITH_TAPS = process.argv.includes('--taps');

async function transfer(f: Fixture, kind: 'deviceLink' | 'raw', direction: Direction) {
  const side = sender(direction);
  const wireBase = senderWire(f, direction);
  const t0 = performance.now();
  const samples: Sample[] = [];
  const timer = setInterval(() => samples.push(sample(f, direction, t0, wireBase)), 100);
  let tapIndex = 0;
  const tapTimer = WITH_TAPS ? setInterval(() => {
    void f.request({ channel: TAP_CHANNEL, args: [`probe-${tapIndex++}`] }, TRANSFER_TIMEOUT_MS).catch(() => undefined);
  }, 500) : null;
  let ok = true, error: string | undefined;
  try {
    if (kind === 'deviceLink') {
      const result = await f.request({
        channel: BULK_CHANNEL, args: direction === 'down' ? ['down'] : ['up', f.bulkPayload],
      }, TRANSFER_TIMEOUT_MS);
      if (!result.ok) { ok = false; error = result.error.code; }
    } else {
      const receiver = f.socket(side.receiverRole) as unknown as {
        on(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
        off(event: 'message', listener: (raw: { toString(): string }) => void): unknown;
      };
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => { receiver.off('message', listener); reject(new Error('RAW_TIMEOUT')); }, TRANSFER_TIMEOUT_MS);
        function listener(raw: { toString(): string }) {
          const text = raw.toString();
          if (!text.includes(`"${RAW_CHANNEL}"`)) return;
          clearTimeout(deadline); receiver.off('message', listener); resolve();
        }
        receiver.on('message', listener);
        f.socket(side.role).send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', dst: side.peer,
          payload: { channel: RAW_CHANNEL, args: [f.bulkPayload] } }));
      });
    }
  } catch (cause) {
    ok = false; error = (cause as { code?: string; message?: string }).code ?? (cause as Error).message;
  } finally {
    clearInterval(timer);
    if (tapTimer) clearInterval(tapTimer);
  }
  const ms = performance.now() - t0;
  samples.push(sample(f, direction, t0, wireBase));
  return { kind, direction, ok, error, ms: Math.round(ms), samples };
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function summarize(profile: LinkProfile, result: Awaited<ReturnType<typeof transfer>>) {
  const s = result.samples;
  const last = s[s.length - 1];
  const first = s[0];
  const kbps = BULK_BYTES / 1024 / (result.ms / 1000);
  const blocked: Record<string, number> = {};
  for (const item of s) for (const [key, count] of Object.entries(item.dlBlockedBy ?? {})) blocked[key] = (blocked[key] ?? 0) + count;
  return {
    kind: result.kind, direction: result.direction, ok: result.ok, error: result.error, ms: result.ms,
    throughputKiBps: Math.round(kbps),
    linkUtilization: profile.rateBytesPerSec >= 1e9 ? null : Number(((BULK_BYTES / (result.ms / 1000)) / profile.rateBytesPerSec).toFixed(2)),
    wireRatio: Number((last.wire / BULK_BYTES).toFixed(2)),
    peakSocketBufferedKiB: Math.round(Math.max(...s.map((item) => item.socketBuffered)) / 1024),
    medianSocketBufferedKiB: Math.round((median(s.map((item) => item.socketBuffered)) ?? 0) / 1024),
    peakDlPending: Math.max(...s.map((item) => item.dlPending ?? 0)),
    dlLocalPressureShare: Number((s.filter((item) => item.dlLocalPressure).length / s.length).toFixed(2)),
    dlBlockedBySamples: blocked,
    medianRttMs: median(s.map((item) => item.rttMs ?? NaN)),
    maxRttMs: Math.max(...s.map((item) => item.rttMs ?? 0)),
    medianBandwidthKiBps: (() => { const value = median(s.map((item) => item.bandwidthBps ?? NaN)); return value === null ? null : Math.round(value / 1024); })(),
    retransmittedSegments: last.retransmitted !== null && first.retransmitted !== null ? last.retransmitted - first.retransmitted : null,
    packetsSent: last.packetsSent !== null && first.packetsSent !== null ? last.packetsSent - first.packetsSent : null,
  };
}

async function main() {
  const profiles = (argument('--profiles') ?? 'unshaped,fast,slow').split(',').map((name) => {
    const profile = PROFILES[name];
    if (!profile) throw new Error('UNKNOWN_PROFILE ' + name);
    return profile;
  });
  const modes = (argument('--modes') ?? 'worker,portable').split(',') as SocketMode[];
  const reps = Number(argument('--reps') ?? 2);
  const directions = (argument('--directions') ?? 'down').split(',') as Direction[];
  /** `--cold <kind>`：每个网络只传一次，单独看冷连接；`--prelude <秒>`：传之前先只发小请求这么久，模拟连接上长时间只有零散消息。 */
  const coldKind = argument('--cold') as 'deviceLink' | 'raw' | undefined;
  const preludeMs = Number(argument('--prelude') ?? 0) * 1000;
  /** `--after-reverse`：冷连接上先在反方向用 Device Link 传一次 1 MiB，再测这一次（复现基线里 down 之后紧跟 up）。 */
  const afterReverse = process.argv.includes('--after-reverse');
  const module = await WebAssembly.compile(await readFile(new URL('../../agent-net-core/dist/core.wasm', import.meta.url)));
  const results: unknown[] = [];
  for (const profile of profiles) {
    for (const mode of modes) {
      // 每个方向单独建网络：两个方向的核心连接、拥塞状态互不影响，各自从冷连接起步。
      for (const direction of directions) {
        if (coldKind) {
          for (let rep = 1; rep <= reps; rep++) {
            const f = await setup(profile, module, mode);
            try {
              for (let index = 0; index * 500 < preludeMs; index++) {
                void f.request({ channel: TAP_CHANNEL, args: [`prelude-${index}`] }, TRANSFER_TIMEOUT_MS).catch(() => undefined);
                await sleep(500);
              }
              let reverse: ReturnType<typeof summarize> | null = null;
              if (afterReverse) {
                await sleep(1000);
                reverse = summarize(profile, await transfer(f, 'deviceLink', direction === 'up' ? 'down' : 'up'));
              }
              await sleep(1000);
              const result = await transfer(f, coldKind, direction);
              const summary = summarize(profile, result);
              results.push({ profile, mode, rep, preludeMs, reverse, summary, samples: result.samples });
              console.log(JSON.stringify({ profile: profile.name, mode, rep, preludeMs, reverseMs: reverse?.ms ?? null, ...summary }));
            } finally {
              await f.close();
            }
          }
          continue;
        }
        const f = await setup(profile, module, mode);
        try {
          for (let rep = 1; rep <= reps; rep++) {
            // 先传的一方要从冷连接起步（拥塞窗口和带宽估计还没涨上来），所以每轮交换先后。
            const order = rep % 2 === 1 ? (['deviceLink', 'raw'] as const) : (['raw', 'deviceLink'] as const);
            for (const kind of order) {
              await sleep(1000);
              const result = await transfer(f, kind, direction);
              const summary = summarize(profile, result);
              results.push({ profile, mode, rep, summary, samples: result.samples });
              console.log(JSON.stringify({ profile: profile.name, mode, rep, ...summary }));
            }
          }
        } finally {
          await f.close();
        }
      }
    }
  }
  const out = argument('--out');
  if (out) await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform}-${process.arch}`, bulkBytes: BULK_BYTES, results }, null, 2) + '\n');
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
