// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bootedSimulatorLinesForTarget,
  classifySimMetroListener,
  extractSimJsonArgs,
  extractSimMetroPortArgs,
  extractSimTakeoverArgs,
  extractSimWhoamiUdidArgs,
  getSimulatorAppContainer,
  resolveMobileSimulatorBundleId,
  resolveSimMetroHandoff,
  resolveSimulatorDeviceSets,
  selectBootedSimulator,
  simulatorBackendNotice,
  cindySimulatorAvailable,
  inspectTargetNativeIdentity,
  findSimulatorDeviceSet,
  simctlArgs,
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

describe('mobile:sim takeover and JSON arguments', () => {
  it('extracts one explicit takeover flag', () => {
    expect(extractSimTakeoverArgs(['--takeover'])).toEqual({
      takeover: true,
      passthrough: [],
    });
    expect(extractSimTakeoverArgs([])).toEqual({ takeover: false, passthrough: [] });
    expect(() => extractSimTakeoverArgs(['--takeover', '--takeover'])).toThrow(/只能传一次/);
  });

  it('extracts one JSON output flag', () => {
    expect(extractSimJsonArgs(['--json', '--port=8082'])).toEqual({
      json: true,
      passthrough: ['--port=8082'],
    });
    expect(() => extractSimJsonArgs(['--json', '--json'])).toThrow(/只能传一次/);
  });

  it('rejects non-Cindy paths and missing source identities', () => {
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
    expect(classifySimMetroListener({
      cwd: '/repo/apps/mobile',
      source: 'branch@commit',
      targetWorktree: '/repo-target',
    })).toEqual({ confirmed: true, worktree: '/repo', isTarget: false });
    expect(classifySimMetroListener({
      cwd: '/repo/apps/mobile/',
      source: 'branch@commit',
      targetWorktree: '/repo/',
    })).toEqual({ confirmed: true, worktree: '/repo', isTarget: true });
  });

  it('compares Windows worktree paths case-insensitively', () => {
    expect(classifySimMetroListener({
      cwd: 'C:\\Repo\\apps\\mobile',
      source: 'branch@commit',
      targetWorktree: 'c:\\repo',
      platform: 'win32',
    })).toEqual({ confirmed: true, worktree: 'C:/Repo', isTarget: true });
    expect(classifySimMetroListener({
      cwd: 'C:\\RepoOther\\apps\\mobile',
      source: 'branch@commit',
      targetWorktree: 'c:\\repo',
      platform: 'win32',
    })).toEqual({ confirmed: true, worktree: 'C:/RepoOther', isTarget: false });
    expect(classifySimMetroListener({
      cwd: 'C:\\Repo\\apps\\mobile',
      source: 'branch@commit',
      targetWorktree: 'D:\\repo',
      platform: 'win32',
    })).toEqual({ confirmed: true, worktree: 'C:/Repo', isTarget: false });
    expect(classifySimMetroListener({
      cwd: '/Repo/apps/mobile',
      source: 'branch@commit',
      targetWorktree: '/repo',
      platform: 'linux',
    })).toEqual({ confirmed: true, worktree: '/Repo', isTarget: false });
  });

  it('restarts a target Metro when its persisted region differs', () => {
    expect(resolveSimMetroHandoff({
      currentSource: 'branch@commit', runningSource: 'branch@commit',
      currentRegion: 'global', runningRegion: 'cn',
      listener: { confirmed: true, isTarget: true }, listenerWorktreeExists: true,
    })).toMatchObject({ action: 'refuse', code: 'target-region-stale' });
    expect(resolveSimMetroHandoff({
      takeover: true, currentSource: 'branch@commit', runningSource: 'branch@commit',
      currentRegion: 'global', runningRegion: 'cn',
      listener: { confirmed: true, isTarget: true }, listenerWorktreeExists: true,
    })).toMatchObject({ action: 'restart', code: 'target-region' });
  });

  it('restarts a target Metro when its persisted environment fingerprint differs', () => {
    expect(resolveSimMetroHandoff({
      currentSource: 'branch@commit', runningSource: 'branch@commit',
      currentEnvFingerprint: 'env-new', runningEnvFingerprint: 'env-old',
      listener: { confirmed: true, isTarget: true }, listenerWorktreeExists: true,
    })).toMatchObject({ action: 'refuse', code: 'target-env-stale' });
    expect(resolveSimMetroHandoff({
      takeover: true, currentSource: 'branch@commit', runningSource: 'branch@commit',
      currentEnvFingerprint: 'env-new', runningEnvFingerprint: 'env-old',
      listener: { confirmed: true, isTarget: true }, listenerWorktreeExists: true,
    })).toMatchObject({ action: 'restart', code: 'target-env' });
  });
});

