import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/xdt-publish-service-test';
const authState = vi.hoisted(() => ({ ownerId: 'user-1' as string | null }));

vi.mock('electron', () => ({
  app: {
    getPath: () => TEST_ROOT,
  },
  net: {
    fetch: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    decryptString: () => 'test-api-key',
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: vi.fn(() => 'https://skillhub.test.invalid'),
}));

vi.mock('../../serverApiClient', async () => {
  class ServerApiError extends Error {
    constructor(
      public readonly code: string,
      public readonly statusCode: number,
      message: string,
    ) {
      super(message);
      this.name = 'ServerApiError';
    }
  }
  return {
    ServerApiError,
    serverApiFetch: vi.fn(),
  };
});

vi.mock('../folderHash', () => ({
  computeFolderHash: vi.fn(),
}));

vi.mock('../snapshot', () => ({
  writeSnapshot: vi.fn(),
}));

vi.mock('../zipPacker', () => ({
  pack: vi.fn(),
}));

vi.mock('../registry', () => ({
  registryService: {
    addInstall: vi.fn(),
    updateInstall: vi.fn(),
    getInstall: vi.fn(),
    removeInstall: vi.fn(),
  },
}));

vi.mock('../../authManager', () => ({
  getCurrentUserId: vi.fn(),
  getCurrentDataOwnerId: vi.fn(() => authState.ownerId),
}));

vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseSkillHubCloud: true }),
  requireAppCapability: vi.fn(),
}));


function writeApiKeyFile() {
  const safeStorageDir = `${TEST_ROOT}/safe-storage`;
  fs.mkdirSync(safeStorageDir, { recursive: true });
  fs.writeFileSync(`${safeStorageDir}/api_key.enc`, Buffer.from('encrypted-api-key').toString('base64'));
}

