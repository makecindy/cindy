// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { describe, expect, it, vi } from 'vitest';
import {
  bootedSimulatorLinesForTarget,
  extractSimMetroPortArgs,
  extractSimWhoamiUdidArgs,
  getSimulatorAppContainer,
  resolveMobileSimulatorBundleId,
} from '../../scripts/lib/sim-whoami.mjs';

const SIMULATOR_UDID = 'A1B2C3D4-E5F6-47A8-9B0C-D1E2F3A4B5C6';

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

describe('mobile:sim:whoami exact Simulator target', () => {
  it.each([
    [['--udid', SIMULATOR_UDID.toLowerCase()]],
    [[`--udid=${SIMULATOR_UDID}`]],
  ])('accepts and canonicalizes an exact UDID from %j', (args) => {
    expect(extractSimWhoamiUdidArgs(args)).toEqual({
      simulatorUdid: SIMULATOR_UDID,
      passthrough: [],
    });
  });

  it('keeps manual whoami compatible when no target is supplied', () => {
    expect(extractSimWhoamiUdidArgs(['--port', '8082'])).toEqual({
      simulatorUdid: null,
      passthrough: ['--port', '8082'],
    });
  });

  it('rejects missing, invalid, or duplicate UDIDs', () => {
    expect(() => extractSimWhoamiUdidArgs(['--udid'])).toThrow(/UDID 无效/);
    expect(() => extractSimWhoamiUdidArgs(['--udid', 'booted'])).toThrow(/UDID 无效/);
    expect(() =>
      extractSimWhoamiUdidArgs(['--udid', SIMULATOR_UDID, `--udid=${SIMULATOR_UDID}`]),
    ).toThrow(/只能传一次/);
  });

  it('does not treat another booted Simulator as the requested target', () => {
    const otherUdid = '11111111-2222-4333-8444-555555555555';
    const lines = [
      `iPhone A (${SIMULATOR_UDID}) (Booted)`,
      `iPhone B (${otherUdid}) (Booted)`,
      'iPhone C (AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE) (Shutdown)',
    ];

    expect(bootedSimulatorLinesForTarget(lines, otherUdid)).toEqual([lines[1]]);
    expect(bootedSimulatorLinesForTarget(lines, '99999999-2222-4333-8444-555555555555')).toEqual([]);
  });

  it('probes app installation on the exact target without a booted fallback', () => {
    const run = vi.fn((_command, args) =>
      args[2] === SIMULATOR_UDID ? '' : '/another-simulator/Cindy.app',
    );

    expect(getSimulatorAppContainer(run, SIMULATOR_UDID, 'com.example.cindy')).toBe('');
    expect(run).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'get_app_container',
      SIMULATOR_UDID,
      'com.example.cindy',
      'app',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
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
