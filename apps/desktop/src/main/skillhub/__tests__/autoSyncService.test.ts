import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { net } from 'electron';
import { getCurrentUserId } from '../../authManager';
import type { StoredInstall } from '../registry/types';
import { registryService } from '../registry';
import { parseAutoSyncConfig, SkillhubAutoSyncService } from '../autoSyncService';
import type { install as installFn } from '../installService';

type InstallResult = Awaited<ReturnType<typeof installFn>>;
type SuccessfulInstallResult = Extract<InstallResult, { success: true }>;
type FailedInstallResult = Extract<InstallResult, { success: false }>;
type CleanupInstallParams = {
  slug: string;
  absolutePath: string;
  previousInstall?: { skillName: string; installPath: string; entry: StoredInstall };
  replacedBackupPath?: string;
};

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));
const originalAutoSyncConfigUrl = process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL;
const TEST_ROOT = path.join('/tmp', 'xdt-auto-sync-test');
const TEST_HOME = path.join(TEST_ROOT, 'home');
const TEST_USER_DATA = path.join(TEST_ROOT, 'userData');

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join('/tmp', 'xdt-auto-sync-test', 'userData')),
  },
  net: {
    fetch: vi.fn(),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

vi.mock('../../authManager', () => ({
  getCurrentUserId: vi.fn(() => null),
}));

vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: vi.fn(() => 'https://skillhub.test.invalid'),
}));

vi.mock('../../serverApiClient', () => ({
  serverApiFetch: vi.fn(),
}));

vi.mock('../registry', () => ({
  registryService: {
    listAllInstalls: vi.fn(async () => []),
    addInstall: vi.fn(),
    getInstall: vi.fn(),
    removeInstall: vi.fn(),
  },
}));

vi.mock('../../maker-host/shared-global-skills.js', () => ({
  prepareSharedGlobalSkillLinks: vi.fn(async () => ({ warnings: [] })),
  prepareSharedProjectSkillLinks: vi.fn(async () => ({ warnings: [] })),
  projectWorkingDirFromSkillPath: vi.fn(() => null),
}));

function installEntry(version: string, overrides: Partial<StoredInstall> = {}): StoredInstall {
  return {
    version,
    authorId: 'owner',
    folderHash: 'hash',
    installedAt: 1,
    updatedAt: 1,
    origin: 'installed',
    autoSynced: true,
    catalogScope: 'market',
    catalogScopeMigrated: true,
    ...overrides,
  };
}

