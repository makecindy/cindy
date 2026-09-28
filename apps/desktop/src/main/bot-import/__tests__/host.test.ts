import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Routine, RoutineInput } from '@cindy/maker-scheduler';
import { companionEnvironmentKey, createCompanionEnvironmentStore } from '../environment.js';
import { fingerprint } from '../files.js';
import { createBotProfile, getBotRemoteResourceSource } from '../../localDb/ipc/bots.js';
import type { ImportSnapshot } from '../types.js';
import { CompanionImportError } from '../types.js';
import { previewImportRedactions } from '../environmentSelection.js';
import { redactEnvironmentValues } from '../process.js';

const h = vi.hoisted(() => ({ root: '', botId: '', created: false, verified: false, sourceEnabled: true, failReadyWrite: false, boundary: false,
  snapshot: null as unknown as ImportSnapshot, store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>,
  routines: [] as Routine[], pause: vi.fn(), lifecycle: vi.fn(), sourceEnvironment: {} as Record<string, string>,
  writeProfile: vi.fn(), importDocument: vi.fn(), readName: vi.fn(), secretValues: new Map<string, string>(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.root } }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => h.root, ownerScopedUserDataPath: () => h.root, getActiveAppSession: () => ({ dataOwnerId: 'fixture-owner' }), isAppSessionBoundaryPending: () => h.boundary }));
vi.mock('../../localDb/ipc/bots.js', () => ({
  listBotRemoteResourceSources: async () => [],
  getBotRemoteResourceSource: vi.fn(),
  createBotProfile: vi.fn(), createBotCanonicalSession: async () => ({ canonicalSessionId: 'chat' }),
  getBotMemoryService: () => ({ importDocument: h.importDocument }), reconcileBotProfileFolder: async () => {},
}));
vi.mock('../../localDb/ipc/botAvatarSelection.js', () => ({ validateBotAvatarBuffer: vi.fn(), decodeBotAvatarImage: vi.fn() }));
vi.mock('../../maker-ipc/botProfileFolder.js', () => ({ BOT_PROFILE_TEXT_MAX_BYTES: 100000, readBotProfileFolder: async () => ({ config: {} }), writeBotProfileFolder: h.writeProfile,
  ensureBotWorkspaceDir: async () => { const directory = path.join(h.root, 'bots', h.botId, 'workspace'); await fs.mkdir(directory, { recursive: true }); return directory; },
}));
vi.mock('@cindy/mcps', () => ({ resolveLiziMcpSessionContext: () => ({ sessionId: 'chat' }) }));
vi.mock('../sources.js', () => ({ createImportSourceReader: vi.fn(() => ({ readName: h.readName })), discoverImportSources: vi.fn(async () => [h.snapshot.source]), inspectImportSource: vi.fn(async () => h.snapshot) }));
vi.mock('../openclawCron.js', () => ({ readOpenClawCronDatabase: vi.fn() }));
vi.mock('../verification.js', () => ({ verifyImportedAutomation: vi.fn(async () => ({ verified: h.verified, reason: 'AUTOMATION_DATA_READ_FAILED' })) }));
vi.mock('../takeover.js', () => ({ changeSourceAutomationState: async (_source: unknown, _item: unknown, enabled: boolean, _readers: unknown, _owner: unknown, _resume: boolean, env: Record<string, string>) => { h.pause(enabled); h.sourceEnabled = enabled; h.sourceEnvironment = env; } }));
vi.mock('../runtime.js', () => ({ recoverCompanionEnvironmentRemovals: vi.fn(async () => {}),
  readCompanionSessionEnvironment: async () => ({ identity: h.root, botId: h.botId, userData: h.root, assertOwner() {}, environment: await h.store.read(h.root, h.botId, () => {}) }),
  companionEnvironmentStore: {
  read: (...args: Parameters<typeof h.store.read>) => h.store.read(...args),
  write: (...args: Parameters<typeof h.store.write>) => h.store.write(...args),
  update: (...args: Parameters<typeof h.store.update>) => h.store.update(...args),
  stageRemoval: (...args: Parameters<typeof h.store.stageRemoval>) => h.store.stageRemoval(...args),
  finishRemoval: (...args: Parameters<typeof h.store.finishRemoval>) => h.store.finishRemoval(...args),
} }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: vi.fn() }));
vi.mock('../../routines/service.js', () => ({
  updateBotRoutineLifecycle: h.lifecycle,
  routineTools: {
    list: async () => structuredClone(h.routines),
    createOnce: async (botId: string, input: RoutineInput, id: string) => {
      // The real engine publishes creationId as the stable routine ID.
      expect((await h.store.read(h.root, botId, () => {}))?.automations?.[id]?.handover).toBe(h.sourceEnabled ? 'pending' : 'ready');
      const routine = { ...input, botId, id, revision: 1, createdAt: 1, updatedAt: 1 };
      h.routines.push(routine); return routine;
    },
  },
  getRoutineEngine: async () => ({ put: async (_botId: string, input: RoutineInput, id: string) => {
    expect(h.sourceEnabled).toBe(false);
    h.routines = h.routines.map(row => row.id === id ? { ...row, ...input, revision: row.revision + 1 } : row);
  } }),
}));
import { listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult, recoverCompanionImports, prepareCompanionImportDeletion, cancelCompanionImportsForDeletion, ensureImportedAutomationReady } from '../host.js';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock.js';
import { assertImportedAutomationReady, prepareImportedAutomation } from '../automationRuntime.js';
import { decodeBotAvatarImage } from '../../localDb/ipc/botAvatarSelection.js';
import { createCompanionConnectionsProvider } from '../connectionProvider.js';
import { createImportSourceReader, discoverImportSources, inspectImportSource } from '../sources.js';
import { verifyImportedAutomation } from '../verification.js';

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-host-test-'));
  h.created = false; h.verified = false; h.sourceEnabled = true; h.failReadyWrite = false; h.boundary = false; h.routines = []; h.pause.mockReset(); h.sourceEnvironment = {};
  h.lifecycle.mockReset().mockImplementation(async (_botId: string, action: string) => {
    if (action === 'delete') h.routines = [];
  });
  vi.mocked(verifyImportedAutomation).mockClear();
  vi.mocked(getBotRemoteResourceSource).mockReset().mockImplementation(async () => { if (!h.created) throw new Error('[NOT_FOUND]'); return { canonicalSessionId: 'chat' } as never; });
  vi.mocked(createBotProfile).mockReset().mockImplementation(async input => { h.created = true; h.botId = (input as { id: string }).id; return {} as never; });
  h.writeProfile.mockReset().mockResolvedValue(undefined); h.importDocument.mockReset().mockResolvedValue(undefined);
  vi.mocked(decodeBotAvatarImage).mockReset();
  vi.mocked(discoverImportSources).mockReset().mockImplementation(async () => [h.snapshot.source]);
  vi.mocked(inspectImportSource).mockReset().mockImplementation(async () => h.snapshot);
  vi.mocked(createImportSourceReader).mockReset().mockImplementation(() => ({ readName: h.readName }) as never);
  h.readName.mockReset().mockImplementation(async source => redactEnvironmentValues(source.name, previewImportRedactions(h.snapshot.items)));
  const values = h.secretValues; values.clear();
  h.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: (key, value) => {
    if (h.failReadyWrite && Object.values<{ handover?: string }>(JSON.parse(value).automations ?? {}).some(binding => binding.handover === 'ready')) { h.failReadyWrite = false; return false; }
    values.set(key, value); return true;
  }, remove: key => { values.delete(key); return true; } });
  h.snapshot = { source: { kind: 'hermes', agentId: 'default', name: 'Ada', root: h.root, workspace: h.root, configFile: path.join(h.root, 'config.yaml') }, fingerprint: 'fixture', items: [{
    view: { id: 'task', category: 'automations', name: 'Report', enabled: true, selected: true },
    automation: { sourceId: 'task', fingerprint: 'fixture', original: { enabled: true }, input: { name: 'Report', prompt: 'Read data', enabled: false, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] } },
  }] };
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(h.root, { recursive: true, force: true }); });