describe('mobile:sim Metro handoff', () => {
  const foreign = {
    confirmed: true,
    worktree: '/other',
    isTarget: false,
  };
  const target = {
    confirmed: true,
    worktree: '/repo',
    isTarget: true,
  };

  it('lets --takeover stop a foreign Metro even if that worktree is dirty', () => {
    expect(resolveSimMetroHandoff({
      cwd: '/other/apps/mobile',
      takeover: true,
      currentSource: 'here@aaa',
      runningSource: 'there@bbb',
      listener: foreign,
      listenerWorktreeExists: true,
    })).toMatchObject({ action: 'restart', code: 'occupied-foreign' });
  });

  it('lets --takeover stop an orphan Metro whose worktree is gone', () => {
    expect(resolveSimMetroHandoff({
      cwd: '/gone/apps/mobile',
      takeover: true,
      currentSource: 'here@aaa',
      runningSource: 'gone@ccc',
      listener: foreign,
      listenerWorktreeExists: false,
    })).toMatchObject({ action: 'restart', code: 'occupied-orphan' });
  });

  it('refuses a dirty or orphan foreign Metro without --takeover', () => {
    expect(resolveSimMetroHandoff({
      cwd: '/other/apps/mobile',
      currentSource: 'here@aaa',
      runningSource: 'there@bbb',
      listener: foreign,
      listenerWorktreeExists: true,
    })).toMatchObject({ action: 'refuse', code: 'occupied-foreign' });
    expect(resolveSimMetroHandoff({
      cwd: '/gone/apps/mobile',
      currentSource: 'here@aaa',
      runningSource: 'gone@ccc',
      listener: foreign,
      listenerWorktreeExists: false,
    })).toMatchObject({ action: 'refuse', code: 'occupied-orphan' });
  });

  it('keeps unknown occupants fail-closed even with --takeover', () => {
    expect(resolveSimMetroHandoff({
      cwd: '/random',
      takeover: true,
      currentSource: 'here@aaa',
      runningSource: null,
      listener: { confirmed: false, worktree: null },
    })).toMatchObject({ action: 'refuse', code: 'occupied-unknown' });
  });

  it('reuses a fresh Metro on this worktree and restarts a stale one only with --takeover', () => {
    expect(resolveSimMetroHandoff({
      cwd: '/repo/apps/mobile',
      currentSource: 'here@aaa',
      runningSource: 'here@aaa',
      listener: target,
      listenerWorktreeExists: true,
    })).toMatchObject({ action: 'reuse', code: 'target-fresh' });
    expect(resolveSimMetroHandoff({
      cwd: '/repo/apps/mobile',
      currentSource: 'here@aaa',
      runningSource: 'here@old',
      listener: target,
      listenerWorktreeExists: true,
    })).toMatchObject({ action: 'refuse', code: 'target-stale' });
    expect(resolveSimMetroHandoff({
      cwd: '/repo/apps/mobile',
      takeover: true,
      currentSource: 'here@aaa',
      runningSource: 'here@old',
      listener: target,
      listenerWorktreeExists: true,
    })).toMatchObject({ action: 'restart', code: 'target-stale' });
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

describe('mobile:sim simulator choice', () => {
  const root = '/home/test/Library/Application Support/BaguetteCindy';
  const cindy = { name: 'cindy', path: join(root, 'devices') };
  const system = { name: 'system', path: null };
  const settings = (value?: string) => () => {
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  };
  const resolve = (choice: string, readFile = settings(), exists = () => true) =>
    resolveSimulatorDeviceSets({ choice, root, exists, readFile });

  it('prefers Cindy only while it is installed and allowed to run', () => {
    expect(resolve('auto')).toEqual([cindy, system]);
    expect(resolve('auto', settings('{"enabled":true,"idleMinutes":15}'))).toEqual([cindy, system]);
    expect(resolve('auto', settings('{"enabled":false,"idleMinutes":15}'))).toEqual([system]);
    expect(resolve('auto', settings('{broken'))).toEqual([system]);
    expect(resolve('auto', settings(), () => false)).toEqual([system]);
  });

  it('pins one simulator when chosen outside the repository', () => {
    expect(resolve('system')).toEqual([system]);
    expect(resolve('cindy')).toEqual([cindy]);
    expect(resolve('/tmp/devices')).toEqual([{ name: '/tmp/devices', path: '/tmp/devices' }]);
    expect(resolve(cindy.path)).toEqual([cindy]);
    expect(() => resolve('cindy', settings('{"enabled":false,"idleMinutes":15}'))).toThrow(/关闭了运行/);
    expect(() => resolve('cindy', settings(), () => false)).toThrow(/没有找到 Cindy 模拟器/);
    expect(() => resolve('relative/devices')).toThrow(/绝对路径/);
  });

  it('scopes simctl to the selected device set', () => {
    expect(simctlArgs(cindy, ['launch', 'booted', 'com.xd.cindy'])).toEqual([
      'simctl', '--set', cindy.path, 'launch', 'booted', 'com.xd.cindy',
    ]);
    expect(simctlArgs(system, ['list'])).toEqual(['simctl', 'list']);
    const run = vi.fn(() => '/cindy/Cindy.app');
    getSimulatorAppContainer(run, null, 'com.xd.cindy', cindy);
    expect(run).toHaveBeenCalledWith('xcrun', ['simctl', '--set', cindy.path, 'get_app_container', 'booted', 'com.xd.cindy', 'app']);
  });

  it('stays on Cindy while it is idle and only leaves it for an exact UDID', () => {
    const otherUdid = '11111111-2222-4333-8444-555555555555';
    const listing = { cindy: `iPhone A (${SIMULATOR_UDID}) (Booted)`, system: `iPhone B (${otherUdid}) (Booted)` };
    const listBooted = (set: { name: 'cindy' | 'system' }) => listing[set.name];

    expect(selectBootedSimulator([cindy, system], listBooted, null)).toMatchObject({ deviceSet: cindy, targetBooted: [listing.cindy] });
    expect(selectBootedSimulator([cindy, system], listBooted, otherUdid)).toMatchObject({ deviceSet: system, targetBooted: [listing.system] });
    expect(selectBootedSimulator([cindy, system], (set: { name: 'cindy' | 'system' }) => (set.name === 'cindy' ? '' : listing.system), null))
      .toEqual({ deviceSet: cindy, booted: [], targetBooted: [] });
    expect(selectBootedSimulator([cindy, system], (set: { name: 'cindy' | 'system' }) => (set.name === 'cindy' ? '' : listing.system), otherUdid))
      .toMatchObject({ deviceSet: system, targetBooted: [listing.system] });
    expect(selectBootedSimulator([system], () => listing.system, null)).toMatchObject({ deviceSet: system, targetBooted: [listing.system] });
    expect(selectBootedSimulator([cindy, system], () => '', null)).toEqual({ deviceSet: cindy, booted: [], targetBooted: [] });
  });

  it('fails closed when Cindy cannot be listed, unless an exact UDID may live elsewhere', () => {
    const line = `iPhone B (${SIMULATOR_UDID}) (Booted)`;
    const listBooted = (set: { name: string }) => {
      if (set.name === 'cindy') throw new Error('cannot read device set');
      return line;
    };
    expect(() => selectBootedSimulator([cindy, system], listBooted, null)).toThrow(/cannot read.*不改用其他模拟器/);
    expect(selectBootedSimulator([cindy, system], listBooted, SIMULATOR_UDID)).toMatchObject({ deviceSet: system, targetBooted: [line] });
    expect(() => selectBootedSimulator([cindy], listBooted, null)).toThrow(/cannot read/);
  });

  it('points an idle Cindy simulator at the plugin and lists reusable devices', () => {
    const shutdown = `iPhone Air (${SIMULATOR_UDID}) (Shutdown)`;
    const listDevices = () => `== Devices ==\n    ${shutdown}\n    iPhone B (11111111-2222-4333-8444-555555555555) (Booted)`;
    const idle = { deviceSet: cindy, booted: [], simulatorUdid: null, listDevices, cindyAvailable: true };

    expect(simulatorBackendNotice(idle)).toMatchObject({ code: 'cindy-idle', reusable: [shutdown] });
    expect(simulatorBackendNotice({ ...idle, listDevices: () => { throw new Error('no list'); } }))
      .toMatchObject({ code: 'cindy-idle', reusable: [] });
    expect(simulatorBackendNotice({ ...idle, booted: ['iPhone'] })).toBeNull();
    expect(simulatorBackendNotice({ ...idle, simulatorUdid: SIMULATOR_UDID })).toBeNull();
  });

  it('flags the system simulator only while Cindy is available', () => {
    const selection = { deviceSet: system, booted: ['iPhone'], simulatorUdid: SIMULATOR_UDID, listDevices: () => '' };
    expect(simulatorBackendNotice({ ...selection, cindyAvailable: true })).toMatchObject({ code: 'system-while-cindy-available' });
    expect(simulatorBackendNotice({ ...selection, cindyAvailable: false })).toBeNull();
    expect(cindySimulatorAvailable({ root, exists: () => true, readFile: settings('{"enabled":false}') })).toBe(false);
    expect(cindySimulatorAvailable({ root, exists: () => false, readFile: settings() })).toBe(false);
    expect(cindySimulatorAvailable({ root, exists: () => true, readFile: settings() })).toBe(true);
  });

  it('does not report a missing app when no exact target was probed', () => {
    const inspect = vi.fn(() => ({ healthy: true, code: 'native-matched' }));
    const unknown = { healthy: false, code: 'native-unknown' };
    expect(inspectTargetNativeIdentity({ targetBooted: ['a', 'b'], probeFailed: false, inspect }))
      .toMatchObject({ ...unknown, reason: 'target-not-unique' });
    expect(inspectTargetNativeIdentity({ targetBooted: [], probeFailed: false, inspect }))
      .toMatchObject({ ...unknown, reason: 'target-not-unique' });
    expect(inspectTargetNativeIdentity({ targetBooted: [], probeFailed: true, inspect }))
      .toMatchObject({ ...unknown, reason: 'probe-timeout' });
    expect(inspect).not.toHaveBeenCalled();
    expect(inspectTargetNativeIdentity({ targetBooted: ['a'], probeFailed: false, inspect })).toMatchObject({ code: 'native-matched' });
  });

  it('finds the owning device set for a UDID in any state', () => {
    const listing = { cindy: `iPhone A (${SIMULATOR_UDID.toLowerCase()}) (Shutdown)`, system: '' };
    const list = (set: { name: 'cindy' | 'system' }) => listing[set.name];
    expect(findSimulatorDeviceSet([cindy, system], list, SIMULATOR_UDID)).toBe(cindy);
    expect(findSimulatorDeviceSet([cindy, system], list, '11111111-2222-4333-8444-555555555555')).toBeNull();
    expect(findSimulatorDeviceSet([cindy, system], (set: { name: string }) => {
      if (set.name === 'cindy') throw new Error('unreadable');
      return `iPhone B (${SIMULATOR_UDID}) (Shutdown)`;
    }, SIMULATOR_UDID)).toBe(system);
  });
});

describe('mobile:sim:whoami bundle identity', () => {
  // 2026-10-29: identity checks stalled for minutes with no actionable phase.
  // Unit: a timed-out Expo config must remain an explicit error, never a guessed bundle ID.
  it('reports the bounded Expo config timeout without leaking child output', () => {
    const execFile = vi.fn(() => { throw Object.assign(new Error('private output'), { code: 'ETIMEDOUT', stderr: 'private output' }); });
    expect(() => resolveMobileSimulatorBundleId('global', { execFile })).toThrow(/Expo config.*超时/);
    expect(execFile).toHaveBeenCalledWith('pnpm', expect.any(Array), expect.objectContaining({ timeout: 30_000, killSignal: 'SIGKILL' }));
  });

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
