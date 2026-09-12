import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputDeviceHost } from '../../input-devices/registry.js';

interface MockTaskRow {
  id: string;
  title: string | null;
  pinnedAt: number | null;
  userSendAt?: number | null;
  sidebarOrder?: number;
}

const mocks = vi.hoisted(() => ({
  register: vi.fn(), ipc: new Map<string, (...args: any[]) => any>(),
  catalog: vi.fn(),
  buildCatalog: vi.fn((rows: readonly MockTaskRow[]) => ({
    sidebar: rows.map((row) => ({ id: row.id, title: row.title, pinned: row.pinnedAt !== null })),
    lastSent: rows.map((row) => ({ id: row.id, title: row.title, pinned: row.pinnedAt !== null })),
    options: rows.map((row) => ({ id: row.id, title: row.title, pinned: row.pinnedAt !== null })),
  })),
  publishedRows: null as MockTaskRow[] | null, boundaryPending: false,
  asr: vi.fn(), open: vi.fn(), spawn: vi.fn(), guard: vi.fn(),
  reply: vi.fn(),
  helperLockHeld: false,
  createHelperLock: vi.fn(() => ({
    tryAcquire: () => {
      if (mocks.helperLockHeld) return false;
      mocks.helperLockHeld = true;
      return true;
    },
    release: () => { mocks.helperLockHeld = false; },
    isHeld: () => mocks.helperLockHeld,
  })),
  owner: 'owner-a',
}));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/test/profile' }, ipcMain: {
  handle: (name: string, fn: (...args: any[]) => any) => mocks.ipc.set(name, fn),
} }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ default: { access: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../input-devices/registry.js', () => ({ registerInputDevice: mocks.register }));
vi.mock('../../device-link/ownership.js', async () => {
  const actual = await vi.importActual<typeof import('../../device-link/ownership.js')>('../../device-link/ownership.js');
  return { ...actual, createSqliteExclusiveFileLock: mocks.createHelperLock };
});
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
vi.mock('../../deepLink.js', () => ({ openMainWindowSession: mocks.open }));
vi.mock('../../worklouder-codex/taskSlots.js', () => ({
  buildWorkLouderCodexTaskCatalog: mocks.buildCatalog,
  listWorkLouderCodexTaskCatalog: mocks.catalog,
}));
vi.mock('../../worklouder-codex/taskCatalogPublication.js', () => ({
  readRendererTaskCatalog: (scope: string | null) => scope === mocks.owner ? mocks.publishedRows : null,
  subscribeRendererTaskCatalog: () => () => undefined,
}));
vi.mock('../../voice-input/index.js', () => ({ transcribeVoiceInputOpus: mocks.asr }));
vi.mock('../../localDb/latestMessageText.js', () => ({ latestMessage: mocks.reply }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: mocks.guard }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => mocks.owner,
  isAppSessionBoundaryPending: () => mocks.boundaryPending,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: mocks.owner, ownerGeneration: 1 }),
  ownerScopedUserDataPath: () => '/test/settings',
}));
vi.mock('../../maker-host/override-settings-file.js', () => ({ createOverrideSettingsFile: () => ({
  read: () => ({ enabled: true }),
}) }));

