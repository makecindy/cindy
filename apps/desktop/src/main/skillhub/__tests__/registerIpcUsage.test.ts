import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-ipc-management-'));
afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
const expectedAttestedRoot = (value: string): string => {
  const physicalRoot = fs.realpathSync.native(value);
  return process.platform === 'win32' ? physicalRoot.toLowerCase() : physicalRoot;
};
const setCindySkillEnabled = vi.fn(async () => undefined);
const isCindyLearnSkillEnabled = vi.fn(() => true);
vi.mock('../activationPreferences', () => ({
  isCindyLearnSkillEnabled,
  setCindySkillEnabled,
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const comparePublishedSkill = vi.fn();
vi.mock('../publishedComparison', () => ({ comparePublishedSkill }));
const showOpenDialog = vi.fn();
const showMessageBox = vi.fn();
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
const assertTrustedAppRendererEvent = vi.fn();
const isTrustedAppRendererWindow = vi.fn();
const publishServiceOptions = vi.hoisted(() => ({ onProgress: null as null | ((event: unknown) => void) }));
vi.mock('../publishService', () => ({
  SkillPublishService: class {
    constructor(options: { onProgress: (event: unknown) => void }) {
      publishServiceOptions.onProgress = options.onProgress;
    }
  },
}));
const importLocalSkillMocks = vi.hoisted(() => ({
  inspectLocalSkill: vi.fn(),
  importLocalSkill: vi.fn(),
}));
const installServiceMocks = vi.hoisted(() => ({
  install: vi.fn(),
  cancelInstall: vi.fn(),
  uninstall: vi.fn(),
  retryUninstallCleanup: vi.fn(),
  listPendingUninstallCleanups: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/cindy-skillhub-test'),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({ isDestroyed: () => false })),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog,
    showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
}));

const getCurrentDataOwnerId = vi.fn((): string | null => 'local-v1');
vi.mock('../../authManager', () => ({ getCurrentDataOwnerId }));

const ownerState = { generation: 1, pending: false };
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => `cloud:owner:${ownerState.generation}`,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: ownerState.generation }),
  isAppSessionBoundaryPending: vi.fn(() => ownerState.pending),
}));

const ensureReady = vi.fn();
vi.mock('../../localDb', () => ({
  ensureReady,
}));

const defaultDbClient = { id: 'client' };
const getCurrentDbClientSnapshot = vi.fn(() => ({
  client: defaultDbClient,
  userId: 'local-v1',
  clientEpoch: 1,
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot }));

const readSkillRawFile = vi.fn();
const readSkillContent = vi.fn();
const listSkillFolderChildren = vi.fn();
const readSkillSiblingFile = vi.fn();
const renameLocalSkill = vi.fn();
const scanAllSkills = vi.fn();
const getManagedSkillRoots = vi.fn((): string[] => []);
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
  getScanStatus: vi.fn(),
  sync: vi.fn(),
  updatePublished: vi.fn(),
};

