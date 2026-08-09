import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const showOpenDialog = vi.fn();
const assertTrustedAppRendererEvent = vi.fn();
const importLocalSkillMocks = vi.hoisted(() => ({
  inspectLocalSkill: vi.fn(),
  importLocalSkill: vi.fn(),
}));
const installServiceMocks = vi.hoisted(() => ({
  install: vi.fn(),
  cancelInstall: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ isDestroyed: () => false })),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent,
}));

const getCurrentDataOwnerId = vi.fn((): string | null => 'local-v1');
vi.mock('../../authManager', () => ({ getCurrentDataOwnerId }));

const ensureReady = vi.fn();
const getRawDb = vi.fn(() => ({ id: 'db' }));
vi.mock('../../localDb', () => ({
  ensureReady,
  getRawDb,
}));

const readSkillRawFile = vi.fn();
const readSkillContent = vi.fn();
const listSkillFolderChildren = vi.fn();
const readSkillSiblingFile = vi.fn();
const renameLocalSkill = vi.fn();
const scanAllSkills = vi.fn();
const writeSkillFile = vi.fn();
const resolveExistingSkillPathForGrant = vi.fn();
const isExistingSkillPathGranted = vi.fn();
vi.mock('../scanner', () => ({
  isExistingSkillPathGranted,
  listSkillFolderChildren,
  readSkillContent,
  readSkillRawFile,
  readSkillSiblingFile,
  renameLocalSkill,
  resolveExistingSkillPathForGrant,
  scanAllSkills,
  writeSkillFile,
}));

vi.mock('../folderHash', () => ({
  computeFolderHashDetailed: vi.fn(),
}));

vi.mock('../snapshot', () => ({
  computeSnapshotDiff: vi.fn(),
  snapshotExists: vi.fn(),
}));

const getLocalSkillUsageSummary = vi.fn();
const getLocalSkillUsageDiagnosisContext = vi.fn();
const requestLocalSkillUsageAnalyticsRefresh = vi.fn();
vi.mock('../usageIndexer', () => ({
  getLocalSkillUsageDiagnosisContext,
  getLocalSkillUsageSummary,
  requestLocalSkillUsageAnalyticsRefresh,
}));

vi.mock('../installService', () => installServiceMocks);
vi.mock('../importLocalSkill', () => importLocalSkillMocks);

const publish = vi.fn();
const cancel = vi.fn();
const listAgentSkills = vi.fn();
const getAllowedProjectRoots = vi.fn();
const marketService = {
  deletePublished: vi.fn(),
  getPublishedFiles: vi.fn(),
  info: vi.fn(),
  listMarket: vi.fn(),
  listPublishedVersions: vi.fn(),
  sync: vi.fn(),
  updatePublished: vi.fn(),
};

