import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveScreenFramer,
  LiveScreenInputMapper,
  LiveScreenRetirement,
  LiveScreenSession,
  type LiveScreenSource,
} from '../liveScreen';

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));

const frame = (type: number, ...payload: number[]) => {
  const body = Buffer.from([type, ...payload]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
const screen = {
  plugin: 'sim',
  id: 'UDID-1',
  name: 'iPhone',
  platform: 'ios' as const,
  cornerRadius: 0,
  maxTouches: 2,
  keyboard: true,
  buttons: [],
};

describe('live screen framing', () => {
  it('reassembles messages split anywhere and copies each one', () => {
    const framer = new LiveScreenFramer();
    const bytes = Buffer.concat([frame(0x10, 1, 2), frame(0x02, 3)]);
    const out = [
      ...framer.push(bytes.subarray(0, 3)),
      ...framer.push(bytes.subarray(3, 9)),
      ...framer.push(bytes.subarray(9)),
    ];
    expect(out.map((m) => [...m])).toEqual([
      [0x10, 1, 2],
      [0x02, 3],
    ]);
    expect(out[0].buffer.byteLength).toBe(3);
  });

  it('rejects empty and oversized messages', () => {
    expect(() => new LiveScreenFramer().push(Buffer.from([0, 0, 0, 0]))).toThrow(
      'DESKTOP_SCREEN_FRAME_INVALID',
    );
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(9 * 1024 * 1024);
    expect(() => new LiveScreenFramer().push(huge)).toThrow('DESKTOP_SCREEN_FRAME_INVALID');
  });
});

describe('live screen input mapping', () => {
  it('turns keyboard downs into device keys with held modifiers, and refuses desktop pointers', () => {
    const mapper = new LiveScreenInputMapper();
    expect(
      mapper.map([
        { kind: 'key', code: 'ShiftLeft', down: true },
        { kind: 'key', code: 'KeyA', down: true },
        { kind: 'key', code: 'KeyA', down: false },
        { kind: 'key', code: 'ShiftLeft', down: false },
        { kind: 'key', code: 'Enter', down: true },
        { kind: 'text', text: '好' },
        { kind: 'press', button: 'home' },
        { kind: 'release' },
      ]),
    ).toEqual([
      { kind: 'key', code: 'KeyA', modifiers: ['shift'] },
      { kind: 'key', code: 'Enter' },
      { kind: 'text', text: '好' },
      { kind: 'press', button: 'home' },
      { kind: 'release' },
    ]);
    expect(() => mapper.map([{ kind: 'scroll', dx: 0, dy: 1 }])).toThrow('INVALID_REQUEST');
  });
});

describe('live screen session', () => {
  let server: http.Server | null = null;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = null;
  });
  const serve = async (write: (res: http.ServerResponse) => void) => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      write(res);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/live/token`;
  };
  const source = (url: string): LiveScreenSource & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      open: vi.fn(async () => ({ url, screen: { ...screen, width: 10, height: 20 } })),
      input: vi.fn(async (...args: unknown[]) => {
        calls.push(['input', ...args]);
      }),
      control: vi.fn(async (...args: unknown[]) => {
        calls.push(['control', ...args]);
      }),
      close: vi.fn(async (...args: unknown[]) => {
        calls.push(['close', ...args]);
      }),
    };
  };

  it('delivers messages in order to the pulling page and reports the end of the stream', async () => {
    let response: http.ServerResponse | null = null;
    const url = await serve((res) => {
      response = res;
      res.write(Buffer.concat([frame(0x10, 7), frame(0x01, 1), frame(0x02, 2)]));
    });
    const plugin = source(url);
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    await session.connect();
    const first = await session.pull(1000);
    const rest = first!.length < 3 ? await session.pull(1000) : [];
    expect([...first!, ...rest!].map((m) => m[0])).toEqual([0x10, 0x01, 0x02]);
    expect(await session.pull(30)).toEqual([]);
    response!.end();
    expect(await session.pull(1000)).toBeNull();
    session.close();
  });

  it('reports the upright shape the plugin last described', async () => {
    const described = (value: object) => {
      const json = Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(5);
      header.writeUInt32BE(json.length + 1, 0);
      header[4] = 0x10;
      return Buffer.concat([header, json]);
    };
    const url = await serve((res) => {
      res.write(described({ type: 'screen', width: 1206, height: 2622, rotation: 0 }));
      res.write(described({ type: 'screen', width: 1206, height: 2622, rotation: 3 }));
    });
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      source(url),
      vi.fn(),
    );
    expect(session.shape).toBeNull();
    await session.connect();
    await session.pull(1000);
    if (session.shape?.width !== 2622) await session.pull(1000);
    expect(session.shape).toEqual({ width: 2622, height: 1206 });
    session.close();
  });

  it('asks for a keyframe and drops stale deltas when the page lost its decoder', async () => {
    let response: http.ServerResponse | null = null;
    const url = await serve((res) => {
      response = res;
    });
    const plugin = source(url);
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    await session.connect();
    response!.write(frame(0x03, 1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await session.pull(10, true)).toEqual([]);
    expect(plugin.control).toHaveBeenCalledWith('sim', 'UDID-1', { keyframe: true });
    response!.write(Buffer.concat([frame(0x03, 2), frame(0x02, 3), frame(0x03, 4)]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await session.pull(1000))!.map((m) => [...m])).toEqual([
      [0x02, 3],
      [0x03, 4],
    ]);
    session.close();
  });

  it('opens a fresh stream for a later offer and lifts held contacts before closing', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    await session.connect();
    expect(plugin.open).not.toHaveBeenCalled();
    await session.connect();
    expect(plugin.open).toHaveBeenCalledOnce();
    session.input([{ kind: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, phase: 'began' }] }]);
    session.close();
    await vi.waitFor(() => expect(plugin.calls.at(-1)?.[0]).toBe('close'));
    expect(plugin.calls.filter((call) => call[0] === 'input').map((call) => call[3])).toEqual([
      [{ kind: 'touch', touches: [{ id: 0, x: 0.5, y: 0.5, phase: 'began' }] }],
      [{ kind: 'release' }],
    ]);
    await expect(session.connect()).rejects.toThrow('DESKTOP_SCREEN_ENDED');
  });

  it('ends at once when a later offer finds the device shut down, but not on a passing failure', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    const ended = vi.fn();
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      ended,
    );
    await session.connect();
    vi.mocked(plugin.open).mockRejectedValueOnce(new Error('DESKTOP_SCREEN_TIMEOUT'));
    await expect(session.connect()).rejects.toThrow('DESKTOP_SCREEN_TIMEOUT');
    expect(ended).not.toHaveBeenCalled();
    vi.mocked(plugin.open).mockRejectedValueOnce(new Error('DESKTOP_SCREEN_NOT_RUNNING'));
    await expect(session.connect()).rejects.toThrow('DESKTOP_SCREEN_NOT_RUNNING');
    expect(ended).toHaveBeenCalledOnce();
    await expect(session.connect()).rejects.toThrow('DESKTOP_SCREEN_ENDED');
  });

  it('when the plugin ends the stream, ends with a stopped device and reopens a running one', async () => {
    let response: http.ServerResponse | null = null;
    const url = await serve((res) => {
      response = res;
    });
    const plugin = source(url);
    const ended = vi.fn();
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      ended,
    );
    await session.connect();
    await vi.waitFor(() => expect(response).not.toBeNull());
    // Still running (the plugin restarted): opened again, and the next offer uses it.
    response!.end();
    await vi.waitFor(() => expect(plugin.open).toHaveBeenCalledOnce());
    await session.connect();
    expect(plugin.open).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    // Shut down: the session ends without waiting for the viewer's next offer.
    vi.mocked(plugin.open).mockRejectedValueOnce(new Error('DESKTOP_SCREEN_NOT_RUNNING'));
    response!.end();
    await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
  });

  it('settles close only after input in flight and the plugin close, so a reopen cannot be closed late', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    let release!: () => void;
    vi.mocked(plugin.input).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    session.input([{ kind: 'press', button: 'home' }]);
    let settled = false;
    const closing = session.close().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(plugin.close).not.toHaveBeenCalled();
    release();
    await closing;
    expect(plugin.close).toHaveBeenCalledOnce();
    expect(session.close()).toBe(session.close());
  });

  it('forgets held modifiers when control ends, touching or not', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    session.input([{ kind: 'key', code: 'ShiftLeft', down: true }]);
    session.release();
    session.input([{ kind: 'key', code: 'KeyA', down: true }]);
    await vi.waitFor(() => expect(plugin.calls.some((call) => call[0] === 'input')).toBe(true));
    expect(plugin.calls.find((call) => call[0] === 'input')?.[3]).toEqual([
      { kind: 'key', code: 'KeyA' },
    ]);
    session.close();
  });

  it('keeps every closing session pending, however it ended, until the plugin has closed it', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    let release!: () => void;
    vi.mocked(plugin.input).mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    session.input([{ kind: 'press', button: 'home' }]);
    const retirement = new LiveScreenRetirement();
    retirement.retire(session);
    let settled = false;
    const done = retirement.settled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await done;
    expect(plugin.close).toHaveBeenCalledOnce();
  });

  it('keeps only the latest position of a moving finger while a send is in flight', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    let unblock!: () => void;
    vi.mocked(plugin.input).mockImplementationOnce(async (...args: unknown[]) => {
      plugin.calls.push(['input', ...args]);
      await new Promise<void>((resolve) => (unblock = resolve));
    });
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    const touch = (phase: string, x: number) =>
      ({ kind: 'touch', touches: [{ id: 0, x, y: 0.5, phase }] }) as never;
    session.input([touch('began', 0.1)]);
    // A 120 Hz phone keeps sampling while the device takes the first batch.
    for (let i = 1; i <= 50; i++) session.input([touch('moved', 0.1 + i / 100)]);
    session.input([touch('ended', 0.6)]);
    unblock();
    await vi.waitFor(() => expect(plugin.input).toHaveBeenCalledTimes(2));
    const sent = plugin.calls.map(
      (call) => call[3] as { touches: { x: number; phase: string }[] }[],
    );
    expect(sent[1].map((event) => event.touches[0].phase)).toEqual(['moved', 'ended']);
    expect(sent[1][0].touches[0].x).toBeCloseTo(0.6);
    session.close();
  });

  it('merges input that arrives during a send and drops typing the device cannot keep up with', async () => {
    const url = await serve(() => {});
    const plugin = source(url);
    let unblock!: () => void;
    vi.mocked(plugin.input).mockImplementationOnce(async (...args: unknown[]) => {
      plugin.calls.push(['input', ...args]);
      await new Promise<void>((resolve) => (unblock = resolve));
    });
    const session = new LiveScreenSession(
      'sim',
      'UDID-1',
      screen,
      { width: 10, height: 20 },
      { url, screen: { ...screen, width: 10, height: 20 } },
      plugin,
      vi.fn(),
    );
    const key = (code: string) => ({ kind: 'key' as const, code, down: true });
    session.input([key('KeyQ')]);
    // A held key repeating far faster than the device types.
    for (let i = 0; i < 100; i++) session.input([key('KeyA')]);
    session.input([{ kind: 'press', button: 'home' }]);
    const flood = Array.from({ length: 513 }, () => ({ kind: 'press' as const, button: 'home' }));
    expect(() => session.input(flood)).toThrow('DESKTOP_INPUT_BUSY');
    unblock();
    await vi.waitFor(() => expect(plugin.input).toHaveBeenCalledTimes(2));
    const sent = plugin.calls.map((call) => call[3] as { kind: string; code?: string }[]);
    expect(sent[0]).toEqual([{ kind: 'key', code: 'KeyQ' }]);
    expect(sent[1]).toHaveLength(33);
    expect(sent[1].filter((event) => event.code === 'KeyA')).toHaveLength(32);
    expect(sent[1].at(-1)).toEqual({ kind: 'press', button: 'home' });
    session.close();
  });
});
