// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { describe, expect, it, vi } from 'vitest';
import {
  classifySimMetroListener,
  extractSimJsonArgs,
  extractSimMetroPortArgs,
  extractSimTakeoverArgs,
  resolveMobileSimulatorBundleId,
} from '../../scripts/lib/sim-whoami.mjs';

describe('mobile:sim:whoami Metro port', () => {
  it.each([
    [['--port', '8082'], 8082],
    [['-p', '8083'], 8083],
    [['--port=8084'], 8084],
  ])('accepts an explicit port from %j', (args, port) => {
    expect(extractSimMetroPortArgs(args)).toEqual({ port, explicit: true, passthrough: [] });
  });

  it('defaults to 8081 and preserves unsupported arguments', () => {
    expect(extractSimMetroPortArgs(['--unknown'])).toEqual({
      port: 8081,
      explicit: false,
      passthrough: ['--unknown'],
    });
  });

  it('rejects missing, invalid, or duplicate ports', () => {
    expect(() => extractSimMetroPortArgs(['--port'])).toThrow(/端口无效/);
    expect(() => extractSimMetroPortArgs(['--port', '0'])).toThrow(/端口无效/);
    expect(() => extractSimMetroPortArgs(['--port=8082', '-p', '8083'])).toThrow(/只能传一次/);
  });
});

describe('mobile:sim takeover and JSON arguments', () => {
  it('extracts one explicit takeover flag', () => {
    expect(extractSimTakeoverArgs(['--takeover', '--region=cn'])).toEqual({
      takeover: true,
      passthrough: ['--region=cn'],
    });
    expect(extractSimTakeoverArgs([])).toEqual({ takeover: false, passthrough: [] });
    expect(() => extractSimTakeoverArgs(['--takeover', '--takeover'])).toThrow(/只能传一次/);
  });

  it('extracts one JSON output flag', () => {
    expect(extractSimJsonArgs(['--json', '--port=8082'])).toEqual({
      json: true,
      passthrough: ['--port=8082'],
    });
    expect(extractSimJsonArgs([])).toEqual({ json: false, passthrough: [] });
    expect(() => extractSimJsonArgs(['--json', '--json'])).toThrow(/只能传一次/);
  });
});

describe('mobile:sim Metro identity', () => {
  it('requires a Cindy mobile cwd and injected source identity', () => {
    expect(classifySimMetroListener({
      cwd: '/repo/apps/mobile',
      source: 'branch@commit',
      targetWorktree: '/repo-target',
    })).toEqual({ confirmed: true, worktree: '/repo', isTarget: false });
    expect(classifySimMetroListener({
      cwd: '/other/project',
      source: 'branch@commit',
      targetWorktree: '/repo-target',
    })).toEqual({ confirmed: false, worktree: null });
    expect(classifySimMetroListener({
      cwd: '/repo/apps/mobile',
      source: null,
      targetWorktree: '/repo-target',
    })).toEqual({ confirmed: false, worktree: null });
  });
});

describe('mobile:sim:whoami bundle identity', () => {
  it.each([
    ['cn', 'com.local.cindycn'],
    ['global', 'com.local.cindy'],
  ])('从 %s 的最终 Expo config 读取 bundle id', (region, bundleIdentifier) => {
    const execFile = vi.fn(() => JSON.stringify({ ios: { bundleIdentifier } }));

    expect(
      resolveMobileSimulatorBundleId(region, {
        execFile,
        env: { KEEP_ME: 'yes' },
        mobileDir: '/repo/apps/mobile',
      }),
    ).toBe(bundleIdentifier);

    expect(execFile).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'expo', 'config', '--type', 'public', '--json'],
      expect.objectContaining({
        cwd: '/repo/apps/mobile',
        env: expect.objectContaining({
          KEEP_ME: 'yes',
          CINDY_USE_LOCAL_REGION_CONFIG: '1',
          EXPO_PUBLIC_CINDY_AUTH_REGION: region,
        }),
      }),
    );
  });

  it('最终 Expo config 缺少 bundle id 时 fail closed', () => {
    expect(() =>
      resolveMobileSimulatorBundleId('cn', {
        execFile: () => JSON.stringify({ ios: {} }),
      }),
    ).toThrow(/缺少 ios\.bundleIdentifier.*cn/);
  });

  it('保留 Expo config 的失败原因', () => {
    const cause = Object.assign(new Error('command failed'), {
      stderr: '缺少地区构建配置',
    });
    expect(() =>
      resolveMobileSimulatorBundleId('global', {
        execFile: () => {
          throw cause;
        },
      }),
    ).toThrow(/无法解析 global Simulator bundle id: 缺少地区构建配置/);
  });
});
