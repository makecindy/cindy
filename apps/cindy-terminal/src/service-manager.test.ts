// Behavior tier: uninstalling from a daemon RPC must preserve its response,
// then the foreground caller must unload the actual launchd job. No real
// system registration is performed by these command-contract tests.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalServiceManager } from './service-manager.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  const execute = vi.fn(async (_file: string, _args: string[]) => ({ stdout: '', stderr: '' }));
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'darwin', home: directory, uid: 12345, execute });
  return { directory, execute, manager };
}

// The optional native screen host must survive service registration and restart
// without being launched as a Node script. Its Windows supervisor stays Node;
// only the supervised child is the signed graphical executable. tier: unit.
it.each(['darwin','linux','win32'] as const)('registers the desktop host command on %s and preserves the headless boot boundary',async platform=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'cindy-platform-service-'));directories.push(directory);
  // Linux systemd descriptors use POSIX paths even when this matrix case runs
  // on a Windows host; keep that fixture independent of the test runner path.
  const executable=platform==='linux'?'/opt/cindy/Cindy Host/Cindy':path.join(directory,'Cindy Host',platform==='win32'?'Cindy.exe':'Cindy');
  const execute=vi.fn(async(_file:string,args:string[])=>({stdout:args.includes('/user')?'"user","S-1-5-21-111-222-333-1001"':'',stderr:''}));
  const manager=new TerminalServiceManager(path.join(directory,'profile'),path.join(directory,'app','cli.js'),process.execPath,{
    platform,home:directory,uid:12345,execute,desktopHost:{executable,args:[]},
  });
  const installed=await manager.install();
  expect(installed).toMatchObject({desktop:true,starts:'login'});
  const raw=await readFile(installed.file);
  const descriptor=platform==='win32'?raw.subarray(2).toString('utf16le'):raw.toString();
  if(platform==='win32'){
    expect(descriptor).toContain('service-supervisor.cjs');
    expect(descriptor).toContain('Cindy.exe');
    expect(descriptor).toContain('&quot;executable');
  } else {
    expect(descriptor).toContain(executable);
    expect(descriptor).not.toContain('cli.js');
  }
  execute.mockClear();
  await expect(manager.enableBoot()).rejects.toThrow('DESKTOP_SERVICE_REQUIRES_LOGIN');
  expect(execute).not.toHaveBeenCalled();
});

it('disables restart in the RPC phase and bootouts only after foreground completion', async () => {
  const { execute, manager } = await fixture();
  const installed = await manager.install();
  execute.mockClear();
  expect(await manager.uninstall()).toEqual({ removed: false, requiresLocalCompletion: true });
  expect(execute.mock.calls.map(call => call[1][0]).filter(command => command !== 'print')).toEqual(['disable']);
  expect(await stat(installed.file).catch(() => null)).toBeNull();
  expect((await manager.status())?.uninstalling).toBe(true);
  expect(await manager.completeUninstall()).toEqual({ removed: true });
  expect(execute.mock.calls.map(call => call[1][0]).filter(command => command !== 'print')).toEqual(['disable', 'bootout']);
  expect(await manager.status()).toBeNull();
});

it('retains retry information if the launchd job is still present', async () => {
  const { execute, manager } = await fixture();
  await manager.install(); await manager.uninstall();
  execute.mockImplementation(async (_file, args) => { if (args[0] === 'bootout') throw new Error('test failure'); return { stdout: 'job exists', stderr: '' }; });
  await expect(manager.completeUninstall()).rejects.toThrow('SERVICE_UNREGISTRATION_FAILED');
  expect((await manager.status())?.uninstalling).toBe(true);
});

it('clears the pending registration when launchctl explicitly reports no loaded job', async () => {
  const { execute, manager } = await fixture();
  await manager.install(); await manager.uninstall();
  execute.mockImplementation(async (_file, args) => {
    if (args[0] === 'bootout') throw new Error('test failure');
    if (args[1] === 'gui/12345') return { stdout: 'domain', stderr: '' };
    throw Object.assign(new Error('no job'), { stderr: 'Could not find service in domain for user' });
  });
  expect(await manager.completeUninstall()).toEqual({ removed: true });
});

