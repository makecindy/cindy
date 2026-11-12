import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_MENUBAR_SETTINGS, type MenubarHelperMessage } from '../../../shared/menubarQuota.js';
import { emptyMenubarInputs } from '../collect.js';
import { buildMenubarView } from '../snapshot.js';
import { MacMenubarNativeHost } from '../MacMenubarNativeHost.js';
import { MENUBAR_HARNESS_LOGOS } from '../logos.js';
import { buildMenubarUiStrings } from '../strings.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(),
  app: { isPackaged: true, getPath: vi.fn(), getAppPath: () => '/fixture/app' },
}));
vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.execFile.mockReset();
  mocks.app.isPackaged = true;
  Object.defineProperty(process, 'resourcesPath', { value: '/fixture/Resources', configurable: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
});

it.each(['exit', 'process-error', 'stdin-error'])('closes the panel lease on %s without bypassing restart backoff', async reason => {
  const children: ReturnType<typeof childProcess>[] = [];
  mocks.spawn.mockImplementation(() => {
    const child = childProcess();
    children.push(child);
    return child;
  });
  const view = buildMenubarView({ ...emptyMenubarInputs(Date.now(), 'Fixture'),
    nowMs: Date.now(), locale: 'en', moneySymbol: '$', settings: DEFAULT_MENUBAR_SETTINGS,
    harnessLogos: MENUBAR_HARNESS_LOGOS, uiStrings: buildMenubarUiStrings([], key => key, 'en'), t: key => key,
  });
  const onMessage = vi.fn((message: MenubarHelperMessage) => {
    // Closing the real controller clears its shared sources and publishes a replacement.
    if (message.type === 'panel' && !message.open) host.publish(view);
  });
  const host = new MacMenubarNativeHost({ onMessage });
  host.publish(view);
  await vi.advanceTimersByTimeAsync(0);
  const first = children[0];
  first.stdout.write('{"type":"ready"}\n{"type":"panel","open":true}\n');
  expect(onMessage).toHaveBeenLastCalledWith({ type: 'panel', open: true });
  if (reason === 'exit') first.emit('exit', 1, null);
  else if (reason === 'process-error') first.emit('error', new Error('lost'));
  else first.stdin.emit('error', new Error('broken pipe'));
  expect(onMessage).toHaveBeenLastCalledWith({ type: 'panel', open: false });
  expect(host.running).toBe(false);
  await vi.advanceTimersByTimeAsync(999);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  const second = children[1];
  second.stdout.write('{"type":"ready"}\n');
  expect(host.running).toBe(true);
  const commands = second.stdin.read().toString().trim().split('\n').map((line: string) => JSON.parse(line));
  expect(commands.map((command: { type: string }) => command.type)).toEqual(['update']);
  // Duplicate exit from the lost process must not close a newly opened replacement.
  second.stdout.write('{"type":"panel","open":true}\n');
  const count = onMessage.mock.calls.length;
  first.emit('exit', 1, null);
  expect(onMessage).toHaveBeenCalledTimes(count);
  host.stop();
  second.emit('exit', 0, null);
  expect(onMessage).toHaveBeenCalledTimes(count);
});

// Regression: a source-only cached helper has no AppKit preference identity.
// prepare() must replace it, then retain the identity across rebuilds while
// keeping other profiles separate. Existing lifecycle tests never build dev assets.
// Unit tier: in-memory files/compiler; native drag/relaunch is covered by local acceptance.
it('upgrades an identity-less dev cache and keeps subsequent builds isolated by profile', async () => {
  mocks.app.isPackaged = false;
  const source = Buffer.from('fixture Swift source');
  const files = new Map<string, string>();
  const binaryFor = (profile: string) => path.join(profile, 'menubar', 'xdt-macos-menubar-helper');
  const firstProfile = '/fixture/profile-one';
  const oldHash = createHash('sha256').update(source).digest('hex');
  files.set(`${binaryFor(firstProfile)}.sha256`, oldHash);
  mocks.app.getPath.mockReturnValue(firstProfile);
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: 1, size: 1 } as fs.Stats);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor) => {
    const name = String(file);
    if (name.endsWith('.swift')) return source;
    if (path.basename(name) === 'Info.plist') return '<plist><dict><key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string></dict></plist>';
    return files.get(name) ?? '';
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => { files.set(String(file), String(data)); });
  const identities: string[] = [];
  mocks.execFile.mockImplementation((_file, args: string[], _options, done: (error: null) => void) => {
    const section = args.indexOf('__info_plist');
    expect(section).toBeGreaterThan(0);
    const plist = files.get(args[section + 2])!;
    identities.push(plist.match(/<string>([^<]+)<\/string>/)![1]);
    queueMicrotask(() => done(null));
    return new EventEmitter();
  });
  const prepare = async () => {
    new MacMenubarNativeHost({ onMessage: vi.fn() }).prepare();
    await vi.advanceTimersByTimeAsync(0);
  };
  await prepare();
  expect(identities).toHaveLength(1);
  expect(files.get(`${binaryFor(firstProfile)}.sha256`)).not.toBe(oldHash);
  await prepare();
  expect(identities).toHaveLength(1); // Same source + identity is reusable.
  mocks.app.getPath.mockReturnValue('/fixture/profile-two');
  await prepare();
  expect(identities).toHaveLength(2);
  expect(identities[0]).not.toBe(identities[1]);
  expect(identities.every(id => /^[a-zA-Z0-9.-]+$/.test(id))).toBe(true);
});

function childProcess() {
  const child = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable> & {
    killed: boolean;
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return child;
}