describe('SkillPublishService', () => {
  beforeEach(() => {
    authState.ownerId = 'user-1';
    vi.resetModules();
    vi.clearAllMocks();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  it('rejects manual-category publish requests without a category before review or upload starts', async () => {
    const { SkillPublishService } = await import('../publishService');
    const service = new SkillPublishService();
    const events: Array<{ phase: string; errorCode?: string; message?: string }> = [];

    const result = await service.publish(
      {
        absolutePath: '/tmp/skill',
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        categoryMode: 'manual',
        categories: [],
      },
      (event) => events.push(event),
    );

    expect(result).toEqual({ success: false, errorCode: 'CATEGORY_REQUIRED' });
    expect(events).toEqual([
      {
        phase: 'failed',
        name: 'lark-task',
        errorCode: 'CATEGORY_REQUIRED',
        message: '请选择分类后再发布',
      },
    ]);
  });

  it('allows version publishes without category metadata and omits category fields from commit', async () => {
    writeApiKeyFile();
    const skillPath = '/tmp/xdt-publish-service-test/skill';
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(`${skillPath}/SKILL.md`, [
      '---',
      'name: lark-task',
      'version: 1.0.0',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string, opts?: { body?: unknown }) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.1.0',
          ossKey: 'skills/lark-task/v1.1.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        return { slug: 'lark-task', version: (opts?.body as { version: string }).version, status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: skillPath,
        name: 'lark-task',
        isFirstPublish: false,
        version: '1.1.0',
        changelog: 'Update flow.',
      },
      () => {},
    );

    expect(result.success).toBe(true);
    const commitCall = vi.mocked(serverApiFetch).mock.calls.find(([path]) => path === '/api/skills-hub/skills/publish/commit');
    expect(commitCall?.[1]?.body).toMatchObject({
      ossKey: 'skills/lark-task/v1.1.0.zip',
      slug: 'lark-task',
      version: '1.1.0',
      changelog: 'Update flow.',
    });
    expect(commitCall?.[1]?.body).not.toHaveProperty('categoryMode');
    expect(commitCall?.[1]?.body).not.toHaveProperty('categories');
    expect(commitCall?.[1]?.body).not.toHaveProperty('visibility');
  });

  it('publishes through Hub without requiring a local LLM API key file', async () => {
    const skillPath = '/tmp/xdt-publish-service-test/skill';
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(`${skillPath}/SKILL.md`, [
      '---',
      'name: lark-task',
      'version: 1.0.0',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string, opts?: { body?: unknown }) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.1.0',
          ossKey: 'skills/lark-task/v1.1.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        return { slug: 'lark-task', version: (opts?.body as { version: string }).version, status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: skillPath,
        name: 'lark-task',
        isFirstPublish: false,
        version: '1.1.0',
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(serverApiFetch).toHaveBeenCalledWith('/api/skills-hub/skills/publish/init', {
      method: 'POST',
      body: { slug: 'lark-task', version: '1.1.0' },
      baseUrl: expect.any(Function),
    });
    const initCall = vi.mocked(serverApiFetch).mock.calls.find(
      ([path]) => path === '/api/skills-hub/skills/publish/init',
    );
    const initBaseUrl = initCall?.[1]?.baseUrl;
    expect(
      typeof initBaseUrl === 'function' ? initBaseUrl() : initBaseUrl,
    ).toBe('https://skillhub.test.invalid');
  });

  it('sends the hand-filled 280-char text to Hub commit as summary', async () => {
    writeApiKeyFile();
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string, opts?: { body?: unknown }) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.0.0',
          ossKey: 'skills/lark-task/v1.0.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        return { slug: 'lark-task', version: (opts?.body as { version: string }).version, status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        categoryMode: 'manual',
        categories: ['productivity'],
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(serverApiFetch).toHaveBeenCalledWith('/api/skills-hub/skills/publish/commit', {
      method: 'POST',
      baseUrl: expect.any(Function),
      body: expect.objectContaining({
        displayName: 'Lark Task',
        summary: 'Publish summary',
        categories: ['productivity'],
        categoryMode: 'manual',
      }),
    });
    const commitCall = vi.mocked(serverApiFetch).mock.calls.find(([path]) => path === '/api/skills-hub/skills/publish/commit');
    expect(commitCall?.[1]?.body).not.toHaveProperty('description');
  });

  it('allows auto category mode and asks Hub to classify the skill', async () => {
    writeApiKeyFile();
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string, opts?: { body?: unknown }) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.0.0',
          ossKey: 'skills/lark-task/v1.0.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        return { slug: 'lark-task', version: (opts?.body as { version: string }).version, status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        categoryMode: 'auto',
        categories: [],
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(serverApiFetch).toHaveBeenCalledWith('/api/skills-hub/skills/publish/commit', {
      method: 'POST',
      baseUrl: expect.any(Function),
      body: expect.objectContaining({
        categoryMode: 'auto',
        categories: [],
      }),
    });
  });

  it('keeps an explicit empty visibleSlugs list in first-publish commit', async () => {
    writeApiKeyFile();
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string, opts?: { body?: unknown }) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.0.0',
          ossKey: 'skills/lark-task/v1.0.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        return { slug: 'lark-task', version: (opts?.body as { version: string }).version, status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        visibleSlugs: [],
        categoryMode: 'manual',
        categories: ['productivity'],
      },
      () => {},
    );

    expect(result.success).toBe(true);
    expect(serverApiFetch).toHaveBeenCalledWith('/api/skills-hub/skills/publish/commit', {
      method: 'POST',
      baseUrl: expect.any(Function),
      body: expect.objectContaining({
        visibility: 'public',
        visibleSlugs: [],
      }),
    });
  });

  it('calls writeSnapshot and syncPublishedRegistry immediately after commit succeeds', async () => {
    writeApiKeyFile();
    const skillPath = '/tmp/xdt-publish-service-test/skill';
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(
      `${skillPath}/SKILL.md`,
      [
        '---',
        'name: lark-task',
        'version: 0.9.0',
        'description: Frontmatter description',
        '---',
        '',
        '# Lark task',
        '',
      ].join('\n'),
    );

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({
      buffer: Buffer.from('zip'),
      size: 3,
      sha256: 'zip-sha',
      manifest: { files: [] },
    });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(
      async (apiPath: string, opts?: { body?: unknown }) => {
        if (apiPath === '/api/skills-hub/skills/publish/init') {
          return {
            nextVersion: '1.0.0',
            ossKey: 'skills/lark-task/v1.0.0.zip',
            uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
          };
        }
        if (apiPath === '/api/skills-hub/skills/publish/commit') {
          return {
            slug: 'lark-task',
            version: (opts?.body as { version: string }).version,
            status: 'scanning',
          };
        }
        throw new Error(`unexpected api path ${apiPath}`);
      },
    );

    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: skillPath,
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        categoryMode: 'manual',
        categories: ['productivity'],
      },
      () => {},
    );

    expect(result.success).toBe(true);
    // Snapshot and registry writes happen immediately on commit success (no deferred confirmation)
    expect(writeSnapshot).toHaveBeenCalledWith(skillPath, 'lark-task');
    expect(registryService.addInstall).toHaveBeenCalledWith(
      'lark-task',
      skillPath,
      expect.objectContaining({
        version: '1.0.0',
        authorId: 'user-1',
        folderHash: 'folder-hash',
        origin: 'published',
      }),
    );
  });

  it('finishes local reconciliation when cancellation happens after commit is accepted', async () => {
    writeApiKeyFile();
    const skillPath = '/tmp/xdt-publish-service-test/skill';
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(
      `${skillPath}/SKILL.md`,
      [
        '---',
        'name: lark-task',
        'version: 0.9.0',
        'description: Frontmatter description',
        '---',
        '',
        '# Lark task',
        '',
      ].join('\n'),
    );

    const { serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { writeSnapshot } = await import('../snapshot');
    const { pack } = await import('../zipPacker');
    const { registryService } = await import('../registry');
    const { getCurrentUserId } = await import('../../authManager');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(writeSnapshot).mockResolvedValue(undefined);
    vi.mocked(pack).mockResolvedValue({
      buffer: Buffer.from('zip'),
      size: 3,
      sha256: 'zip-sha',
      manifest: { files: [] },
    });
    vi.mocked(getCurrentUserId).mockReturnValue('user-1');
    vi.mocked(registryService.getInstall).mockResolvedValue(null);
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    let notifyCommitStarted!: () => void;
    let releaseCommit!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      notifyCommitStarted = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.0.0',
          ossKey: 'skills/lark-task/v1.0.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        notifyCommitStarted();
        await commitGate;
        return { slug: 'lark-task', version: '1.0.0', status: 'scanning' };
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const events: Array<{ phase: string; errorCode?: string }> = [];
    const service = new SkillPublishService();
    const publishing = service.publish(
      {
        absolutePath: skillPath,
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        categoryMode: 'manual',
        categories: ['productivity'],
      },
      (event) => events.push(event),
    );

    await commitStarted;
    service.cancel();
    releaseCommit();

    await expect(publishing).resolves.toEqual({
      success: true,
      result: { name: 'lark-task', version: '1.0.0' },
    });
    expect(writeSnapshot).toHaveBeenCalledWith(skillPath, 'lark-task');
    expect(events.at(-1)).toMatchObject({ phase: 'done' });
    expect(events).not.toContainEqual(expect.objectContaining({ phase: 'failed' }));
  });

  it('maps preserved Hub business error codes to actionable publish errors', async () => {
    writeApiKeyFile();
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { ServerApiError, serverApiFetch } = await import('../../serverApiClient');
    const { computeFolderHash } = await import('../folderHash');
    const { pack } = await import('../zipPacker');
    const { net } = await import('electron');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash-2');
    vi.mocked(pack).mockResolvedValue({ buffer: Buffer.from('zip'), size: 3, sha256: 'zip-sha', manifest: { files: [] } });
    vi.mocked(net.fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    vi.mocked(serverApiFetch).mockImplementation(async (apiPath: string) => {
      if (apiPath === '/api/skills-hub/skills/publish/init') {
        return {
          nextVersion: '1.0.0',
          ossKey: 'skills/lark-task/v1.0.0.zip',
          uploadUrl: 'https://oss.example.com/skills/lark-task.zip',
        };
      }
      if (apiPath === '/api/skills-hub/skills/publish/commit') {
        throw new ServerApiError('NAME_TAKEN', 409, '名字已被占用');
      }
      throw new Error(`unexpected api path ${apiPath}`);
    });

    const events: Array<{ phase: string; errorCode?: string }> = [];
    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: true,
        version: '1.0.0',
        displayName: 'Lark Task',
        summary: 'Publish summary',
        visibility: 'PUBLIC',
        categoryMode: 'manual',
        categories: ['productivity'],
      },
      (event) => events.push(event),
    );

    expect(result).toEqual({ success: false, errorCode: 'NAME_TAKEN' });
    expect(events.at(-1)).toMatchObject({ phase: 'failed', errorCode: 'NAME_TAKEN' });
  });

  it('emits a failed progress event when packing throws unexpectedly', async () => {
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    const originalSkillMd = [
      '---',
      'name: lark-task',
      'version: 0.9.0',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n');
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', originalSkillMd);

    const { computeFolderHash } = await import('../folderHash');
    const { pack } = await import('../zipPacker');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(pack).mockRejectedValue(new Error('zip failed'));

    const events: Array<{ phase: string; errorCode?: string; message?: string }> = [];
    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: false,
        version: '1.0.0',
        changelog: 'Update flow.',
      },
      (event) => events.push(event),
    );

    expect(result).toEqual({ success: false, errorCode: 'PACK_FAILED', error: 'zip failed' });
    expect(events).toEqual([
      { phase: 'packing' },
      { phase: 'failed', name: 'lark-task', errorCode: 'PACK_FAILED', message: 'zip failed' },
    ]);
    expect(fs.readFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', 'utf8')).toBe(originalSkillMd);
  });

  it('maps pack timeout failures to PACK_FAILED without relying on IPC rejection', async () => {
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'version: 0.9.0',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { computeFolderHash } = await import('../folderHash');
    const { pack } = await import('../zipPacker');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(pack).mockRejectedValue(new Error('打包超过 45 秒未完成，请重试'));

    const events: Array<{ phase: string; errorCode?: string; message?: string }> = [];
    const service = new SkillPublishService();
    const result = await service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: false,
        changelog: 'Update flow.',
      },
      (event) => events.push(event),
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PACK_FAILED');
    expect(events).toEqual([
      { phase: 'packing' },
      {
        phase: 'failed',
        name: 'lark-task',
        errorCode: 'PACK_FAILED',
        message: '打包超过 45 秒未完成，请重试',
      },
    ]);
  });

  it('treats cancellation during packing as CANCELLED', async () => {
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    fs.writeFileSync('/tmp/xdt-publish-service-test/skill/SKILL.md', [
      '---',
      'name: lark-task',
      'version: 0.9.0',
      'description: Frontmatter description',
      '---',
      '',
      '# Lark task',
      '',
    ].join('\n'));

    const { computeFolderHash } = await import('../folderHash');
    const { pack } = await import('../zipPacker');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(pack).mockImplementation((_absolutePath, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const events: Array<{ phase: string; errorCode?: string; message?: string }> = [];
    const service = new SkillPublishService();
    const publishPromise = service.publish(
      {
        absolutePath: '/tmp/xdt-publish-service-test/skill',
        name: 'lark-task',
        isFirstPublish: false,
        changelog: 'Update flow.',
      },
      (event) => events.push(event),
    );

    await Promise.resolve();
    service.cancel();
    const result = await publishPromise;

    expect(result).toEqual({ success: false, errorCode: 'CANCELLED', error: '已取消' });
    expect(events).toEqual([
      { phase: 'packing' },
      { phase: 'failed', name: 'lark-task', errorCode: 'CANCELLED', message: '已取消' },
    ]);
  });

  it('cancels an in-flight publish when the data owner changes', async () => {
    fs.mkdirSync('/tmp/xdt-publish-service-test/skill', { recursive: true });
    const { computeFolderHash } = await import('../folderHash');
    const { pack } = await import('../zipPacker');
    const { SkillPublishService } = await import('../publishService');

    vi.mocked(computeFolderHash).mockResolvedValue('folder-hash');
    vi.mocked(pack).mockImplementation(async () => {
      authState.ownerId = 'user-2';
      return {
        buffer: Buffer.from('zip'),
        size: 3,
        sha256: 'zip-sha',
        manifest: { files: [] },
      };
    });

    const service = new SkillPublishService();
    const result = await service.publish({
      absolutePath: '/tmp/xdt-publish-service-test/skill',
      name: 'lark-task',
      isFirstPublish: false,
    });

    expect(result).toEqual({ success: false, errorCode: 'CANCELLED' });
  });

  it('treats blocked scan status as terminal when polling publish scan results', async () => {
    vi.useFakeTimers();
    try {
      const { serverApiFetch } = await import('../../serverApiClient');
      const { SkillPublishService } = await import('../publishService');

      vi.mocked(serverApiFetch).mockResolvedValue({
        status: 'blocked',
        gates: [{ name: 'policy', status: 'blocked' }],
      });

      const events: Array<{ phase: string; status?: string; gates?: unknown[] }> = [];
      const service = new SkillPublishService({
        scanPollIntervalMs: 10,
        onProgress: (event) => events.push(event),
      });

      service.startScanPoll('lark-task', '1.0.0');
      await vi.advanceTimersByTimeAsync(10);

      expect(events).toEqual([
        {
          phase: 'scan-status',
          name: 'lark-task',
          version: '1.0.0',
          status: 'blocked',
          gates: [{ name: 'policy', status: 'blocked' }],
        },
        {
          phase: 'scan-result',
          name: 'lark-task',
          version: '1.0.0',
          status: 'blocked',
          gates: [{ name: 'policy', status: 'blocked' }],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stale scan poll responses after a newer poll starts', async () => {
    vi.useFakeTimers();
    try {
      const { serverApiFetch } = await import('../../serverApiClient');
      const { SkillPublishService } = await import('../publishService');

      let resolveOldPoll!: (value: { status: string; gates: Array<{ name: string; status: string }> }) => void;
      const oldPollResult = new Promise<{ status: string; gates: Array<{ name: string; status: string }> }>((resolve) => {
        resolveOldPoll = resolve;
      });
      vi.mocked(serverApiFetch)
        .mockImplementationOnce(() => oldPollResult)
        .mockResolvedValueOnce({
          status: 'pass',
          gates: [{ name: 'policy', status: 'pass' }],
        });

      const events: Array<{ phase: string; name?: string; version?: string; status?: string; gates?: unknown[] }> = [];
      const service = new SkillPublishService({
        scanPollIntervalMs: 10,
        onProgress: (event) => events.push(event),
      });

      service.startScanPoll('lark-task', '1.0.0');
      await vi.advanceTimersByTimeAsync(10);
      expect(serverApiFetch).toHaveBeenCalledTimes(1);

      service.startScanPoll('lark-task', '1.0.1');
      resolveOldPoll({ status: 'blocked', gates: [{ name: 'policy', status: 'blocked' }] });
      await Promise.resolve();
      await Promise.resolve();

      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(10);

      expect(events).toEqual([
        {
          phase: 'scan-status',
          name: 'lark-task',
          version: '1.0.1',
          status: 'pass',
          gates: [{ name: 'policy', status: 'pass' }],
        },
        {
          phase: 'scan-result',
          name: 'lark-task',
          version: '1.0.1',
          status: 'pass',
          gates: [{ name: 'policy', status: 'pass' }],
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