// Native macOS first activation failed because an unloaded job was mistaken
// for an unavailable launchd manager. SSH has no GUI domain; keep that loaded
// user job when a desktop login appears later instead of starting a duplicate.
it.each(['gui', 'user'] as const)('activates a new macOS service in the available %s domain', async initialDomain => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  let guiAvailable = initialDomain === 'gui';
  let loaded: string | undefined;
  const execute = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'print') {
      if (args[1] === loaded) return { stdout: 'state = running\npid = 3456\n', stderr: '' };
      if (args[1] === 'user/12345' || args[1] === 'gui/12345' && guiAvailable) return { stdout: 'domain', stderr: '' };
      throw Object.assign(new Error('not loaded'), { stderr: 'Could not find service in domain for user' });
    }
    if (args[0] === 'bootstrap') {
      expect(args[1]).toBe(`${initialDomain}/12345`);
      loaded = `${args[1]}/${manager.id}`;
    }
    if (args[0] === 'kickstart' || args[0] === 'disable') expect(args[1]).toBe(loaded);
    if (args[0] === 'bootout') { expect(args[1]).toBe(loaded); loaded = undefined; }
    return { stdout: '', stderr: '' };
  });
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'darwin', home: directory, uid: 12345, execute });
  await manager.install();
  expect(await manager.inspect()).toMatchObject({ managerAvailable: true, registered: false, running: false });
  expect(await manager.activate()).toMatchObject({ managerAvailable: true, registered: true, running: true, pid: 3456 });
  guiAvailable = true;
  expect(await manager.activate()).toMatchObject({ running: true, pid: 3456 });
  expect(execute.mock.calls.filter(([, args]) => args[0] === 'bootstrap')).toHaveLength(1);
  await manager.uninstall();
  expect(await manager.completeUninstall()).toEqual({ removed: true });
});

it('keeps Linux registration distinct from running and verifies the explicit boot opt-in', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  let linger = false;
  let running = false;
  const execute = vi.fn(async (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    if (file === 'loginctl') {
      if (args[0] === 'enable-linger') linger = true;
      return { stdout: linger ? 'yes\n' : 'no\n', stderr: '' };
    }
    // Native linger acceptance inherited UID 1001's runtime while the service
    // actually ran as UID 1002. Every systemctl operation must use its own bus.
    expect(options.env?.XDG_RUNTIME_DIR).toBe('/run/user/12345');
    expect(options.env?.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/12345/bus');
    expect(options.env?.SYSTEMD_BUS_ADDRESS).toBeUndefined();
    if (args[1] === 'start') running = true;
    return { stdout: `LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nMainPID=${running ? 2345 : 0}\n`, stderr: '' };
  });
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'linux', home: directory, uid: 12345, env: { XDG_RUNTIME_DIR: '/run/user/999', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/999/bus', SYSTEMD_BUS_ADDRESS: 'unix:path=/run/user/999/bus' }, execute });
  expect(await manager.install()).toMatchObject({ starts: 'login', registrationOnly: true });
  expect(await manager.inspect()).toMatchObject({ registered: true, running: false, starts: 'login', bootEnableCommand: ['loginctl', 'enable-linger', '12345'] });
  expect(await manager.enableBoot()).toMatchObject({ running: false, starts: 'boot' });
  expect(await manager.activate()).toMatchObject({ running: true, starts: 'boot', pid: 2345 });
  expect((await manager.inspect()).bootEnableCommand).toBeUndefined();
});

it('does not call a receipt an active service when the user manager is unavailable', async () => {
  const { manager, execute } = await fixture();
  await manager.install();
  execute.mockRejectedValue(new Error('no GUI login session'));
  expect(await manager.inspect()).toMatchObject({ installation: { registrationOnly: true }, managerAvailable: false, registered: false, running: false });
  await expect(manager.enableBoot()).rejects.toThrow();
});

it.each(['darwin', 'win32'] as const)('registers explicit %s boot operation through the native foreground prompt', async platform => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  const execute = vi.fn(async (file: string, args: string[]) => ({ stdout: path.win32.basename(file) === 'whoami.exe' ? args.length ? '"test-user","S-1-5-21-1234"' : 'machine\\test-user' : file === 'launchctl' && args[0] === 'print' ? 'state = running\npid = 3456\n' : '', stderr: '' }));
  const interactive = vi.fn(async (_file: string, _args: string[], _env?: NodeJS.ProcessEnv) => {});
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform, home: directory, uid: 12345, userName: 'test-user', env: {}, execute, interactive });
  await manager.install();
  await manager.enableBoot();
  expect(await manager.status()).toMatchObject({ scope: 'system', starts: 'boot' });
  if (platform === 'darwin') expect(interactive.mock.calls.length).toBe(3);
  else expect(interactive.mock.calls.length).toBe(1);
  if (platform === 'win32') {
    const [, args, env] = interactive.mock.calls[0];
    const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain("Read-Host 'Windows account password' -AsSecureString");
    expect(script).toContain('ZeroFreeBSTR');
    expect(Object.keys(env ?? {})).not.toContain('PASSWORD');
  }
});