it('rejects a simultaneous normalized-name conflict, removes only the loser checkpoint, and accepts a renamed request', async () => {
  h.snapshot.items = [{ view: { id: 'env', name: 'Key', category: 'connections', selected: true }, env: { API_KEY: 'fixture-private-key' } }];
  const profiles = new Map<string, string>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(getBotRemoteResourceSource).mockImplementation(async id => {
    if (!profiles.has(id)) throw new Error('[NOT_FOUND]');
    return { canonicalSessionId: 'chat' } as never;
  });
  vi.mocked(createBotProfile).mockImplementation(async input => {
    await gate;
    const profile = input as { name: string; id: string };
    const name = profile.name.normalize('NFKC').trim().toLowerCase();
    if ([...profiles.values()].includes(name)) throw new Error('[ALREADY_EXISTS] 同名伙伴');
    profiles.set(profile.id, name);
    return {} as never;
  });
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selections = ['Ada', 'Ａｄａ'].map((name, index) => ({ requestId: `name-race-request-${index}`, previewId: preview.id, name, entryIds: ['env'], takeover: false }));
  let settled = false;
  const pending = Promise.allSettled(selections.map(selection => startCompanionImport(selection, 'fixture'))).then(results => { settled = true; return results; });
  await vi.waitFor(() => expect(createBotProfile).toHaveBeenCalledTimes(2));
  // A durable checkpoint is not yet a created companion; do not acknowledge it.
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  release();
  const results = await pending;
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const rejectedIndex = results.findIndex(result => result.status === 'rejected');
  const rejected = selections[rejectedIndex]!;
  const botId = `import_${fingerprint(rejected.requestId).slice(0, 24)}`;
  expect((results[rejectedIndex] as PromiseRejectedResult).reason.message).toContain('IMPORT_NAME_EXISTS');
  expect(h.secretValues.has(companionEnvironmentKey(botId))).toBe(false);
  expect(await h.store.read(h.root, botId, () => {})).toBeUndefined();
  const winner = selections[1 - rejectedIndex]!;
  await vi.waitFor(async () => expect((await getCompanionImportResult(winner.requestId))?.status).toBe('complete'));
  expect(h.secretValues.size).toBe(1);
  const receiptText = await fs.readFile(path.join(h.root, 'companion-imports', `${rejected.requestId}.json`), 'utf8');
  expect(receiptText).not.toContain('fixture-private-key');
  expect(JSON.parse(receiptText).creationRejected).toBe('IMPORT_NAME_EXISTS');
  await expect(getCompanionImportResult(rejected.requestId)).rejects.toThrow('IMPORT_NAME_EXISTS');
  await expect(startCompanionImport({ ...rejected, previewId: 'expired-preview' }, 'other-controller')).rejects.toThrow('IMPORT_NAME_EXISTS');
  await startCompanionImport({ ...rejected, name: 'Grace', requestId: 'name-race-renamed-request' }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult('name-race-renamed-request'))?.status).toBe('complete'));
  expect(profiles.size).toBe(2);
  expect(h.secretValues.size).toBe(2);
  expect(h.pause).not.toHaveBeenCalled();
});

it('recovers rejected creation cleanup after a storage failure without retrying the impossible create', async () => {
  vi.mocked(createBotProfile).mockRejectedValue(new Error('[ALREADY_EXISTS] 同名伙伴'));
  const finish = vi.spyOn(h.store, 'finishRemoval').mockRejectedValueOnce(new CompanionImportError('CREDENTIAL_STORAGE_FAILED'));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'name-rejection-recovery', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await expect(startCompanionImport(selection, 'fixture')).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  expect(h.secretValues.size).toBe(1);
  await recoverCompanionImports();
  expect(h.secretValues.size).toBe(0);
  expect(finish).toHaveBeenCalledTimes(2);
  expect(createBotProfile).toHaveBeenCalledOnce();
  await expect(getCompanionImportResult(selection.requestId)).rejects.toThrow('IMPORT_NAME_EXISTS');
  expect(h.pause).not.toHaveBeenCalled();
  expect(verifyImportedAutomation).not.toHaveBeenCalled();
});

it('retains a committed profile and credentials when a create conflict acknowledgement is misleading', async () => {
  vi.mocked(createBotProfile).mockImplementation(async input => {
    h.created = true; h.botId = (input as { id: string }).id;
    throw new Error('[ALREADY_EXISTS] lost original create acknowledgement');
  });
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'name-committed-acknowledgement', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: false };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.created).toBe(true);
  expect(h.secretValues.size).toBe(1);
  expect(await h.store.read(h.root, h.botId, () => {})).toBeDefined();
});

it('bounds background handover reconciliation and does not restart it on status polling or startup', async () => {
  h.verified = true;
  h.pause.mockImplementation(() => { throw new CompanionImportError('SOURCE_HANDOVER_PENDING'); });
  const realTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realTimeout(callback, ms === 5000 ? 0 : ms, ...args)) as typeof setTimeout);
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'bounded-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  expect(h.pause).toHaveBeenCalledTimes(3);
  expect(verifyImportedAutomation).toHaveBeenCalledTimes(1);
  await recoverCompanionImports();
  await getCompanionImportResult(selection.requestId);
  expect(h.pause).toHaveBeenCalledTimes(3);
  expect(h.sourceEnabled).toBe(true);
  // A user retry can finish the original handover once its source is ready.
  h.pause.mockImplementation(() => {});
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(verifyImportedAutomation).toHaveBeenCalledTimes(1);
});

