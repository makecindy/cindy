/**
 * 浏览器扩展的 Native Messaging 绑定(宿主侧):把插件包内的平台二进制复制到
 * Cindy 的私有目录,向各 Chromium 浏览器注册 host manifest,并在
 * `connections/<port>.json` 写入桥接的私有授权令牌。令牌只给本机的 native host
 * 读,不进扩展、不进插件 KV、不进 /health 结果。
 *
 * 文件布局与插件时期完全相同(`<App Support>/Cindy/browser-native/`),已安装
 * 用户升级后无需重新配对;插件与宿主交错更新期间,两份注册写的是同一份清单。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { readBoundedFileNoFollow, readBoundedFileNoFollowSync } from '../utils/readBoundedFile.js';
import { withSecurityBoundaryLock } from '../device-link/crossProcessLock.js';

export interface NativeBindingOptions {
  /** 注册名(身份卡 browserExtension.nativeHost.name)。 */
  hostName: string;
  /** 包内平台二进制目录:`<binaryDir>/<platform>-<arch>/cindy-browser-native[.exe]`。 */
  binaryDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 覆盖私有目录(测试用)。 */
  root?: string;
  /** Stable owner + installed-instance partition; omitted for the historical binding layout. */
  registrationKey?: string;
  /** Only an explicit action in the trusted main window may replace another registration. */
  confirmTakeover?(): Promise<boolean>;
  assertCurrent?(): void;
  /** 覆盖浏览器 profile 目录清单(测试用)。 */
  profiles?: string[];
  run?: (
    file: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number },
  ) => Promise<unknown>;
}

export type NativeBindingState = 'preparing' | 'ready' | 'unavailable';

