import { ipcMain, MessageChannelMain } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DesktopCaptureWindow } from '../remote-desktop/captureWindow';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState';
import { readBoundedFileNoFollowWithStat } from '../utils/readBoundedFile.js';
import { withCrossProcessLock } from './crossProcessLock.js';
import { createLogger } from '../logger';
import { LinkTrafficMeter, mergeTrafficBuckets, readTrafficBuckets, TICKS_PER_HOUR, type TrafficBucket } from './linkTraffic';

let current: { scope: string; meter: LinkTrafficMeter } | undefined;
let priorCheckpoint = Promise.resolve();
// Old sockets and renderer callbacks may finish after an owner change. Keep their
// original meter reachable for quit only while it has a live source or unsaved bytes.
const activeMeters = new Set<LinkTrafficMeter>();
const log = createLogger('device-link:traffic');

// Twenty-five rotating hour files cover both partial hours at the ends of a rolling day.
// A checkpoint rewrites at most 240 small rows per active hour.
const HOUR_FILES = 25;
function createMeter(previous: Promise<void>): LinkTrafficMeter {
  if (!getActiveAppSession().dataOwnerId) return new LinkTrafficMeter();
  const directory = ownerScopedUserDataPath('device-link', 'traffic-v1');
  const filename = (slot: number) => path.join(directory, `${slot}.json`);
  const cache = new Map<number, { version?: string; rows: TrafficBucket[] }>();
  const version = (stat: import('node:fs').BigIntStats) => [stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(':');
  const read = async (slot: number, checkVersion = false): Promise<TrafficBucket[]> => {
    try {
      const file = filename(slot);
      const cached = cache.get(slot);
      if (checkVersion && cached?.version && version(await fs.lstat(file, { bigint: true })) === cached.version) return cached.rows;
      const saved = await readBoundedFileNoFollowWithStat(file, 32 * 1024, { nonBlocking: true });
      if (!saved) throw new Error('Unreadable connection traffic');
      let rows: TrafficBucket[] = [];
      try {
        rows = readTrafficBuckets(JSON.parse(saved.bytes.toString('utf8')))
          .filter(row => Math.floor(row[0] / TICKS_PER_HOUR) % HOUR_FILES === slot);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Only malformed contents of a verified regular file are recoverable on the next write.
        log.warn('discarding malformed connection traffic hour');
      }
      cache.set(slot, { version: version(saved.stat), rows });
      return rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(slot); return []; }
      throw error;
    }
  };
  return new LinkTrafficMeter({
    read: async () => {
      // Returning to the same owner quickly must also see the checkpoint started on sign-out.
      await previous;
      let names: Set<string>;
      try {
        names = new Set(await fs.readdir(directory));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        cache.clear();
        return [];
      }
      const files = await Promise.allSettled(Array.from({ length: HOUR_FILES }, (_, slot) => {
        if (names.has(`${slot}.json`)) return read(slot, true);
        cache.delete(slot);
        return [];
      }));
      if (files.some(file => file.status === 'rejected')) log.warn('could not read part of connection traffic history');
      return files.flatMap((file, slot) => file.status === 'fulfilled' ? file.value : cache.get(slot)?.rows ?? []);
    },
    mergeHour: async (hour, deltas) => {
      const slot = hour % HOUR_FILES, file = filename(slot);
      await fs.mkdir(directory, { recursive: true });
      return withCrossProcessLock(file + '.lock', { label: 'connection-traffic' }, async status => {
        if (!status.held) throw new Error('Connection traffic history is busy');
        const rows = mergeTrafficBuckets(await read(slot), deltas).filter(row => Math.floor(row[0] / TICKS_PER_HOUR) === hour);
        if (!rows.length) return [];
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temp, JSON.stringify(rows), { flag: 'wx', mode: 0o600 });
          await fs.rename(temp, file);
          cache.set(slot, { rows });
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => {});
          throw error;
        }
        return rows;
      });
    },
    onError: () => log.warn('could not update connection traffic history'),
    onActivity: (meter, active) => { if (active) activeMeters.add(meter); else activeMeters.delete(meter); },
  });
}

export function currentLinkTraffic(): LinkTrafficMeter {
  // A source created during teardown has no stable owner. Its lifetime stays ephemeral.
  if (isAppSessionBoundaryPending()) return new LinkTrafficMeter();
  const scope = activeOwnerScopeKey();
  if (current?.scope !== scope) {
    if (current) priorCheckpoint = Promise.all([priorCheckpoint, current.meter.flush()]).then(() => {});
    current = { scope, meter: createMeter(priorCheckpoint) };
  }
  return current.meter;
}

const closingRtcHosts = new Set<Promise<void>>();

export async function flushLinkTraffic(): Promise<void> {
  await Promise.all(closingRtcHosts);
  const meters = new Set(activeMeters);
  if (current) meters.add(current.meter);
  await Promise.all([priorCheckpoint, ...Array.from(meters, meter => meter.flush())]);
}

/** Each renderer reports cumulative bytes to the account which registered its top frame. */
export function registerRtcTraffic(host: DesktopCaptureWindow, channels: { REGISTER: string; TRAFFIC: string; FINISH_TRAFFIC: string }) {
  const reporters = new WeakMap<Electron.WebContents, (sent: unknown, received: unknown) => void>();
  ipcMain.handle(channels.REGISTER, event => {
    host.registered(event);
    if (reporters.has(event.sender)) return;
    const meter = currentLinkTraffic();
    let lastSent = 0, lastReceived = 0;
    reporters.set(event.sender, (sent, received) => {
      if (typeof sent !== 'number' || typeof received !== 'number' || !Number.isSafeInteger(sent)
        || !Number.isSafeInteger(received) || sent < lastSent || received < lastReceived) return;
      meter.record('device-link', sent - lastSent, received - lastReceived);
      lastSent = sent;
      lastReceived = received;
    });
  });
  ipcMain.handle(channels.TRAFFIC, (event, sent: unknown, received: unknown) => {
    host.assertSender(event);
    reporters.get(event.sender)?.(sent, received);
  });
  return (contents: Electron.WebContents, destroy: () => void) => {
    const record = reporters.get(contents);
    if (!record || contents.isDestroyed()) { destroy(); return; }
    // The caller has already revoked all regular IPC. This private port can only settle this
    // renderer's own meter, even if a different account opens a replacement window immediately.
    const { port1, port2 } = new MessageChannelMain();
    let settled!: () => void;
    const closing = new Promise<void>(resolve => { settled = resolve; });
    closingRtcHosts.add(closing);
    const finish = () => {
      closingRtcHosts.delete(closing);
      settled();
      clearTimeout(timeout);
      port1.close();
      destroy();
    };
    const timeout = setTimeout(finish, 1000);
    port1.once('message', ({ data }) => { record(data?.sent, data?.received); finish(); });
    port1.start();
    try { contents.postMessage(channels.FINISH_TRAFFIC, null, [port2]); }
    catch { port2.close(); finish(); }
  };
}