it.each(['handback', 'cleanup staging'])('retains paused routines and credentials when deletion fails during %s, then completes on retry', async failure => {
  h.verified = true;
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'handback-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.sourceEnabled).toBe(false);
  const routines = structuredClone(h.routines);
  expect(routines).toHaveLength(1);
  const staging = vi.spyOn(h.store, 'stageRemoval');
  if (failure === 'handback') h.pause.mockImplementationOnce(() => { throw new CompanionImportError('SOURCE_COMMAND_UNAVAILABLE'); });
  else staging.mockRejectedValueOnce(new Error('fixture staging failed'));
  const remove = () => withBotProfileLocks([accepted.botId], () => prepareCompanionImportDeletion(accepted.botId));
  await expect(remove()).rejects.toThrow(failure === 'handback' ? 'SOURCE_COMMAND_UNAVAILABLE' : 'fixture staging failed');
  expect(h.lifecycle.mock.calls).toEqual([[accepted.botId, 'pause']]);
  expect(h.routines).toEqual(routines);
  expect(h.created).toBe(true);
  expect(await h.store.read(h.root, accepted.botId, () => {})).toBeDefined();
  if (failure === 'handback') expect(staging).not.toHaveBeenCalled();
  await remove();
  expect(h.sourceEnabled).toBe(true);
  // Preparation can succeed while the following profile transaction fails.
  // Even on repeated preparation, only pause: definitions must survive until commit.
  expect(h.routines).toEqual(routines);
  expect(h.lifecycle.mock.calls).toEqual([[accepted.botId, 'pause'], [accepted.botId, 'pause']]);
  const calls = h.pause.mock.calls.length;
  await remove();
  expect(h.pause).toHaveBeenCalledTimes(calls);
  expect(h.routines).toEqual(routines);
  expect(h.lifecycle).not.toHaveBeenCalledWith(accepted.botId, 'delete');
  // Credentials remain available until the profile deletion commits.
  expect(await h.store.read(h.root, accepted.botId, () => {})).toBeDefined();
  await h.store.finishRemoval(h.root, accepted.botId, () => {});
});

it('does not resume source tasks that were imported paused or without takeover', async () => {
  h.sourceEnabled = false;
  h.snapshot.items[0]!.view.enabled = false;
  h.snapshot.items[0]!.automation!.original.enabled = false;
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'paused-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: false };
  const accepted = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  await cancelCompanionImportsForDeletion(accepted.botId);
  expect(h.pause).not.toHaveBeenCalled();
});

it.each(['', ' ', 'invalid-image'])('rejects avatar %j before persisting credentials and lets the same request be corrected', async avatarImageBase64 => {
  h.snapshot.items = [{ view: { id: 'env', name: 'Key', category: 'connections', selected: true }, env: { KEY: 'fixture-private-key' } }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const writes = vi.spyOn(h.store, 'write');
  vi.mocked(decodeBotAvatarImage).mockImplementation(() => { throw new Error('Invalid image'); });
  const selection = { requestId: 'fixture-avatar-12345', previewId: preview.id, name: 'Ada', entryIds: ['env'], takeover: false };
  await expect(startCompanionImport({ ...selection, avatarImageBase64 }, 'fixture')).rejects.toThrow('INVALID_SELECTION');
  expect(h.created).toBe(false);
  expect(writes).not.toHaveBeenCalled();
  expect(await getCompanionImportResult(selection.requestId)).toBeUndefined();
  expect(await fs.readdir(h.root)).toEqual([]);
  // The omitted-avatar path still uses ordinary companion creation defaults.
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.created).toBe(true);
});

it('masks all known credentials in discovery and preview without choosing conflicting accounts or changing the private snapshot', async () => {
  const secrets = ['fake-work-key', 'fake-personal-key', 'fake-unselected-key', 'fake-local-key', 'fake-header-key', 'fake-access-key', 'fake-refresh-key', 'fake/url+key'];
  const text = `status en us ${secrets.join(' ')} fake%2Furl%2Bkey`;
  h.snapshot.source.name = `Ada ${text}`;
  h.snapshot.items = [
    { view: { id: 'work', name: 'Work', category: 'connections', selected: false, exclusiveWith: ['personal'] }, env: { OPENAI_API_KEY: secrets[0]! } },
    { view: { id: 'personal', name: 'Personal', category: 'connections', selected: false, exclusiveWith: ['work'] }, env: { OPENAI_API_KEY: secrets[1]! } },
    { view: { id: 'unselected', name: 'Other', category: 'connections', selected: false }, env: { OTHER_TOKEN: secrets[2]!, ENDPOINT: 'https://example.invalid/mcp?token=fake%2Furl%2Bkey', LANG: 'en', REGION: 'us' } },
    { view: { id: 'mcp', name: text, category: 'connections', selected: false, dependsOn: ['unselected'] }, mcp: { name: text, url: '${ENDPOINT}', env: { KEY: secrets[3]! }, headers: { Authorization: `Bearer ${secrets[4]}` } } },
    { view: { id: 'native', name: 'Auth', category: 'connections', selected: false }, credential: { format: 'native-auth', value: { access_token: secrets[5], nested: { refreshToken: secrets[6] } } } },
    { view: { id: 'skill', name: text, description: text, category: 'skills', selected: false } },
    { view: { id: 'task', name: text, description: text, category: 'automations', selected: false, enabled: true, issues: ['DELIVERY_NEEDS_ADAPTER'], dependsOn: ['mcp'] } },
  ];
  const original = structuredClone(h.snapshot);
  const [source] = await listCompanionImportSources('mobile-controller');
  const preview = await previewCompanionImport(source!.id, 'mobile-controller');
  for (const secret of [...secrets, 'fake%2Furl%2Bkey']) expect(JSON.stringify([source, preview])).not.toContain(secret);
  expect(source?.name).toBe(preview.name);
  expect(preview.name).toContain('Ada status en us');
  expect(preview.source.name).toBe(preview.name);
  for (const entry of preview.entries) {
    const raw = original.items.find(item => item.view.id === entry.id)!.view;
    const { name: _name, description: _description, ...structure } = entry;
    const { name: _rawName, description: _rawDescription, ...rawStructure } = raw;
    expect(structure).toEqual(rawStructure);
  }
  expect(preview.entries.find(item => item.id === 'skill')?.description).toContain('status en us');
  expect(h.snapshot).toEqual(original);
  expect(h.created).toBe(false);
  expect(await fs.readdir(h.root)).toEqual([]);
  // A later explicit selection still imports the original usable credential.
  const requestId = 'preview-choice-12345';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['work'], takeover: false }, 'mobile-controller');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  expect((await h.store.read(h.root, result.botId, () => {}))?.env).toEqual({ OPENAI_API_KEY: secrets[0] });
});

