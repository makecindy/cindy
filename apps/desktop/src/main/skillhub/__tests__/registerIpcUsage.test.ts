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

vi.mock('../../authManager', () => ({
  getCurrentDataOwnerId: vi.fn(() => 'local-v1'),
}));

const ensureReady = vi.fn();
const getRawDb = vi.fn(() => ({ id: 'db' }));
vi.mock('../../localDb', () => ({
  ensureReady,
  getRawDb,
}));

const readSkillRawFile = vi.fn();
vi.mock('../scanner', () => ({
  listSkillFolderChildren: vi.fn(),
  readSkillContent: vi.fn(),
  readSkillRawFile,
  readSkillSiblingFile: vi.fn(),
  renameLocalSkill: vi.fn(),
  scanAllSkills: vi.fn(),
  writeSkillFile: vi.fn(),
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
    ensureReady.mockResolvedValue({ ready: true });
    requestLocalSkillUsageAnalyticsRefresh.mockReturnValue(null);
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });
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