describe('registerSkillhubIpc usage handlers', () => {
  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    getCurrentDataOwnerId.mockReturnValue('local-v1');
    ensureReady.mockResolvedValue({ ready: true });
    requestLocalSkillUsageAnalyticsRefresh.mockReturnValue(null);
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    getAllowedProjectRoots.mockResolvedValue(['/repo', '/old', '/new']);
    resolveExistingSkillPathForGrant.mockImplementation((candidate: string) => (
      candidate.includes('/authorized/demo') ? '/physical/demo' : null
    ));
    isExistingSkillPathGranted.mockImplementation((candidate: string, roots: Set<string>) => (
      roots.has('/physical/demo') && candidate.includes('/authorized/demo')
    ));
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });
  });

  it('binds SkillHub file access to the trusted renderer latest scan', async () => {
    const destroyedCallbacks: Array<() => void> = [];
    const sender = {
      id: 11,
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') destroyedCallbacks.push(callback);
      }),
    };
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        absolutePath: '/physical/demo',
        discoveredPath: '/repo/.pi/skills/authorized/demo',
        scope: 'project',
        projectRoot: '/repo',
      }],
      sources: [],
    });
    readSkillContent.mockResolvedValue({ success: true, content: 'demo' });
    listSkillFolderChildren.mockResolvedValue({ success: true, entries: [] });
    readSkillSiblingFile.mockResolvedValue({ success: true, content: 'notes' });
    readSkillRawFile.mockResolvedValue({ success: true, content: 'raw' });
    writeSkillFile.mockResolvedValue({ success: true });
    renameLocalSkill.mockResolvedValue({ success: true, newAbsolutePath: '/renamed' });

    const scanResult = await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });

    expect(assertTrustedAppRendererEvent).toHaveBeenCalledWith({ sender });
    expect(resolveExistingSkillPathForGrant).toHaveBeenCalledWith(
      '/repo/.pi/skills/authorized/demo',
    );
    expect(scanResult).toMatchObject({ success: true });
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));

    const calls = [
      ['skillhub:read-skill', { mdPath: '/repo/.pi/skills/authorized/demo/SKILL.md' }, readSkillContent],
      ['skillhub:list-children', { dirPath: '/repo/.pi/skills/authorized/demo' }, listSkillFolderChildren],
      ['skillhub:read-sibling-file', { filePath: '/repo/.pi/skills/authorized/demo/notes.md' }, readSkillSiblingFile],
      ['skillhub:read-raw', { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' }, readSkillRawFile],
      ['skillhub:write-file', { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md', content: '# Demo' }, writeSkillFile],
      ['skillhub:rename-local', { absolutePath: '/repo/.pi/skills/authorized/demo', newName: 'renamed' }, renameLocalSkill],
    ] as const;
    for (const [channel, params, delegated] of calls) {
      await handlers.get(channel)?.({ sender }, params);
      expect(delegated).toHaveBeenCalledWith(params);
    }

    const wrongSender = await handlers.get('skillhub:read-raw')?.(
      { sender: { id: 22 } },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    );
    expect(wrongSender).toMatchObject({ success: false, error: expect.stringContaining('latest SkillHub scan') });

    const unscannedPath = await handlers.get('skillhub:write-file')?.(
      { sender },
      { filePath: '/other/.pi/skills/unscanned/SKILL.md', content: '# Injected' },
    );
    expect(unscannedPath).toMatchObject({ success: false, error: expect.stringContaining('latest SkillHub scan') });

    scanAllSkills.mockRejectedValueOnce(new Error('scan failed'));
    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });
    const afterFailedRescan = await handlers.get('skillhub:read-skill')?.(
      { sender },
      { mdPath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    );
    expect(afterFailedRescan).toMatchObject({ success: false });

    destroyedCallbacks[0]?.();
    const afterDestroy = await handlers.get('skillhub:read-skill')?.(
      { sender },
      { mdPath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    );
    expect(afterDestroy).toMatchObject({ success: false });
  });

  it('revokes project scan grants after the last active project session disappears', async () => {
    const sender = { id: 12, once: vi.fn() };
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        absolutePath: '/physical/demo',
        discoveredPath: '/repo/.pi/skills/authorized/demo',
        scope: 'project',
        projectRoot: '/repo',
      }],
      sources: [],
    });
    readSkillRawFile.mockResolvedValue({ success: true, content: 'raw' });

    await handlers.get('skillhub:scan')?.(
      { sender },
      { projects: [{ projectRoot: '/repo', hash: 'repo' }] },
    );
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    )).resolves.toMatchObject({ success: true });

    getAllowedProjectRoots.mockResolvedValue([]);
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    )).resolves.toMatchObject({ success: false });
    expect(readSkillRawFile).toHaveBeenCalledTimes(1);
  });

  it('does not let an older concurrent scan overwrite the latest sender grant', async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    const older = new Promise((resolve) => { resolveOlder = resolve; });
    const newer = new Promise((resolve) => { resolveNewer = resolve; });
    scanAllSkills
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    resolveExistingSkillPathForGrant.mockImplementation((candidate: string) => {
      if (candidate.includes('/old-skill')) return '/physical/old-skill';
      if (candidate.includes('/new-skill')) return '/physical/new-skill';
      return null;
    });
    isExistingSkillPathGranted.mockImplementation((candidate: string, roots: Set<string>) => (
      (candidate.includes('/old-skill') && roots.has('/physical/old-skill'))
      || (candidate.includes('/new-skill') && roots.has('/physical/new-skill'))
    ));
    readSkillRawFile.mockResolvedValue({ success: true, content: 'raw' });
    const sender = { id: 33, once: vi.fn() };
    const scan = handlers.get('skillhub:scan');

    const olderRequest = scan?.({ sender }, { projects: [{ projectRoot: '/old', hash: 'old' }] });
    const newerRequest = scan?.({ sender }, { projects: [{ projectRoot: '/new', hash: 'new' }] });
    resolveNewer({
      skills: [{ absolutePath: '/physical/new-skill', discoveredPath: '/new/.pi/skills/new-skill' }],
      sources: [],
    });
    await newerRequest;
    resolveOlder({
      skills: [{ absolutePath: '/physical/old-skill', discoveredPath: '/old/.pi/skills/old-skill' }],
      sources: [],
    });
    await olderRequest;

    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/new/.pi/skills/new-skill/SKILL.md' },
    )).resolves.toMatchObject({ success: true });
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/old/.pi/skills/old-skill/SKILL.md' },
    )).resolves.toMatchObject({ success: false });
  });

  it('revokes a sender scan grant when the active data owner changes', async () => {
    const sender = { id: 34, once: vi.fn() };
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        absolutePath: '/physical/demo',
        discoveredPath: '/repo/.pi/skills/authorized/demo',
      }],
      sources: [],
    });
    readSkillRawFile.mockResolvedValue({ success: true, content: 'raw' });

    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    )).resolves.toMatchObject({ success: true });

    getCurrentDataOwnerId.mockReturnValue('local-v2');
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    )).resolves.toMatchObject({ success: false });

    getCurrentDataOwnerId.mockReturnValue('local-v1');
    await expect(handlers.get('skillhub:read-raw')?.(
      { sender },
      { filePath: '/repo/.pi/skills/authorized/demo/SKILL.md' },
    )).resolves.toMatchObject({ success: false });
  });

  it('rejects renderer-provided project roots outside Main-owned active projects', async () => {
    const sender = { id: 44, once: vi.fn() };

    const result = await handlers.get('skillhub:scan')?.(
      { sender },
      { projects: [{ projectRoot: '/arbitrary', hash: 'bad' }] },
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('not owned'),
    });
    expect(scanAllSkills).not.toHaveBeenCalled();
  });

  it('issues a sender-bound grant for the file selected and inspected in main', async () => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/selected/demo-skill.zip'],
    });
    importLocalSkillMocks.inspectLocalSkill.mockResolvedValueOnce({
      success: true,
      name: 'demo-skill',
      description: 'Demo',
      version: '1.0.0',
    });
    const sender = { id: 11 };
    const handler = handlers.get('skillhub:pick-local');

    const result = await handler?.({ sender });

    expect(assertTrustedAppRendererEvent).toHaveBeenCalledWith({ sender });
    expect(importLocalSkillMocks.inspectLocalSkill).toHaveBeenCalledWith({
      filePath: '/selected/demo-skill.zip',
    });
    expect(result).toMatchObject({
      success: true,
      canceled: false,
      grantToken: expect.any(String),
      name: 'demo-skill',
      description: 'Demo',
      version: '1.0.0',
    });
  });

  it('imports only the selected path for the grant owner and consumes a successful grant', async () => {
    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/selected/demo-skill.zip'],
    });
    importLocalSkillMocks.inspectLocalSkill.mockResolvedValueOnce({
      success: true,
      name: 'demo-skill',
      description: 'Demo',
      version: '1.0.0',
    });
    importLocalSkillMocks.importLocalSkill.mockResolvedValueOnce({
      success: true,
      name: 'demo-skill',
      description: 'Demo',
      version: '1.0.0',
      absolutePath: '/home/.agents/skills/demo-skill',
    });
    const sender = { id: 11 };
    const picked = (await handlers.get('skillhub:pick-local')?.({ sender })) as {
      grantToken: string;
    };
    const handler = handlers.get('skillhub:import-local');

    const result = await handler?.(
      { sender },
      {
        grantToken: picked.grantToken,
        filePath: '/not-authorized/other.zip',
        force: true,
      },
    );

    expect(importLocalSkillMocks.importLocalSkill).toHaveBeenCalledWith({
      filePath: '/selected/demo-skill.zip',
      force: true,
    });
    expect(result).toMatchObject({ success: true, name: 'demo-skill' });

    const replay = await handler?.({ sender }, { grantToken: picked.grantToken });
    expect(replay).toMatchObject({ success: false, errorCode: 'PERMISSION_DENIED' });
    expect(importLocalSkillMocks.importLocalSkill).toHaveBeenCalledTimes(1);
  });

  it('rejects missing grants and grants issued to another renderer', async () => {
    const importHandler = handlers.get('skillhub:import-local');
    const missing = await importHandler?.(
      { sender: { id: 11 } },
      { filePath: '/not-authorized/demo.zip' },
    );
    expect(missing).toMatchObject({ success: false, errorCode: 'PERMISSION_DENIED' });

    showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/selected/demo-skill.zip'],
    });
    importLocalSkillMocks.inspectLocalSkill.mockResolvedValueOnce({
      success: true,
      name: 'demo-skill',
      description: 'Demo',
      version: '1.0.0',
    });
    const picked = (await handlers.get('skillhub:pick-local')?.({
      sender: { id: 11 },
    })) as { grantToken: string };
    const wrongSender = await importHandler?.(
      { sender: { id: 22 } },
      { grantToken: picked.grantToken },
    );

    expect(wrongSender).toMatchObject({ success: false, errorCode: 'PERMISSION_DENIED' });
    expect(importLocalSkillMocks.importLocalSkill).not.toHaveBeenCalled();
  });

  it('retries usage summary after local DB becomes ready', async () => {
    getLocalSkillUsageSummary
      .mockRejectedValueOnce(new Error('localDb not ready: pending'))
      .mockResolvedValueOnce({ success: true, summary: { totalUseCount: 1 }, refreshing: false });

    const handler = handlers.get('skillhub:get-usage-summary');
    expect(handler).toBeTypeOf('function');
    const result = await handler?.({}, { name: 'word-doc' });

    expect(ensureReady).toHaveBeenCalledWith('local-v1');
    expect(getLocalSkillUsageSummary).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, summary: { totalUseCount: 1 }, refreshing: false });
  });

  it('returns a structured failure when usage summary still fails', async () => {
    getLocalSkillUsageSummary.mockRejectedValueOnce(new Error('bad transcript'));

    const handler = handlers.get('skillhub:get-usage-summary');
    const result = await handler?.({}, { name: 'word-doc' });

    expect(result).toEqual({ success: false, error: 'bad transcript' });
  });

  it('passes readable SKILL.md content and path into diagnosis context', async () => {
    readSkillRawFile.mockResolvedValueOnce({ success: true, content: 'skill body' });
    getLocalSkillUsageDiagnosisContext.mockResolvedValueOnce({
      success: true,
      context: { prompt: 'diagnose' },
    });

    const handler = handlers.get('skillhub:get-usage-diagnosis-context');
    const result = await handler?.({}, { name: 'word-doc', mdPath: 'C:\\skills\\word-doc\\SKILL.md' });

    expect(readSkillRawFile).toHaveBeenCalledWith({ filePath: 'C:\\skills\\word-doc\\SKILL.md' });
    expect(getLocalSkillUsageDiagnosisContext).toHaveBeenCalledWith({
      skillName: 'word-doc',
      currentSkillContent: 'skill body',
      skillPath: 'C:\\skills\\word-doc\\SKILL.md',
    });
    expect(result).toEqual({ success: true, context: { prompt: 'diagnose' } });
  });

  it('drops internal autoSync flag from renderer install params', async () => {
    installServiceMocks.install.mockResolvedValueOnce({
      success: true,
      name: 'demo-oa-skill',
      version: '1.0.0',
      absolutePath: '/tmp/demo-oa-skill',
    });
    const sender = { send: vi.fn() };
    const handler = handlers.get('skillhub:install');

    const result = await handler?.(
      { sender },
      {
        name: 'demo-oa-skill',
        version: '1.0.0',
        force: true,
        installPath: '/tmp/demo-oa-skill',
        skipBackup: true,
        autoSync: true,
      },
    );

    expect(result).toEqual({
      success: true,
      name: 'demo-oa-skill',
      version: '1.0.0',
      absolutePath: '/tmp/demo-oa-skill',
    });
    expect(installServiceMocks.install).toHaveBeenCalledWith(
      {
        name: 'demo-oa-skill',
        version: '1.0.0',
        force: true,
        installPath: '/tmp/demo-oa-skill',
        skipBackup: true,
      },
      expect.any(Function),
    );
  });

  it('refreshes the Codex cwd cache after installing a project skill', async () => {
    installServiceMocks.install.mockResolvedValueOnce({
      success: true,
      name: 'project-skill',
      version: '1.0.0',
      absolutePath: '/project/.agents/skills/project-skill',
      projectWorkingDir: '/project',
    });
    listAgentSkills.mockResolvedValueOnce({ skills: [] });
    const sender = { send: vi.fn() };
    const handler = handlers.get('skillhub:install');

    const result = await handler?.(
      { sender },
      {
        name: 'project-skill',
        version: '1.0.0',
        installPath: '/project/.agents/skills/project-skill',
      },
    );

    expect(result).toEqual({
      success: true,
      name: 'project-skill',
      version: '1.0.0',
      absolutePath: '/project/.agents/skills/project-skill',
    });
    expect(listAgentSkills).toHaveBeenCalledWith('codex', {
      workingDir: '/project',
      forceReload: true,
    });
  });

  it('refreshes the Codex cwd cache after uninstalling a project skill', async () => {
    installServiceMocks.uninstall.mockResolvedValueOnce({
      success: true,
      projectWorkingDir: '/project',
    });
    listAgentSkills.mockResolvedValueOnce({ skills: [] });
    const handler = handlers.get('skillhub:uninstall');

    const result = await handler?.({}, {
      absolutePath: '/project/.agents/skills/project-skill',
    });

    expect(result).toEqual({ success: true });
    expect(listAgentSkills).toHaveBeenCalledWith('codex', {
      workingDir: '/project',
      forceReload: true,
    });
  });
});
