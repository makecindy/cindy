import { EventEmitter } from 'node:events';
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

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  Object.defineProperty(process, 'resourcesPath', { value: '/fixture/Resources', configurable: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
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