function makeService(options: {
  userId?: string | null;
  configSkills?: Array<string | { name: string; version?: string; enabled?: boolean; catalogScope?: 'market' | 'team' }>;
  installs?: Array<{ skillName: string; installPath: string; entry: StoredInstall }>;
  listAllInstallsImpl?: () => Promise<Array<{ skillName: string; installPath: string; entry: StoredInstall }>>;
  fetchConfigImpl?: () => Promise<Array<{ name: string; version?: string; enabled?: boolean; catalogScope?: 'market' | 'team' }>>;
  syncResults?: Array<{ name: string; exists: boolean; latestVersion?: string; catalogScope?: 'market' | 'team' }>;
  syncResponses?: Array<{ success: boolean; results?: Array<{ name: string; exists: boolean; latestVersion?: string; catalogScope?: 'market' | 'team' }>; error?: string }>;
  syncSuccess?: boolean;
  installImpl?: typeof installFn;
  installResults?: Array<SuccessfulInstallResult | FailedInstallResult>;
  onInstall?: () => void;
  cancelInstall?: (name: string) => boolean;
  ignoredSkills?: string[];
  listIgnoredSkills?: (userId: string) => Promise<Set<string>>;
  recordCandidateSkills?: (userId: string, names: string[], options?: { replace?: boolean }) => Promise<void>;
  cleanupInstall?: (params: CleanupInstallParams) => Promise<void>;
  useDefaultCleanupInstall?: boolean;
  detectClaudeSkillConflict?: (slug: string, expectedSharedPath: string) => Promise<{ path: string; reason: string } | null>;
  pathExists?: (p: string) => boolean | Promise<boolean>;
  getUserId?: () => string | null;
} = {}) {
  const defaultInstall: typeof installFn = async () => {
    options.onInstall?.();
    return options.installResults?.shift() ?? { success: true, name: 'skill', version: '1.0.0', absolutePath: '/tmp/skill' };
  };
  const install = vi.fn(options.installImpl ?? defaultInstall);
  const cancelInstall = vi.fn((name: string) => options.cancelInstall?.(name) ?? true);
  const cleanupInstall = vi.fn(options.cleanupInstall ?? (async () => undefined));
  const syncMarket = vi.fn(async () => (
    options.syncResponses?.shift() ?? {
      success: options.syncSuccess ?? true,
      results: options.syncResults ?? [],
    }
  ));
  const listAllInstalls = vi.fn(options.listAllInstallsImpl ?? (async () => options.installs ?? []));
  const listIgnoredSkills = vi.fn(options.listIgnoredSkills ?? (async () => new Set(options.ignoredSkills ?? [])));
  const recordCandidateSkills = vi.fn(options.recordCandidateSkills ?? (async () => undefined));
  const defaultFetchConfig = async () => (options.configSkills ?? ['alpha']).map((skill) => (
    typeof skill === 'string' ? { name: skill } : skill
  )).filter((skill) => skill.enabled !== false);
  const fetchConfig = vi.fn(options.fetchConfigImpl ?? defaultFetchConfig);
  const detectClaudeSkillConflict = vi.fn(options.detectClaudeSkillConflict ?? (async () => null));
  const pathExists = vi.fn(async (p: string) => options.pathExists?.(p) ?? true);
  const deps = {
    getCurrentUserId: () => options.getUserId?.() ?? ('userId' in options ? options.userId ?? null : 'user-1'),
    fetchConfig,
    listAllInstalls,
    syncMarket,
    detectClaudeSkillConflict,
    install,
    cancelInstall,
    listIgnoredSkills,
    recordCandidateSkills,
    pathExists,
  };
  const service = new SkillhubAutoSyncService(options.useDefaultCleanupInstall
    ? deps
    : { ...deps, cleanupInstall });
  return { service, install, cancelInstall, cleanupInstall, syncMarket, listAllInstalls, listIgnoredSkills, recordCandidateSkills, fetchConfig, detectClaudeSkillConflict, pathExists };
}

