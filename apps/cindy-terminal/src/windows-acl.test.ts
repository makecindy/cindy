/** Unit: native Windows acceptance exhausted a deadline that also counted
 * PowerShell startup before readiness was known. Exercise the production pipe protocol
 * with delayed readiness and absent acknowledgements; existing real-Windows
 * host integration still verifies the resulting DACL. No real timer waits. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { restrictWindowsDirectory } from './windows-acl.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
const children: ReturnType<typeof child>[] = [];
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    ref() {}, unref() {}, kill: vi.fn(() => true),
  });
  const writes: string[] = [];
  process.stdin.on('data', bytes => writes.push(String(bytes)));
  process.kill.mockImplementation(() => { process.emit('exit', 1); return true; });
  return { process: Object.assign(process, { stdio: [process.stdin, process.stdout, process.stderr] }), writes };
}
function setup() {
  vi.useFakeTimers();
  spawn.mockImplementation(() => { const entry = child(); children.push(entry); return entry.process; });
}
afterEach(() => {
  for (const { process } of children.splice(0)) {
    process.emit('exit', 0); process.stdin.destroy(); process.stdout.destroy(); process.stderr.destroy();
  }
  spawn.mockReset(); vi.useRealTimers();
});

it('waits for readiness without accepting a directory before its exact acknowledgement', async () => {
  setup();
  let completed = false;
  const directory = 'C:\\权限\\a\'$(not-source)';
  const request = restrictWindowsDirectory(directory, 'powershell.exe', {}).then(() => { completed = true; });
  const helper = children[0];
  await vi.advanceTimersByTimeAsync(20_000);
  expect(helper.writes).toEqual([]);
  expect(completed).toBe(false);
  helper.process.stdout.write('ready\n');
  const [id, data] = helper.writes[0].trim().split(':');
  expect(Buffer.from(data, 'base64').toString('utf8')).toBe(directory);
  await vi.advanceTimersByTimeAsync(14_000);
  expect(completed).toBe(false);
  helper.process.stdout.write(`${id}:ok\n`);
  await request;
  expect(completed).toBe(true);
});

it('fails closed on stalled startup or an unacknowledged ACL and restarts the helper', async () => {
  setup();
  const starting = restrictWindowsDirectory('C:\\first', 'powershell.exe', {}).catch(error => error);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await starting).toMatchObject({ message: 'PRIVATE_DIRECTORY_PERMISSIONS_STARTUP_TIMEOUT' });
  expect(children[0].process.kill).toHaveBeenCalledOnce();
  const changing = restrictWindowsDirectory('C:\\second', 'powershell.exe', {}).catch(error => error);
  expect(children).toHaveLength(2);
  children[1].process.stdout.write('ready\n');
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await changing).toMatchObject({ message: 'PRIVATE_DIRECTORY_PERMISSIONS_TIMEOUT' });
  expect(children[1].process.kill).toHaveBeenCalledOnce();
  const refused = restrictWindowsDirectory('C:\\third', 'powershell.exe', {}).catch(error => error);
  children[2].process.stdout.write('ready\n');
  const id = children[2].writes[0].split(':')[0];
  children[2].process.stdout.write(`${id}:error\n`);
  expect(await refused).toMatchObject({ message: 'PRIVATE_DIRECTORY_PERMISSIONS_FAILED' });
});
