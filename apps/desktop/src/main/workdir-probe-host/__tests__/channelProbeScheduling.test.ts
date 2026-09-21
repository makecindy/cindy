import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MainProcessWorkdirProbeClient,
  type MainProcessWorkdirProbeFs,
} from '../MainProcessWorkdirProbeClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const directory = { isDirectory: () => true };
const clients: MainProcessWorkdirProbeClient[] = [];
function harness(options: { maxInFlight?: number; maxQueued?: number } = {}) {
  const fs = {
    stat: vi.fn<MainProcessWorkdirProbeFs['stat']>(async () => directory),
    realpath: vi.fn<MainProcessWorkdirProbeFs['realpath']>(async (dir) => dir),
    readdir: vi.fn<MainProcessWorkdirProbeFs['readdir']>(async () => []),
    mkdir: vi.fn<MainProcessWorkdirProbeFs['mkdir']>(async () => undefined),
    writeFile: vi.fn<MainProcessWorkdirProbeFs['writeFile']>(async () => undefined),
    rm: vi.fn<MainProcessWorkdirProbeFs['rm']>(async () => undefined),
  };
  const client = new MainProcessWorkdirProbeClient({ log: { warn: vi.fn() }, fs, ...options });
  clients.push(client);
  return { client, fs };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
});