describe('registerSkillhubIpc usage handlers', () => {
  beforeEach(async () => {
    publishServiceOptions.onProgress = null;
    isTrustedAppRendererWindow.mockReset();
    ownerState.generation = 1;
    ownerState.pending = false;
    installServiceMocks.listPendingUninstallCleanups.mockReturnValue([]);
    isCindyLearnSkillEnabled.mockReturnValue(true);
    handlers.clear();
    vi.clearAllMocks();
    comparePublishedSkill.mockReset().mockResolvedValue({ status: 'same', version: '1.0.0', pending: false });
    renameLocalSkill.mockReset();
    getManagedSkillRoots.mockReturnValue([]);
    getCurrentDataOwnerId.mockReturnValue('local-v1');
    getCurrentDbClientSnapshot.mockReset();
    getCurrentDbClientSnapshot.mockReturnValue({
      client: defaultDbClient,
      userId: 'local-v1',
      clientEpoch: 1,
    });
    ensureReady.mockResolvedValue({ ready: true });
    requestLocalSkillUsageAnalyticsRefresh.mockReturnValue(null);
    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue({ response: 0 });
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
      getManagedSkillRoots,
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });
  });

  it.each(['unchanged', 'generation', 'revoked', 'failure', '429', '503', 'network', '404'] as const)(
    'binds publication comparison to the scanned local identity and original account: %s', async (transition) => {
      const sender = { id: 75, on: vi.fn(), once: vi.fn() };
      const source = fs.mkdtempSync(path.join(fixtureRoot, 'compare-'));
      const absolutePath = fs.realpathSync.native(source);
      getAllowedProjectRoots.mockResolvedValue([source]);
      const scannedSkill = {
        id: 'demo', kind: 'skill', name: 'local-name', registrySkillName: 'registered-slug',
        absolutePath, discoveredPath: source,
        scope: 'project', projectRoot: source,
      };
      scanAllSkills.mockResolvedValueOnce({ skills: [scannedSkill], sources: [] });
      await handlers.get('skillhub:scan')!({ sender }, { projects: [] });
      const params = { absolutePath, skillId: 'demo', includeDiff: true };
      await expect(handlers.get('skillhub:compare-published')!({ sender: { id: 76 } }, params))
        .rejects.toThrow('Refresh the Skill list');
      await expect(handlers.get('skillhub:compare-published')!({ sender }, { ...params, skillId: 'other' }))
        .rejects.toThrow('Refresh the Skill list');
      expect(comparePublishedSkill).not.toHaveBeenCalled();
      comparePublishedSkill.mockImplementationOnce(async () => {
        if (transition === 'generation') ownerState.generation++;
        if (transition === 'revoked') getAllowedProjectRoots.mockResolvedValueOnce([]);
        if (transition === 'failure') throw new Error('unreadable local directory');
        if (['429', '503', 'network', '404'].includes(transition)) {
          const { ServerApiError } = await import('../../serverApiClient');
          throw new ServerApiError('TEST_ERROR', transition === 'network' ? 0 : Number(transition), 'remote failure');
        }
        return { status: 'different', version: '1.0.0', pending: false, changes: [{ oldContent: 'private content' }] };
      });
      const response = await Promise.resolve(handlers.get('skillhub:compare-published')!({ sender }, params))
        .catch((error) => ({ error }));
      expect(assertTrustedAppRendererEvent).toHaveBeenCalledWith({ sender });
      expect(comparePublishedSkill).toHaveBeenCalledWith(scannedSkill, marketService, true);
      if (transition === 'unchanged') expect(response).toMatchObject({ status: 'different' });
      else {
        if (transition === 'generation' || transition === 'revoked') expect(response).toMatchObject({ error: expect.any(Error) });
        else expect(response).toEqual({ status: 'unavailable', ...(['429', '503', 'network'].includes(transition) ? { reason: 'service' } : {}) });
        expect(JSON.stringify(response)).not.toContain('private content');
      }
    },
  );

  it('delivers private publication feedback only to currently trusted app windows', async () => {
    const { BrowserWindow } = await import('electron');
    const { registerSkillhubIpc } = await import('../registerIpc');
    const trusted = { webContents: { send: vi.fn() } };
    const utility = { webContents: { send: vi.fn() } };
    const navigated = { webContents: { send: vi.fn() } };
    const destroyed = { webContents: { send: vi.fn() } };
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([trusted, utility, navigated, destroyed] as never);
    isTrustedAppRendererWindow.mockImplementation((win) => win === trusted);
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots, getAllowedProjectRoots, marketService: marketService as never,
    });
    const feedback = { phase: 'scan-result', name: 'review-helper', status: 'rejected', rejectionReason: 'Private feedback' };
    publishServiceOptions.onProgress!(feedback);
    expect(trusted.webContents.send).toHaveBeenCalledWith('skillhub:publish-progress', {
      ...feedback, ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
    });
    for (const win of [utility, navigated, destroyed]) {
      expect(isTrustedAppRendererWindow).toHaveBeenCalledWith(win);
      expect(win.webContents.send).not.toHaveBeenCalled();
    }

    // A window can navigate away between successive progress frames.
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([trusted] as never);
    isTrustedAppRendererWindow.mockReturnValue(false);
    publishServiceOptions.onProgress!(feedback);
    expect(trusted.webContents.send).toHaveBeenCalledTimes(1);

    ownerState.pending = true;
    isTrustedAppRendererWindow.mockReturnValue(true);
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValueOnce([trusted] as never);
    publishServiceOptions.onProgress!(feedback);
    expect(trusted.webContents.send).toHaveBeenCalledTimes(1);
    vi.mocked(BrowserWindow.getAllWindows).mockReset().mockReturnValue([]);
  });

  it('blocks publishing a Cindy built-in Skill at the Main boundary', async () => {
    const builtInRoot = path.join(fixtureRoot, 'system-skills', 'cindy-skill-creator');
    const builtInFile = path.join(builtInRoot, 'SKILL.md');
    fs.mkdirSync(builtInRoot, { recursive: true });
    fs.writeFileSync(builtInFile, '# Built in\n');
    // Built-in protection compares the Main-owned physical root directly; it
    // must not depend on generic discovery-root grant heuristics.
    isExistingSkillPathGranted.mockReturnValue(false);
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots,
      getBuiltInSkills: () => [{
        name: 'cindy-skill-creator',
        absolutePath: builtInRoot,
        nativeClaudePath: '/tmp/claude-home/skills/cindy-skill-creator',
      }],
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        id: 'builtin:cindy-skill-creator',
        kind: 'skill',
        name: 'cindy-skill-creator',
        absolutePath: builtInRoot,
        discoveredPath: builtInRoot,
        scope: 'global',
        builtIn: true,
      }],
      sources: [],
    });
    const event = { sender: { id: 12, on: vi.fn(), once: vi.fn() } };
    await handlers.get('skillhub:scan')!(event, { projects: [] });

    await expect(handlers.get('skillhub:publish')!(event, {
      absolutePath: builtInFile,
    })).resolves.toMatchObject({ success: false, message: expect.stringContaining('cannot be published') });
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledWith(event);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects publishing a path absent from the sender latest scan', async () => {
    const event = { sender: { id: 13, on: vi.fn(), once: vi.fn() } };

    await expect(handlers.get('skillhub:publish')!(event, {
      absolutePath: '/repo/.pi/skills/authorized/demo',
      name: 'demo',
      isFirstPublish: true,
    })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Refresh'),
    });
    expect(publish).not.toHaveBeenCalled();
  });

  describe.each([
    { channel: 'skillhub:get-scan-status', field: 'slug', method: 'getScanStatus' },
    { channel: 'skillhub:list-published-versions', field: 'name', method: 'listPublishedVersions' },
  ] as const)('$channel private review boundary', ({ channel, field, method }) => {
    it('rejects an untrusted sender before accessing the service', async () => {
      assertTrustedAppRendererEvent.mockImplementationOnce(() => { throw new Error('PERMISSION_DENIED'); });
      await expect(handlers.get(channel)!({}, { [field]: 'review-helper' })).rejects.toThrow('PERMISSION_DENIED');
      expect(marketService[method]).not.toHaveBeenCalled();
    });

    it.each([null, [], {}, { value: 3 }, { value: '' }, { value: 'a'.repeat(129) },
      { value: 'valid', version: 3 }, { value: 'valid', version: 'v'.repeat(129) },
      { value: 'valid', catalogScope: 'invalid' }, { value: 'bad\0name' },
    ])('rejects malformed parameters %j without a service request', async (input) => {
      const params = input && !Array.isArray(input) ? { ...input, [field]: input.value } : input;
      await expect(handlers.get(channel)!({}, params)).rejects.toThrow('INVALID_PARAMS');
      expect(marketService[method]).not.toHaveBeenCalled();
    });

    it.each([undefined, 'team', 'market'] as const)('preserves catalog selection %s for trusted reads', async (catalogScope) => {
      const result = { success: true, rejectionReason: 'Private feedback' };
      marketService[method].mockResolvedValueOnce(result);
      const event = { sender: { id: 11 } };
      expect(await handlers.get(channel)!(event, { [field]: 'review-helper', version: '1.0.1', catalogScope })).toEqual(result);
      expect(assertTrustedAppRendererEvent).toHaveBeenCalledWith(event);
      if (method === 'getScanStatus') {
        expect(marketService[method]).toHaveBeenCalledWith({ slug: 'review-helper', version: '1.0.1', ...(catalogScope ? { catalogScope } : {}) });
      } else {
        expect(marketService[method]).toHaveBeenCalledWith('review-helper', catalogScope);
      }
    });

    it.each(['generation', 'boundary'] as const)('drops a private response across an account %s change', async (transition) => {
      let resolve!: (value: unknown) => void;
      marketService[method].mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
      const request = handlers.get(channel)!({}, { [field]: 'review-helper' });
      if (transition === 'generation') ownerState.generation += 1;
      else ownerState.pending = true;
      resolve({ success: true, rejectionReason: 'Private feedback', versions: [{ rejectionReason: 'Private feedback' }] });
      const result = await request;
      expect(result).toMatchObject({ success: false });
      expect(JSON.stringify(result)).not.toContain('Private feedback');
    });

    it('preserves the empty-version shorthand for the latest release', async () => {
      marketService[method].mockResolvedValueOnce({ success: true });
      expect(await handlers.get(channel)!({}, { [field]: 'review-helper', version: '' })).toEqual({ success: true });
      if (method === 'getScanStatus') expect(marketService[method]).toHaveBeenCalledWith({ slug: 'review-helper' });
    });
  });

  it('binds SkillHub file access to the trusted renderer latest scan', async () => {
    const destroyedCallbacks: Array<() => void> = [];
    const sender = {
      id: 11,
      on: vi.fn(),
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
      if (channel === 'skillhub:rename-local') expect(delegated).toHaveBeenCalledWith(params, expect.any(Function));
      else expect(delegated).toHaveBeenCalledWith(params);
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

  it('returns the Learn activation preference even when discovery fails', async () => {
    const sender = { id: 91, on: vi.fn(), once: vi.fn() };
    isCindyLearnSkillEnabled.mockReturnValue(false);
    scanAllSkills.mockRejectedValueOnce(new Error('scan failed'));

    await expect(
      handlers.get('skillhub:scan')?.({ sender }, { projects: [] }),
    ).resolves.toEqual({
      success: false,
      error: 'scan failed',
      learnSkillEnabled: false,
    });
  });

  it('grants read-only access to a Main-attested built-in with no discovery alias', async () => {
    const builtInRoot = path.join(fixtureRoot, 'shared-system-skills', 'learn');
    const builtInFile = path.join(builtInRoot, 'SKILL.md');
    const builtInNotes = path.join(builtInRoot, 'notes.md');
    fs.mkdirSync(builtInRoot, { recursive: true });
    fs.writeFileSync(builtInFile, '# Learn\n');
    fs.writeFileSync(builtInNotes, 'notes\n');
    const attestedRoot = expectedAttestedRoot(builtInRoot);
    const sender = { id: 18, on: vi.fn(), once: vi.fn() };
    resolveExistingSkillPathForGrant.mockReturnValue(null);
    isExistingSkillPathGranted.mockReturnValue(false);
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        id: 'builtin:learn',
        kind: 'skill',
        name: 'learn',
        absolutePath: builtInRoot,
        discoveredPath: builtInRoot,
        discoveryPaths: [builtInRoot],
        scope: 'global',
        builtIn: true,
      }],
      sources: [],
    });
    readSkillContent.mockResolvedValue({ success: true, content: 'Learn' });
    listSkillFolderChildren.mockResolvedValue({ success: true, entries: [] });
    readSkillSiblingFile.mockResolvedValue({ success: true, content: 'notes' });
    readSkillRawFile.mockResolvedValue({ success: true, content: '# Learn\n' });
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots,
      getBuiltInSkills: () => [{
        name: 'learn',
        absolutePath: builtInRoot,
        nativeClaudePath: '/tmp/claude-home/skills/learn',
      }],
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });

    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });
    await expect(handlers.get('skillhub:read-skill')?.(
      { sender },
      { mdPath: builtInFile },
    )).resolves.toMatchObject({ success: true, content: 'Learn' });
    await handlers.get('skillhub:list-children')?.({ sender }, { dirPath: builtInRoot });
    await handlers.get('skillhub:read-sibling-file')?.(
      { sender },
      { filePath: builtInNotes },
    );
    await handlers.get('skillhub:read-raw')?.({ sender }, { filePath: builtInFile });
    expect(readSkillContent).toHaveBeenCalledWith({ mdPath: builtInFile, attestedRoot });
    expect(listSkillFolderChildren).toHaveBeenCalledWith({
      dirPath: builtInRoot,
      attestedRoot,
    });
    expect(readSkillSiblingFile).toHaveBeenCalledWith({
      filePath: builtInNotes,
      attestedRoot,
    });
    expect(readSkillRawFile).toHaveBeenCalledWith({
      filePath: builtInFile,
      attestedRoot,
    });

    await expect(handlers.get('skillhub:write-file')?.(
      { sender },
      { filePath: builtInFile, content: '# changed' },
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('read-only') });
    expect(writeSkillFile).not.toHaveBeenCalled();
  });

  it('preserves the built-in attestation when discovery used a shared alias', async () => {
    const builtInRoot = path.join(fixtureRoot, 'shared-system-skills', 'learn');
    const builtInFile = path.join(builtInRoot, 'SKILL.md');
    const sharedAlias = path.join(fixtureRoot, 'home', '.agents', 'skills', 'learn');
    fs.mkdirSync(builtInRoot, { recursive: true });
    fs.mkdirSync(path.dirname(sharedAlias), { recursive: true });
    fs.writeFileSync(builtInFile, '# Learn\n');
    fs.symlinkSync(builtInRoot, sharedAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const physicalBuiltInRoot = fs.realpathSync.native(builtInRoot);
    const attestedRoot = expectedAttestedRoot(builtInRoot);
    const sender = { id: 181, on: vi.fn(), once: vi.fn() };
    resolveExistingSkillPathForGrant.mockReturnValue(physicalBuiltInRoot);
    isExistingSkillPathGranted.mockReturnValue(true);
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        id: 'builtin:learn',
        kind: 'skill',
        name: 'learn',
        absolutePath: builtInRoot,
        discoveredPath: sharedAlias,
        discoveryPaths: [sharedAlias],
        scope: 'global',
        builtIn: true,
      }],
      sources: [],
    });
    readSkillRawFile.mockResolvedValue({ success: true, content: '# Learn\n' });
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots,
      getBuiltInSkills: () => [{
        name: 'learn',
        absolutePath: builtInRoot,
        nativeClaudePath: '/tmp/claude-home/skills/learn',
      }],
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });

    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });
    await handlers.get('skillhub:read-raw')?.({ sender }, { filePath: builtInFile });

    expect(readSkillRawFile).toHaveBeenCalledWith({ filePath: builtInFile, attestedRoot });
  });

  it('keeps a scanned built-in version immutable after the active bundle advances', async () => {
    const versionsRoot = path.join(fixtureRoot, 'shared-system-skills', '.versions');
    const previousRoot = path.join(versionsRoot, 'v7-previous', 'learn');
    const currentRoot = path.join(versionsRoot, 'v8-current', 'learn');
    const previousFile = path.join(previousRoot, 'SKILL.md');
    fs.mkdirSync(previousRoot, { recursive: true });
    fs.mkdirSync(currentRoot, { recursive: true });
    fs.writeFileSync(previousFile, '# Previous built-in\n');
    fs.writeFileSync(path.join(currentRoot, 'SKILL.md'), '# Current built-in\n');
    let activeRoot = previousRoot;
    const sender = { id: 19, on: vi.fn(), once: vi.fn() };
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        id: 'builtin:learn',
        kind: 'skill',
        name: 'learn',
        absolutePath: previousRoot,
        discoveredPath: previousRoot,
        discoveryPaths: [previousRoot],
        scope: 'global',
        builtIn: true,
      }],
      sources: [],
    });
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots,
      getBuiltInSkills: () => [{
        name: 'learn',
        absolutePath: activeRoot,
        nativeClaudePath: '/tmp/claude-home/skills/learn',
      }],
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });

    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });
    activeRoot = currentRoot;

    await expect(handlers.get('skillhub:write-file')?.(
      { sender },
      { filePath: previousFile, content: '# changed' },
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('read-only') });
    await expect(handlers.get('skillhub:rename-local')?.(
      { sender },
      { absolutePath: previousRoot, newName: 'renamed' },
    )).resolves.toMatchObject({ success: false, error: expect.stringContaining('read-only') });
    await expect(handlers.get('skillhub:publish')?.(
      { sender },
      { absolutePath: previousRoot },
    )).resolves.toMatchObject({ success: false, message: expect.stringContaining('cannot be published') });
    expect(writeSkillFile).not.toHaveBeenCalled();
    expect(renameLocalSkill).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'grant-wait', 'mutation-wait', 'boundary-pending'] as const)(
    'guards local rename at its original owner generation: %s', async (transition) => {
      resolveExistingSkillPathForGrant.mockImplementation((candidate: string) => {
        if (candidate.includes('/authorized/demo')) return '/physical/demo';
        if (candidate === '/physical/renamed') return '/physical/renamed';
        return null;
      });
      const sender = { id: 71, on: vi.fn(), once: vi.fn() };
      scanAllSkills.mockResolvedValueOnce({ skills: [{
        absolutePath: '/physical/demo', discoveredPath: '/repo/.pi/skills/authorized/demo',
        scope: 'project', projectRoot: '/repo',
      }], sources: [] });
      await handlers.get('skillhub:scan')!({ sender }, { projects: [] });
      const mutate = vi.fn();
      renameLocalSkill.mockImplementationOnce(async (_params, canMutate: () => boolean) => {
        if (transition === 'mutation-wait') ownerState.generation += 1;
        if (transition === 'boundary-pending') ownerState.pending = true;
        if (!canMutate()) return { success: false, error: 'Skill mutation context changed' };
        mutate();
        return { success: true, newAbsolutePath: '/physical/renamed' };
      });
      if (transition === 'grant-wait') getAllowedProjectRoots.mockImplementationOnce(async () => {
        ownerState.generation += 1;
        return ['/repo'];
      });
      const result = await handlers.get('skillhub:rename-local')!({ sender }, {
        absolutePath: '/repo/.pi/skills/authorized/demo', newName: 'renamed',
      });
      expect(result).toMatchObject({ success: transition === 'unchanged' });
      expect(mutate).toHaveBeenCalledTimes(transition === 'unchanged' ? 1 : 0);
      if (transition === 'grant-wait') {
        expect(renameLocalSkill).not.toHaveBeenCalled();
      }
    },
  );

  it('carries a scanned user Skill grant across rename into immediate publish', async () => {
    resolveExistingSkillPathForGrant.mockImplementation((candidate: string) => {
      if (candidate.includes('/authorized/demo')) return '/physical/demo';
      if (candidate === '/physical/renamed') return '/physical/renamed';
      return null;
    });
    isExistingSkillPathGranted.mockImplementation((candidate: string, roots: Set<string>) => (
      (candidate.includes('/authorized/demo') && roots.has('/physical/demo'))
      || (candidate === '/physical/renamed' && roots.has('/physical/renamed'))
    ));
    scanAllSkills.mockResolvedValueOnce({ skills: [{
      absolutePath: '/physical/demo',
      discoveredPath: '/repo/.pi/skills/authorized/demo',
      scope: 'project',
      projectRoot: '/repo',
    }], sources: [] });
    renameLocalSkill.mockResolvedValueOnce({
      success: true,
      newAbsolutePath: '/physical/renamed',
    });
    publish.mockResolvedValueOnce({ success: true });
    const sender = { id: 72, on: vi.fn(), once: vi.fn() };

    await handlers.get('skillhub:scan')!({ sender }, { projects: [] });
    await expect(handlers.get('skillhub:rename-local')!({ sender }, {
      absolutePath: '/repo/.pi/skills/authorized/demo',
      newName: 'renamed',
    })).resolves.toEqual({ success: true, newAbsolutePath: '/physical/renamed' });
    const publishParams = {
      absolutePath: '/physical/renamed',
      name: 'renamed',
      isFirstPublish: true,
    };

    await expect(handlers.get('skillhub:publish')!({ sender }, publishParams))
      .resolves.toEqual({ success: true });
    expect(publish).toHaveBeenCalledWith(publishParams);
  });

  it('revokes project scan grants after the last active project session disappears', async () => {
    const sender = { id: 12, on: vi.fn(), once: vi.fn() };
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
    const sender = { id: 33, on: vi.fn(), once: vi.fn() };
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
    const sender = { id: 34, on: vi.fn(), once: vi.fn() };
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
    const sender = { id: 44, on: vi.fn(), once: vi.fn() };

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
    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue({ response: 0 });
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
    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue({ response: 0 });
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

    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue({ response: 0 });
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
    const firstClient = { id: 'first-client' };
    const readyClient = { id: 'ready-client' };
    const firstSnapshot = { client: firstClient, userId: 'local-v1', clientEpoch: 1 };
    const readySnapshot = { client: readyClient, userId: 'local-v1', clientEpoch: 2 };
    getCurrentDbClientSnapshot
      .mockReturnValueOnce(firstSnapshot)
      .mockReturnValue(readySnapshot);
    getLocalSkillUsageSummary
      .mockRejectedValueOnce(new Error('localDb not ready: pending'))
      .mockResolvedValueOnce({ success: true, summary: { totalUseCount: 1 }, refreshing: false });

    const handler = handlers.get('skillhub:get-usage-summary');
    expect(handler).toBeTypeOf('function');
    const result = await handler?.({}, { name: 'word-doc' });

    expect(ensureReady).toHaveBeenCalledWith('local-v1');
    expect(getCurrentDbClientSnapshot).toHaveBeenCalledTimes(3);
    expect(getLocalSkillUsageSummary).toHaveBeenCalledTimes(2);
    expect(getLocalSkillUsageSummary).toHaveBeenNthCalledWith(1, {
      skillName: 'word-doc',
      currentSkillContent: null,
      client: firstClient,
    });
    expect(getLocalSkillUsageSummary).toHaveBeenNthCalledWith(2, {
      skillName: 'word-doc',
      currentSkillContent: null,
      client: readyClient,
    });
    expect(result).toEqual({ success: true, summary: { totalUseCount: 1 }, refreshing: false });
  });

  it('returns a structured failure when usage summary still fails', async () => {
    getLocalSkillUsageSummary.mockRejectedValueOnce(new Error('bad transcript'));

    const handler = handlers.get('skillhub:get-usage-summary');
    const result = await handler?.({}, { name: 'word-doc' });

    expect(result).toEqual({ success: false, error: 'bad transcript' });
  });

  it('does not return a usage summary from the previous database owner', async () => {
    const previousClient = { id: 'previous-client' };
    const currentClient = { id: 'current-client' };
    const previousSnapshot = { client: previousClient, userId: 'owner-a', clientEpoch: 1 };
    const currentSnapshot = { client: currentClient, userId: 'owner-b', clientEpoch: 2 };
    getCurrentDbClientSnapshot
      .mockReturnValueOnce(previousSnapshot)
      .mockReturnValue(currentSnapshot);
    getLocalSkillUsageSummary
      .mockResolvedValueOnce({ success: true, summary: { totalUseCount: 99 }, refreshing: false })
      .mockResolvedValueOnce({ success: true, summary: { totalUseCount: 1 }, refreshing: false });
    getCurrentDataOwnerId.mockReturnValue('owner-b');

    const handler = handlers.get('skillhub:get-usage-summary');
    const result = await handler?.({}, { name: 'word-doc' });

    expect(ensureReady).toHaveBeenCalledWith('owner-b');
    expect(getLocalSkillUsageSummary).toHaveBeenNthCalledWith(1, {
      skillName: 'word-doc',
      currentSkillContent: null,
      client: previousClient,
    });
    expect(getLocalSkillUsageSummary).toHaveBeenNthCalledWith(2, {
      skillName: 'word-doc',
      currentSkillContent: null,
      client: currentClient,
    });
    expect(result).toEqual({ success: true, summary: { totalUseCount: 1 }, refreshing: false });
  });

  it('passes readable SKILL.md content and path into diagnosis context', async () => {
    const sender = { id: 31, on: vi.fn(), once: vi.fn() };
    const mdPath = '/repo/.pi/skills/authorized/demo/SKILL.md';
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        absolutePath: '/physical/demo',
        discoveredPath: '/repo/.pi/skills/authorized/demo',
        scope: 'project',
        projectRoot: '/repo',
      }],
      sources: [],
    });
    readSkillRawFile.mockResolvedValueOnce({ success: true, content: 'skill body' });
    getLocalSkillUsageDiagnosisContext.mockResolvedValueOnce({
      success: true,
      context: { prompt: 'diagnose' },
    });
    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });

    const handler = handlers.get('skillhub:get-usage-diagnosis-context');
    const result = await handler?.({ sender }, { name: 'word-doc', mdPath });

    expect(readSkillRawFile).toHaveBeenCalledWith({ filePath: mdPath });
    expect(getLocalSkillUsageDiagnosisContext).toHaveBeenCalledWith({
      skillName: 'word-doc',
      currentSkillContent: 'skill body',
      skillPath: mdPath,
      client: defaultDbClient,
    });
    expect(result).toEqual({ success: true, context: { prompt: 'diagnose' } });
  });

  it('reads built-in Skill usage through the attested scan root', async () => {
    const builtInRoot = path.join(fixtureRoot, 'system-skills', 'cindy-skill-creator');
    const mdPath = path.join(builtInRoot, 'SKILL.md');
    fs.mkdirSync(builtInRoot, { recursive: true });
    fs.writeFileSync(mdPath, '# Built in\n');
    const { registerSkillhubIpc } = await import('../registerIpc');
    registerSkillhubIpc({
      getMaker: () => ({ listAgentSkills }) as never,
      getManagedSkillRoots,
      getBuiltInSkills: () => [{
        name: 'cindy-skill-creator',
        absolutePath: builtInRoot,
        nativeClaudePath: '/tmp/claude-home/skills/cindy-skill-creator',
      }],
      getAllowedProjectRoots,
      marketService: marketService as never,
      publishService: { publish, cancel } as never,
    });
    scanAllSkills.mockResolvedValueOnce({
      skills: [{
        id: 'builtin:cindy-skill-creator',
        name: 'cindy-skill-creator',
        absolutePath: builtInRoot,
        discoveredPath: builtInRoot,
        scope: 'user',
        kind: 'skill',
        builtIn: true,
      }],
      sources: [],
    });
    readSkillRawFile.mockResolvedValueOnce({ success: true, content: 'built-in body' });
    getLocalSkillUsageSummary.mockResolvedValueOnce({
      success: true,
      summary: { totalUseCount: 1 },
      refreshing: false,
    });
    const sender = { id: 32, on: vi.fn(), once: vi.fn() };
    await handlers.get('skillhub:scan')?.({ sender }, { projects: [] });

    const result = await handlers.get('skillhub:get-usage-summary')?.(
      { sender },
      { name: 'cindy-skill-creator', mdPath },
    );

    expect(readSkillRawFile).toHaveBeenCalledWith({
      filePath: mdPath,
      attestedRoot: expectedAttestedRoot(builtInRoot),
    });
    expect(getLocalSkillUsageSummary).toHaveBeenCalledWith({
      skillName: 'cindy-skill-creator',
      currentSkillContent: 'built-in body',
      client: defaultDbClient,
    });
    expect(result).toMatchObject({ success: true });
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

  async function scanLocalFixture() {
    const project = fs.mkdtempSync(path.join(fixtureRoot, 'project-'));
    const source = path.join(project, '.agents', 'skills', 'local');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'local skill');
    const absolutePath = fs.realpathSync.native(source);
    getAllowedProjectRoots.mockResolvedValue([project]);
    scanAllSkills.mockResolvedValue({ skills: [{
      kind: 'skill', scope: 'project', name: 'local', absolutePath,
      discoveredPath: source, projectRoot: project,
    }], sources: [] });
    const event = { sender: { id: 71, on: vi.fn(), once: vi.fn() } };
    await handlers.get('skillhub:scan')!(event, { projects: [{ projectRoot: project, hash: 'fixture' }] });
    return { event, absolutePath, project };
  }

  async function scanSharedAliases(physicalProjectSkill: boolean) {
    const root = fs.mkdtempSync(path.join(fixtureRoot, 'shared-aliases-'));
    const projects = [path.join(root, 'project-a'), path.join(root, 'project-b')];
    const source = physicalProjectSkill
      ? path.join(projects[0]!, '.agents', 'skills', 'foo') : path.join(root, 'external', 'foo');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
    const absolutePath = fs.realpathSync.native(source);
    const aliases = [path.join(root, 'home', '.agents', 'skills', 'global-alias'),
      ...projects.map((project) => path.join(project, '.agents', 'skills', 'project-alias'))];
    for (const alias of aliases) {
      fs.mkdirSync(path.dirname(alias), { recursive: true });
      fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const records = aliases.map((alias, index) => ({
      id: `entry-${index}`, kind: 'skill', name: 'foo', absolutePath,
      scope: index === 0 ? 'global' : 'project',
      discoveredPath: alias, discoveryPaths: [alias],
      ...(index > 0 ? { projectRoot: projects[index - 1] } : {}),
    }));
    if (physicalProjectSkill) records[1]!.discoveryPaths.push(source);
    getAllowedProjectRoots.mockResolvedValue(projects);
    scanAllSkills.mockResolvedValue({ skills: records, sources: [] });
    const event = { sender: { id: 71, on: vi.fn(), once: vi.fn() } };
    await handlers.get('skillhub:scan')!(event, { projects: projects.map((projectRoot, index) => ({ projectRoot, hash: `p${index}` })) });
    return { absolutePath, aliases, records, projects, event };
  }

  it('uses the selected scan ID for external aliases and retains the selected project boundary', async () => {
    const { absolutePath, aliases, projects, event } = await scanSharedAliases(false);
    installServiceMocks.uninstall.mockResolvedValueOnce({ success: true });
    await handlers.get('skillhub:uninstall')!(event, { absolutePath, skillId: 'entry-2' });
    expect(installServiceMocks.uninstall).toHaveBeenCalledWith(absolutePath,
      expect.objectContaining({ operationPath: aliases[2], aliases: [aliases[2]], linkOnly: true }), expect.any(Function));
    await expect(handlers.get('skillhub:uninstall')!(event, { absolutePath, skillId: 'unknown' }))
      .rejects.toThrow('PRECONDITION_FAILED');
    getAllowedProjectRoots.mockResolvedValue([projects[0]]);
    await expect(handlers.get('skillhub:uninstall')!(event, { absolutePath, skillId: 'entry-2' }))
      .rejects.toThrow('PERMISSION_DENIED');
    await expect(handlers.get('skillhub:set-enabled')!(event, { absolutePath, skillId: 'entry-2', enabled: false }))
      .rejects.toThrow('PERMISSION_DENIED');
  });

  it('persists discovered aliases across scopes when disabling a physical Skill', async () => {
    const { absolutePath, aliases, event } = await scanSharedAliases(false);
    await handlers.get('skillhub:set-enabled')!(event, { absolutePath, skillId: 'entry-2', enabled: false });
    expect(setCindySkillEnabled).toHaveBeenCalledWith(absolutePath, false, expect.any(Function), aliases);
  });

  it('captures differently named discovery links across scopes for physical Skill removal', async () => {
    const { absolutePath, aliases, event } = await scanSharedAliases(true);
    installServiceMocks.uninstall.mockResolvedValueOnce({ success: true });
    await handlers.get('skillhub:uninstall')!(event, { absolutePath, skillId: 'entry-1' });
    expect(installServiceMocks.uninstall).toHaveBeenCalledWith(absolutePath,
      expect.objectContaining({ operationPath: absolutePath, aliases: expect.arrayContaining(aliases), linkOnly: false }), expect.any(Function));
  });

  it('requires native confirmation for direct uninstall and never mutates on cancellation', async () => {
    const { event, absolutePath } = await scanLocalFixture();
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await handlers.get('skillhub:uninstall')!(event, { absolutePath }))
      .toEqual({ success: false, errorCode: 'CANCELLED', message: '' });
    expect(installServiceMocks.uninstall).not.toHaveBeenCalled();
    expect(showMessageBox).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      defaultId: 1, cancelId: 1, detail: expect.stringContaining(absolutePath),
    }));
  });

  it.each(['owner', 'reload', 'source', 'project'])('revokes confirmation when %s changes while native dialog is open', async (change) => {
    const { event, absolutePath } = await scanLocalFixture();
    let approve!: (value: { response: number }) => void;
    showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));
    const pending = handlers.get('skillhub:uninstall')!(event, { absolutePath });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
    expect(installServiceMocks.uninstall).not.toHaveBeenCalled();
    if (change === 'owner') getCurrentDataOwnerId.mockReturnValue('another-owner');
    if (change === 'project') getAllowedProjectRoots.mockResolvedValue([]);
    if (change === 'reload') event.sender.on.mock.calls.find(([name]) => name === 'did-start-navigation')![1]({}, '', false, true);
    if (change === 'source') {
      fs.renameSync(absolutePath, `${absolutePath}-old`);
      fs.mkdirSync(absolutePath);
      fs.writeFileSync(path.join(absolutePath, 'SKILL.md'), 'replacement');
    }
    approve({ response: 0 });
    await rejected;
    expect(installServiceMocks.uninstall).not.toHaveBeenCalled();
  });

  it('does not queue repeated native uninstall dialogs from one renderer', async () => {
    const { event, absolutePath } = await scanLocalFixture();
    let cancel!: (value: { response: number }) => void;
    showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { cancel = resolve; }));
    const pending = handlers.get('skillhub:uninstall')!(event, { absolutePath });
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
    await expect(handlers.get('skillhub:uninstall')!(event, { absolutePath })).rejects.toThrow('PRECONDITION_FAILED');
    expect(showMessageBox).toHaveBeenCalledOnce();
    cancel({ response: 1 });
    await pending;
  });

  it('refreshes the Codex cwd cache after uninstalling a granted project skill', async () => {
    const { event, absolutePath, project } = await scanLocalFixture();
    installServiceMocks.uninstall.mockResolvedValueOnce({ success: true, projectWorkingDir: project });
    listAgentSkills.mockResolvedValueOnce({ skills: [] });
    expect(await handlers.get('skillhub:uninstall')!(event, { absolutePath })).toEqual({ success: true });
    expect(listAgentSkills).toHaveBeenCalledWith('codex', { workingDir: project, forceReload: true });
    expect(installServiceMocks.uninstall).toHaveBeenCalledWith(absolutePath,
      expect.objectContaining({ sourcePath: absolutePath, linkOnly: false }), expect.any(Function));
  });

  it('allows toggling an unregistered local Skill and rejects another renderer', async () => {
    const { event, absolutePath } = await scanLocalFixture();
    const handler = handlers.get('skillhub:set-enabled')!;
    expect(await handler(event, { absolutePath, enabled: false })).toEqual({ cindyEnabled: false });
    expect(setCindySkillEnabled).toHaveBeenCalledWith(absolutePath, false, expect.any(Function), expect.any(Array));
    await expect(handler({ sender: { id: 72 } }, { absolutePath, enabled: false }))
      .rejects.toThrow('PRECONDITION_FAILED');
    expect(setCindySkillEnabled).toHaveBeenCalledTimes(1);
  });

  it.each(['destroyed', 'reload'] as const)('revokes window cleanup grants and reissues them after a fresh scan (%s)', async (lifecycle) => {
    const { event, absolutePath } = await scanLocalFixture();
    installServiceMocks.uninstall.mockResolvedValueOnce({ success: true, cleanupToken: 'receipt' });
    await handlers.get('skillhub:uninstall')!(event, { absolutePath });
    if (lifecycle === 'destroyed') {
      event.sender.once.mock.calls.find(([name]) => name === 'destroyed')![1]();
    } else {
      event.sender.on.mock.calls.find(([name]) => name === 'did-start-navigation')![1]({}, '', false, true);
    }
    await expect(handlers.get('skillhub:retry-uninstall-cleanup')!(event, 'receipt')).rejects.toThrow('PRECONDITION_FAILED');
    expect(installServiceMocks.retryUninstallCleanup).not.toHaveBeenCalled();
    installServiceMocks.listPendingUninstallCleanups.mockReturnValue([{ token: 'receipt', name: 'example' }]);
    installServiceMocks.retryUninstallCleanup.mockResolvedValueOnce(true);
    expect(await handlers.get('skillhub:scan')!(event, {})).toMatchObject({
      success: true, pendingCleanups: [{ token: 'receipt', name: 'example' }],
    });
    expect(await handlers.get('skillhub:retry-uninstall-cleanup')!(event, 'receipt')).toEqual({ complete: true });
  });

  it('issues independent recovery grants to two scanned windows and rejects account changes', async () => {
    const { event } = await scanLocalFixture();
    const second = { sender: { id: event.sender.id + 1, once: vi.fn(), on: vi.fn() } };
    installServiceMocks.listPendingUninstallCleanups.mockReturnValue([{ token: 'receipt', name: 'example' }]);
    installServiceMocks.retryUninstallCleanup.mockImplementation(async (_token, canMutate) => canMutate());
    await handlers.get('skillhub:scan')!(event, {});
    await handlers.get('skillhub:scan')!(second, {});
    expect(await handlers.get('skillhub:retry-uninstall-cleanup')!(event, 'receipt')).toEqual({ complete: true });
    expect(await handlers.get('skillhub:retry-uninstall-cleanup')!(second, 'receipt')).toEqual({ complete: true });
    await handlers.get('skillhub:scan')!(event, {});
    getCurrentDataOwnerId.mockReturnValue('other-owner');
    await expect(handlers.get('skillhub:retry-uninstall-cleanup')!(event, 'receipt')).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('withholds a late cleanup receipt when its window reloads during uninstall', async () => {
    const { event, absolutePath } = await scanLocalFixture();
    installServiceMocks.uninstall.mockImplementationOnce(async () => {
      event.sender.on.mock.calls.find(([name]) => name === 'did-start-navigation')![1]({}, '', false, true);
      return { success: true, cleanupToken: 'late-receipt' };
    });
    expect(await handlers.get('skillhub:uninstall')!(event, { absolutePath })).toEqual({ success: true });
    await expect(handlers.get('skillhub:retry-uninstall-cleanup')!(event, 'late-receipt')).rejects.toThrow('PRECONDITION_FAILED');
  });

  it('rejects direct uninstall of a plugin snapshot even when the scanned UI claims it is removable', async () => {
    const stateRoot = fs.mkdtempSync(path.join(fixtureRoot, 'plugin-state-'));
    const source = path.join(stateRoot, 'skill-snapshots', 'plugin', 'revision', 'skill');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'plugin skill');
    const alias = path.join(fixtureRoot, '.agents', 'skills', 'plugin--skill');
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    getManagedSkillRoots.mockReturnValue([stateRoot]);
    scanAllSkills.mockResolvedValue({ skills: [{
      kind: 'skill', scope: 'global', name: 'plugin--skill', canUninstall: true,
      absolutePath: source, discoveredPath: alias, discoveryPaths: [alias],
    }], sources: [] });
    const event = { sender: { id: 73, on: vi.fn(), once: vi.fn() } };
    await handlers.get('skillhub:scan')!(event, {});
    await expect(handlers.get('skillhub:uninstall')!(event, { absolutePath: source }))
      .rejects.toThrow('PRECONDITION_FAILED');
    expect(installServiceMocks.uninstall).not.toHaveBeenCalled();
    await expect(handlers.get('skillhub:set-enabled')!(event, { absolutePath: source, enabled: false }))
      .rejects.toThrow('PRECONDITION_FAILED');
    expect(setCindySkillEnabled).not.toHaveBeenCalled();
    expect(fs.existsSync(alias)).toBe(true);
    getManagedSkillRoots.mockReturnValue([]);
  });

  it('rejects owner changes and replaced sources before mutation', async () => {
    const { event, absolutePath } = await scanLocalFixture();
    const uninstall = handlers.get('skillhub:uninstall')!;
    getCurrentDataOwnerId.mockReturnValue('other-owner');
    await expect(uninstall(event, { absolutePath })).rejects.toThrow('PRECONDITION_FAILED');
    getCurrentDataOwnerId.mockReturnValue('local-v1');
    fs.renameSync(absolutePath, `${absolutePath}-old`);
    fs.mkdirSync(absolutePath);
    fs.writeFileSync(path.join(absolutePath, 'SKILL.md'), 'replacement');
    await expect(uninstall(event, { absolutePath })).rejects.toThrow('PRECONDITION_FAILED');
    expect(installServiceMocks.uninstall).not.toHaveBeenCalled();
  });
});