it('lists an unreadable source with an opaque name without hiding healthy sources or bypassing preview errors', async () => {
  const unreadable = { ...h.snapshot.source, name: 'Ada fixture-private-token' };
  vi.mocked(discoverImportSources).mockResolvedValue([unreadable, h.snapshot.source]);
  vi.mocked(inspectImportSource).mockImplementation(async source => {
    if (source === unreadable) throw new Error('SOURCE_CREDENTIAL_INVALID');
    return h.snapshot;
  });
  h.readName.mockImplementation(async source => { if (source === unreadable) throw new Error('SOURCE_CREDENTIAL_INVALID'); return source.name; });
  const listed = await listCompanionImportSources('fixture');
  expect(inspectImportSource).not.toHaveBeenCalled();
  expect(listed.map(source => source.name)).toEqual(['Hermes · 1', 'Ada']);
  await expect(previewCompanionImport(listed[0]!.id, 'fixture')).rejects.toThrow('SOURCE_CREDENTIAL_INVALID');
  expect((await previewCompanionImport(listed[1]!.id, 'fixture')).name).toBe('Ada');
  expect(await fs.readdir(h.root)).toEqual([]);
});

it('rejects discovery if the account changes while building the name mask', async () => {
  h.readName.mockImplementation(async () => { h.boundary = true; return 'Ada'; });
  await expect(listCompanionImportSources('fixture')).rejects.toThrow('OWNER_CHANGED');
});

it.each(['hermes', 'openclaw'] as const)('masks %s names from real source files before publishing the discovery list', async kind => {
  const actual = await vi.importActual<typeof import('../sources.js')>('../sources.js');
  vi.mocked(discoverImportSources).mockImplementation((deps, reader) => actual.discoverImportSources({ ...deps, env: {} }, reader));
  vi.mocked(createImportSourceReader).mockImplementation(deps => actual.createImportSourceReader({ ...deps, env: {} }));
  vi.mocked(inspectImportSource).mockImplementation((source, deps) => actual.inspectImportSource(source, { ...deps, env: {} }));
  const root = path.join(h.root, `.${kind}`);
  const secrets = ['fixture-dotenv-secret', 'fixture-header-secret', 'fixture-auth-secret', 'fixture-skill-secret'];
  const name = `Ada ${secrets.join(' ')}`;
  const config = { ...(kind === 'hermes' ? { name } : { agents: { list: [{ id: 'main', name }] } }),
    mcpServers: { data: { url: 'https://example.invalid/mcp', headers: { Authorization: `Bearer ${secrets[1]}` } } },
    skills: { entries: { report: { env: { REPORT_TOKEN: secrets[3] } } } } };
  const authFile = kind === 'hermes' ? 'auth.json' : 'agents/main/agent/auth-profiles.json';
  await fs.mkdir(path.dirname(path.join(root, authFile)), { recursive: true });
  await fs.mkdir(path.join(root, 'skills/report'), { recursive: true });
  await fs.writeFile(path.join(root, kind === 'hermes' ? 'config.yaml' : 'openclaw.json'), JSON.stringify(config));
  await fs.writeFile(path.join(root, '.env'), `DATA_TOKEN=${secrets[0]}`);
  await fs.writeFile(path.join(root, authFile), JSON.stringify({ [kind === 'hermes' ? 'providers' : 'profiles']: { openai: { type: 'api_key', key: secrets[2] } } }));
  await fs.writeFile(path.join(root, 'skills/report/SKILL.md'), '# report');
  const listed = await listCompanionImportSources('mobile-controller');
  expect(listed).toHaveLength(1);
  expect(listed[0]?.name).toMatch(/^Ada \[/);
  for (const secret of secrets) expect(JSON.stringify(listed)).not.toContain(secret);
  const preview = await previewCompanionImport(listed[0]!.id, 'mobile-controller');
  expect(preview.name).toBe(listed[0]!.name);
  expect(h.created).toBe(false);
  expect(await fs.readdir(h.root)).toEqual([`.${kind}`]);
});

it.each([false, true])('redacts all known credentials from profile/memory copies while importing only selected connections (deselected: %s)', async deselected => {
  const secrets = ['fake-env-key', 'fake-local-key', 'fake-header-token', 'fake/url+key', 'fake-access-token', 'fake-refresh-token', '123:fake-telegram-token'];
  const text = `简短一点，带点幽默。status en us true 3000\n${secrets.join('\n')}\nfake-unselected-key`;
  const documents: ImportSnapshot['items'] = [
    { view: { id: 'soul', name: 'SOUL.md', category: 'personality', selected: true }, role: 'identity', text },
    { view: { id: 'user', name: 'USER.md', category: 'memory', selected: true }, role: 'user', text },
    { view: { id: 'instructions', name: 'HERMES.md', category: 'personality', selected: true }, role: 'instructions', text },
    { view: { id: 'reference', name: 'notes fake-unselected-key.md', category: 'memory', selected: true }, text },
    { view: { id: 'ordinary', name: 'ordinary.md', category: 'memory', selected: true }, text: 'Keep this paragraph exactly.\nSecond line.' },
  ];
  h.snapshot.items = [...documents,
    { view: { id: 'env', name: 'env', category: 'connections', selected: true }, env: { DATA_TOKEN: secrets[0]!, LANG: 'en', REGION: 'us', DEBUG: 'true', PORT: '3000' } },
    { view: { id: 'mcp', name: 'Data', category: 'connections', selected: true }, mcp: { name: 'Data', url: 'https://example.invalid/mcp?token=fake%2Furl%2Bkey', env: { KEY: secrets[1]!, REFERENCED: '${DATA_TOKEN}' }, headers: { Authorization: `Bearer ${secrets[2]}` } } },
    { view: { id: 'oauth', name: 'Auth', category: 'connections', selected: true }, credential: { format: 'native-auth', value: { value: { access_token: secrets[4], nested: { refreshToken: secrets[5] } } } } },
    { view: { id: 'telegram', name: 'Telegram', category: 'connections', selected: true }, credential: { format: 'telegram', value: { token: secrets[6], account: 'default' } } },
    { view: { id: 'excluded', name: 'Excluded', category: 'connections', selected: false }, env: { EXCLUDED: 'fake-unselected-key', UNUSED_ONLY: 'fake-absent-from-selected-content' } },
  ];
  if (deselected) for (const item of h.snapshot.items.filter(item => item.view.category === 'connections')) item.view.selected = false;
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: h.snapshot.items.filter(item => item.view.selected).map(item => item.view.id), takeover: false };
  const result = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const profile = h.writeProfile.mock.calls[0]![2];
  const publicText = JSON.stringify([profile, h.importDocument.mock.calls]);
  for (const secret of secrets) expect(publicText).not.toContain(secret);
  expect(publicText).not.toContain('fake-unselected-key');
  for (const field of ['identitySource', 'userContextSource', 'systemPromptOverride']) {
    expect(profile[field]).toContain('简短一点，带点幽默。status en us true 3000');
  }
  expect(h.importDocument.mock.calls.find(call => call[1] === 'ordinary')?.[3]).toBe(documents[4]!.text);
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  if (deselected) { expect(stored.env).toEqual({}); expect(stored.mcp).toEqual([]); expect(stored.credentials).toEqual([]); }
  else {
    expect(stored.env.DATA_TOKEN).toBe(secrets[0]);
    expect(stored.mcp[0]?.env?.REFERENCED).toBe(secrets[0]);
    expect(stored.mcp[0]?.headers?.Authorization).toBe(`Bearer ${secrets[2]}`);
  }
  expect(stored.env).not.toHaveProperty('EXCLUDED');
  expect(JSON.stringify(stored)).not.toContain('fake-absent-from-selected-content');
  expect(stored.documents).toEqual(Object.fromEntries(documents.map(item => [item.view.id, item.text])));
  expect(stored.pendingImport).toBeUndefined();
});