describe('SkillhubAutoSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);
    vi.mocked(getCurrentUserId).mockReturnValue(null);
    vi.mocked(net.fetch).mockReset();
    if (originalAutoSyncConfigUrl === undefined) {
      delete process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL;
    } else {
      process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL = originalAutoSyncConfigUrl;
    }
  });

  it('does not touch SkillHub when no user is logged in', async () => {
    const { service, syncMarket, install } = makeService({ userId: null });

    await service.runOnceAfterLogin();

    expect(syncMarket).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('no-ops when the product config has no enabled skills', async () => {
    const { service, syncMarket, install, listAllInstalls } = makeService({ configSkills: [] });

    await service.runOnceAfterLogin();

    expect(listAllInstalls).not.toHaveBeenCalled();
    expect(syncMarket).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('honors an explicitly empty remote auto-sync config', async () => {
    process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL = 'https://cdn.example.test/auto-sync.json';
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ skills: [] })),
    } as unknown as Awaited<ReturnType<typeof net.fetch>>);

    const service = new SkillhubAutoSyncService();

    await service.runOnceAfterLogin();

    expect(net.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/cdn\.example\.test\/auto-sync\.json\?t=\d+$/),
      expect.any(Object),
    );
    expect(registryService.listAllInstalls).not.toHaveBeenCalled();
  });

  it('skips user-ignored auto-sync skills before touching market or registry', async () => {
    const { service, syncMarket, install, listAllInstalls, listIgnoredSkills, recordCandidateSkills } = makeService({
      configSkills: ['alpha'],
      ignoredSkills: ['alpha'],
    });

    await service.runOnceAfterLogin();

    expect(listIgnoredSkills).toHaveBeenCalledTimes(1);
    expect(recordCandidateSkills).toHaveBeenCalledWith('user-1', ['alpha'], { replace: true });
    expect(listAllInstalls).not.toHaveBeenCalled();
    expect(syncMarket).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'auto sync skipped user-ignored skill',
      { slug: 'alpha' },
    );
  });

  it('does not mark auto-sync completed when ignored preferences cannot be read', async () => {
    let attempts = 0;
    const { service, syncMarket, install, listAllInstalls, listIgnoredSkills, recordCandidateSkills } = makeService({
      configSkills: ['alpha'],
      listIgnoredSkills: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('corrupt preferences');
        return new Set();
      },
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(listIgnoredSkills).toHaveBeenCalledTimes(1);
    expect(recordCandidateSkills).not.toHaveBeenCalled();
    expect(listAllInstalls).not.toHaveBeenCalled();
    expect(syncMarket).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'read auto sync ignored skills failed',
      { error: 'corrupt preferences' },
    );

    await service.runOnceAfterLogin();

    expect(listIgnoredSkills).toHaveBeenCalledTimes(2);
    expect(recordCandidateSkills).toHaveBeenCalledWith('user-1', ['alpha'], { replace: true });
    expect(syncMarket).toHaveBeenCalledWith({ skills: [{ slug: 'alpha', catalogScope: 'market' }] });
    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
  });

  it('continues with non-ignored skills when only part of the config is ignored', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: ['alpha', 'beta'],
      ignoredSkills: ['alpha'],
      syncResults: [{ name: 'beta', exists: true, latestVersion: '2.0.0' }],
    });

    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledWith({ skills: [{ slug: 'beta', catalogScope: 'market' }] });
    expect(install).toHaveBeenCalledWith({ name: 'beta', catalogScope: 'market', autoSync: true }, expect.any(Function));
  });

  it('records empty fallback candidates without replacing previous remote candidates when the config fetch fails', async () => {
    const { service, syncMarket, recordCandidateSkills } = makeService({
      fetchConfigImpl: async () => {
        throw new Error('cdn unavailable');
      },
    });

    await service.runOnceAfterLogin();

    // 默认白名单为空:拉不到远端配置时不同步任何技能,也不覆盖已记录的远端候选。
    expect(recordCandidateSkills).toHaveBeenCalledWith('user-1', [], { replace: false });
    expect(syncMarket).not.toHaveBeenCalled();
  });

  it('records empty fallback candidates when remote config parsing falls back to defaults', async () => {
    process.env.XDT_SKILLHUB_AUTO_SYNC_CONFIG_URL = 'https://cdn.example.test/auto-sync.json';
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ invalid: true })),
    } as unknown as Awaited<ReturnType<typeof net.fetch>>);

    const recordCandidateSkills = vi.fn(async () => undefined);
    const syncMarket = vi.fn(async () => ({ success: true, results: [] }));
    vi.mocked(registryService.listAllInstalls).mockResolvedValue([]);
    const service = new SkillhubAutoSyncService({
      syncMarket,
      install: async () => ({ success: true, name: 'demo-skill', version: '1.0.0', absolutePath: '/tmp/demo-skill' }),
      recordCandidateSkills,
    });

    await service.runOnceAfterLogin();

    expect(recordCandidateSkills).toHaveBeenCalledWith('user-1', [], { replace: false });
    expect(syncMarket).not.toHaveBeenCalled();
  });

  it('installs a whitelisted skill that is not locally registered', async () => {
    const { service, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
  });

  it('keeps the configured team catalog scope through sync and install', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: [{ name: 'alpha', catalogScope: 'team' }],
      syncResults: [{ name: 'alpha', catalogScope: 'team', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledWith({
      skills: [{ slug: 'alpha', catalogScope: 'team' }],
    });
    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'team', autoSync: true },
      expect.any(Function),
    );
  });

  it('continues auto-sync after deleting a corrupt pending cleanup store', async () => {
    const storePath = path.join(TEST_USER_DATA, 'skillhub', 'auto-sync-pending-cleanups.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{broken', 'utf-8');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
    expect(fs.existsSync(storePath)).toBe(false);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'parse pending cancellation cleanup store failed',
      { error: expect.any(String) },
    );
  });

  it('continues auto-sync when the pending cleanup store cannot be read', async () => {
    const storePath = path.join(TEST_USER_DATA, 'skillhub', 'auto-sync-pending-cleanups.json');
    fs.mkdirSync(storePath, { recursive: true });
    const { service, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'read pending cancellation cleanup store failed',
      { error: expect.any(String) },
    );
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('fails auto-sync while an unreadable pending cleanup store cannot be cleared', async () => {
    const storePath = path.join(TEST_USER_DATA, 'skillhub', 'auto-sync-pending-cleanups.json');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, 'locked', 'utf-8');
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    const originalRm = fs.promises.rm.bind(fs.promises);
    const readSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
      if (String(args[0]) === storePath) throw Object.assign(new Error('locked'), { code: 'EACCES' });
      return originalReadFile(...args);
    });
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
      if (String(args[0]) === storePath) throw Object.assign(new Error('still locked'), { code: 'EACCES' });
      return originalRm(...args);
    });
    const { service, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    try {
      await service.runOnceAfterLogin();
      await service.runOnceAfterLogin();

      expect(install).not.toHaveBeenCalled();
      expect(readSpy).toHaveBeenCalledTimes(2);
      expect(rmSpy).toHaveBeenCalledTimes(2);
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        'delete unreadable pending cancellation cleanup store failed',
        { error: 'still locked' },
      );
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        'auto sync failed',
        { error: 'still locked' },
      );
    } finally {
      readSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('cleans up a managed global skill when the current user cannot see it in SkillHub', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install, cleanupInstall } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0') },
      ],
      syncResults: [{ name: 'alpha', exists: false }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(cleanupInstall).toHaveBeenCalledWith({
      slug: 'alpha',
      absolutePath: installPath,
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync removed inaccessible managed global skill',
      { slug: 'alpha', installPath },
    );
  });

  it('cleans inaccessible managed installs before terminal Claude-side skips', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const claudePath = path.join(os.homedir(), '.claude', 'skills', 'alpha');
    const { service, install, cleanupInstall, detectClaudeSkillConflict } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0') },
      ],
      syncResults: [{ name: 'alpha', exists: false }],
      detectClaudeSkillConflict: async () => ({
        path: claudePath,
        reason: 'path exists and is not a managed symlink',
      }),
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(detectClaudeSkillConflict).not.toHaveBeenCalled();
    expect(cleanupInstall).toHaveBeenCalledWith({
      slug: 'alpha',
      absolutePath: installPath,
    });
  });

  it('retries inaccessible managed skill cleanup before marking the user complete', async () => {
    let cleanupAttempts = 0;
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const setup = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0') },
      ],
      syncResults: [{ name: 'alpha', exists: false }],
      cleanupInstall: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('locked');
      },
    });

    await setup.service.runOnceAfterLogin();
    await setup.service.runOnceAfterLogin();

    expect(setup.cleanupInstall).toHaveBeenCalledTimes(2);
    expect(setup.install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync cleanup inaccessible managed global skill failed',
      { slug: 'alpha', installPath, error: 'locked' },
    );
  });

  it('updates an installed whitelisted skill when the local version is stale', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '1.2.3', force: true, skipBackup: false },
      expect.any(Function),
    );
  });

  it('matches managed global skill paths case-insensitively on Windows', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });
    try {
      const installPath = path.join(os.homedir().toUpperCase(), '.agents', 'skills', 'alpha');
      const { service, install } = makeService({
        configSkills: ['alpha'],
        installs: [
          { skillName: 'alpha', installPath, entry: installEntry('1.0.0') },
        ],
        syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
      });

      await service.runOnceAfterLogin();

      expect(install).toHaveBeenCalledWith(
        { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '1.2.3', force: true, skipBackup: false },
        expect.any(Function),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
      });
    }
  });

  it('installs a pinned whitelisted version from the product config', async () => {
    const { service, install } = makeService({
      configSkills: [{ name: 'alpha', version: '1.1.0' }],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, version: '1.1.0' },
      expect.any(Function),
    );
  });

  it('does not downgrade a managed global skill when local version is newer', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.3.0') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
  });

  it('reconciles a managed global skill to an older pinned version', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: [{ name: 'alpha', version: '1.1.0' }],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.2.3') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '1.1.0', force: true, skipBackup: false },
      expect.any(Function),
    );
  });

  it('treats a v-prefixed pinned version as satisfied', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: [{ name: 'alpha', version: 'v1.1.0' }],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.1.0') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
  });

  it('skips a user-published global skill', async () => {
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        {
          skillName: 'alpha',
          installPath: path.join(os.homedir(), '.agents', 'skills', 'alpha'),
          entry: installEntry('1.0.0', { origin: 'published' }),
        },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync skipped user-owned global skill',
      { slug: 'alpha', origin: 'published' },
    );
  });

  it('installs when a user-owned global registry entry is missing on disk', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        {
          skillName: 'alpha',
          installPath,
          entry: installEntry('1.0.0', { origin: 'published' }),
        },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
      pathExists: () => false,
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'user-owned global skill registry entry is missing on disk',
      { slug: 'alpha', origin: 'published', installPath },
    );
  });

  it('skips when an unmanaged Claude global skill already owns the same slug', async () => {
    const claudePath = path.join(os.homedir(), '.claude', 'skills', 'alpha');
    const expectedSharedPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install, detectClaudeSkillConflict } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
      detectClaudeSkillConflict: async () => ({
        path: claudePath,
        reason: 'path exists and is not a managed symlink',
      }),
    });

    await service.runOnceAfterLogin();

    expect(detectClaudeSkillConflict).toHaveBeenCalledWith('alpha', expectedSharedPath);
    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync skipped user-owned claude skill',
      {
        slug: 'alpha',
        installPath: claudePath,
        reason: 'path exists and is not a managed symlink',
      },
    );
  });

  it('skips a legacy originless global skill record', async () => {
    const entry = installEntry('1.0.0');
    delete entry.origin;
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        {
          skillName: 'alpha',
          installPath: path.join(os.homedir(), '.agents', 'skills', 'alpha'),
          entry,
        },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync skipped user-owned global skill',
      { slug: 'alpha', origin: undefined },
    );
  });

  it('treats legacy installed auto-sync records as managed', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0', { autoSynced: undefined }) },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '1.2.3', force: true, skipBackup: false },
      expect.any(Function),
    );
  });

  it('skips a regular manually installed global skill record', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.0.0', { autoSynced: false }) },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync skipped user-owned global skill',
      { slug: 'alpha', origin: 'installed' },
    );
  });

  it('does not force-update a custom install path as the managed global copy', async () => {
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath: path.join('/workspace', '.agents', 'skills', 'alpha'), entry: installEntry('1.0.0') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith({ name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
  });

  it('skips a whitelisted skill when the local version already matches SkillHub', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install, pathExists } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.2.3') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(pathExists).toHaveBeenCalledWith(installPath);
    expect(install).not.toHaveBeenCalled();
  });

  it('reinstalls a satisfied managed global skill when the install path is missing', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.2.3') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
      pathExists: () => false,
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '1.2.3', force: true, skipBackup: true },
      expect.any(Function),
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'managed global skill registry entry is missing on disk',
      { slug: 'alpha', installPath },
    );
  });

  it('does not update when local prerelease has the same release core', async () => {
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, install } = makeService({
      configSkills: ['alpha'],
      installs: [
        { skillName: 'alpha', installPath, entry: installEntry('1.2.3-alpha') },
      ],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.2.3' }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
  });

  it('warns and skips when a whitelisted skill is unavailable in SkillHub', async () => {
    const { service, install } = makeService({
      configSkills: ['missing'],
      syncResults: [{ name: 'missing', exists: false }],
    });

    await service.runOnceAfterLogin();

    expect(install).not.toHaveBeenCalled();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'whitelisted skill is unavailable in SkillHub',
      { slug: 'missing' },
    );
  });

  it('continues syncing later skills after one install fails', async () => {
    const { service, install } = makeService({
      configSkills: ['alpha', 'beta'],
      syncResults: [
        { name: 'alpha', exists: true, latestVersion: '1.0.0' },
        { name: 'beta', exists: true, latestVersion: '2.0.0' },
      ],
      installResults: [
        { success: false, errorCode: 'INTERNAL', message: 'boom' },
        { success: true, name: 'beta', version: '2.0.0', absolutePath: '/tmp/beta' },
      ],
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenNthCalledWith(1, { name: 'alpha', catalogScope: 'market', autoSync: true }, expect.any(Function));
    expect(install).toHaveBeenNthCalledWith(2, { name: 'beta', catalogScope: 'market', autoSync: true }, expect.any(Function));
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto install/update failed',
      { slug: 'alpha', version: '1.0.0', errorCode: 'INTERNAL', message: 'boom' },
    );
  });

  it('retries the same user when an install failed in the previous run', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installResults: [
        { success: false, errorCode: 'INTERNAL', message: 'boom' },
        { success: true, name: 'alpha', version: '1.0.0', absolutePath: '/tmp/alpha' },
      ],
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('retries the same user when listing local installs failed', async () => {
    let listAttempts = 0;
    const { service, listAllInstalls, syncMarket, install } = makeService({
      configSkills: ['alpha'],
      listAllInstallsImpl: async () => {
        listAttempts += 1;
        if (listAttempts === 1) throw new Error('db busy');
        return [];
      },
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(listAllInstalls).toHaveBeenCalledTimes(2);
    expect(syncMarket).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'list local installs failed',
      { error: 'db busy' },
    );
  });

  it('cancels and retries the current user when auth changes during install', async () => {
    let currentUserId = 'user-1';
    const { service, syncMarket, install, cancelInstall } = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installImpl: async (_params, onProgress) => {
        currentUserId = 'user-2';
        onProgress({ phase: 'downloading', name: 'alpha' });
        return { success: false, errorCode: 'CANCELLED', message: '已取消' };
      },
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(2);
    expect(cancelInstall).toHaveBeenCalledWith('alpha');
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync failed',
      { error: 'auth user changed during auto sync' },
    );
  });

  it('cleans up a successful install when auth cancellation wins late', async () => {
    let currentUserId = 'user-1';
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const { service, syncMarket, install, cancelInstall, cleanupInstall } = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      cancelInstall: () => false,
      installImpl: async (_params, onProgress) => {
        currentUserId = 'user-2';
        onProgress({ phase: 'registering', name: 'alpha' });
        return { success: true, name: 'alpha', version: '1.0.0', absolutePath: installPath };
      },
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(cancelInstall).toHaveBeenCalledWith('alpha');
    expect(cleanupInstall).toHaveBeenCalledWith({
      slug: 'alpha',
      absolutePath: installPath,
      previousInstall: undefined,
      replacedBackupPath: undefined,
    });
    expect(syncMarket).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(2);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync failed',
      { error: 'auth user changed during auto sync' },
    );
  });

  it('retries failed cancellation cleanup before later sync work', async () => {
    let currentUserId = 'user-1';
    let installAttempts = 0;
    let cleanupAttempts = 0;
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const setup = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installImpl: async () => {
        installAttempts += 1;
        if (installAttempts === 1) currentUserId = 'user-2';
        return { success: true, name: 'alpha', version: '1.0.0', absolutePath: installPath };
      },
      cleanupInstall: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts <= 2) throw new Error('locked');
      },
    });

    await setup.service.runOnceAfterLogin();
    await setup.service.runOnceAfterLogin();
    await setup.service.runOnceAfterLogin();

    expect(setup.cleanupInstall).toHaveBeenCalledTimes(3);
    expect(setup.install).toHaveBeenCalledTimes(2);
    expect(setup.listAllInstalls).toHaveBeenCalledTimes(2);
    expect(setup.syncMarket).toHaveBeenCalledTimes(2);
    expect(setup.cleanupInstall.mock.invocationCallOrder[1]).toBeLessThan(
      setup.listAllInstalls.mock.invocationCallOrder[1],
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync pending cancellation cleanup failed',
      { slug: 'alpha', installPath, error: 'locked' },
    );
  });

  it('retries pending cleanup before honoring an empty config', async () => {
    let currentUserId = 'user-1';
    let installAttempts = 0;
    let cleanupAttempts = 0;
    let fetchAttempts = 0;
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const setup = makeService({
      getUserId: () => currentUserId,
      fetchConfigImpl: async () => {
        fetchAttempts += 1;
        return fetchAttempts === 1 ? [{ name: 'alpha' }] : [];
      },
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installImpl: async () => {
        installAttempts += 1;
        if (installAttempts === 1) currentUserId = 'user-2';
        return { success: true, name: 'alpha', version: '1.0.0', absolutePath: installPath };
      },
      cleanupInstall: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts <= 2) throw new Error('locked');
      },
    });

    await setup.service.runOnceAfterLogin();
    await setup.service.runOnceAfterLogin();
    await setup.service.runOnceAfterLogin();

    expect(setup.cleanupInstall).toHaveBeenCalledTimes(3);
    expect(setup.fetchConfig).toHaveBeenCalledTimes(2);
    expect(setup.install).toHaveBeenCalledTimes(1);
    expect(setup.syncMarket).toHaveBeenCalledTimes(1);
    expect(setup.cleanupInstall.mock.invocationCallOrder[1]).toBeLessThan(
      setup.fetchConfig.mock.invocationCallOrder[1],
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync pending cancellation cleanup failed',
      { slug: 'alpha', installPath, error: 'locked' },
    );
  });

  it('persists failed cancellation cleanup and retries it after service restart', async () => {
    let currentUserId = 'user-1';
    let cleanupAttempts = 0;
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const storePath = path.join(TEST_USER_DATA, 'skillhub', 'auto-sync-pending-cleanups.json');
    const first = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installImpl: async () => {
        currentUserId = 'user-2';
        return { success: true, name: 'alpha', version: '1.0.0', absolutePath: installPath };
      },
      cleanupInstall: async () => {
        cleanupAttempts += 1;
        throw new Error('locked');
      },
    });

    await first.service.runOnceAfterLogin();

    expect(cleanupAttempts).toBe(1);
    expect(fs.existsSync(storePath)).toBe(true);

    const second = makeService({
      getUserId: () => currentUserId,
      fetchConfigImpl: async () => [],
      cleanupInstall: async (params) => {
        cleanupAttempts += 1;
        expect(params).toEqual({
          slug: 'alpha',
          absolutePath: installPath,
        });
      },
    });

    await second.service.runOnceAfterLogin();

    expect(cleanupAttempts).toBe(2);
    expect(second.cleanupInstall).toHaveBeenCalledTimes(1);
    expect(second.fetchConfig).toHaveBeenCalledTimes(1);
    expect(second.cleanupInstall.mock.invocationCallOrder[0]).toBeLessThan(
      second.fetchConfig.mock.invocationCallOrder[0],
    );
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('retries cancelled update cleanup without deleting an already restored previous install', async () => {
    let currentUserId = 'user-1';
    let fetchAttempts = 0;
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const backupPath = path.join(TEST_ROOT, 'backups', 'alpha-old');
    const previousEntry = installEntry('1.0.0');
    await fs.promises.mkdir(installPath, { recursive: true });
    await fs.promises.writeFile(path.join(installPath, 'new.txt'), 'new', 'utf-8');
    await fs.promises.mkdir(backupPath, { recursive: true });
    await fs.promises.writeFile(path.join(backupPath, 'old.txt'), 'old', 'utf-8');
    vi.mocked(registryService.addInstall)
      .mockRejectedValueOnce(new Error('registry locked'))
      .mockResolvedValueOnce(undefined);
    const setup = makeService({
      getUserId: () => currentUserId,
      useDefaultCleanupInstall: true,
      fetchConfigImpl: async () => {
        fetchAttempts += 1;
        return fetchAttempts === 1 ? [{ name: 'alpha' }] : [];
      },
      installs: [{ skillName: 'alpha', installPath, entry: previousEntry }],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '2.0.0' }],
      installImpl: async () => {
        currentUserId = 'user-2';
        return {
          success: true,
          name: 'alpha',
          version: '2.0.0',
          absolutePath: installPath,
          replacedBackupPath: backupPath,
        };
      },
    });

    await setup.service.runOnceAfterLogin();

    expect(fs.existsSync(path.join(installPath, 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(installPath, 'new.txt'))).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(false);
    expect(registryService.addInstall).toHaveBeenCalledTimes(1);

    await setup.service.runOnceAfterLogin();

    expect(fs.existsSync(path.join(installPath, 'old.txt'))).toBe(true);
    expect(fs.existsSync(path.join(installPath, 'new.txt'))).toBe(false);
    expect(registryService.addInstall).toHaveBeenCalledTimes(2);
    expect(registryService.addInstall).toHaveBeenLastCalledWith('alpha', installPath, previousEntry);
    expect(setup.install).toHaveBeenCalledTimes(1);
  });

  it('cleans up when logout-start cancellation arrives before auth clears', async () => {
    const holder: { service?: SkillhubAutoSyncService } = {};
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const setup = makeService({
      getUserId: () => 'user-1',
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installImpl: async (_params, onProgress) => {
        holder.service?.cancelInFlight();
        onProgress({ phase: 'registering', name: 'alpha' });
        return { success: true, name: 'alpha', version: '1.0.0', absolutePath: installPath };
      },
    });
    holder.service = setup.service;

    await setup.service.runOnceAfterLogin();

    expect(setup.cancelInstall).toHaveBeenCalledWith('alpha');
    expect(setup.cleanupInstall).toHaveBeenCalledWith({
      slug: 'alpha',
      absolutePath: installPath,
      previousInstall: undefined,
      replacedBackupPath: undefined,
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync failed',
      { error: 'auth user changed during auto sync' },
    );
  });

  it('preserves the previous install backup when a cancelled update succeeds late', async () => {
    let currentUserId = 'user-1';
    const installPath = path.join(os.homedir(), '.agents', 'skills', 'alpha');
    const backupPath = path.join('/tmp', 'skillhub-backups', 'alpha-old');
    const entry = installEntry('1.0.0');
    const { service, install, cleanupInstall } = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      installs: [{ skillName: 'alpha', installPath, entry }],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '2.0.0' }],
      installImpl: async (_params, onProgress) => {
        currentUserId = 'user-2';
        onProgress({ phase: 'registering', name: 'alpha' });
        return {
          success: true,
          name: 'alpha',
          version: '2.0.0',
          absolutePath: installPath,
          replacedBackupPath: backupPath,
        };
      },
    });

    await service.runOnceAfterLogin();

    expect(install).toHaveBeenCalledWith(
      { name: 'alpha', catalogScope: 'market', autoSync: true, installPath, version: '2.0.0', force: true, skipBackup: false },
      expect.any(Function),
    );
    expect(cleanupInstall).toHaveBeenCalledWith({
      slug: 'alpha',
      absolutePath: installPath,
      previousInstall: { skillName: 'alpha', installPath, entry },
      replacedBackupPath: backupPath,
    });
  });

  it('treats user-owned install conflicts as terminal skips', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
      installResults: [
        { success: false, errorCode: 'CONFLICT_USER_OWNED', message: 'target exists' },
      ],
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'auto sync skipped user-owned global skill',
      { slug: 'alpha', errorCode: 'CONFLICT_USER_OWNED', message: 'target exists' },
    );
  });

  it('runs only once for repeated authenticated notifications', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('retries after a market sync failure', async () => {
    const { service, syncMarket, install } = makeService({
      configSkills: ['alpha'],
      syncResponses: [
        { success: false, error: 'offline' },
        { success: true, results: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }] },
      ],
    });

    await service.runOnceAfterLogin();
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('runs once per authenticated user', async () => {
    let currentUserId = 'user-1';
    const { service, syncMarket, install } = makeService({
      getUserId: () => currentUserId,
      configSkills: ['alpha'],
      syncResults: [{ name: 'alpha', exists: true, latestVersion: '1.0.0' }],
    });

    await service.runOnceAfterLogin();
    currentUserId = 'user-2';
    await service.runOnceAfterLogin();

    expect(syncMarket).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe('parseAutoSyncConfig', () => {
  it('preserves explicit catalog scopes and defaults legacy string entries to market', () => {
    expect(parseAutoSyncConfig({ skills: [
      'public-skill',
      { slug: 'team-skill', catalogScope: 'team' },
      { name: 'scope-alias', scope: 'market' },
    ] })).toEqual([
      { name: 'public-skill', catalogScope: 'market' },
      { name: 'team-skill', catalogScope: 'team' },
      { name: 'scope-alias', catalogScope: 'market' },
    ]);
  });

  it('rejects entries with an invalid explicit catalog scope', () => {
    expect(parseAutoSyncConfig({ skills: [
      { slug: 'wrong-scope', catalogScope: 'native' },
    ] })).toEqual([]);
  });

  it('uses the first catalog scope when config repeats a slug for the single global install slot', () => {
    expect(parseAutoSyncConfig({ skills: [
      { slug: 'shared-name', catalogScope: 'team' },
      { slug: 'shared-name', catalogScope: 'market' },
    ] })).toEqual([
      { name: 'shared-name', catalogScope: 'team' },
    ]);
  });
});
