import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';
import { resolvePnpmInvocation, usablePnpmExecPath } from '../../../../scripts/shared/pnpm-invocation.mjs';
import { extractMobileDevRegionArgs, withLocalMobileRegionConfig } from '../../scripts/lib/mobile-dev-region.mjs';
import { extractSimWhoamiUdidArgs, resolveMobileSimulatorBundleId, selectBootedSimulator, findSimulatorDeviceSet, simctlArgs } from '../../scripts/lib/sim-whoami.mjs';

const source = readFileSync(resolve(process.cwd(), 'scripts/sim-rebuild.mjs'), 'utf8');
const start = source.indexOf('const iosDir =');
if (start < 0) throw new Error('sim-rebuild workflow entry missing');
const mobileDir = '/repo/apps/mobile';
const cacheRoot = '/home/test/Library/Caches/xdt-maker/sim-app-cache';
const cacheDir = `${cacheRoot}/ios-arm64-fingerprint`;
const builtApp = `${mobileDir}/ios/build/Build/Products/Debug-iphonesimulator/Cindy.app`;
const udid = '11111111-1111-1111-1111-111111111111';

// Execute the real CLI workflow with in-memory filesystem and process boundaries.
// simPodInstall and simNativeIdentity suites cover their real implementations separately.
async function rebuild(options: {
  args?: string[]; platform?: 'darwin' | 'win32'; cached?: boolean; cachedArch?: string;
  fingerprintFailure?: boolean; metroHealthy?: boolean; builtArch?: string; cindyBooted?: boolean;
} = {}) {
  const cindySet = { name: 'cindy', path: '/home/test/Library/Application Support/BaguetteCindy/devices' };
  const env = { EXPO_PUBLIC_APP_VARIANT: 'beta', npm_execpath: '/tools/pnpm.cjs' };
  const processStub = {
    argv: ['node', 'sim-rebuild.mjs', ...(options.args ?? [])], env,
    platform: options.platform ?? 'darwin', arch: 'arm64', execPath: '/node', exitCode: 0,
    exit(code: number) { throw new Error(`exit:${code}`); },
  };
  const execFileSync = vi.fn((command: string, args: string[], _opts: object) => {
    if (command === 'plutil') return args[1] === 'CFBundleIdentifier' ? 'com.xd.cindy' : 'Cindy';
    if (command === 'lipo') return args[1].startsWith(cacheRoot) ? (options.cachedArch ?? 'arm64') : (options.builtArch ?? 'arm64');
    if (command === '/node' && args.includes('config')) return JSON.stringify({ android: { package: 'com.xd.cindy' } });
    if (command === 'xcrun' && args.includes('get_app_container')) return '/installed/Cindy.app';
    if (command === 'xcrun' && args.includes('list')) {
      const inCindySet = args.includes(cindySet.path);
      return inCindySet === Boolean(options.cindyBooted) ? `iPhone (${udid}) (${args.includes('booted') ? 'Booted' : 'Shutdown'})` : '';
    }
    if (['pnpm', '/node', 'xcodebuild', 'cmd.exe', '/sdk/adb', 'xcrun'].includes(command)) return '';
    throw new Error(`unexpected executable ${command}`);
  });
  const spawnSync = vi.fn((_command: string, _args: string[], _opts: { env: object }) => ({ status: 0, stdout: JSON.stringify({ hash: 'fingerprint' }) }));
  const podInstallBounded = vi.fn(async () => undefined);
  const rmSync = vi.fn();
  const cpSync = vi.fn();
  const writeFileSync = vi.fn();
  const utimesSync = vi.fn();
  const now = Date.now();
  const cacheEntries = ['recent0', 'recent1', 'recent2', 'recent3', 'young', 'old'];
  const validateSimMetroIdentity = vi.fn(() => ({ healthy: options.metroHealthy !== false, code: 'METRO_OTHER_WORKTREE' }));
  const resolveAndroidSdkTools = vi.fn(() => ({ sdkRoot: '/sdk' }));
  const ensureWindowsAndroidEmulator = vi.fn(async () => ({ sdkRoot: '/sdk', adb: '/sdk/adb', serial: 'emulator-5554' }));
  const javaEnv = { ...env, JAVA_HOME: '/jdk17', ANDROID_SDK_ROOT: '/sdk', ANDROID_HOME: '/sdk' };
  const resolveJavaRuntimeEnv = vi.fn(() => javaEnv);
  const log = vi.fn();
  const execution = runInNewContext(`(async () => { ${source.slice(start)} })()`, {
    mobileDir, worktreeRoot: '/repo', join: posix.join, resolve: posix.resolve, homedir: () => '/home/test',
    process: processStub, console: { log, error: log, warn: log }, execFileSync, spawnSync,
    mobileClientBundleEnv, extractMobileDevRegionArgs, withLocalMobileRegionConfig,
    extractSimWhoamiUdidArgs, selectBootedSimulator, findSimulatorDeviceSet, simctlArgs,
    resolveSimulatorDeviceSets: () => [cindySet, { name: 'system', path: null }],
    resolveMobileSimulatorBundleId: (region: string) => resolveMobileSimulatorBundleId(region, { execFile: () => JSON.stringify({ ios: { bundleIdentifier: 'com.xd.cindy' } }) }),
    resolvePnpmInvocation: (args: string[], opts: object) => resolvePnpmInvocation(args, { ...opts, platform: processStub.platform, execPath: '/node' }),
    usablePnpmExecPath, ensureMobileLocalRegionConfig: () => ({}), formatMobileLocalConfigStatus: () => '',
    ensureMobileEnv: () => ({ created: false, addedKeys: [] }), formatMobileEnvStatus: () => '',
    computeSimulatorNativeFingerprint: () => 'native-fingerprint', inspectSimulatorNativeIdentity: () => ({ healthy: true }),
    computeFingerprintReport: (_dir: string, opts: { run: (input: object) => { hash: string } }) => {
      if (options.fingerprintFailure) throw new Error('fingerprint unavailable');
      return { platforms: { ios: opts.run({ binPath: '/fingerprint/cli.js', projectDir: mobileDir, platform: 'ios' }).hash } };
    },
    parseFingerprintCliOutput: JSON.parse, podInstallBounded,
    existsSync: () => true, mkdirSync: vi.fn(), rmSync, cpSync, writeFileSync, utimesSync,
    readFileSync: (path: string) => {
      if (!options.cached || path !== `${cacheDir}/meta.json`) throw new Error('cache miss');
      return JSON.stringify({ scheme: 'Cindy' });
    },
    readdirSync: (path: string) => path === `${mobileDir}/ios` ? ['Cindy.xcworkspace'] : cacheEntries,
    statSync: (path: string) => ({ isDirectory: () => true, mtimeMs: now - (path.endsWith('/old') ? 3_600_000 : cacheEntries.indexOf(posix.basename(path)) * 1000) }),
    resolveAndroidSdkTools, ensureWindowsAndroidEmulator, resolveJavaRuntimeEnv,
    probeMetroOwnership: () => ({ cwd: mobileDir, source: 'same', region: 'global', envFingerprint: 'same-env' }),
    applySimMockArg: (args: string[]) => args,
    readSimEnvironment: () => ({ envFingerprint: 'same-env' }), gitSourceIdentity: () => 'same',
    classifySimMetroListener: (input: object) => input, validateSimMetroIdentity,
  });
  let error: unknown;
  try { await execution; } catch (caught) { error = caught; }
  return { error, execFileSync, spawnSync, podInstallBounded, rmSync, cpSync, writeFileSync, utimesSync, validateSimMetroIdentity, resolveAndroidSdkTools, ensureWindowsAndroidEmulator, resolveJavaRuntimeEnv, javaEnv, log };
}