it('persists redacted routine fields and retains identical publication masks across a handover retry after restart', async () => {
  const selectedSecret = 'fake-active-query-token'; const excludedSecret = 'fake-excluded-note-token';
  const input = h.snapshot.items[0]!.automation!.input!;
  input.name = `Morning report ${selectedSecret} ${excludedSecret}`;
  input.prompt = `Read reports using ${selectedSecret}; note ${excludedSecret}`;
  h.snapshot.items[0]!.automation!.original = { enabled: true, name: input.name, prompt: input.prompt };
  const original = structuredClone(input);
  h.snapshot.items.push(
    { view: { id: 'excluded', name: 'Not selected', category: 'connections', selected: false }, env: { DISCARDED: excludedSecret, UNUSED: 'fake-unused-account-token' } },
    { view: { id: 'active', name: 'Selected', category: 'connections', selected: true }, env: { ACTIVE: selectedSecret } },
  );
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-routine-12345', previewId: preview.id, name: 'Ada', entryIds: ['task', 'active'], takeover: true };
  const result = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  expect(h.routines).toHaveLength(1);
  const saved = structuredClone(h.routines[0]!);
  for (const secret of [selectedSecret, excludedSecret]) expect(JSON.stringify(saved)).not.toContain(secret);
  expect(saved.name).toContain('Morning report'); expect(saved.prompt).toContain('Read reports');
  expect(saved.triggers).toEqual(input.triggers);
  expect(h.pause).not.toHaveBeenCalled();
  const environment = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(environment.env).toEqual({ ACTIVE: selectedSecret });
  expect(environment.sourceAutomations?.[0]?.original).toEqual({ enabled: true, name: original.name, prompt: original.prompt });
  expect(JSON.stringify(environment)).not.toContain('fake-unused-account-token');
  const checkpoint = JSON.parse(environment.pendingImport!.snapshotJson);
  expect(checkpoint.items.map((item: { view: { id: string } }) => item.view.id)).toEqual(['task', 'active']);
  expect(Object.values(checkpoint.publicationRedactions)).toContain(excludedSecret);
  expect(await fs.readFile(path.join(h.root, 'companion-imports', `${selection.requestId}.json`), 'utf8')).not.toContain(excludedSecret);
  h.verified = true;
  // A different controller cannot access the original in-memory preview.
  await startCompanionImport(selection, 'after-restart');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines).toHaveLength(1);
  expect(h.routines[0]).toMatchObject({ name: saved.name, prompt: saved.prompt, triggers: saved.triggers, enabled: true });
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
  expect(h.sourceEnvironment).toEqual({ ACTIVE: selectedSecret });
  expect(input).toEqual(original);
});

it.each([false, true])('publishes masked skills and runs original scripts/resources through the existing bridge (native credentials only: %s)', async nativeOnly => {
  const token = 'fake-selected-source-token'; const native = 'fake-native-resource-token';
  const excluded = 'fake-deselected-skill-token';
  const files = [
    { name: 'SKILL.md', bytes: Buffer.from(`---\nname: report\ndescription: Query using ${token}\n---\nUse scripts/report task.cjs; 原来的谈吐。`), executable: false },
    { name: 'scripts/report task.cjs', bytes: Buffer.from(`const fs = require('node:fs'); const helper = require('./helper.cjs'); if (${nativeOnly ? 'false' : `process.env.SOURCE_TOKEN !== '${token}'`} || helper.token !== '${native}' || process.env.DISCARDED || process.argv[2] !== 'query & report') process.exit(1); fs.writeFileSync('report.txt', 'query succeeded'); console.log('query succeeded', helper.token, '${token}', '${excluded}');`), executable: true },
    { name: 'scripts/helper.cjs', bytes: Buffer.from('module.exports = require("./data/query.json");'), executable: false },
    { name: 'scripts/data/query.json', bytes: Buffer.from(JSON.stringify({ token: native })), executable: false },
    { name: 'references/guide.md', bytes: Buffer.from(`使用原接口。${native}\r\n`), executable: false },
    { name: 'assets/image.bin', bytes: Buffer.from([0xff, 0, 0x80, 3]), executable: false },
  ];
  const plain = Buffer.from('---\nname: plain\n---\nKeep this exactly.\r\n');
  h.snapshot.items = [
    { view: { id: 'skill', name: 'report', category: 'skills', selected: true }, files, filesComplete: true },
    { view: { id: 'plain', name: 'plain', category: 'skills', selected: true }, files: [{ name: 'SKILL.md', bytes: plain, executable: false }], filesComplete: true },
    { view: { id: 'excluded', name: 'excluded', category: 'skills', selected: false }, files, filesComplete: true },
    { view: { id: 'env', name: 'env', category: 'connections', selected: true }, env: { SOURCE_TOKEN: token } },
    { view: { id: 'native', name: 'native', category: 'connections', selected: true }, credential: { format: 'native-auth', value: { access_token: native, refresh_token: token } } },
    { view: { id: 'discarded-credential', name: 'Discarded', category: 'connections', selected: false }, env: { DISCARDED: excluded } },
  ];
  const original = files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-skill-12345';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['skill', 'plain', 'native', ...(nativeOnly ? [] : ['env'])], takeover: false }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  const skillRoot = path.join(h.root, 'bots', result.botId, 'skills');
  for (const file of files) {
    const published = await fs.readFile(path.join(skillRoot, 'report', file.name));
    expect(published.includes(Buffer.from(token))).toBe(false); expect(published.includes(Buffer.from(native))).toBe(false);
    expect(published.includes(Buffer.from(excluded))).toBe(false);
    if (file.name.endsWith('.bin')) expect(published).toEqual(file.bytes);
  }
  const guide = await fs.readFile(path.join(skillRoot, 'report', 'SKILL.md'), 'utf8');
  expect(guide).toContain('原来的谈吐。'); expect(guide).toContain('companion_connections.run_command');
  expect(guide).toContain('$CINDY_IMPORTED_SKILLS/report');
  expect(await fs.readFile(path.join(skillRoot, 'plain', 'SKILL.md'))).toEqual(plain);
  await expect(fs.access(path.join(skillRoot, 'excluded'))).rejects.toThrow();
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(stored.pendingImport).toBeUndefined();
  if (nativeOnly) expect(stored.env).toEqual({});
  expect(stored.env).not.toHaveProperty('DISCARDED');
  expect(h.writeProfile.mock.calls[0]![2].config.mcpServers).toContain('companion_connections');
  expect(Object.keys(stored.skillFiles!)).toEqual(['report']);
  expect(stored.skillFiles!.report!.map(file => ({ ...file, bytes: Buffer.from(file.bytes, 'base64') }))).toEqual(original);
  expect(files).toEqual(original);
  expect(await fs.readFile(path.join(h.root, 'bots', result.botId, 'environment.json'), 'utf8')).not.toContain(token);

  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  const mkdir = vi.spyOn(fs, 'mkdtemp');
  try {
    const prefix = process.platform === 'win32' ? '%CINDY_IMPORTED_SKILLS%' : '$CINDY_IMPORTED_SKILLS';
    const output = await client.callTool({ name: 'run_command', arguments: { command: `"${process.execPath}" "${prefix}/report/scripts/report task.cjs" "query & report"` } });
    expect(output.isError).toBe(false);
    expect(JSON.stringify(output)).toContain('query succeeded');
    expect(JSON.stringify(output)).not.toContain(token); expect(JSON.stringify(output)).not.toContain(native);
    expect(JSON.stringify(output)).not.toContain(excluded);
    expect(await fs.readFile(path.join(h.root, 'bots', result.botId, 'workspace', 'report.txt'), 'utf8')).toBe('query succeeded');
    expect(mkdir).toHaveBeenCalledTimes(1);
    await expect(fs.access(await mkdir.mock.results[0]!.value)).rejects.toThrow();
  } finally { mkdir.mockRestore(); await client.close(); await config.instance.close(); }
});

