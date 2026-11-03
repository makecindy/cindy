// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  mobileXcodeGeneratedDir,
  parseMobileXcodeArgs,
  selectMobileXcodeWorkspace,
  updateMobileXcodeEnvContent,
} from '../../scripts/lib/mobile-xcode.mjs';
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from '../../scripts/lib/mobile-dev-region.mjs';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';
import { resolvePnpmInvocation, usablePnpmExecPath } from '../../../../scripts/shared/pnpm-invocation.mjs';

describe('mobile:xcode 参数', () => {
  it('不传 region 时默认 global', () => {
    expect(parseMobileXcodeArgs([])).toEqual({ help: false, region: 'global' });
  });

  it('支持 --region value / --region=value 与 pnpm 的分隔符', () => {
    expect(parseMobileXcodeArgs(['--region', 'cn'])).toEqual({ help: false, region: 'cn' });
    expect(parseMobileXcodeArgs(['--', '--region=global'])).toEqual({ help: false, region: 'global' });
  });

  it('region 只允许 cn / global / dev', () => {
    expect(() => parseMobileXcodeArgs(['--region', 'us'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => parseMobileXcodeArgs(['--region'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => parseMobileXcodeArgs(['--region', ''])).toThrow(/只能是 cn 或 global 或 dev/);
  });
});

describe('mobile simulator region 参数', () => {
  it('默认 global，并仅移除 region 参数', () => {
    expect(extractMobileDevRegionArgs(['--port', '8082'])).toEqual({
      region: 'global',
      passthrough: ['--port', '8082'],
    });
    expect(extractMobileDevRegionArgs(['--', '--region=global', '--clean'])).toEqual({
      region: 'global',
      passthrough: ['--clean'],
    });
  });

  it('拒绝非法或重复 region', () => {
    expect(() => extractMobileDevRegionArgs(['--region=us'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => extractMobileDevRegionArgs(['--region=cn', '--region=global'])).toThrow(/只能传一次/);
  });

  it.each(['global', 'cn'])('把所选 %s 注入 Metro 子进程，覆盖 shell 残留值', async (region) => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/sim-start.mjs'), 'utf8');
    const start = source.indexOf("const args = ['exec', 'expo', 'start'");
    if (start < 0) throw new Error('Missing sim:start launch flow');
    const buildEnv = withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region }));
    const spawn = vi.fn(() => ({ once: vi.fn(), on: vi.fn() }));
    await runInNewContext(`(async () => { ${source.slice(start)} })()`, {
      DEFAULT_PORT: 8081, portArgs: { port: 8082, passthrough: [] },
      portInUse: async () => false, ensureAndroidTarget: vi.fn(), spawn,
      console: { log: vi.fn(), error: vi.fn() },
      process: { env: { KEEP: 'inherited', EXPO_PUBLIC_CINDY_AUTH_REGION: region === 'cn' ? 'global' : 'cn',
        CINDY_USE_LOCAL_REGION_CONFIG: '0', EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://stale.invalid' } },
      resolvePnpmInvocation: (args, options) => resolvePnpmInvocation(args, { ...options, platform: 'darwin', execPath: '/node' }),
      usablePnpmExecPath, existsSync: () => false,
      mobileDir: '/repo/apps/mobile', worktreeRoot: '/repo', buildEnv, region,
      branch: 'test', commit: '123', sourceIdentity: 'test@123',
    });
    expect(spawn).toHaveBeenCalledWith('pnpm', ['exec', 'expo', 'start', '--dev-client', '--port', '8082'],
      expect.objectContaining({ shell: false, env: expect.objectContaining({ ...buildEnv,
        KEEP: 'inherited', EXPO_PUBLIC_CINDY_AUTH_REGION: region, CINDY_USE_LOCAL_REGION_CONFIG: '1' }) }));
  });

  it('所有本地构建环境都启用 region JSON 配置源', () => {
    expect(withLocalMobileRegionConfig({ EXPO_PUBLIC_CINDY_AUTH_REGION: 'global' }))
      .toEqual({
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
        CINDY_USE_LOCAL_REGION_CONFIG: '1',
      });
  });
});

describe('mobile:xcode env 切换', () => {
  it('覆盖地区键、去掉重复定义并保留其它本地配置', () => {
    const source = [
      '# local settings',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=stale',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://cn.example',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=https://global.example',
      'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me',
      '',
    ].join('\n');
    const next = updateMobileXcodeEnvContent(source, {
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://global.example',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: 'https://cn.example',
      CINDY_USE_LOCAL_REGION_CONFIG: '1',
    });

    expect(next.match(/EXPO_PUBLIC_CINDY_AUTH_REGION=/g)).toHaveLength(1);
    expect(next).toContain('EXPO_PUBLIC_CINDY_AUTH_REGION=global');
    expect(next).toContain('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://global.example');
    expect(next).toContain(
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=https://cn.example',
    );
    expect(next).toContain('CINDY_USE_LOCAL_REGION_CONFIG=1');
    expect(next).toContain('EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me');
  });
});

describe('mobile:xcode workspace 选择', () => {
  it('只选 app workspace，忽略 Pods workspace', () => {
    expect(selectMobileXcodeWorkspace('/repo/apps/mobile/ios', [
      'Pods.xcworkspace',
      'Cindy.xcworkspace',
      'Podfile',
    ])).toBe(join('/repo/apps/mobile/ios', 'Cindy.xcworkspace'));
  });

  it('缺失或出现多个 app workspace 时 fail closed', () => {
    expect(() => selectMobileXcodeWorkspace('/ios', ['Podfile'])).toThrow(/未在 .* 找到/);
    expect(() => selectMobileXcodeWorkspace('/ios', ['A.xcworkspace', 'B.xcworkspace'])).toThrow(/找到多个/);
  });
});

describe('mobile:xcode 完整开发链路', () => {
  // Execute main with only filesystem/process boundaries injected. The former
  // source checks could not prove that region survives the Xcode-to-Metro bridge
  // or that an occupied 8081 refuses before changing the generated project.
  it.each([
    { name: 'defaults to global despite a stale cn shell', argv: [], region: 'global', owner: 'free', sameEnv: false },
    { name: 'forwards explicit cn', argv: ['--region=cn'], region: 'cn', owner: 'free', sameEnv: false },
    { name: 'reuses the same checkout and region', argv: ['--region=cn'], region: 'cn', owner: 'local', sameEnv: true },
    { name: 'refuses another checkout', argv: [], region: 'global', owner: 'foreign', sameEnv: true, error: '其它 checkout/process' },
    { name: 'refuses a local Metro with changed region', argv: [], region: 'global', owner: 'local', sameEnv: false, error: 'region/env 将变化' },
  ])('$name', async ({ argv, region, owner, sameEnv, error }) => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/open-ios-xcode.mjs'), 'utf8');
    const start = source.indexOf('const iosDir =');
    const end = source.lastIndexOf('\nmain().catch(');
    if (start < 0 || end < start) throw new Error('Missing mobile:xcode main flow');
    const worktreeRoot = resolve('/fixture-xcode');
    const mobileDir = join(worktreeRoot, 'apps', 'mobile');
    const iosDir = join(mobileDir, 'ios');
    const envPath = join(mobileDir, '.env');
    const simStartPath = join(mobileDir, 'scripts', 'sim-start.mjs');
    const buildEnv = withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region }));
    const previousEnv = updateMobileXcodeEnvContent('', sameEnv ? buildEnv
      : withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region === 'cn' ? 'global' : 'cn' })));
    const files = new Map([[envPath, previousEnv]]);
    const writeFileSync = vi.fn((target, content) => files.set(target, content));
    const execFileSync = vi.fn();
    const podInstallBounded = vi.fn(async () => {});
    const portInUse = vi.fn(async () => owner !== 'free');
    const execution = runInNewContext(`(async () => { ${source.slice(start, end)}; await main(); })()`, {
      mobileDir, worktreeRoot, resolve,
      process: { platform: 'darwin', execPath: '/fixture-node', argv: ['node', 'open-ios-xcode.mjs', ...argv],
        env: { EXPO_PUBLIC_CINDY_AUTH_REGION: region === 'cn' ? 'global' : 'cn', KEEP: 'inherited' } },
      console: { log: vi.fn() },
      parseMobileXcodeArgs, withLocalMobileRegionConfig, mobileClientBundleEnv, updateMobileXcodeEnvContent,
      existsSync: (target) => files.has(target), readFileSync: (target) => files.get(target), writeFileSync,
      portInUse, listenerPid: () => '4242', cwdOfPid: () => owner === 'local' ? mobileDir : resolve('/other-checkout/apps/mobile'),
      isInside: (root, cwd) => cwd === mobileDir && root === worktreeRoot,
      execFileSync, podInstallBounded, withUserGemPodOnPath: ({ env }: { env: object }) => env, readdirSync: () => ['Pods.xcworkspace', 'Cindy.xcworkspace'],
      selectMobileXcodeWorkspace, mobileXcodeGeneratedDir,
    });
    if (error) {
      await expect(execution).rejects.toThrow(error);
      expect(execFileSync).not.toHaveBeenCalled();
      expect(podInstallBounded).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(files.get(envPath)).toBe(previousEnv);
    } else {
      await execution;
      const expectedEnv = expect.objectContaining({ ...buildEnv, KEEP: 'inherited', EXPO_PUBLIC_CINDY_AUTH_REGION: region });
      expect(execFileSync).toHaveBeenNthCalledWith(1, 'pnpm', ['exec', 'expo', 'prebuild', '-p', 'ios', '--clean', '--no-install'],
        { cwd: mobileDir, env: expectedEnv, stdio: 'inherit' });
      expect(podInstallBounded).toHaveBeenCalledWith({ iosDir, env: expectedEnv });
      expect(execFileSync).toHaveBeenNthCalledWith(2, 'open', ['-a', 'Xcode', join(iosDir, 'Cindy.xcworkspace')],
        { cwd: mobileDir, stdio: 'inherit' });
      expect(execFileSync).toHaveBeenNthCalledWith(3, '/fixture-node', [simStartPath, `--region=${region}`],
        { cwd: worktreeRoot, env: expectedEnv, stdio: 'inherit' });
      expect(files.get(envPath)).toBe(updateMobileXcodeEnvContent(previousEnv, buildEnv));
      expect(writeFileSync).toHaveBeenCalledTimes(sameEnv ? 0 : 1);
    }
    expect(portInUse).toHaveBeenCalledWith(8081);
  });
});