describe('sim-rebuild workflow', () => {
  it.each([false, true])('reuses valid cache and writes force-built artifacts back (force=%s)', async (force) => {
    const result = await rebuild({ cached: true, args: ['--build-only', ...(force ? ['--force-build', '--udid', udid] : [])] });
    expect(result.error).toEqual(new Error('exit:0'));
    expect(result.podInstallBounded).toHaveBeenCalledTimes(force ? 1 : 0);
    expect(result.execFileSync.mock.calls.some(([cmd]) => cmd === 'xcodebuild')).toBe(force);
    const fingerprintEnv = result.spawnSync.mock.calls[0][2].env;
    expect(fingerprintEnv).toMatchObject({ EXPO_PUBLIC_APP_VARIANT: 'beta', CINDY_USE_LOCAL_REGION_CONFIG: '1' });
    if (force) {
      expect(result.execFileSync).toHaveBeenCalledWith('pnpm', ['exec', 'expo', 'prebuild', '-p', 'ios', '--no-install'], expect.objectContaining({ env: fingerprintEnv }));
      expect(result.podInstallBounded).toHaveBeenCalledWith({ iosDir: `${mobileDir}/ios`, env: fingerprintEnv });
      expect(result.execFileSync).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-destination', `platform=iOS Simulator,id=${udid}`]), expect.objectContaining({ env: fingerprintEnv }));
      expect(result.cpSync).toHaveBeenCalledWith(builtApp, `${cacheDir}/Cindy.app`, expect.any(Object));
      expect(JSON.parse(result.writeFileSync.mock.calls[0][1])).toMatchObject({ scheme: 'Cindy', bundleId: 'com.xd.cindy' });
      expect(result.cpSync.mock.invocationCallOrder[0]).toBeLessThan(result.writeFileSync.mock.invocationCallOrder[0]);
      expect(result.rmSync).toHaveBeenCalledWith(`${cacheRoot}/old`, { recursive: true, force: true });
      expect(result.rmSync).not.toHaveBeenCalledWith(`${cacheRoot}/young`, expect.anything());
    } else {
      expect(result.utimesSync).toHaveBeenCalledWith(cacheDir, expect.anything(), expect.anything());
      expect(result.utimesSync.mock.calls[0][1].getTime()).toBeGreaterThan(0);
      expect(result.cpSync).not.toHaveBeenCalled();
    }
    // build-only never touches the device; with --udid it only reads the device list to find the owning set.
    expect(result.execFileSync.mock.calls.some(([cmd, args]) => cmd === 'xcrun'
      && ['install', 'launch', 'uninstall', 'get_app_container'].some((action) => args.includes(action)))).toBe(false);
  });

  it.each(['fingerprint-failure', 'cached-architecture-mismatch'])('falls back to a full build for %s', async (reason) => {
    const result = await rebuild({ args: ['--build-only'], cached: true, cachedArch: 'x86_64', fingerprintFailure: reason === 'fingerprint-failure' });
    expect(result.error).toEqual(new Error('exit:0'));
    expect(result.podInstallBounded).toHaveBeenCalledOnce();
    expect(result.execFileSync).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-destination', 'generic/platform=iOS Simulator']), expect.any(Object));
    expect(result.cpSync).toHaveBeenCalledTimes(reason === 'fingerprint-failure' ? 0 : 1);
  });

  it('builds generically and installs into Cindy\'s simulator when its device is booted', async () => {
    const result = await rebuild({ cindyBooted: true, args: ['--udid', udid] });
    expect(result.error).toBeUndefined();
    expect(result.execFileSync).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-destination', 'generic/platform=iOS Simulator']), expect.any(Object));
    for (const action of ['install', 'get_app_container', 'launch']) {
      const call = result.execFileSync.mock.calls.find(([cmd, args]) => cmd === 'xcrun' && args.includes(action));
      expect(call?.[1].slice(0, 3)).toEqual(['simctl', '--set', '/home/test/Library/Application Support/BaguetteCindy/devices']);
    }
  });

  it('uses the generic destination for a build-only UDID that lives in Cindy\'s set, even when shut down', async () => {
    const result = await rebuild({ cindyBooted: true, args: ['--build-only', '--force-build', '--udid', udid] });
    expect(result.error).toEqual(new Error('exit:0'));
    expect(result.execFileSync).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-destination', 'generic/platform=iOS Simulator']), expect.any(Object));
  });

  it('falls back to the system simulator when Cindy has no booted device', async () => {
    const result = await rebuild({ args: ['--udid', udid] });
    expect(result.error).toBeUndefined();
    expect(result.execFileSync).toHaveBeenCalledWith('xcodebuild', expect.arrayContaining(['-destination', `platform=iOS Simulator,id=${udid}`]), expect.any(Object));
    expect(result.execFileSync).toHaveBeenCalledWith('xcrun', ['simctl', 'launch', udid, 'com.xd.cindy'], expect.any(Object));
  });

  it('rejects incompatible build architecture before installing on the simulator', async () => {
    const result = await rebuild({ builtArch: 'x86_64' });
    expect(result.error).toMatchObject({ message: expect.stringContaining('Simulator 产物架构错误') });
    expect(result.execFileSync.mock.calls.some(([, args]) => args.includes('install'))).toBe(false);
  });

  it.each([true, false])('checks Metro after Windows installation and before launch (healthy=%s)', async (healthy) => {
    const result = await rebuild({ platform: 'win32', metroHealthy: healthy });
    expect(result.error).toEqual(new Error(`exit:${healthy ? 0 : 1}`));
    expect(result.resolveAndroidSdkTools).toHaveBeenCalledWith(expect.objectContaining({ platform: 'win32', requireTools: true }));
    expect(result.resolveJavaRuntimeEnv).toHaveBeenCalledWith(expect.objectContaining({ ANDROID_SDK_ROOT: '/sdk', ANDROID_HOME: '/sdk', CINDY_USE_LOCAL_REGION_CONFIG: '1' }));
    expect(result.execFileSync).toHaveBeenCalledWith('/node', ['/tools/pnpm.cjs', 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'], expect.any(Object));
    expect(result.execFileSync).toHaveBeenCalledWith('cmd.exe', ['/d', '/s', '/c', '.\\gradlew.bat assembleDebug'], expect.objectContaining({ cwd: `${mobileDir}/android`, env: result.javaEnv, windowsVerbatimArguments: true }));
    const install = result.execFileSync.mock.calls.findIndex(([, args]) => args.includes('install'));
    const launch = result.execFileSync.mock.calls.findIndex(([, args]) => args.includes('monkey'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(result.validateSimMetroIdentity).toHaveBeenCalledWith(expect.objectContaining({ currentRegion: 'global', runningRegion: 'global', currentEnvFingerprint: 'same-env', runningEnvFingerprint: 'same-env' }));
    expect(result.execFileSync.mock.invocationCallOrder[install]).toBeLessThan(result.validateSimMetroIdentity.mock.invocationCallOrder[0]);
    if (healthy) expect(result.validateSimMetroIdentity.mock.invocationCallOrder[0]).toBeLessThan(result.execFileSync.mock.invocationCallOrder[launch]);
    else expect(launch).toBe(-1);
    expect(result.execFileSync.mock.calls.some(([cmd]) => ['xcrun', 'xcodebuild'].includes(cmd))).toBe(false);
    expect(result.podInstallBounded).not.toHaveBeenCalled();
  });
});