it('does not reintroduce a credential-bearing skill slug in the generated resource guidance', async () => {
  const token = 'fake-secret-slug';
  h.snapshot.items = [
    { view: { id: 'skill', name: token, category: 'skills', selected: true }, files: [{ name: 'SKILL.md', bytes: Buffer.from(`# Skill\n${token}`), executable: false }], filesComplete: true },
    { view: { id: 'env', name: 'env', category: 'connections', selected: true }, env: { KEY: token } },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-slug-12345';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['skill', 'env'], takeover: false }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  const directory = path.join(h.root, 'bots', result.botId, 'skills');
  const [slug] = await fs.readdir(directory);
  expect(slug).toMatch(/^import-[a-f0-9]+$/);
  expect(await fs.readFile(path.join(directory, slug!, 'SKILL.md'), 'utf8')).not.toContain(token);
});

it.each(['absolute', 'relative'])('resolves a selected %s MCP cwd after environment choice without anchoring an absolute reference twice', async form => {
  const expected = path.join(h.root, 'server files');
  const value = form === 'absolute' ? expected : 'server files';
  h.snapshot.items = [
    { view: { id: 'cwd', name: 'MCP_DIR', category: 'connections', selected: true }, env: { MCP_DIR: value } },
    { view: { id: 'mcp', name: 'Data', category: 'connections', selected: true, dependsOn: ['cwd'] }, mcp: { name: 'Data', command: process.execPath, args: ['./server.cjs'], cwd: '${MCP_DIR}' } },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-cwd-123456';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada', entryIds: ['cwd', 'mcp'], takeover: false }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(stored.mcp[0]?.cwd).toBe(expected);
  expect(stored.env.MCP_DIR).toBe(value);
  expect(h.snapshot.items[1]?.mcp?.cwd).toBe('${MCP_DIR}');
});

it('joins an in-flight credential write before deletion and durably blocks old-preview and restart retries', async () => {
  h.snapshot.items = [{ view: { id: 'env', name: 'Key', category: 'connections', selected: true }, env: { KEY: 'fake-import-secret' } }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['env'], takeover: false };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writing = false;
  const write = h.store.write.bind(h.store);
  const writes = vi.spyOn(h.store, 'write').mockImplementation(async (...args) => {
    if (args[2].env.KEY) { writing = true; await blocked; }
    await write(...args);
  });
  const accepted = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(() => expect(writing).toBe(true));
  expect(h.created).toBe(true);
  let deleted = false;
  // The real lifecycle service holds this same lock around preparation/DB deletion/cleanup.
  const deletion = withBotProfileLocks([accepted.botId], async () => {
    await cancelCompanionImportsForDeletion(accepted.botId);
    await h.store.stageRemoval(h.root, accepted.botId, () => {});
    h.created = false;
    await h.store.finishRemoval(h.root, accepted.botId, () => {});
    await fs.rm(path.join(h.root, 'bots', accepted.botId), { recursive: true, force: true });
    deleted = true;
  });
  try {
    expect((await getCompanionImportResult(selection.requestId))?.status).toBe('running');
    expect(deleted).toBe(false);
  } finally { release(); }
  await deletion;
  const count = writes.mock.calls.length;
  expect(await startCompanionImport(selection, 'fixture')).toMatchObject({ status: 'needs-attention', checks: expect.arrayContaining([{ entryId: 'import', status: 'needs-attention', message: 'IMPORT_CANCELLED' }]) });
  // Even an old unfinished handover phase cannot restart a cancelled receipt.
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.routines.old = { id: 'old', phase: 'source-paused' };
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await recoverCompanionImports();
  expect(h.created).toBe(false);
  expect(writes).toHaveBeenCalledTimes(count);
  expect(await h.store.read(h.root, accepted.botId, () => {})).toBeUndefined();
  expect((await getCompanionImportResult(selection.requestId))?.checks).toContainEqual({ entryId: 'import', status: 'needs-attention', message: 'IMPORT_CANCELLED' });
});

it.each(['scan', 'same-request'] as const)('recovers an indexed checkpoint before receipt acknowledgement through %s', async recovery => {
  h.verified = true;
  h.snapshot.items.push(
    { view: { id: 'selected-env', name: 'Selected', category: 'connections', selected: true }, env: { SOURCE_KEY: 'fake-selected-credential' } },
    { view: { id: 'excluded-env', name: 'Excluded', category: 'connections', selected: false }, env: { UNUSED_KEY: 'fake-excluded-credential' } },
  );
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task', 'selected-env'], takeover: true };
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const write = h.store.write.bind(h.store);
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let checkpointWritten = false; let botId = ''; let acknowledged = false;
  vi.spyOn(h.store, 'write').mockImplementationOnce(async (...args) => {
    // A restart can discover the request even before the checkpoint flag is saved.
    const index = await fs.readFile(receiptFile, 'utf8');
    expect(index).not.toContain('fake-selected-credential'); expect(index).not.toContain('fake-excluded-credential');
    expect(JSON.parse(index)).toMatchObject({ result: { requestId: selection.requestId, status: 'running', botId: args[1] } });
    expect(JSON.parse(index).checkpointSaved).not.toBe(true);
    await write(...args); botId = args[1]; checkpointWritten = true;
    await pause; h.boundary = true; // Simulates stopping before the acknowledgement write.
  });
  const pending = startCompanionImport(selection, 'fixture').then(value => { acknowledged = true; return value; }).catch(error => error);
  try {
    await vi.waitFor(() => expect(checkpointWritten).toBe(true));
    // Several acknowledgement polling ticks must not accept the index alone.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(acknowledged).toBe(false); expect(h.created).toBe(false);
    const stored = (await h.store.read(h.root, botId, () => {}))!.pendingImport!;
    expect(stored.snapshotJson).toContain('fake-selected-credential');
    expect(stored.snapshotJson).not.toContain('fake-excluded-credential');
  } finally { release(); }
  expect(await pending).toMatchObject({ code: 'OWNER_CHANGED' });
  h.boundary = false;
  // A new controller cannot use the old in-memory preview; both paths use the checkpoint.
  if (recovery === 'scan') await recoverCompanionImports();
  else await startCompanionImport(selection, 'restarted-controller');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines).toHaveLength(1); expect(h.routines[0]?.enabled).toBe(true);
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
  expect((await h.store.read(h.root, botId, () => {}))?.env).toEqual({ SOURCE_KEY: 'fake-selected-credential' });
  expect(h.sourceEnvironment).toEqual({ SOURCE_KEY: 'fake-selected-credential' });
});

