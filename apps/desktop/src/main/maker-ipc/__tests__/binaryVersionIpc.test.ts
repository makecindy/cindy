/**
 * `maker:agent:binary-version` — About 页的本地版本与线上更新判断。
 *
 * 普通调用不能等网络（离线时关于页要立刻显示本地版本）；checkLatest 只在线上
 * 版本严格更高时报告可更新，与启动安装「保留不旧于 manifest 的本地版本」同口径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  fetchManifest: vi.fn(),
  execFile: vi.fn(),
  versions: new Map<string, string>(),
  trust: vi.fn(),
  isDeviceLink: vi.fn(() => false),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../pi-kernel.js', () => ({ registerPiKernelIpc: vi.fn() }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (event: unknown) => h.trust(event),
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: () => h.isDeviceLink(),
}));
vi.mock('../../manifestService.js', () => ({
  fetchManifest: h.fetchManifest,
  getPlatformKey: () => 'darwin-arm64',
}));
vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: (kind: string) => `/managed/${kind}`,
  getCachedBinaryStatus: () => ({ binaryReady: false, binaryPath: null }),
  isVettedAgentBinaryPath: () => true,
}));

const { registerMakerBinaryVersionIpc } = await import('../binary-version.js');
const { MAKER_INVOKE } = await import('../channels.js');

function installable(version: string, file = `runtime/${version}/pkg`) {
  return { version, file, sha256: 'a'.repeat(64), size: 7 };
}

function invoke(kind: unknown, options?: unknown) {
  const handler = h.handlers.get(MAKER_INVOKE.AGENT_BINARY_VERSION);
  if (!handler) throw new Error('handler not registered');
  return handler({}, kind, options) as Promise<{
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
  }>;
}

describe('maker:agent:binary-version', () => {
  beforeEach(() => {
    h.handlers.clear();
    h.fetchManifest.mockReset();
    h.versions.clear();
    h.trust.mockReset().mockImplementation(() => {});
    h.isDeviceLink.mockReset().mockReturnValue(false);
    h.execFile.mockReset().mockImplementation((
      binaryPath: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, h.versions.get(binaryPath) ?? '', '');
    });
    registerMakerBinaryVersionIpc();
  });


  it('rejects an untrusted renderer before probing or fetching the manifest', async () => {
    h.trust.mockImplementation(() => {
      throw new Error('PERMISSION_DENIED');
    });
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockReturnValue(new Promise(() => {}));

    await expect(invoke('codex', { checkLatest: true })).rejects.toThrow('PERMISSION_DENIED');
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.fetchManifest).not.toHaveBeenCalled();
  });

  it('still serves a device-link invoke that has no renderer sender', async () => {
    h.isDeviceLink.mockReturnValue(true);
    h.trust.mockImplementation(() => {
      throw new Error('PERMISSION_DENIED');
    });
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');

    await expect(invoke('codex')).resolves.toMatchObject({ version: 'codex-cli 0.145.0' });
    expect(h.trust).not.toHaveBeenCalled();
  });

  it('returns the local version without touching the network', async () => {
    h.versions.set('/managed/claude-code', '2.1.258 (Claude Code)');
    h.fetchManifest.mockReturnValue(new Promise(() => {}));

    await expect(invoke('claude-code')).resolves.toMatchObject({
      version: '2.1.258 (Claude Code)',
      latestVersion: null,
      updateAvailable: false,
    });
    expect(h.fetchManifest).not.toHaveBeenCalled();
  });

  it('reports an update only when the channel version is strictly newer', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockResolvedValue({ codexPackage: installable('0.146.0') });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      latestVersion: '0.146.0',
      updateAvailable: true,
    });
  });

  it('does not offer an update from a legacy codex manifest field the installer cannot consume', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockResolvedValue({ codex: { version: '0.146.0' } });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
    });
  });

  it.each(['0.145.0', '0.144.9'])('does not offer a no-op update when the channel has %s', async (latest) => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockResolvedValue({ codexPackage: installable(latest) });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      latestVersion: latest,
      updateAvailable: false,
    });
  });

  it('never offers the About update for Pi, which has its own kernel manager', async () => {
    h.versions.set('/managed/pi', 'pi 0.84.4');
    h.fetchManifest.mockResolvedValue({ pi: installable('0.90.0') });
    await expect(invoke('pi', { checkLatest: true })).resolves.toMatchObject({ updateAvailable: false });
  });

  it('keeps the local version when the manifest is unreachable', async () => {
    h.versions.set('/managed/claude-code', '2.1.258 (Claude Code)');
    h.fetchManifest.mockRejectedValue(new Error('offline'));
    await expect(invoke('claude-code', { checkLatest: true })).resolves.toMatchObject({
      version: '2.1.258 (Claude Code)',
      latestVersion: null,
      updateAvailable: false,
    });
  });


  it('re-probes on checkLatest instead of comparing a cached --version', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockResolvedValue({ codexPackage: installable('0.146.0') });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      version: 'codex-cli 0.145.0',
      updateAvailable: true,
    });

    h.versions.set('/managed/codex', 'codex-cli 0.146.0');
    await expect(invoke('codex')).resolves.toMatchObject({ version: 'codex-cli 0.145.0' });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      version: 'codex-cli 0.146.0',
      latestVersion: '0.146.0',
      updateAvailable: false,
    });
  });

  it('does not advertise an update the installer would reject', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    h.fetchManifest.mockResolvedValue({
      codexPackage: { version: '0.146.0', file: 'runtime/0.146.0/pkg' },
    });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
    });

    h.fetchManifest.mockResolvedValue({
      codexPackage: installable('0.146.0', 'codex/win32-x64/0.146.0/pkg'),
    });
    await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
    });
  });


  it('does not advertise an update whose sha256 the downloader would reject', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    for (const sha256 of ['', 'not-hex', 'abcd', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const asset = installable('0.146.0');
      asset.sha256 = sha256;
      h.fetchManifest.mockResolvedValue({ codexPackage: asset });
      await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
        latestVersion: null,
        updateAvailable: false,
      });
    }
  });


  it('does not advertise an update whose size the downloader would reject', async () => {
    h.versions.set('/managed/codex', 'codex-cli 0.145.0');
    for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const asset = installable('0.146.0');
      asset.size = size;
      h.fetchManifest.mockResolvedValue({ codexPackage: asset });
      await expect(invoke('codex', { checkLatest: true })).resolves.toMatchObject({
        latestVersion: null,
        updateAvailable: false,
      });
    }
  });

  it('rejects malformed options', async () => {
    await expect(invoke('codex', { checkLatest: 'yes' })).rejects.toThrow();
    await expect(invoke('codex', 'checkLatest')).rejects.toThrow();
  });
});
