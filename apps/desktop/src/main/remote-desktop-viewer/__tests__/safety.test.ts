import { expect, it, vi } from 'vitest';
import {
  ClipboardSync,
  type RemoteDesktopCapabilities,
  type RemoteDesktopRequest,
} from '@cindy/device-link';
import { DEFAULT_VIEWER_PREFERENCES } from '../../../shared/remoteDesktopViewer';
import { ViewerSafety } from '../safety';

it.each([
  ['CLIPBOARD_UNSUPPORTED', 'clipboardSyncSkipped'],
  ['CLIPBOARD_TOO_LONG', 'clipboardSyncTooLarge'],
] as const)(
  'distinguishes %s and clears its notice after a new empty snapshot',
  async (code, notice) => {
    const { safety, sync } = syncFixture();
    let version = '1';
    let error = code as string;
    const json = '{"text":"remote"}';
    const options: Parameters<ViewerSafety['tick']>[0] = {
      ...sync,
      caps: { ...sync.caps, clipboardInline: true },
      clipboard: {
        version: async () => version,
        read: async () => {
          throw new Error(error);
        },
        write: vi.fn(),
      },
      request: (async (message: RemoteDesktopRequest) => {
        if (message.op === 'clipboardVersion') return { version: '1' };
        if (message.op === 'clipboardContent') return { data: json, length: json.length };
        return { enabled: true };
      }) as Parameters<ViewerSafety['tick']>[0]['request'],
    };
    expect((await safety.tick(options)).notice).toBeNull();
    version = '2';
    expect((await safety.tick(options)).notice).toBe(notice);
    const first = safety.snapshot().clipboardNoticeVersion;
    expect(first).toBeGreaterThan(0);
    expect((await safety.tick(options)).clipboardNoticeVersion).toBe(first);
    version = '3';
    const repeated = await safety.tick(options);
    expect(repeated.notice).toBe(notice);
    expect(repeated.clipboardNoticeVersion).toBe(first! + 1);
    expect((await safety.tick(options)).clipboardNoticeVersion).toBe(
      repeated.clipboardNoticeVersion,
    );
    version = '4';
    error = 'CLIPBOARD_EMPTY';
    expect((await safety.tick(options)).notice).toBeNull();
  },
);

function fixture() {
  const safety = new ViewerSafety();
  const request = vi.fn(async () => ({ enabled: true })) as any;
  const options = {
    lease: 'lease',
    caps: { privacyScreen: true, hostMute: true, clipboardSync: true } as RemoteDesktopCapabilities,
    preferences: { ...DEFAULT_VIEWER_PREFERENCES, privacyScreen: true, hostMute: true },
    current: () => true,
    clipboardCurrent: () => false,
    request,
  };
  return { safety, options, request };
}
it('applies preferences once and prioritizes privacy failures over mute failures', async () => {
  const { safety, options, request } = fixture();
  request.mockRejectedValue(new Error('DESKTOP_UNAVAILABLE'));
  expect((await safety.tick(options)).notice).toBe('privacyFailed');
  const count = request.mock.calls.length;
  await safety.tick(options);
  expect(request.mock.calls.length).toBe(count);
  safety.invalidate();
  request.mockResolvedValue({ enabled: true });
  expect(await safety.tick(options)).toMatchObject({ privacyActive: true, notice: null });
});
it('does not apply opt-ins without confirmed control', async () => {
  const { safety, options, request } = fixture();
  await safety.tick({ ...options, current: () => false });
  expect(request).not.toHaveBeenCalled();
});
it('background passes preserve privacy state and do not retry failed mute settings', async () => {
  const { safety, options, request } = fixture();
  request.mockImplementation(async (message: { op: string }) => {
    if (message.op === 'hostMute') throw new Error('DESKTOP_UNAVAILABLE');
    return { enabled: true };
  });
  await safety.tick(options);
  const before = safety.snapshot();
  await safety.tick(options);
  expect(safety.snapshot()).toEqual(before);
  expect(
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'privacyScreen'),
  ).toHaveLength(1);
  expect(
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'hostMute'),
  ).toHaveLength(1);
});
it('pauses until old work settles and discards its late success', async () => {
  const { safety, options, request } = fixture();
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = safety.tick(options);
  let paused = false;
  const pause = safety.pause().then(() => {
    paused = true;
  });
  await Promise.resolve();
  expect(paused).toBe(false);
  finish({ enabled: true });
  await Promise.all([pending, pause]);
  expect(safety.snapshot()).toMatchObject({ privacyActive: false, notice: null });
  expect(request).toHaveBeenCalledTimes(1);
});