describe('channel probes share the main-process scheduler', () => {
  it('single-flights by kind and serializes settings while reserving remote capacity', async () => {
    const { client, fs } = harness();
    const slow = deferred<string>();
    fs.realpath.mockReturnValueOnce(slow.promise);
    const validate = client.validate('/dir', '/dir', 1000);
    expect(client.validate('/dir', '/dir', 1000)).toBe(validate);
    const availability = client.availability('/dir', '/dir', 1000);
    expect(availability).not.toBe(validate);
    expect(fs.stat).not.toHaveBeenCalled();
    await expect(client.probe('/remote', '/remote', 1000)).resolves.toMatchObject({
      ok: true,
      isDirectory: true,
    });
    expect(fs.stat).toHaveBeenCalledTimes(1);
    slow.resolve('/resolved');
    await expect(validate).resolves.toEqual({ ok: true, realPath: '/resolved' });
    await expect(availability).resolves.toEqual({ ok: true, usable: true });
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('a full settings queue does not reject a runnable remote operation', async () => {
    const { client, fs } = harness({ maxQueued: 1 });
    const slow = deferred<string>();
    fs.realpath.mockReturnValueOnce(slow.promise);
    const first = client.validate('/first', '/first', 1000);
    const queued = client.availability('/queued', '/queued', 1000);
    await expect(client.availability('/overflow', '/overflow', 1000)).rejects.toMatchObject({
      code: 'WORKDIR_PROBE_UNAVAILABLE',
    });
    await expect(client.probe('/remote', '/remote', 1000)).resolves.toMatchObject({ ok: true });
    slow.resolve('/first');
    await first;
    await queued;
    // Queue rejection must not leave a stale single-flight entry.
    await expect(client.availability('/overflow', '/overflow', 1000)).resolves.toEqual({
      ok: true,
      usable: true,
    });
  });

  it.each(['probe', 'mkdir', 'realpath', 'similar'] as const)(
    'prioritizes remote %s over queued settings without changing same-class FIFO',
    async (kind) => {
      const { client, fs } = harness({ maxInFlight: 1 });
      const slow = deferred<string>();
      fs.realpath.mockReturnValueOnce(slow.promise);
      const order: string[] = [];
      const active = client.validate('/active', '/active', 1000);
      const queued = client.availability('/queued', '/queued', 1000).then(() => {
        order.push('settings');
      });
      const remote = client.probe('/remote', '/remote', 1000, kind).then(() => {
        order.push('remote');
      });
      slow.resolve('/active');
      await Promise.all([active, queued, remote]);
      expect(order).toEqual(['remote', 'settings']);
    },
  );

  it.each(['validate', 'probe'] as const)(
    'keeps timed-out %s I/O in occupancy until it actually settles',
    async (kind) => {
      vi.useFakeTimers();
      const { client, fs } = harness();
      const slow = deferred<string>();
      const slowStat = deferred<typeof directory>();
      if (kind === 'validate') fs.realpath.mockReturnValueOnce(slow.promise);
      else fs.stat.mockReturnValueOnce(slowStat.promise);
      const first = client[kind]('/slow', '/slow', 20);
      const rejected = first.catch((error) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect((await rejected).code).toBe('WORKDIR_PROBE_TIMEOUT');
      expect(client[kind]('/slow', '/slow', 1000)).toBe(first);
      const settings = client.availability('/queued', '/queued', 1000);
      expect(fs.stat.mock.calls.some(([dir]) => dir === '/queued')).toBe(false);
      await expect(client.probe('/remote', '/remote', 1000)).resolves.toMatchObject({ ok: true });
      slow.resolve('/slow');
      slowStat.resolve(directory);
      await expect(settings).resolves.toEqual({ ok: true, usable: true });
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['realpath', 'stat', 'writeFile', 'rm'] as const)(
    'bounds a stuck %s phase and cleans up only confirmed writes',
    async (phase) => {
      vi.useFakeTimers();
      const { client, fs } = harness();
      const slow = deferred<void>();
      if (phase === 'realpath')
        fs.realpath.mockImplementationOnce(async () => {
          await slow.promise;
          return '/dir';
        });
      if (phase === 'stat')
        fs.stat.mockImplementationOnce(async () => {
          await slow.promise;
          return directory;
        });
      if (phase === 'writeFile') fs.writeFile.mockImplementationOnce(() => slow.promise);
      if (phase === 'rm') fs.rm.mockImplementationOnce(() => slow.promise);
      const validation = client.validate('/dir', '/dir', 20);
      const rejected = validation.catch((error) => error);
      await vi.advanceTimersByTimeAsync(20);
      expect((await rejected).code).toBe('WORKDIR_PROBE_TIMEOUT');
      expect(client.validate('/dir', '/dir', 1000)).toBe(validation);
      const next = client.availability('/next', '/next', 1000);
      await expect(client.probe('/remote', '/remote', 1000)).resolves.toMatchObject({ ok: true });
      slow.resolve();
      await next;
      const ownsProbe = phase === 'writeFile' || phase === 'rm';
      expect(fs.writeFile).toHaveBeenCalledTimes(ownsProbe ? 2 : 1);
      expect(fs.rm).toHaveBeenCalledTimes(ownsProbe ? 2 : 1);
    },
  );

  it('uses one deadline for queue wait and execution, then permits retry after I/O settles', async () => {
    vi.useFakeTimers();
    const { client, fs } = harness();
    const firstIo = deferred<string>();
    const secondIo = deferred<string>();
    fs.realpath.mockReturnValueOnce(firstIo.promise).mockReturnValueOnce(secondIo.promise);
    const active = client.validate('/active', '/active', 1000);
    const queued = client.validate('/queued', '/queued', 100).catch((error) => error);
    await vi.advanceTimersByTimeAsync(60);
    firstIo.resolve('/active');
    await active;
    await vi.advanceTimersByTimeAsync(40);
    expect((await queued).code).toBe('WORKDIR_PROBE_TIMEOUT');
    secondIo.resolve('/queued');
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.validate('/queued', '/queued', 100)).resolves.toMatchObject({ ok: true });
  });

  it('expires queued requests without starting I/O and clears already-expired dedupe entries', async () => {
    vi.useFakeTimers();
    const { client, fs } = harness();
    const slow = deferred<string>();
    fs.realpath.mockReturnValueOnce(slow.promise);
    const active = client.validate('/active', '/active', 1000);
    const queued = client.availability('/queued', '/queued', 20).catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect((await queued).code).toBe('WORKDIR_PROBE_TIMEOUT');
    expect(fs.stat).not.toHaveBeenCalled();
    await expect(client.probe('/expired', '/expired', 0)).rejects.toMatchObject({
      code: 'WORKDIR_PROBE_TIMEOUT',
    });
    await expect(client.probe('/expired', '/expired', 100)).resolves.toMatchObject({ ok: true });
    slow.resolve('/active');
    await active;
  });

  it('disposal rejects active and queued settings and prevents late writes', async () => {
    const { client, fs } = harness();
    const slow = deferred<string>();
    fs.realpath.mockReturnValueOnce(slow.promise);
    const active = client.validate('/active', '/active', 1000).catch((error) => error);
    const queued = client.availability('/queued', '/queued', 1000).catch((error) => error);
    client.dispose();
    expect((await active).code).toBe('WORKDIR_PROBE_UNAVAILABLE');
    expect((await queued).code).toBe('WORKDIR_PROBE_UNAVAILABLE');
    slow.resolve('/active');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    await expect(client.validate('/new', '/new', 1000)).rejects.toMatchObject({
      code: 'WORKDIR_PROBE_UNAVAILABLE',
    });
  });
});