function wire(kind: number, sequence: number, payload = Buffer.alloc(0)): string {
  const p = Buffer.alloc(7 + payload.length); p[0] = kind; p.writeUInt32LE(5, 1);
  p.writeUInt16LE(sequence, 5); payload.copy(p, 7);
  return JSON.stringify({ kind: 'voice', packet: p.toString('base64') }) + '\n';
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
describe('Passport host transcription boundary', () => {
  let host: InputDeviceHost, stdout: EventEmitter;
  let resourcesPathDescriptor: PropertyDescriptor | undefined;
  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/test/resources' });
    mocks.owner = 'owner-a'; mocks.ipc.clear(); mocks.publishedRows = null; mocks.boundaryPending = false;
    mocks.helperLockHeld = false; mocks.createHelperLock.mockClear();
    mocks.catalog.mockResolvedValue({ options: [{ id: 'task', title: '中文任务' }] });
    mocks.asr.mockResolvedValue({ text: '继续这个任务' });
    mocks.reply.mockResolvedValue({ text: '这是 Cindy 的完整回复。'.repeat(30), createdAt: 1 });
    let first = true;
    mocks.spawn.mockImplementation(() => {
      const childStdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
      const child = Object.assign(new EventEmitter(), { stdout: childStdout, stderr: { resume: vi.fn() },
        stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroyed: false }), kill: vi.fn() });
      if (first) { stdout = childStdout; first = false; }
      return child;
    });
    const { registerPassportInputDevice } = await import('../index.js');
    registerPassportInputDevice(); host = mocks.register.mock.calls[0][0];
    host.start(); await flush();
    host.updateSessionActivity([{ sessionId: 'task', phase: 'completed', compactDetail: 'Done' } as any]);
    await flush(); stdout.emit('data', '{"kind":"ready"}\n');
  });
  afterEach(async () => {
    for (const result of mocks.spawn.mock.results) (result.value as EventEmitter).emit('exit', 0, null);
    await host?.dispose(); vi.useRealTimers(); vi.restoreAllMocks();
    if (resourcesPathDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    else Reflect.deleteProperty(process, 'resourcesPath');
  });
  function record(): void {
    const id = Buffer.alloc(40); id.write('task');
    stdout.emit('data', wire(1, 0, id));
    stdout.emit('data', wire(2, 0, Buffer.alloc(120)));
    stdout.emit('data', wire(3, 1));
  }
  function action(kind: number, token = 5): void {
    stdout.emit('data', JSON.stringify({ kind: 'action', action: kind, id: 'task', token }) + '\n');
  }
  it('previews text on hardware and only releases it once after confirmation', async () => {
    record(); await flush();
    expect(mocks.asr).toHaveBeenCalledOnce();
    expect(mocks.asr.mock.calls[0][0].subarray(0, 4).toString()).toBe('OggS');
    const read = mocks.ipc.get('passport:dictation')!;
    expect(mocks.open).not.toHaveBeenCalled();
    expect(await read({}, 'task')).toBeNull();
    action(5, 123); await flush();
    expect(await read({}, 'task')).toBeNull();
    action(5); action(5); await flush();
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(mocks.open).toHaveBeenCalledWith('task', { focus: true });
    expect(await read({}, 'another-task')).toBeNull();
    const claims = await Promise.all([read({}, 'task'), read({}, 'task')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const draft = claims.find(Boolean);
    expect(draft).toMatchObject({ sessionId: 'task', text: '继续这个任务', ownerStamp: { dataOwnerId: 'owner-a' } });
    expect(await read({}, 'task')).toBeNull();
    mocks.ipc.get('passport:dictation-ack')!({}, draft.token, true);
    expect(await read({}, 'task')).toBeNull();
  });
  it('discards the preview on re-record and rejects a stale confirmation', async () => {
    record(); await flush(); action(4); await flush(); action(5); await flush();
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('requires another hardware confirmation after a rejected send', async () => {
    record(); await flush(); action(5); await flush();
    const read = mocks.ipc.get('passport:dictation')!;
    const draft = await read({}, 'task');
    mocks.ipc.get('passport:dictation-ack')!({}, draft.token, false);
    expect(await read({}, 'task')).toBeNull();
    action(5); await flush();
    expect(await read({}, 'task')).toMatchObject({ token: draft.token, text: draft.text });
  });
  it('returns an unclaimed confirmation to review instead of waiting forever', async () => {
    record(); await flush(); action(5); await flush();
    await vi.advanceTimersByTimeAsync(16_000); await flush();
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).toBeNull();
    action(5); await flush();
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).not.toBeNull();
  });
  it('allows leaving a claimed send without automatically sending it again', async () => {
    record(); await flush(); action(5); await flush();
    await mocks.ipc.get('passport:dictation')!({}, 'task');
    action(6); await flush();
    expect(mocks.ipc.get('passport:state')!({}).voice).toBe('idle');
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).toBeNull();
  });
  it('lets an in-flight transcription finish after rejecting a second start', async () => {
    let finish!: (value: { text: string }) => void;
    mocks.asr.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    record(); await flush();
    const id = Buffer.alloc(40); id.write('task'); stdout.emit('data', wire(1, 0, id));
    finish({ text: '完整结果' }); await flush(); action(5); await flush();
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).toMatchObject({ text: '完整结果' });
  });
  it('reads the latest visible reply for hardware page actions without opening the Mac task', async () => {
    action(1, 0); await flush(); action(3, 0); await flush();
    expect(mocks.reply).toHaveBeenCalledWith('task', 'assistant');
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('lists catalog tasks that no island activity covers', async () => {
    const stdin = mocks.spawn.mock.results[0].value.stdin;
    mocks.catalog.mockResolvedValue({ options: [{ id: 'idle-task', title: '无活动任务' }] });
    host.updateSessionActivity([]);
    await flush();
    stdout.emit('data', '{"kind":"idle"}\n');
    await flush();
    const frame = Buffer.from(stdin.write.mock.calls.at(-1)![0].trim(), 'base64');
    expect(frame[3]).toBe(1);
    expect(frame.subarray(4, 13).toString()).toBe('idle-task');
    expect(frame.subarray(44, 124).toString().replace(/\0+$/u, '')).toBe('无活动任务');
  });
  it('uses the renderer catalog when a task lives on a linked machine', async () => {
    const stdin = mocks.spawn.mock.results[0].value.stdin;
    mocks.publishedRows = [{ id: 'remote-task', title: '远程任务', pinnedAt: null, userSendAt: null, sidebarOrder: 0 }];
    host.updateSessionActivity([]);
    await flush();
    stdout.emit('data', '{"kind":"idle"}\n');
    await flush();
    const frame = Buffer.from(stdin.write.mock.calls.at(-1)![0].trim(), 'base64');
    expect(frame[3]).toBe(1);
    expect(frame.subarray(4, 44).toString().replace(/\0+$/u, '')).toBe('remote-task');
    expect(frame.subarray(44, 124).toString().replace(/\0+$/u, '')).toBe('远程任务');
  });
  it('waits for the previous helper to exit before starting another one', async () => {
    const oldChild = mocks.spawn.mock.results[0].value;
    expect(mocks.createHelperLock).toHaveBeenCalledWith(path.join('/test/profile', 'passport-helper-ownership.lock.db'));
    host.suspendTaskSlots();
    const resume = host.resumeTaskSlots();
    await flush();

    expect(mocks.spawn).toHaveBeenCalledOnce();
    oldChild.emit('exit', 0, null);
    await resume;

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
  it('clears the prior owner snapshot before a resumed helper is ready', async () => {
    const oldChild = mocks.spawn.mock.results[0].value;
    host.suspendTaskSlots();
    mocks.owner = 'owner-b';
    mocks.catalog.mockImplementation(() => new Promise(() => {}));
    oldChild.emit('exit', 0, null);
    await host.resumeTaskSlots();
    await flush();
    const nextChild = mocks.spawn.mock.results.at(-1)!.value;
    nextChild.stdout.emit('data', '{"kind":"ready"}\n');
    await flush();
    const frame = Buffer.from(nextChild.stdin.write.mock.calls.at(-1)![0].trim(), 'base64');
    expect(frame[3]).toBe(0);
    expect(frame.toString()).not.toContain('task');
  });
  it('recovers from a voice configuration rejection without staying in transcription', async () => {
    mocks.asr.mockRejectedValueOnce(new Error('Voice recording configuration changed'));
    record();
    await flush();
    expect(mocks.ipc.get('passport:state')!({}).voice).toBe('error');
    record();
    await flush();
    expect(mocks.asr).toHaveBeenCalledTimes(2);
    expect(mocks.ipc.get('passport:state')!({}).voice).toBe('draft');
  });
  it('accepts a batch of complete helper lines larger than the line limit', async () => {
    const child = mocks.spawn.mock.results[0].value;
    stdout.emit('data', '{"kind":"idle"}\n'.repeat(1000));
    record(); await flush();
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.ipc.get('passport:state')!({}).voice).toBe('draft');
  });
  it.each(['', '\n'])('rejects an oversized individual helper line ending with %j', (ending) => {
    const child = mocks.spawn.mock.results[0].value;
    stdout.emit('data', 'x'.repeat(8193) + ending);
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('restarts an unexpectedly exited helper with bounded backoff', async () => {
    const firstChild = mocks.spawn.mock.results[0].value;
    firstChild.emit('exit', 1, null);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    const replacement = mocks.spawn.mock.results[1].value;
    replacement.stdout.emit('data', '{"kind":"disconnected"}\n');
    replacement.emit('exit', 1, null);
    await flush();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_001);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(3);

    const stable = mocks.spawn.mock.results[2].value;
    stable.stdout.emit('data', '{"kind":"ready"}\n');
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    stable.emit('exit', 1, null);
    await flush();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.spawn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(4);
  });
  it('stops retrying repeated short-lived helpers and allows an explicit restart', async () => {
    for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000]) {
      const child = mocks.spawn.mock.results.at(-1)!.value;
      child.stdout.emit('data', '{"kind":"ready"}\n');
      child.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(6);
    mocks.spawn.mock.results.at(-1)!.value.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(6);
    host.suspendTaskSlots();
    await host.resumeTaskSlots();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(7);
  });
  it.each(['owner', 'disconnect', 'archive'])('discards late transcription after %s', async (boundary) => {
    let finish!: (value: { text: string }) => void;
    mocks.asr.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    record(); await flush();
    if (boundary === 'owner') mocks.owner = 'owner-b';
    if (boundary === 'disconnect') stdout.emit('data', '{"kind":"disconnected"}\n');
    if (boundary === 'archive') mocks.catalog.mockResolvedValue({ options: [] });
    finish({ text: 'private words' }); await flush();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(await mocks.ipc.get('passport:dictation')!({}, 'task')).toBeNull();
  });
  it('guards dictation IPC against untrusted renderer requests', async () => {
    mocks.guard.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(mocks.ipc.get('passport:dictation')!({}, 'task')).rejects.toThrow('untrusted');
    expect(mocks.asr).not.toHaveBeenCalled();
  });
});