// Native Windows rejected UTF-8 task XML with "unable to switch the encoding".
// Exercise the real installation and boot-conversion entries, including paths
// outside ASCII, rather than checking a generated source-code literal.
it('registers and upgrades a Windows task with a decodable Unicode descriptor', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  const profile = path.join(directory, '终端 配置');
  const imported: string[] = [];
  const readDescriptor = async (file: string) => {
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const text = bytes.subarray(2).toString('utf16le');
    expect(text).toContain('encoding="UTF-16"');
    expect(text).toContain(profile);
    imported.push(text);
  };
  const manager = new TerminalServiceManager(profile, path.join(directory, '启动.js'), process.execPath, {
    platform: 'win32', home: directory, env: {},
    execute: async (file, args) => {
      if (path.win32.basename(file) === 'whoami.exe') { expect(path.win32.isAbsolute(file)).toBe(true); return { stdout: args.length ? '"test-user","S-1-5-21-1234"' : 'machine\\test-user', stderr: '' }; }
      if (path.win32.basename(file) === 'schtasks.exe' && args[0] === '/Create') await readDescriptor(args[args.indexOf('/XML') + 1]);
      return { stdout: '', stderr: '' };
    },
    interactive: async (_file, _args, env) => { await readDescriptor(env!.CINDY_BOOT_XML!); },
  });
  const installed = await manager.install();
  await manager.enableBoot();
  expect(imported[0]).toContain('<LogonType>InteractiveToken</LogonType>');
  expect(imported[1]).toContain('<LogonType>Password</LogonType>');
  expect(imported[1]).toContain('<BootTrigger>');
  await readDescriptor(installed.file);
  expect(imported[2]).toEqual(imported[1]);
});

// A rejected system bootstrap must not disable an existing working user job.
it('restores the user registration after macOS boot migration fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-service-command-test-')); directories.push(directory);
  let loaded = true;
  const execute = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'print' && args[1].split('/').length === 3 && !loaded) throw new Error('job not loaded');
    return { stdout: 'state = running\npid = 3456\n', stderr: '' };
  });
  const interactive = vi.fn(async (_file: string, args: string[]) => {
    if (args[1] === 'bootstrap') throw new Error('SERVICE_BOOT_SETUP_FAILED');
  });
  const manager = new TerminalServiceManager(path.join(directory, 'profile'), path.join(directory, 'cli.js'), process.execPath, { platform: 'darwin', home: directory, uid: 12345, execute, interactive });
  const before = await manager.install();
  await expect(manager.enableBoot()).rejects.toThrow('SERVICE_BOOT_SETUP_FAILED');
  expect(await manager.status()).toEqual(before);
  expect(await manager.inspect()).toMatchObject({ running: true, starts: 'login' });
  expect(await stat(before.file)).toBeTruthy();
});