it('persists a failed handover, blocks use, and unlocks the same routine only after a successful retry', async () => {
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(false); expect(h.sourceEnabled).toBe(true); expect(h.pause).not.toHaveBeenCalled();
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
  expect(await prepareImportedAutomation(h.root, { ...routine, enabled: true }, 'run', new AbortController().signal, () => {})).toMatchObject({ deferred: true });
  h.verified = true;
  await expect(ensureImportedAutomationReady(h.root, routine.botId, routine.id, () => {}, { input: { ...routine, prompt: 'Different operation', enabled: true }, expectedRevision: routine.revision })).rejects.toThrow('TARGET_AUTOMATION_CHANGED');
  expect(h.pause).not.toHaveBeenCalled();
  await ensureImportedAutomationReady(h.root, routine.botId, routine.id, () => {}, { input: { ...routine, enabled: true }, expectedRevision: routine.revision });
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines).toHaveLength(1); expect(h.routines[0]?.enabled).toBe(true);
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  // Status/startup reads do not decrypt the full environment for current receipts.
  const privateRead = vi.spyOn(h.store, 'read');
  await getCompanionImportResult(selection.requestId);
  await recoverCompanionImports();
  expect(privateRead).not.toHaveBeenCalled(); privateRead.mockRestore();
  // Earlier successful receipts repair missing state once without rerunning a takeover.
  const legacyReceiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const legacyReceipt = JSON.parse(await fs.readFile(legacyReceiptFile, 'utf8'));
  delete legacyReceipt.handoverMarkers;
  await fs.writeFile(legacyReceiptFile, JSON.stringify(legacyReceipt));
  await h.store.update(h.root, routine.botId, () => {}, env => { delete env.automations![routine.id]!.handover; });
  await getCompanionImportResult(selection.requestId);
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  expect(h.pause).toHaveBeenCalledTimes(1);
  // Simulate a crash after the ready marker but before the outer receipt save.
  await h.store.update(h.root, routine.botId, () => {}, env => { env.pendingImport = { selection, snapshotJson: JSON.stringify(h.snapshot) }; });
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  receipt.result.status = 'running'; receipt.routines.task.phase = 'source-paused';
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  h.routines[0]!.name = 'Edited after takeover';
  await getCompanionImportResult(selection.requestId);
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.routines[0]?.name).toBe('Edited after takeover');
  expect(h.pause).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps a copied routine paused and only allows future enable if the source was already paused (%s)', async sourcePaused => {
  h.sourceEnabled = !sourcePaused;
  h.snapshot.items[0]!.view.enabled = !sourcePaused;
  h.snapshot.items[0]!.automation!.original.enabled = !sourcePaused;
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: false };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(false); expect(h.pause).not.toHaveBeenCalled();
  const guard = assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {});
  if (sourcePaused) await expect(guard).resolves.toBeUndefined();
  else await expect(guard).rejects.toThrow('AUTOMATION_HANDOVER_REQUIRED');
});

it('keeps the source paused and execution deferred when the ready marker write fails after activation', async () => {
  h.verified = true; h.failReadyWrite = true;
  // The one-time deadline passes while the durable host recovery waits to retry.
  h.snapshot.items[0]!.automation!.input!.triggers = [{ id: 'once', kind: 'once', at: Date.now() + 1000 }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-request-12345', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.checks.some(check => check.message === 'TARGET_HANDOVER_UNCERTAIN')).toBe(true));
  const routine = h.routines[0]!;
  expect(routine.enabled).toBe(true); expect(h.sourceEnabled).toBe(false);
  expect(await prepareImportedAutomation(h.root, routine, 'run', new AbortController().signal, () => {})).toMatchObject({ deferred: true });
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'), { timeout: 8000 });
  await expect(assertImportedAutomationReady(h.root, routine.botId, routine.id, () => {})).resolves.toBeUndefined();
  expect(h.pause).toHaveBeenCalledExactlyOnceWith(false);
}, 10000);


it.each(['count', 'entrypoint', 'projected-entrypoint', 'captured-entrypoint'])('rejects skill %s limits before storing a checkpoint or creating a companion, then accepts a corrected selection', async mode => {
  const count = mode === 'count' ? 101 : 1;
  h.snapshot.items = Array.from({ length: count }, (_, index) => ({
    view: { id: `skill-${index}`, category: 'skills' as const, name: `skill-${index}`, selected: true }, filesComplete: true,
    files: [{ name: 'SKILL.md', bytes: Buffer.alloc(mode === 'entrypoint' ? 65537 : mode === 'projected-entrypoint' ? 65536 : 10, 'a'), executable: false }],
  }));
  if (mode === 'projected-entrypoint') {
    h.snapshot.items[0]!.files!.push({ name: 'resource.txt', bytes: Buffer.from('fixture-private-key'), executable: false });
    h.snapshot.items.push({ view: { id: 'key', name: 'Key', category: 'connections', selected: true }, env: { API_KEY: 'fixture-private-key' } });
  }
  if (mode === 'captured-entrypoint') {
    const directory = path.join(h.root, 'source-skill');
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'SKILL.md'), Buffer.alloc(65537, 'a'));
    Object.assign(h.snapshot.items[0]!, { sourceDirectory: directory, files: [], filesComplete: false });
  }
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `fixture-skill-limit-${mode}`, previewId: preview.id, name: 'Ada', entryIds: h.snapshot.items.map(item => item.view.id), takeover: false };
  await expect(startCompanionImport(selection, 'fixture')).rejects.toThrow('INVALID_SELECTION');
  expect(createBotProfile).not.toHaveBeenCalled();
  expect(h.secretValues.size).toBe(0);
  expect(await getCompanionImportResult(selection.requestId)).toBeUndefined();
  await expect(fs.access(path.join(h.root, 'companion-imports'))).rejects.toThrow();
  // The same preview remains editable; existing INVALID_SELECTION handling clears intent.
  const entryIds = mode === 'count' ? ['skill-0'] : [];
  await startCompanionImport({ ...selection, requestId: `${selection.requestId}-retry`, entryIds }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(`${selection.requestId}-retry`))?.status).toBe('complete'));
});

