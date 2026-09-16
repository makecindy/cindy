import { describe, it, expect, vi } from 'vitest';
import { RemoteViewerConnection } from '../connection';
import type { RemoteDesktopRequest } from '@cindy/device-link';

function fixture() {
  let owner = 'account-a:1';
  const request = vi.fn(
    async (_target: string, request: RemoteDesktopRequest, check: () => void): Promise<unknown> => {
      check();
      return request.op === 'start'
        ? { lease: 'lease-a', controlling: false, display: { id: 'screen' } }
        : { ok: true };
    },
  );
  const readClipboard = vi.fn(() => 'local text'),
    writeClipboard = vi.fn();
  const connection = new RemoteViewerConnection({
    owner: () => owner,
    request,
    readClipboard,
    writeClipboard,
  });
  connection.bind({ deviceId: 'computer-a', name: 'Computer' });
  connection.setActive(true);
  return {
    connection,
    request,
    readClipboard,
    writeClipboard,
    owner: (value: string) => {
      owner = value;
    },
  };
}
describe('standalone remote viewer authority', () => {
  it.each(['target', 'owner'])(
    'does not block a new %s behind the old scope cleanup',
    async (changed) => {
      const current = fixture();
      let resolve!: (value: unknown) => void;
      let starts = 0;
      current.request.mockImplementation(async (_target, request, check) => {
        check();
        if (request.op === 'start' && ++starts === 1)
          return new Promise((done) => {
            resolve = done;
          });
        return request.op === 'start'
          ? { lease: 'new-lease', display: { id: 'screen' }, controlling: false }
          : {};
      });
      const old = current.connection.request(current.connection.generation, {
        op: 'start',
        displayId: 'screen',
      });
      if (changed === 'owner') current.owner('account-b:2');
      current.connection.bind({
        deviceId: changed === 'target' ? 'computer-b' : 'computer-a',
        name: 'New scope',
      });
      current.connection.setActive(true);
      const latest = await current.connection.request(current.connection.generation, {
        op: 'start',
        displayId: 'screen',
      });
      expect(latest).toMatchObject({ ok: true, result: { lease: 'new-lease' } });
      resolve({ lease: 'old-lease', display: { id: 'screen' }, controlling: false });
      expect(await old).toEqual({ ok: false, code: 'DESKTOP_STOPPED' });
      expect(current.connection.snapshot().active).toBe(true);
      const stops = current.request.mock.calls.filter(([, request]) => request.op === 'stop');
      if (changed === 'owner') expect(stops).toHaveLength(0);
      else
        expect(stops.map(([target, request]) => ({ target, request }))).toEqual([
          { target: 'computer-a', request: { op: 'stop', lease: 'old-lease' } },
        ]);
    },
  );
  it('view-only cannot read or write the local clipboard even when the renderer asks', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    for (const action of ['copy', 'paste'])
      expect(await f.connection.clipboard(f.connection.generation, action)).toEqual({
        ok: false,
        code: 'DESKTOP_VIEW_ONLY',
      });
    expect(f.readClipboard).not.toHaveBeenCalled();
    expect(f.writeClipboard).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it('a control release discards a pending copy and a stale heartbeat cannot restore clipboard access', async () => {
    const f = fixture(),
      generation = f.connection.generation;
    await f.connection.request(generation, { op: 'start', displayId: 'screen' });
    f.request.mockResolvedValueOnce({ controlling: true });
    await f.connection.request(generation, { op: 'control', lease: 'lease-a', enabled: true });
    let copied!: (value: unknown) => void, heartbeat!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          copied = resolve;
        }),
    );
    const copy = f.connection.clipboard(generation, 'copy');
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          heartbeat = resolve;
        }),
    );
    const renewal = f.connection.request(generation, { op: 'heartbeat', lease: 'lease-a' });
    f.request.mockResolvedValueOnce({ controlling: false });
    await f.connection.request(generation, { op: 'control', lease: 'lease-a', enabled: false });
    heartbeat({ controlling: true });
    await renewal;
    copied({ text: 'stale remote text' });
    expect(await copy).toEqual({ ok: false, code: 'DESKTOP_VIEW_ONLY' });
    expect(f.writeClipboard).not.toHaveBeenCalled();
    expect(await f.connection.clipboard(generation, 'paste')).toEqual({
      ok: false,
      code: 'DESKTOP_VIEW_ONLY',
    });
    expect(f.readClipboard).not.toHaveBeenCalled();
  });
  it('invalidates queued signaling after a newer media attempt without closing the lease', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    const generation = f.connection.generation;
    f.connection.beginMedia(generation, '1');
    let beforeSend!: () => void;
    f.request.mockImplementationOnce(async (_peer, _body, check) => {
      beforeSend = check;
      return { sdp: 'answer' };
    });
    await f.connection.request(generation, { op: 'offer', lease: 'lease-a', sdp: 'offer' }, '1');
    f.connection.beginMedia(generation, '2');
    expect(() => beforeSend()).toThrow('DESKTOP_VIDEO_STOPPED');
    expect(f.connection.snapshot().active).toBe(true);
    const count = f.request.mock.calls.length;
    expect(
      await f.connection.request(generation, { op: 'offer', lease: 'lease-a', sdp: 'old' }, '1'),
    ).toEqual({ ok: false, code: 'DESKTOP_VIDEO_STOPPED' });
    expect(f.request).toHaveBeenCalledTimes(count);
  });
  it('releases only its lease while another desktop link remains usable', async () => {
    const { connection, request } = fixture();
    await connection.request(connection.generation, { op: 'start', displayId: 'screen' });
    connection.setActive(false);
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'computer-a',
      { op: 'stop', lease: 'lease-a' },
    ]);
    expect(
      (
        await connection.request(connection.generation, {
          op: 'input',
          lease: 'lease-a',
          sequence: 1,
          events: [{ kind: 'release' }],
        })
      ).ok,
    ).toBe(false);
    expect(connection.snapshot().resume).toBe(true);
  });
  it('retires a late successful start after the viewer closes', async () => {
    const { connection, request } = fixture();
    let finish!: (result: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = connection.request(connection.generation, { op: 'start', displayId: 'screen' });
    connection.setActive(false);
    finish({ lease: 'late-lease' });
    expect(await pending).toEqual({ ok: false, code: 'DESKTOP_STOPPED' });
    expect(request.mock.calls.at(-1)?.[1]).toEqual({ op: 'stop', lease: 'late-lease' });
  });
  it('cannot send a stale queued input or cleanup through a new account', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    const generation = f.connection.generation;
    let check!: () => void;
    f.request.mockImplementationOnce(async (_peer, _body, preSend) => {
      check = preSend;
      return null;
    });
    await f.connection.request(generation, { op: 'frame', lease: 'lease-a' });
    f.owner('account-b:2');
    expect(() => check()).toThrow('DESKTOP_STOPPED');
    const count = f.request.mock.calls.length;
    f.connection.deactivate();
    expect(f.request).toHaveBeenCalledTimes(count);
  });
  it('rejects other leases, password operations and arbitrary clipboard access', async () => {
    const { connection, request } = fixture();
    for (const message of [
      { op: 'input', lease: 'someone-else', sequence: 1, events: [] },
      { op: 'credential', version: 1, kind: 'prepare' },
      { op: 'clipboard', lease: 'someone-else', action: 'copy' },
    ])
      expect((await connection.request(connection.generation, message)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps native clipboard text out of the renderer and never replays uncertain pastes', async () => {
    const f = fixture();
    await f.connection.request(f.connection.generation, { op: 'start', displayId: 'screen' });
    f.request.mockResolvedValueOnce({ controlling: true });
    await f.connection.request(f.connection.generation, {
      op: 'control',
      lease: 'lease-a',
      enabled: true,
    });
    f.request.mockResolvedValueOnce({ text: 'remote text' });
    expect(await f.connection.clipboard(f.connection.generation, 'copy')).toEqual({
      ok: true,
      result: null,
    });
    expect(f.writeClipboard).toHaveBeenCalledWith('remote text');
    f.request.mockRejectedValueOnce(new Error('INVOKE_TIMEOUT'));
    expect(await f.connection.clipboard(f.connection.generation, 'paste')).toEqual({
      ok: false,
      code: 'INVOKE_TIMEOUT',
    });
    expect(
      f.request.mock.calls.filter(([, r]) => r.op === 'clipboard' && r.action === 'paste'),
    ).toHaveLength(1);
  });
});
