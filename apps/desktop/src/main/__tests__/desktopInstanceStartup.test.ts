import os from 'node:os';
import { afterAll, expect, it, vi } from 'vitest';

// #13415: loading index exercises the real dispatch/import boundary. The deep-link and
// lock-policy unit tests cannot detect side effects before an unsuccessful acquisition.
const boundary = vi.hoisted(() => ({
  owns: false,
  lock: vi.fn((): boolean => boundary.owns),
  quit: vi.fn(),
  log: vi.fn(),
  cache: vi.fn(() => ({ flush() {}, pruneUnused() {} })),
  register: vi.fn(async () => () => {}),
  load: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  const os = await import('node:os');
  return { app: Object.assign(new EventEmitter(), {
    isPackaged: true, commandLine: { appendSwitch() {}, hasSwitch: () => true },
    getPath: os.tmpdir, setPath() {}, getVersion: () => '1', getAppPath: os.tmpdir,
    requestSingleInstanceLock: boundary.lock, quit: boundary.quit,
  }), utilityProcess: {} };
});
vi.mock('../personalBuildMonitor.js', () => ({}));
vi.mock('../personalLaunchCwd.js', () => ({}));
vi.mock('../cindy-make/versionStartup.js', () => ({
  prepareCindyVersionStartup() {}, dispatchCindyVersionStartup: async () => false,
}));
vi.mock('../windowsTaskbarNative', () => ({ loadPackagedWindowsShellNative: () => null }));
vi.mock('../instance-runtime/config.js', () => ({ initializeInstanceConfig: () => null }));
vi.mock('../linuxInstallation.js', () => ({ recognizeLinuxUserInstallation: () => null }));
vi.mock('fix-path', () => ({ default() {} }));
vi.mock('../agentToolPath.js', () => ({ ensureMacPackageManagerPath() {} }));
vi.mock('../deviceId.js', () => ({ ensureSystemBinPathForMachineId() {} }));
vi.mock('../devStartupStatus.js', () => ({
  beginDesktopDevInstance: boundary.register, markDesktopDevStartupFailed() {},
}));
vi.mock('../logger.js', () => ({
  initLogger: boundary.log, createLogger: () => ({ debug() {}, warn() {}, info() {} }),
}));
vi.mock('../mainCompileCache.js', () => ({ mainBundleBuildId: () => 'test', startMainCompileCache: boundary.cache }));
vi.mock('../device-link/invoke-registry.js', () => ({ installInvokeCapture() {} }));
vi.mock('@cindy/maker-core', () => ({ stripSensitiveAnthropicEnv: () => [] }));
vi.mock('../bootstrap-electron.js', () => {
  boundary.load();
  return { bootstrapElectron: boundary.ready };
});

afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('loads the main application only for the owner and retains an early second launch', async () => {
  vi.stubGlobal('process', Object.assign(Object.create(process), { resourcesPath: os.tmpdir() }));
  vi.stubEnv('XDT_USER_DATA_DIR', os.tmpdir());
  await import('../index.js');
  expect(boundary.quit).toHaveBeenCalledOnce();
  for (const effect of [boundary.log, boundary.cache, boundary.register, boundary.load]) {
    expect(effect).not.toHaveBeenCalled();
  }

  // reset-modules: cold launch of a separate lock-owning process through the same entry point.
  vi.resetModules();
  boundary.owns = true;
  const { app } = await import('electron');
  const argv = ['cindy', 'cindy://focus/test'];
  boundary.register.mockImplementationOnce(async () => {
    app.emit('second-instance', {}, argv, '', {});
    return () => {};
  });
  await import('../index.js');
  await vi.dynamicImportSettled();
  expect(boundary.ready).toHaveBeenCalledOnce();
  for (const effect of [boundary.log, boundary.cache, boundary.register, boundary.load]) {
    expect(effect).toHaveBeenCalledOnce();
  }
  const receive = vi.fn();
  const { handleInstanceLaunches } = await import('../desktopInstanceLock');
  handleInstanceLaunches(receive);
  expect(receive.mock.calls).toEqual([[{ kind: 'link', url: 'cindy://focus/test', source: 'second-instance' }]]);
});
