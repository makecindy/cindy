import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkLouderSdkResolver } from '../sdkResolver.js';

describe('Work Louder SDK discovery', () => {
  it('uses an available native Micro backend without loading Store native modules', () => {
    const queryStoreInstallRoots = vi.fn(async () => []);
    const nativeFallback = { entry: 'cindy:windows-micro', source: 'cindy-native' as const };
    const resolve = createWorkLouderSdkResolver({
      platform: 'win32',
      paths: path.win32,
      env: {},
      exists: () => false,
      resolvePackage: () => {
        throw new Error('no SDK');
      },
      queryStoreInstallRoots,
      onChanged: vi.fn(),
      nativeFallback,
    });
    expect(resolve()).toEqual(nativeFallback);
    expect(queryStoreInstallRoots).not.toHaveBeenCalled();
  });
  function fixture(platform: NodeJS.Platform = 'win32') {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const manifests = new Set<string>();
    const queryStoreInstallRoots = vi.fn(async () => [
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__publisher',
    ]);
    const onChanged = vi.fn();
    const clock = { now: 1_000 };
    const resolvePackage = vi.fn((): string => {
      throw new Error('not installed');
    });
    const resolve = createWorkLouderSdkResolver({
      platform,
      paths,
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
      exists: (file) => manifests.has(file),
      resolvePackage,
      queryStoreInstallRoots,
      onChanged,
      now: () => clock.now,
    });
    return { resolve, manifests, paths, queryStoreInstallRoots, onChanged, resolvePackage, clock };
  }

  it('discovers the Store app/app.asar SDK asynchronously and coalesces probes', async () => {
    const f = fixture();
    const entry = f.paths.join(
      'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1_x64__publisher',
      'app',
      'resources',
      'app.asar',
      'node_modules',
      '@worklouder',
      'device-kit-oai',
    );
    f.manifests.add(f.paths.join(entry, 'package.json'));
    expect(f.resolve()).toBeNull();
    expect(f.resolve()).toBeNull();
    await vi.waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
    expect(f.resolve()).toEqual({ entry, source: 'openai-app' });
    expect(f.queryStoreInstallRoots).toHaveBeenCalledOnce();
  });

  it('prefers a Cindy-installed SDK without querying Store packages', () => {
    const f = fixture();
    f.resolvePackage.mockReturnValue('sdk-entry');
    expect(f.resolve()).toEqual({ entry: 'sdk-entry', source: 'cindy-package' });
    expect(f.queryStoreInstallRoots).not.toHaveBeenCalled();
  });

  it('preserves regular Windows installations', () => {
    const f = fixture();
    const entry = f.paths.join(
      'C:\\Program Files',
      'Codex',
      'resources',
      'app.asar',
      'node_modules',
      '@worklouder',
      'device-kit-oai',
    );
    f.manifests.add(f.paths.join(entry, 'package.json'));
    expect(f.resolve()).toEqual({ entry, source: 'openai-app' });
    expect(f.queryStoreInstallRoots).not.toHaveBeenCalled();
  });

  it('preserves macOS bundles without Windows queries', () => {
    const f = fixture('darwin');
    const entry =
      '/Applications/Codex.app/Contents/resources/app.asar/node_modules/@worklouder/device-kit-oai';
    f.manifests.add(`${entry}/package.json`);
    expect(f.resolve()).toEqual({ entry, source: 'openai-app' });
    expect(f.queryStoreInstallRoots).not.toHaveBeenCalled();
  });

  it('handles Store lookup failure without an unhandled rejection or probe storm', async () => {
    const f = fixture();
    f.queryStoreInstallRoots.mockRejectedValue(new Error('query failed'));
    expect(f.resolve()).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.resolve()).toBeNull();
    expect(f.queryStoreInstallRoots).toHaveBeenCalledOnce();
    expect(f.onChanged).not.toHaveBeenCalled();
  });

  it('retries negative Store results after the cooldown, allowing installation while Cindy is open', async () => {
    const f = fixture();
    f.queryStoreInstallRoots.mockResolvedValue([]);
    f.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.clock.now += 29_999;
    f.resolve();
    expect(f.queryStoreInstallRoots).toHaveBeenCalledOnce();
    f.clock.now += 1;
    f.resolve();
    expect(f.queryStoreInstallRoots).toHaveBeenCalledTimes(2);
  });

  it('ignores relative Store paths instead of resolving them against the workdir', async () => {
    const f = fixture();
    f.queryStoreInstallRoots.mockResolvedValue(['relative-app']);
    f.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.resolve()).toBeNull();
    expect(f.onChanged).not.toHaveBeenCalled();
  });

  it('does not query Windows packages on unsupported platforms', () => {
    const f = fixture('linux');
    expect(f.resolve()).toBeNull();
    expect(f.queryStoreInstallRoots).not.toHaveBeenCalled();
  });
});