export interface NativeBinding {
  readonly token: string;
  install(
    port: number,
    extensionIds: readonly string[],
    options?: { takeover?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: 'NATIVE_BINDING_UNAVAILABLE'; reason: string }>;
  close(): Promise<void>;
  status(): NativeBindingState;
}

export function nativeBindingRoot(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : platform === 'win32'
        ? env.LOCALAPPDATA || path.join(home, 'AppData/Local')
        : path.join(home, '.local/share');
  return path.join(base, 'Cindy', 'browser-native');
}

export function createNativeBinding(options: NativeBindingOptions): NativeBinding {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const registrationRoot = options.root ?? nativeBindingRoot(platform, home, env);
  if (options.registrationKey !== undefined && !/^[a-f0-9]{64}$/.test(options.registrationKey))
    throw new Error('NATIVE_PATH_UNSAFE');
  const root = options.registrationKey ? path.join(registrationRoot, options.registrationKey) : registrationRoot;
  const registrationFile = path.join(registrationRoot, options.hostName + '.json');
  const windowsRegistryKeys = ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser']
    .map(vendor => 'HKCU\\Software\\' + vendor + '\\NativeMessagingHosts\\' + options.hostName);
  const token = crypto.randomBytes(32).toString('hex');
  const run = options.run ?? (promisify(execFile) as NativeBindingOptions['run']);
  let config: string | null = null;
  let state: NativeBindingState = 'preparing';

  async function privateDirectory(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('NATIVE_PATH_UNSAFE');
    if (platform !== 'win32') await fs.chmod(dir, 0o700);
  }

  async function atomic(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
    options.assertCurrent?.();
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(tmp, data, { flag: 'wx', mode });
      options.assertCurrent?.();
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  async function registeredBinary(expectedBinary?: string): Promise<string | null> {
    const requiredFiles = new Set<string>();
    if (expectedBinary !== undefined && platform === 'win32') {
      // reg.exe uses the same failure code for missing keys and failed reads. Read the
      // actual write targets through Registry.GetValue so access errors cannot look absent.
      const keys = Buffer.from(JSON.stringify(windowsRegistryKeys.map(key =>
        key.replace(/^HKCU/, 'HKEY_CURRENT_USER')))).toString('base64');
      const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keys}')) | ConvertFrom-Json
$values = @(foreach ($key in $keys) {
  $value = [Microsoft.Win32.Registry]::GetValue($key, '', $null)
  if ($null -ne $value) {
    if ($value -isnot [string]) { throw 'NATIVE_PATH_UNSAFE' }
    $value
  }
})
[Console]::Write((ConvertTo-Json -InputObject $values -Compress))
`;
      const powershell = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await run!(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 10000 }) as { stdout: string };
      const values: unknown = JSON.parse(result.stdout.trim());
      if (!Array.isArray(values)) throw new Error('NATIVE_PATH_UNSAFE');
      for (const file of values) {
        if (typeof file !== 'string' || !file) throw new Error('NATIVE_PATH_UNSAFE');
        requiredFiles.add(file);
      }
    }
    const files = new Set([registrationFile, ...requiredFiles,
      ...(platform === 'win32' ? [] : browserProfiles().map(profile =>
        path.join(profile, 'NativeMessagingHosts', options.hostName + '.json')))]);
    let matched: string | null = null;
    for (const file of files) {
      let text: string;
      try { text = (await readBoundedFileNoFollow(file, 65536))?.toString('utf8') ?? ''; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !requiredFiles.has(file)) continue;
        throw error;
      }
      const target = (JSON.parse(text) as { path?: unknown }).path;
      if (typeof target !== 'string') throw new Error('NATIVE_PATH_UNSAFE');
      // Installation must prefer any conflicting browser target over a matching cache.
      // Closing keeps the historical first-registration ownership check.
      if (expectedBinary === undefined || target !== expectedBinary) return target;
      matched = target;
    }
    return matched;
  }

  function browserProfiles(): string[] {
    return (
      options.profiles ??
      (platform === 'darwin'
        ? [
            'Google/Chrome',
            'Google/Chrome for Testing',
            'Chromium',
            'Microsoft Edge',
            'BraveSoftware/Brave-Browser',
          ].map((p) => path.join(home, 'Library/Application Support', p))
        : [
            'google-chrome',
            'google-chrome-for-testing',
            'chromium',
            'microsoft-edge',
            'BraveSoftware/Brave-Browser',
          ].map((p) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), p)))
    );
  }

  /** Whether something answers on the loopback port a connection file names. */
  function portListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  /**
   * Withdraw the browser registrations once no Cindy still serves a connection. The registration
   * is shared by every Cindy on this account (release and dev builds, both editions), and each
   * running one keeps its own `connections/<port>.json`; removing it while another is live would
   * cut that one off until it restarts.
   */
  async function unregisterIfUnused(): Promise<void> {
    const ours = path.join(root, 'cindy-browser-native' + (platform === 'win32' ? '.exe' : ''));
    const registered = await registeredBinary();
    if (registered !== null && registered !== ours) return;
    const dir = path.join(root, 'connections');
    const names = await fs.readdir(dir).catch(() => null);
    if (names === null) return;
    // A crashed Cindy leaves its file behind. A file whose port nothing listens on is stale: clear
    // it so it cannot keep the registration alive forever. An unreadable name counts as live.
    let anyLive = false;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const port = Number(name.slice(0, -'.json'.length));
      if (Number.isInteger(port) && port > 0 && !(await portListening(port))) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
      } else {
        anyLive = true;
      }
    }
    if (anyLive) return;
    if (platform === 'win32') {
      const reg = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
      for (const key of windowsRegistryKeys) {
        await run!(
          reg,
          [
            'DELETE',
            key,
            '/f',
          ],
          { windowsHide: true, timeout: 10000 },
        ).catch(() => undefined);
      }
      await fs.rm(registrationFile, { force: true });
      return;
    }
    for (const profile of browserProfiles()) {
      const file = path.join(profile, 'NativeMessagingHosts', options.hostName + '.json');
      const registered = await fs.readFile(file, 'utf8').catch(() => null);
      // Leave a registration that now points somewhere else (another installer took the name).
      let target: unknown = null;
      try {
        target = registered === null ? null : (JSON.parse(registered) as { path?: unknown }).path;
      } catch {
        target = null;
      }
      if (target === ours) await fs.rm(file, { force: true });
    }
    await fs.rm(registrationFile, { force: true });
  }

  /**
   * Extension ids of every running Cindy that shares this registration (release and dev builds, other
   * plugin versions) plus our own: the shared manifest must keep all of their sources, or the last
   * installer would cut the others' extensions off from the native host.
   */
  async function liveExtensionIds(ownPort: number, own: readonly string[]): Promise<string[]> {
    const ids = new Set(own);
    const dir = path.join(root, 'connections');
    for (const name of (await fs.readdir(dir).catch(() => [])) as string[]) {
      if (!name.endsWith('.json')) continue;
      const port = Number(name.slice(0, -'.json'.length));
      if (!Number.isInteger(port) || port <= 0 || port === ownPort || !(await portListening(port)))
        continue;
      try {
        const saved = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as {
          extensionIds?: unknown;
        };
        if (Array.isArray(saved.extensionIds))
          for (const id of saved.extensionIds)
            if (typeof id === 'string' && /^[a-p]{32}$/.test(id)) ids.add(id);
      } catch {
        // An unreadable file contributes nothing.
      }
    }
    return [...ids];
  }

  async function installLocked(port: number, extensionIds: readonly string[], takeover: boolean) {
    try {
      options.assertCurrent?.();
      await privateDirectory(root);
      const binaryName = 'cindy-browser-native' + (platform === 'win32' ? '.exe' : '');
      const binary = path.join(root, binaryName);
      const registered = await registeredBinary(binary);
      if (registered !== null && registered !== binary) {
        if (!takeover || !await options.confirmTakeover?.())
          return { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const, reason: 'NATIVE_HOST_IN_USE' };
        options.assertCurrent?.();
      }
      await privateDirectory(path.join(root, 'connections'));
      // Claim the connection before touching the shared registration, so a binding closing at the
      // same time (plugin update, re-approval, account switch) still sees this one in use.
      config = path.join(root, 'connections', port + '.json');
      await atomic(config, JSON.stringify({ token, extensionIds: [...extensionIds] }));
      const source = path.join(options.binaryDir, platform + '-' + arch, binaryName);
      // 内容相同时不替换正在运行的 Windows 映像。
      const content = await fs.readFile(source);
      const old = await fs.readFile(binary).catch(() => null);
      if (!old?.equals(content)) await atomic(binary, content, 0o700);
      const manifest = {
        name: options.hostName,
        description: 'Cindy browser automatic key binding',
        path: binary,
        type: 'stdio',
        allowed_origins: (await liveExtensionIds(port, extensionIds)).map(
          (id) => 'chrome-extension://' + id + '/',
        ),
      };
      // The same manifest is the system registration and the ownership fact. There is no
      // separate permission database; all instances serialize replacement under one lock.
      await atomic(registrationFile, JSON.stringify(manifest));
      if (platform === 'win32') {
        const file = registrationFile;
        const reg = path.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'reg.exe');
        for (const key of windowsRegistryKeys) {
          await run!(
            reg,
            [
              'ADD',
              key,
              '/ve',
              '/t',
              'REG_SZ',
              '/d',
              file,
              '/f',
            ],
            { windowsHide: true, timeout: 10000 },
          );
        }
      } else {
        for (const profile of browserProfiles()) {
          const dir = path.join(profile, 'NativeMessagingHosts');
          await privateDirectory(dir);
          await atomic(path.join(dir, options.hostName + '.json'), JSON.stringify(manifest));
        }
      }
      state = 'ready';
      return { ok: true as const };
    } catch (e) {
      state = 'unavailable';
      const code = (e as NodeJS.ErrnoException)?.code;
      const reason =
        code && ['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'EBUSY'].includes(code)
          ? code
          : (e as Error)?.message === 'NATIVE_PATH_UNSAFE'
            ? 'NATIVE_PATH_UNSAFE'
            : 'INSTALL_FAILED';
      return { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const, reason };
    }
  }

  async function install(port: number, extensionIds: readonly string[], request?: { takeover?: boolean }) {
    try {
      await privateDirectory(registrationRoot);
      return await withSecurityBoundaryLock(path.join(registrationRoot, options.hostName + '.lock'),
      { label: 'browser-native-registration' }, async lock => {
        if (!lock.held) return { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const, reason: 'REGISTRATION_BUSY' };
        const result = await installLocked(port, extensionIds, request?.takeover === true);
        if (!result.ok) state = 'unavailable';
        return result;
      });
    } catch (error) {
      state = 'unavailable';
      return { ok: false as const, error: 'NATIVE_BINDING_UNAVAILABLE' as const,
        reason: (error as Error).message === 'NATIVE_PATH_UNSAFE' ? 'NATIVE_PATH_UNSAFE' : 'INSTALL_FAILED' };
    }
  }

  async function close(): Promise<void> {
    if (!config) return;
    const data = await fs.readFile(config, 'utf8').catch(() => '');
    // 只删自己写的授权;同端口被另一实例接管时保留它的令牌。
    let saved: unknown;
    try {
      saved = (JSON.parse(data) as { token?: unknown }).token;
    } catch {
      saved = undefined;
    }
    if (saved === token) await fs.rm(config, { force: true });
    config = null;
    await withSecurityBoundaryLock(path.join(registrationRoot, options.hostName + '.lock'),
      { label: 'browser-native-registration' }, async lock => {
        if (lock.held) await unregisterIfUnused();
      }).catch(() => undefined);
  }

  return { token, install, close, status: () => {
    if (state === 'ready') {
      try {
        const registered = JSON.parse(readBoundedFileNoFollowSync(registrationFile, 65536)?.toString('utf8') ?? '') as { path?: unknown };
        if (registered.path !== path.join(root, 'cindy-browser-native' + (platform === 'win32' ? '.exe' : '')))
          return 'unavailable';
      } catch { return 'unavailable'; }
    }
    return state;
  } };
}
