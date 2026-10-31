/**
 * native-binding.test — Native Messaging 注册(从插件时期迁入宿主)的文件系统契约。
 *
 * 测试价值
 * - 生产入口与可观察结果:createNativeBinding().install/close;浏览器 profile 里的 host
 *   manifest 内容、私有连接文件的权限、关闭时只删自己的令牌。
 * - 规则依据:docs/dev-rules/credentials-and-local-storage.md(私有授权不进扩展、不进清单、
 *   0600);协议兼容规则「注册文件布局与插件时期相同」。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:注册目录是符号链接;二进制缺失;同端口被另一实例接管后关闭。
 * - tier:unit(临时目录);实测耗时 < 1 秒。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import net from 'node:net';

import { createNativeBinding } from '../native-binding';

const EXT = 'a'.repeat(32);
const dirs: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-native-binding-'));
  dirs.push(dir);
  const binaryDir = path.join(dir, 'pkg', 'native-host', 'bin');
  await fs.mkdir(path.join(binaryDir, 'darwin-arm64'), { recursive: true });
  await fs.writeFile(
    path.join(binaryDir, 'darwin-arm64', 'cindy-browser-native'),
    'fixture executable',
  );
  const profile = path.join(dir, 'profile');
  await fs.mkdir(profile);
  return { dir, binaryDir, profile, root: path.join(dir, 'native') };
}

describe('native-binding', () => {
  it('registers only allowed origins; the private authority never enters the browser manifest', async () => {
    const { binaryDir, profile, root } = await fixture();
    const n = createNativeBinding({
      hostName: 'com.example.browser',
      binaryDir,
      root,
      profiles: [profile],
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(await n.install(18819, [EXT])).toEqual({ ok: true });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(profile, 'NativeMessagingHosts', 'com.example.browser.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      name: 'com.example.browser',
      type: 'stdio',
      allowed_origins: ['chrome-extension://' + EXT + '/'],
      path: path.join(root, 'cindy-browser-native'),
    });
    expect(JSON.stringify(manifest)).not.toContain(n.token);
    // Windows reports its own permission bits (0o666); owner-only modes are a POSIX property.
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(root, 'connections', '18819.json'))).mode & 0o777).toBe(
        0o600,
      );
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(root, 'cindy-browser-native'), 'utf8')).toBe(
      'fixture executable',
    );
    expect(n.status()).toBe('ready');
    await n.close();
    await expect(fs.access(path.join(root, 'connections', '18819.json'))).rejects.toThrow();
  });

  it('closing one binding keeps another instance authority on the same reused port', async () => {
    const { binaryDir, profile, root } = await fixture();
    const opts = {
      hostName: 'com.example.browser',
      binaryDir,
      root,
      profiles: [profile],
      platform: 'darwin' as const,
      arch: 'arm64',
    };
    // The instance that kept the port is running, so something listens on it.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const a = createNativeBinding(opts);
    const b = createNativeBinding(opts);
    await a.install(port, [EXT]);
    await b.install(port, [EXT]);
    await a.close();
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'connections', `${port}.json`), 'utf8')).token,
    ).toBe(b.token);
    await b.close();
  });

  // Review 2026-10-30 (Codex P2): the shared manifest keeps the sources of every running Cindy.
  it('keeps the extension ids of other running Cindys in the shared manifest', async () => {
    const { binaryDir, profile, root } = await fixture();
    const opts = {
      hostName: 'com.example.browser',
      binaryDir,
      root,
      profiles: [profile],
      platform: 'darwin' as const,
      arch: 'arm64',
    };
    const listen = async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      return (server.address() as net.AddressInfo).port;
    };
    const other = 'b'.repeat(32);
    const first = createNativeBinding(opts);
    const second = createNativeBinding(opts);
    await first.install(await listen(), [EXT]);
    await second.install(await listen(), [other]);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(profile, 'NativeMessagingHosts', 'com.example.browser.json'),
        'utf8',
      ),
    );
    expect([...manifest.allowed_origins].sort()).toEqual(
      ['chrome-extension://' + EXT + '/', 'chrome-extension://' + other + '/'].sort(),
    );
    await first.close();
    await second.close();
  });

  // Review 2026-10-29: registrations were never withdrawn. Every Cindy on the account shares one,
  // so it may only go once no running Cindy still serves a connection.
  it('withdraws the browser registration only after the last running Cindy closes', async () => {
    const { binaryDir, profile, root } = await fixture();
    const opts = {
      hostName: 'com.example.browser',
      binaryDir,
      root,
      profiles: [profile],
      platform: 'darwin' as const,
      arch: 'arm64',
    };
    const registration = path.join(profile, 'NativeMessagingHosts', 'com.example.browser.json');
    // A running Cindy listens on the port its connection file names.
    const listen = async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      return (server.address() as net.AddressInfo).port;
    };
    const releasePort = await listen();
    const devPort = await listen();
    const release = createNativeBinding(opts);
    const dev = createNativeBinding(opts);
    await release.install(releasePort, [EXT]);
    await dev.install(devPort, [EXT]);
    await dev.close();
    await expect(fs.access(registration)).resolves.toBeUndefined();
    await release.close();
    await expect(fs.access(registration)).rejects.toThrow();
  });

  // Review 2026-10-29 (Greptile P2): a crashed Cindy leaves its connection file, which then kept the
  // registration alive for good once another port was in use.
  it('ignores and clears the connection file a crashed Cindy left behind', async () => {
    const { binaryDir, profile, root } = await fixture();
    const opts = {
      hostName: 'com.example.browser',
      binaryDir,
      root,
      profiles: [profile],
      platform: 'darwin' as const,
      arch: 'arm64',
    };
    const registration = path.join(profile, 'NativeMessagingHosts', 'com.example.browser.json');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    // A port that was just listened on and released: nothing listens on it any more.
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const live = createNativeBinding(opts);
    await live.install(port, [EXT]);
    await fs.writeFile(
      path.join(root, 'connections', `${deadPort}.json`),
      JSON.stringify({ token: 'x'.repeat(64) }),
    );
    await live.close();
    await expect(fs.access(registration)).rejects.toThrow();
    await expect(fs.access(path.join(root, 'connections', `${deadPort}.json`))).rejects.toThrow();
  });

  it('Windows registration uses only current-user fixed registry keys and argv', async () => {
    const { dir, binaryDir } = await fixture();
    await fs.mkdir(path.join(binaryDir, 'win32-x64'), { recursive: true });
    await fs.writeFile(path.join(binaryDir, 'win32-x64', 'cindy-browser-native.exe'), 'fixture');
    const run = vi.fn(async () => undefined);
    const n = createNativeBinding({
      hostName: 'com.example.browser',
      binaryDir,
      root: path.join(dir, 'native'),
      platform: 'win32',
      arch: 'x64',
      env: { SystemRoot: 'C:\\Windows' },
      run,
    });
    expect((await n.install(18819, [EXT])).ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    for (const [, args, opts] of run.mock.calls as unknown as Array<
      [string, string[], { windowsHide: boolean }]
    >) {
      expect(args[0]).toBe('ADD');
      expect(args[1]).toMatch(/^HKCU\\Software\\/);
      expect(args.at(-1)).toBe('/f');
      expect(opts.windowsHide).toBe(true);
    }
    await n.close();
  });

  it('fails closed when the executable is absent or the registration directory is a symlink', async () => {
    const { dir, binaryDir, profile } = await fixture();
    const link = path.join(dir, 'link');
    await fs.symlink(profile, link);
    const linked = createNativeBinding({
      hostName: 'com.example.browser',
      binaryDir,
      root: link,
      profiles: [profile],
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(await linked.install(18819, [EXT])).toMatchObject({
      ok: false,
      error: 'NATIVE_BINDING_UNAVAILABLE',
    });
    expect(linked.status()).toBe('unavailable');
    const missing = createNativeBinding({
      hostName: 'com.example.browser',
      binaryDir: path.join(dir, 'nowhere'),
      root: path.join(dir, 'native2'),
      profiles: [profile],
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(await missing.install(18819, [EXT])).toMatchObject({ ok: false, reason: 'ENOENT' });
  });
});