it.each(['oversized', 'symlink'])('rejects a lazily selected %s resource before a receipt, then imports after deselection', async mode => {
  const directory = path.join(h.root, 'source-skill');
  await fs.mkdir(directory);
  if (mode === 'oversized') {
    const file = await fs.open(path.join(directory, 'resource.bin'), 'w');
    try { await file.truncate(16 * 1024 * 1024 + 1); } finally { await file.close(); }
  } else {
    const outside = path.join(h.root, 'outside');
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'resource.txt'), 'fixture');
    await fs.symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  h.snapshot.items = [{ view: { id: 'skill', name: 'Optional skill', category: 'skills', selected: false },
    sourceDirectory: directory, files: [{ name: 'SKILL.md', bytes: Buffer.from('# Skill'), executable: false }], filesComplete: false }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `fixture-capture-${mode}`, previewId: preview.id, name: 'Ada', entryIds: ['skill'], takeover: false };
  await expect(startCompanionImport(selection, 'fixture')).rejects.toThrow(mode === 'oversized' ? 'SOURCE_FILE_TOO_LARGE' : 'SOURCE_LINK_OUTSIDE_FOLDER');
  expect(createBotProfile).not.toHaveBeenCalled(); expect(h.secretValues.size).toBe(0);
  expect(await getCompanionImportResult(selection.requestId)).toBeUndefined();
  await expect(fs.access(path.join(h.root, 'companion-imports'))).rejects.toThrow();
  await startCompanionImport({ ...selection, requestId: `${selection.requestId}-retry`, entryIds: [] }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(`${selection.requestId}-retry`))?.status).toBe('complete'));
});

it('replaces previous previews for the same controller and keeps the latest usable', async () => {
  h.snapshot.items = [];
  const [source] = await listCompanionImportSources('fixture');
  const first = await previewCompanionImport(source!.id, 'fixture');
  const last = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-preview-replace', previewId: first.id, name: 'Ada', entryIds: [], takeover: false };
  await expect(startCompanionImport(selection, 'fixture')).rejects.toThrow('PREVIEW_EXPIRED');
  await startCompanionImport({ ...selection, previewId: last.id }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
});

it.each(['count', 'bytes'])('bounds retained previews across controllers by %s', async mode => {
  const ids: string[] = [];
  for (let index = 0; index < (mode === 'count' ? 5 : 2); index++) {
    h.snapshot = { ...h.snapshot, items: mode === 'bytes' ? [{
      view: { id: 'asset', name: 'Resource', category: 'skills', selected: false },
      asset: { name: 'large.bin', bytes: Buffer.alloc(65 * 1024 * 1024) },
    }] : [] };
    const controller = `fixture-${index}`;
    const [source] = await listCompanionImportSources(controller);
    ids.push((await previewCompanionImport(source!.id, controller)).id);
  }
  const selection = { requestId: `fixture-preview-limit-${mode}`, previewId: ids[0]!, name: 'Ada', entryIds: [], takeover: false };
  await expect(startCompanionImport(selection, 'fixture-0')).rejects.toThrow('PREVIEW_EXPIRED');
  await startCompanionImport({ ...selection, previewId: ids.at(-1)! }, `fixture-${ids.length - 1}`);
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
});

it.each(['readback', 'binding'] as const)('cleans an unbound first checkpoint after %s failure using the durable request index', async failure => {
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-first-write-failure', previewId: preview.id, name: 'Ada', entryIds: [], takeover: false };
  const botId = `import_${fingerprint(selection.requestId).slice(0, 24)}`;
  const values = h.secretValues;
  const bindingFile = path.join(h.root, 'bots', botId, 'environment.json');
  const rename = fsSync.renameSync;
  // Windows can recover replacing a directory through the atomic writer's
  // EPERM backup path. Inject a definite I/O failure at the actual rename instead.
  const bindingFailure = failure === 'binding' ? vi.spyOn(fsSync, 'renameSync').mockImplementation((from, to) => {
    if (to === bindingFile) throw Object.assign(new Error('fixture binding write failed'), { code: 'EIO' });
    return rename(from, to);
  }) : undefined;
  let failed = false;
  h.store = createCompanionEnvironmentStore({
    read: key => { if (failure === 'readback' && failed) throw new Error('fixture readback failed'); return values.get(key) ?? null; },
    write: async (key, value) => {
      // No credential write is possible before this non-secret recovery index.
      const index = await fs.readFile(path.join(h.root, 'companion-imports', `${selection.requestId}.json`), 'utf8');
      expect(JSON.parse(index)).toMatchObject({ result: { botId }, copied: [] });
      values.set(key, value); failed = true;
      return true;
    },
    remove: key => { values.delete(key); return true; },
  });
  const result = await startCompanionImport(selection, 'fixture');
  expect(result.status).toBe('needs-attention');
  expect(h.created).toBe(false); expect(values.size).toBe(1);
  await expect(fs.access(bindingFile)).rejects.toThrow();
  bindingFailure?.mockRestore();
  // A new vault instance and the startup receipt scan must find and remove it,
  // including when the first cleanup attempt also fails.
  const remove = vi.fn((key: string) => { values.delete(key); return true; }).mockReturnValueOnce(false);
  h.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: () => true, remove });
  // A committed profile or an uncertain lookup must never lose its vault key.
  vi.mocked(getBotRemoteResourceSource).mockResolvedValueOnce({ canonicalSessionId: 'chat' } as never);
  await recoverCompanionImports();
  expect(values.size).toBe(1); expect(remove).not.toHaveBeenCalled();
  vi.mocked(getBotRemoteResourceSource).mockRejectedValueOnce(new Error('fixture database unavailable'));
  await recoverCompanionImports();
  expect(values.size).toBe(1); expect(remove).not.toHaveBeenCalled();
  await recoverCompanionImports();
  expect(values.size).toBe(1);
  await recoverCompanionImports();
  expect(values.size).toBe(0); expect(remove).toHaveBeenCalledTimes(2);
  expect(h.created).toBe(false);
});