it('authority invalidation keeps a stopped read from updating the notice or failure count', async () => {
  const { safety, options } = fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  let fail!: (error: Error) => void;
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  const sync = {
    ...options,
    preferences: { ...options.preferences, clipboardSync: true },
    clipboardCurrent: () => true,
    clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
  };
  try {
    const stale = safety.tick(sync);
    await vi.waitFor(() => expect(tick).toHaveBeenCalledTimes(1));
    const paused = safety.pause();
    // Pausing stops the in-flight read, which then reports the clipboard as unavailable.
    fail(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
    expect((await stale).notice).toBeNull();
    await paused;
    expect(safety.snapshot().notice).toBeNull();

    // The stale result was not counted: the first real failure backs off 1.5s, not 3s.
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncFailed');
    now.mockReturnValue(12000);
    await safety.tick(sync);
    expect(tick).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

function syncFixture() {
  const { safety, options, request } = fixture();
  const clipboardEnables = () =>
    request.mock.calls.filter(([message]: [{ op: string }]) => message.op === 'clipboardSync');
  return {
    safety,
    request,
    clipboardEnables,
    sync: {
      ...options,
      preferences: { ...options.preferences, clipboardSync: true },
      clipboardCurrent: () => true,
      clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
    },
  };
}

it('background passes keep the computer sync enabled without reading clipboard contents', async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const tick = vi.spyOn(ClipboardSync.prototype, 'tick').mockResolvedValue(undefined);
  try {
    await safety.tick(sync);
    await safety.tick({ ...sync, clipboardCurrent: () => false });
    expect(tick).toHaveBeenCalledOnce();
    await safety.tick(sync);
    expect(clipboardEnables()).toHaveLength(1);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    tick.mockRestore();
  }
});

it('a locked computer clears an earlier sync failure instead of keeping it on screen', async () => {
  const { safety, sync } = syncFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('DESKTOP_UNKNOWN_FAILURE'))
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'));
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncFailed');
    now.mockReturnValue(20000);
    expect((await safety.tick(sync)).notice).toBeNull();
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it('a locked computer waits silently at a fixed interval, never growing the backoff', async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_CLIPBOARD_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBeNull();
    for (const [at, calls] of [
      [11000, 1],
      [11500, 2],
      [12500, 2],
      [13000, 3],
      [14500, 4],
    ] as const) {
      now.mockReturnValue(at);
      await safety.tick(sync);
      expect(tick).toHaveBeenCalledTimes(calls);
    }
    expect(safety.snapshot().notice).toBeNull();
    // The computer refused sync while locked, so each attempt re-enabled it first.
    expect(clipboardEnables()).toHaveLength(4);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it('a copy mid-read keeps the status; other failures back off to 5s at most and wake retries at once', async () => {
  const { safety, sync } = syncFixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_CHANGED'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockRejectedValueOnce(new Error('DESKTOP_UNAVAILABLE'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBeNull();
    // 1.5s later the unexplained failures start: 1.5s, 3s, then capped at 5s.
    for (const [at, calls, notice] of [
      [11500, 2, 'clipboardSyncFailed'],
      [12900, 2, 'clipboardSyncFailed'],
      [13000, 3, 'clipboardSyncFailed'],
      [15900, 3, 'clipboardSyncFailed'],
      [16000, 4, 'clipboardSyncFailed'],
      [20900, 4, 'clipboardSyncFailed'],
    ] as const) {
      now.mockReturnValue(at);
      expect((await safety.tick(sync)).notice).toBe(notice);
      expect(tick).toHaveBeenCalledTimes(calls);
    }
    // Regained focus or a shortcut: no waiting, and the failure count starts over.
    safety.wake();
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncFailed');
    expect(tick).toHaveBeenCalledTimes(5);
    now.mockReturnValue(22400);
    expect((await safety.tick(sync)).notice).toBeNull();
    expect(tick).toHaveBeenCalledTimes(6);
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it('waits after permission denial, then checks again when the user returns or copies', async () => {
  const { safety, sync } = syncFixture();
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_PERMISSION_DENIED'))
    .mockResolvedValue(undefined);
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncPermission');
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncPermission');
    expect(tick).toHaveBeenCalledOnce();
    safety.wake();
    expect((await safety.tick(sync)).notice).toBeNull();
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    tick.mockRestore();
  }
});

it("this computer's own clipboard helper failing is a plain failure, not the other computer being locked", async () => {
  const { safety, sync, clipboardEnables } = syncFixture();
  const version = vi.fn(async () => {
    throw new Error('DESKTOP_CLIPBOARD_UNAVAILABLE');
  });
  expect((await safety.tick({ ...sync, clipboard: { ...sync.clipboard, version } })).notice).toBe(
    'clipboardSyncFailed',
  );
  expect(version).toHaveBeenCalled();
  await safety.tick({ ...sync, clipboard: { ...sync.clipboard, version } });
  expect(clipboardEnables()).toHaveLength(1);
});

it('keeps conflict feedback until content is actually synchronized', async () => {
  const { safety, options } = fixture();
  const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
  const tick = vi
    .spyOn(ClipboardSync.prototype, 'tick')
    .mockRejectedValueOnce(new Error('CLIPBOARD_CONFLICT'))
    .mockResolvedValue(undefined);
  const sync = {
    ...options,
    preferences: { ...options.preferences, clipboardSync: true },
    clipboardCurrent: () => true,
    clipboard: { version: async () => 'v', read: async () => '{}', write: async () => 'v' },
  };
  try {
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncConflict');
    now.mockReturnValue(12000);
    expect((await safety.tick(sync)).notice).toBe('clipboardSyncConflict');
  } finally {
    now.mockRestore();
    tick.mockRestore();
  }
});

it.each([
  ['none', 'local'],
  ['none', 'remote'],
  ['remote', 'local'],
  ['local', 'remote'],
] as const)(
  'after a conflict with %s unreadable, recopying identical %s content selects it',
  async (unreadable, chosen) => {
    const { safety, sync } = syncFixture();
    const local = {
      version: 1,
      json: JSON.stringify({ text: 'local initial' }),
      unreadable: false,
    };
    const remote = {
      version: 1,
      json: JSON.stringify({ text: 'remote initial' }),
      unreadable: false,
    };
    const write = vi.fn(async (json: string, version: string | undefined) => {
      expect(version).toBe(String(local.version));
      local.json = json;
      local.unreadable = false;
      return String(++local.version);
    });
    const paste = vi.fn((json: string) => {
      remote.json = json;
      remote.unreadable = false;
      return { version: String(++remote.version) };
    });
    const request = vi.fn(async (message: RemoteDesktopRequest): Promise<unknown> => {
      if (message.op === 'clipboardVersion') return { version: String(remote.version) };
      if (message.op === 'clipboardContent' && message.action === 'copy') {
        if (remote.unreadable) throw new Error('CLIPBOARD_UNSUPPORTED');
        return { length: remote.json.length, data: remote.json };
      }
      if (message.op === 'clipboardContent' && message.action === 'paste')
        return paste(message.data);
      return { enabled: true };
    });
    const options: Parameters<ViewerSafety['tick']>[0] = {
      ...sync,
      caps: { ...sync.caps, clipboardInline: true },
      request: request as Parameters<ViewerSafety['tick']>[0]['request'],
      clipboard: {
        version: async () => String(local.version),
        read: async () => {
          if (local.unreadable) throw new Error('CLIPBOARD_UNSUPPORTED');
          return local.json;
        },
        write,
      },
    };
    await safety.tick(options);
    local.version++;
    remote.version++;
    local.json = JSON.stringify({ text: 'local choice' });
    remote.json = JSON.stringify({ text: 'remote choice' });
    local.unreadable = unreadable === 'local';
    remote.unreadable = unreadable === 'remote';
    expect((await safety.tick(options)).notice).toBe('clipboardSyncConflict');
    expect(safety.snapshot().clipboardNoticeVersion).toBe(1);

    // An idle poll cannot pick a winner or clear the conflict on its own.
    safety.wake();
    expect((await safety.tick(options)).notice).toBe('clipboardSyncConflict');
    expect(safety.snapshot().clipboardNoticeVersion).toBe(1);
    // Another pair of copies is a new conflict, even if its notice is identical.
    local.version++;
    remote.version++;
    expect((await safety.tick(options)).notice).toBe('clipboardSyncConflict');
    expect(safety.snapshot().clipboardNoticeVersion).toBe(2);
    safety.wake();
    expect((await safety.tick(options)).clipboardNoticeVersion).toBe(2);
    expect(write).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();

    const source = chosen === 'local' ? local : remote;
    const selected = source.json;
    source.version++; // Recopy exactly the same readable content, changing only its counter.
    safety.wake();
    expect((await safety.tick(options)).notice).toBeNull();
    expect(local.json).toBe(selected);
    expect(remote.json).toBe(selected);
    expect(write).toHaveBeenCalledTimes(chosen === 'remote' ? 1 : 0);
    expect(paste).toHaveBeenCalledTimes(chosen === 'local' ? 1 : 0);

    // Once resolved, normal identical-content deduplication is restored.
    source.version++;
    await safety.tick(options);
    expect(write).toHaveBeenCalledTimes(chosen === 'remote' ? 1 : 0);
    expect(paste).toHaveBeenCalledTimes(chosen === 'local' ? 1 : 0);
  },
);
