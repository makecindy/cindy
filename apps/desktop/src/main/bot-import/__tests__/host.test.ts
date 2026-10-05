import { remoteCompanionImportApi, compactCompanionImportSelection, companionImportSubmissions } from '@cindy/maker-shared/companion-import';
import fsSync, { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Routine, RoutineInput } from '@cindy/maker-scheduler';
import { companionEnvironmentKey, createCompanionEnvironmentStore } from '../environment.js';
import { deserializeImportSnapshotAsync, fingerprint } from '../files.js';
import { createMessage } from '../../localDb/ipc/messages.js';
import { t } from '../../i18n.js';
import { createBotProfile, getBotRemoteResourceSource } from '../../localDb/ipc/bots.js';
import type { ImportSnapshot } from '../types.js';
import { CompanionImportError } from '../types.js';
import { previewImportRedactions } from '../environmentSelection.js';
import { redactEnvironmentValues } from '../process.js';
import { DEFAULT_MEMORY_CONFIG, MemoryStorage, type MakerMemoryStore } from '@cindy/maker-core';
import { BOT_MEMORY_BODY_MAX_BYTES } from '../../../shared/botMemory.js';
import { createBotMemoryService } from '../../maker-ipc/botMemoryService.js';

const h = vi.hoisted(() => ({ root: '', botId: '', created: false, verified: false, sourceEnabled: true, failReadyWrite: false, boundary: false,
  snapshot: null as unknown as ImportSnapshot, store: null as unknown as ReturnType<typeof createCompanionEnvironmentStore>,
  routines: [] as Routine[], pause: vi.fn(), lifecycle: vi.fn(), sourceEnvironment: {} as Record<string, string>,
  profile: { config: {} } as Record<string, unknown>, importMedia: vi.fn(), writeProfile: vi.fn(), importDocument: vi.fn(), readName: vi.fn(), secretValues: new Map<string, string>(),
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
vi.mock('../../maker-ipc/botProfileFolder.js', () => ({ BOT_PROFILE_TEXT_MAX_BYTES: 100000, readBotProfileFolder: async () => h.profile, writeBotProfileFolder: h.writeProfile,
  ensureBotWorkspaceDir: async () => { const directory = path.join(h.root, 'bots', h.botId, 'workspace'); await fs.mkdir(directory, { recursive: true }); return directory; },
}));
vi.mock('@cindy/mcps', () => ({ resolveLiziMcpSessionContext: () => ({ sessionId: 'chat' }) }));
vi.mock('../sources.js', () => ({ createImportSourceReader: vi.fn(() => ({ readName: h.readName })), discoverImportSources: vi.fn(async () => [h.snapshot.source]), inspectImportSource: vi.fn(async () => h.snapshot) }));
vi.mock('../openclawCron.js', () => ({ readOpenClawCronDatabase: vi.fn() }));
vi.mock('../verification.js', () => ({ verifyImportedAutomation: vi.fn(async () => ({ verified: h.verified, reason: 'AUTOMATION_DATA_READ_FAILED' })) }));
vi.mock('../takeover.js', () => ({ changeSourceAutomationState: async (_source: unknown, _item: unknown, enabled: boolean, _readers: unknown, _owner: unknown, _resume: boolean, env: Record<string, string>) => { h.pause(enabled); h.sourceEnabled = enabled; h.sourceEnvironment = env; } }));
vi.mock('../runtime.js', () => ({ recoverCompanionEnvironmentRemovals: vi.fn(async () => {}),
  readCompanionSessionScope: async () => ({ owner: h.root, botId: h.botId, userData: h.root, assertOwner() { if (h.boundary) throw new Error('OWNER_CHANGED'); } }),
  readCompanionSessionEnvironment: async () => ({ identity: h.root, botId: h.botId, userData: h.root, assertOwner() {}, environment: await h.store.read(h.root, h.botId, () => {}) }),
  companionEnvironmentStore: {
  read: (...args: Parameters<typeof h.store.read>) => h.store.read(...args),
  readImportRequestId: (...args: Parameters<typeof h.store.readImportRequestId>) => h.store.readImportRequestId(...args),
  write: (...args: Parameters<typeof h.store.write>) => h.store.write(...args),
  update: (...args: Parameters<typeof h.store.update>) => h.store.update(...args),
  stageRemoval: (...args: Parameters<typeof h.store.stageRemoval>) => h.store.stageRemoval(...args),
  finishRemoval: (...args: Parameters<typeof h.store.finishRemoval>) => h.store.finishRemoval(...args),
} }));
vi.mock('../memoryMedia.js', () => ({ importMemoryMedia: h.importMedia }));
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
import { submitRemoteCompanionImport, readRemoteCompanionImport, listCompanionImportSources, previewCompanionImport, startCompanionImport, getCompanionImportResult, getCompanionImportSetupStatus, recoverCompanionImports, prepareCompanionImportDeletion, cancelCompanionImportsForDeletion, ensureImportedAutomationReady } from '../host.js';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock.js';
import { assertImportedAutomationReady, prepareImportedAutomation } from '../automationRuntime.js';
import { decodeBotAvatarImage } from '../../localDb/ipc/botAvatarSelection.js';
import { createCompanionConnectionsProvider } from '../connectionProvider.js';
import { createImportSourceReader, discoverImportSources, inspectImportSource } from '../sources.js';
import { verifyImportedAutomation } from '../verification.js';
import { indexAutomationDependencies, normalizeAutomation } from '../sourceAutomations.js';

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-host-test-'));
  h.created = false; h.verified = false; h.sourceEnabled = true; h.failReadyWrite = false; h.boundary = false; h.routines = []; h.pause.mockReset(); h.sourceEnvironment = {};
  h.lifecycle.mockReset().mockImplementation(async (_botId: string, action: string) => {
    if (action === 'delete') h.routines = [];
  });
  vi.mocked(verifyImportedAutomation).mockClear();
  vi.mocked(getBotRemoteResourceSource).mockReset().mockImplementation(async () => { if (!h.created) throw new Error('[NOT_FOUND]'); return { canonicalSessionId: 'chat' } as never; });
  vi.mocked(createBotProfile).mockReset().mockImplementation(async input => { h.created = true; h.botId = (input as { id: string }).id; return {} as never; });
  vi.mocked(createMessage).mockReset();
  h.profile = { config: {} }; h.importMedia.mockReset().mockResolvedValue('cindy-media://blobs/fixture.png');
  h.writeProfile.mockReset().mockImplementation(async (_root, _bot, patch) => { h.profile = { ...h.profile, ...patch }; }); h.importDocument.mockReset().mockResolvedValue(undefined);
  vi.mocked(decodeBotAvatarImage).mockReset();
  vi.mocked(discoverImportSources).mockReset().mockImplementation(async () => [h.snapshot.source]);
  vi.mocked(inspectImportSource).mockReset().mockImplementation(async () => h.snapshot);
  vi.mocked(createImportSourceReader).mockReset().mockImplementation(() => ({ readName: h.readName, readRedactions: async () => previewImportRedactions(h.snapshot.items) }) as never);
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

it('compiles credential matching once for a large preview and preserves all entries', async () => {
  const secret = (index: number) => `fixture-compiled-secret-${index.toString().padStart(5, '0')}`;
  h.snapshot.items = [
    ...Array.from({ length: 2_000 }, (_, index) => ({
      view: { id: `env-${index}`, category: 'connections' as const, selected: true, name: `Account ${index}` },
      env: { [`TOKEN_${index}`]: secret(index) },
    })),
    ...Array.from({ length: 10_000 }, (_, index) => ({
      view: { id: `skill-${index}`, category: 'skills' as const, selected: true,
        name: `Skill ${index} ${secret(index % 2_000)}`, description: `Ordinary description ${secret(1_999)}` },
    })),
  ];
  const [source] = await listCompanionImportSources('fixture');
  let compilations = 0;
  const NativeRegExp = RegExp;
  vi.stubGlobal('RegExp', new Proxy(NativeRegExp, {
    construct(target, args) {
      if (String(args[0]).includes('fixture-compiled-secret-')) {
        compilations += 1;
        // Fail before the regression can allocate thousands of large matchers.
        if (compilations > 1) throw new Error('Repeated preview credential matcher compilation');
      }
      return Reflect.construct(target, args);
    },
  }));
  try {
    const preview = await previewCompanionImport(source!.id, 'fixture');
    expect(compilations).toBe(1);
    expect(preview.entries).toHaveLength(12_000);
    for (const entry of preview.entries.slice(2_000)) {
      expect(entry.name).toMatch(/^Skill \d+ \[preview_credential_\d+\]$/);
      expect(entry.description).toMatch(/^Ordinary description \[preview_credential_\d+\]$/);
    }
    expect(h.snapshot.items[2_000]!.view.name).toBe(`Skill 0 ${secret(0)}`);
  } finally { vi.unstubAllGlobals(); }
}, 10_000);

it('bounds actual receipt writes with long entry names while retaining retryable failures', async () => {
  const count = 1_000;
  h.snapshot.items = Array.from({ length: count }, (_, index) => ({
    view: { id: `memory-${index}`, name: `${'长名称'.repeat(60)}-${index}`, category: 'memory', selected: true }, text: `Original ${index}`,
  }));
  h.importDocument.mockImplementation(async (_bot, id) => { if (id === 'memory-999') throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'receipt-byte-budget-fixture', previewId: preview.id, name: 'Ada', entryIds: h.snapshot.items.map(item => item.view.id), takeover: false, deferSetup: true };
  const receiptPath = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  let writtenBytes = 0;
  const write = fsSync.writeFileSync;
  vi.spyOn(fsSync, 'writeFileSync').mockImplementation((file, data, options) => {
    if (String(file).startsWith(`${receiptPath}.`) && typeof data === 'string') writtenBytes += Buffer.byteLength(data);
    return write(file, data, options);
  });
  const accepted = await startCompanionImport(selection, 'fixture');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  const saved = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  expect(writtenBytes).toBeGreaterThan(0);
  expect(writtenBytes).toBeLessThan((await fs.stat(receiptPath)).size * 12);
  expect(Object.keys(saved.entryNames)).toHaveLength(count);
  expect(result?.savedEntryIds).toHaveLength(count - 1);
  expect(result?.checks.find(check => check.entryId === 'memory-999')).toMatchObject({ status: 'needs-attention', message: 'IMPORT_DISK_FULL' });
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.pendingImport).toBeDefined();
  h.importDocument.mockResolvedValue(undefined);
  await startCompanionImport(selection, 'after-restart');
  const retried = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(retried?.status).toBe('complete'); expect(retried?.savedEntryIds).toHaveLength(count);
}, 10_000);

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
  expect(h.secretValues.size).toBe(2);
  const receiptText = await fs.readFile(path.join(h.root, 'companion-imports', `${rejected.requestId}.json`), 'utf8');
  expect(receiptText).not.toContain('fixture-private-key');
  expect(JSON.parse(receiptText).creationRejected).toBe('IMPORT_NAME_EXISTS');
  await expect(getCompanionImportResult(rejected.requestId)).rejects.toThrow('IMPORT_NAME_EXISTS');
  await expect(startCompanionImport({ ...rejected, previewId: 'expired-preview' }, 'other-controller')).rejects.toThrow('IMPORT_NAME_EXISTS');
  await startCompanionImport({ ...rejected, name: 'Grace', requestId: 'name-race-renamed-request' }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult('name-race-renamed-request'))?.status).toBe('complete'));
  expect(profiles.size).toBe(2);
  expect(h.secretValues.size).toBe(4);
  expect(h.pause).not.toHaveBeenCalled();
});

it('recovers rejected creation cleanup after a storage failure without retrying the impossible create', async () => {
  vi.mocked(createBotProfile).mockRejectedValue(new Error('[ALREADY_EXISTS] 同名伙伴'));
  const finish = vi.spyOn(h.store, 'finishRemoval').mockRejectedValueOnce(new CompanionImportError('CREDENTIAL_STORAGE_FAILED'));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'name-rejection-recovery', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true };
  await expect(startCompanionImport(selection, 'fixture')).rejects.toThrow('CREDENTIAL_STORAGE_FAILED');
  expect(h.secretValues.size).toBe(2);
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
  expect(h.secretValues.size).toBe(2);
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
  const basic = `Basic ${Buffer.from('alice:fixture-mcp-basic:password').toString('base64')}`;
  const secrets = ['fake-env-key', 'fake-local-key', 'fake-header-token', 'fake/url+key', 'fake-access-token', 'fake-refresh-token', '123:fake-telegram-token', 'fixture-cookie-session', 'fixture-cookie/second', 'alice:fixture-mcp-basic:password', 'fixture-mcp-basic:password'];
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
    { view: { id: 'mcp', name: 'Data', category: 'connections', selected: true }, mcp: { name: 'Data', url: 'https://example.invalid/mcp?token=fake%2Furl%2Bkey', env: { KEY: secrets[1]!, REFERENCED: '${DATA_TOKEN}' }, headers: { Authorization: `Bearer ${secrets[2]}`, 'Proxy-Authorization': basic, Cookie: 'session=fixture-cookie-session; another="fixture-cookie%2Fsecond"' } } },
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
    expect(stored.mcp[0]?.headers?.['Proxy-Authorization']).toBe(basic);
    expect(stored.mcp[0]?.headers?.Cookie).toBe('session=fixture-cookie-session; another="fixture-cookie%2Fsecond"');
  }
  expect(stored.env).not.toHaveProperty('EXCLUDED');
  expect(JSON.stringify(stored)).not.toContain('fake-absent-from-selected-content');
  expect(stored.documents).toEqual(Object.fromEntries(documents.map(item => [item.view.id, item.text])));
  await vi.waitFor(async () => {
    expect((await h.store.read(h.root, result.botId, () => {}))?.pendingImport).toBeUndefined();
  });
});

it.each([false, true])('publishes command env/argv/stdin credentials safely (command selected: %s)', async selected => {
  const secret = 'fixture-command-json-token';
  const nested = 'fixture-command-json-nested';
  const literalSecrets = ['fixture-argv-token', 'fixture-stdin-token', 'fixture-plain-token', 'fixture-header-token', 'fixture-form argv', 'fixture-form%20argv', 'fixture-form/env', 'fixture-form%2Fenv', 'fixture-curl-password', 'fixture-custom-header-key', 'fixture-command-cookie', 'alice:fixture-basic:password', 'fixture-basic:password'];
  const urlSecrets = ['fixture-hook-token', 'fixture-fragment token', 'fixture-fragment%20token',
    'fixture-raw token', 'fixture-raw%20token', 'fixture-raw-query', 'fixture-raw-fragment',
    'fixture-inherited token', 'fixture-inherited%20token', 'fixture-inherited-query'];
  const inheritedEnv = { WEBHOOK_URL: 'https://host/hooks/fixture-inherited%20token?token=fixture-inherited-query',
    DISPLAY_MODE: 'true', RETRY_COUNT: '7' };
  const config = JSON.stringify({ token: secret, credentials: [{ key: nested }],
    services: [{ endpoint: 'https://host/hooks/fixture-hook-token#access_token=fixture-fragment%20token' }],
    unused: { password: 'fixture-unused-command-secret' }, city: 'Paris', count: 7 });
  const text = `Keep node --mode -e, Paris and 7. ${secret} ${nested} ${urlSecrets.join(' ')} ${literalSecrets.join(' ')}`;
  const skill = `---\nname: report\ndescription: ${text}\n---\n${text}\n`;
  const original = { enabled: false, payload: { kind: 'command', argv: ['curl', '-u', 'alice:fixture-curl-password', '--config=' + JSON.stringify({ token: literalSecrets[0], city: 'Paris' }), '--token=' + literalSecrets[2], '-H', 'Authorization: Bearer ' + literalSecrets[3], '--proxy-header', 'Proxy-Authorization: Basic ' + Buffer.from('alice:fixture-basic:password').toString('base64'), '-H', 'X-API-Key: fixture-custom-header-key', '-HCookie: session=fixture-command-cookie', '--data', 'access_token=fixture-form%20argv&city=Paris'], input: JSON.stringify({ credentials: [{ privateKeyPem: literalSecrets[1] }], count: 7 }), env: { CONFIG: config, FORM: 'password=fixture-form%2Fenv&days=7', WEBHOOK_URL: 'https://host/hooks/fixture-raw%20token?token=fixture-raw-query#access_token=fixture-raw-fragment' } } };
  h.sourceEnabled = false;
  h.snapshot.items = [
    { view: { id: 'source-env', name: '.env', category: 'connections', selected: true }, env: inheritedEnv },
    { view: { id: 'task', name: text, category: 'automations', selected, enabled: false }, automation: { sourceId: 'task', fingerprint: 'fixture', original,
      input: { name: text, prompt: text, enabled: false, triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }] } } },
    { view: { id: 'memory', name: text, category: 'memory', selected: true }, text },
    { view: { id: 'skill', name: 'report', description: text, category: 'skills', selected: true }, filesComplete: true,
      files: [{ name: 'SKILL.md', bytes: Buffer.from(skill), executable: false }] },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const remote = await readRemoteCompanionImport(`preview:${source!.id}`, 'fixture', false);
  for (const value of [secret, nested, ...urlSecrets, ...literalSecrets]) expect(JSON.stringify(remote)).not.toContain(value);
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-json-command-publication';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada',
    entryIds: ['source-env', 'memory', 'skill', ...(selected ? ['task'] : [])], takeover: false }, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.saved).toBe(true));
  const published = await fs.readFile(path.join(h.root, 'bots', result.botId, 'skills/report/SKILL.md'), 'utf8');
  const receiptText = await fs.readFile(path.join(h.root, 'companion-imports', `${requestId}.json`), 'utf8');
  const output = JSON.stringify([published, h.importDocument.mock.calls, h.routines, receiptText]);
  for (const value of [secret, nested, ...urlSecrets, ...literalSecrets]) expect(output).not.toContain(value);
  expect(published).toContain('Keep node --mode -e, Paris and 7.');
  const stored = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(stored.env).toEqual(inheritedEnv);
  expect(stored.documents?.memory).toBe(text);
  const savedSkill = stored.skillFiles?.report?.find(file => file.name === 'SKILL.md');
  expect(Buffer.from(savedSkill!.bytes, 'base64').toString()).toBe(skill);
  if (selected) {
    expect(stored.sourceAutomations?.[0]?.original).toEqual(original);
    expect(h.routines).toHaveLength(1);
    expect(h.routines[0]?.enabled).toBe(false);
  } else {
    expect(h.routines).toHaveLength(0);
    expect(JSON.stringify(stored)).not.toContain('fixture-unused-command-secret');
  }
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


it.each(['count', 'entrypoint', 'projected-entrypoint', 'captured-entrypoint'])('imports skill %s beyond the old authoring and count quotas', async mode => {
  const count = mode === 'count' ? 142 : 1;
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
  const accepted = await startCompanionImport(selection, 'fixture');
  // Acceptance can precede the 142 real filesystem writes. Join the existing
  // profile transaction instead of racing vi.waitFor's one-second deadline.
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.status).toBe('complete');
  expect(result?.savedEntryIds).toEqual(expect.arrayContaining(selection.entryIds));
  expect(await fs.readdir(path.join(h.root, 'bots', accepted.botId, 'skills'))).toHaveLength(count);
  expect(createBotProfile).toHaveBeenCalledOnce();
});

it.each(['oversized', 'symlink'])('retains a failed %s skill for retry while saving the companion and healthy content', async mode => {
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
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.saved).toBe(true));
  expect(createBotProfile).toHaveBeenCalled();
  expect((await getCompanionImportResult(selection.requestId))?.checks).toContainEqual({ entryId: 'skill', status: 'needs-attention', message: mode === 'oversized' ? 'SOURCE_FILE_TOO_LARGE' : 'SOURCE_LINK_OUTSIDE_FOLDER' });
  expect(h.secretValues.size).toBeGreaterThan(0);
  // A corrected resource can finish under the same request; no second companion is needed.
  await fs.rm(path.join(directory, mode === 'oversized' ? 'resource.bin' : 'linked'), { recursive: true });
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
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
  expect(h.created).toBe(false); expect(values.size).toBe(failure === 'binding' ? 2 : 1);
  await expect(fs.access(bindingFile)).rejects.toThrow();
  bindingFailure?.mockRestore();
  // A new vault instance and the startup receipt scan must find and remove it,
  // including when the first cleanup attempt also fails.
  const remove = vi.fn((key: string) => { values.delete(key); return true; }).mockReturnValueOnce(false);
  h.store = createCompanionEnvironmentStore({ read: key => values.get(key) ?? null, write: () => true, remove });
  // A committed profile or an uncertain lookup must never lose its vault key.
  vi.mocked(getBotRemoteResourceSource).mockResolvedValueOnce({ canonicalSessionId: 'chat' } as never);
  await recoverCompanionImports();
  expect(values.size).toBe(failure === 'binding' ? 2 : 1); expect(remove).not.toHaveBeenCalled();
  vi.mocked(getBotRemoteResourceSource).mockRejectedValueOnce(new Error('fixture database unavailable'));
  await recoverCompanionImports();
  expect(values.size).toBe(failure === 'binding' ? 2 : 1); expect(remove).not.toHaveBeenCalled();
  await recoverCompanionImports();
  expect(values.size).toBe(failure === 'binding' ? 2 : 1);
  await recoverCompanionImports();
  expect(values.size).toBe(0); expect(remove).toHaveBeenCalledTimes(3);
  expect(h.created).toBe(false);
});

it('adopts Cindy settings only for explicitly selected items and still requires takeover verification', async () => {
  const { useCindyImportSettings, continueCompanionImport } = await import('../host.js');
  h.snapshot.items = [{ view: { id: 'task', name: 'Report', category: 'automations', selected: true, enabled: true, issues: ['SOURCE_TOOL_POLICY_NEEDS_MAPPING', 'AUTOMATION_MODEL_NEEDS_MAPPING', 'AUTOMATION_CONTEXT_NEEDS_MAPPING'] },
    automation: { sourceId: 'source-task', fingerprint: 'fixture', original: {}, input: { name: 'Report', prompt: 'Read data', enabled: false, triggers: [{ id: 'time', kind: 'interval', intervalMs: 60000 }] } } }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-cindy-settings', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true, deferSetup: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.saved).toBe(true));
  const result = (await getCompanionImportResult(selection.requestId))!;
  await expect(useCindyImportSettings(result.botId, h.root, ['unknown'], () => {})).rejects.toThrow('INVALID_SELECTION');
  await useCindyImportSettings(result.botId, h.root, ['task'], () => {});
  await continueCompanionImport(result.botId, h.root, () => {});
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.checks).toContainEqual({ entryId: 'task', status: 'needs-attention', message: 'AUTOMATION_CONTEXT_NEEDS_MAPPING' }));
});

it('refreshes masks and encrypted originals when a previously failed credential-bearing resource is repaired', async () => {
  const directory = path.join(h.root, 'source-skill');
  const outside = path.join(h.root, 'outside');
  await fs.mkdir(directory); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'read.txt'), 'outside');
  await fs.symlink(outside, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const secret = 'fixture-unselected-resource-secret';
  h.snapshot.items = [
    { view: { id: 'skill', name: 'report', category: 'skills', selected: true }, sourceDirectory: directory, files: [{ name: 'SKILL.md', bytes: Buffer.from('# Report'), executable: false }], filesComplete: false, envDependencies: { names: [], entries: [] } },
    { view: { id: 'unselected', name: 'PRIVATE', category: 'connections', selected: false }, env: { PRIVATE: secret } },
  ];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-repaired-private-skill', previewId: preview.id, name: 'Ada', entryIds: ['skill'], takeover: false, deferSetup: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.saved).toBe(true));
  await fs.rm(path.join(directory, 'escape'), { recursive: true });
  await fs.writeFile(path.join(directory, 'read.txt'), `Token ${secret}`);
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const result = (await getCompanionImportResult(selection.requestId))!;
  expect(await fs.readFile(path.join(h.root, 'bots', result.botId, 'skills/report/read.txt'), 'utf8')).not.toContain(secret);
  const environment = (await h.store.read(h.root, result.botId, () => {}))!;
  expect(environment.env).toEqual({});
  const original = environment.skillFiles?.report?.find(file => file.name === 'read.txt');
  expect(Buffer.from(original!.bytes, 'base64').toString()).toContain(secret);
  expect(Object.values(environment.contentRedactions ?? {})).toContain(secret);
});

it('transfers a 10,000-entry preview in bounded, immutable chunks and preserves selection indexes', async () => {
  h.snapshot.items = Array.from({ length: 10_000 }, (_, index) => ({ view: { id: `skill-${index}`, name: `技能 ${index} ` + 'long name '.repeat(20), description: '説明😀'.repeat(60), category: 'skills' as const, selected: true } }));
  let reads = 0;
  let continuation = '';
  const api = remoteCompanionImportApi(async id => {
    const data = await readRemoteCompanionImport(id, 'phone', true);
    const response = { blocks: [{ primitive: 'companion-import', data }] };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(2 * 1024 * 1024 - 4096);
    reads++;
    if (id.startsWith('chunk:')) continuation = id;
    return response;
  }, async () => {});
  const [source] = await api.sources();
  const preview = await api.preview(source!.id);
  expect(preview.entries).toEqual(h.snapshot.items.map(item => item.view));
  expect(reads).toBeGreaterThan(2);
  expect(inspectImportSource).toHaveBeenCalledOnce();
  expect(compactCompanionImportSelection(preview, preview.entries.filter((_, index) => index !== 500).map(entry => entry.id)))
    .toEqual({ entryIds: [], entryRanges: [[0, 499], [501, 9999]] });
  const again = await readRemoteCompanionImport(continuation, 'phone', true);
  expect(await readRemoteCompanionImport(continuation, 'phone', true)).toEqual(again);
  await expect(readRemoteCompanionImport(continuation, 'other-phone', true)).rejects.toThrow('PREVIEW_EXPIRED');
  h.boundary = true;
  await expect(readRemoteCompanionImport(continuation, 'phone', true)).rejects.toThrow('OWNER_CHANGED');
  h.boundary = false;
  const [legacySource] = await listCompanionImportSources('old-phone');
  await expect(readRemoteCompanionImport(`preview:${legacySource!.id}`, 'old-phone', false)).rejects.toThrow('IMPORT_CLIENT_UPGRADE_REQUIRED');
  expect(h.created).toBe(false);
  expect(h.snapshot.items).toHaveLength(10_000);
  expect(await readRemoteCompanionImport(continuation, 'phone', true)).toEqual(again);
});

it.each(['directory', undefined] as const)('retries a repaired memory directory with its original request, including legacy kind=%s', async kind => {
  const storage = new MemoryStorage(path.join(h.root, 'real-memory'), DEFAULT_MEMORY_CONFIG);
  await storage.init(h.root);
  const memory = createBotMemoryService({ getStore: async () => storage as unknown as MakerMemoryStore, readBot: async () => ({ canonicalSessionId: null }), requestRefresh: async () => {} });
  let releaseMemoryWrite!: () => void;
  const memoryWrite = new Promise<void>(resolve => { releaseMemoryWrite = resolve; });
  h.importDocument.mockImplementation(memory.importDocument).mockImplementationOnce(async (...args: Parameters<typeof memory.importDocument>) => {
    await memoryWrite;
    await memory.importDocument(...args);
  });
  const brokenId = `memory-${fingerprint('broken').slice(0, 20)}`;
  const directory = path.join(h.root, 'memory', 'broken');
  const memoryRoot = path.join(h.root, 'memory');
  await fs.mkdir(memoryRoot);
  h.snapshot.items = [
    { view: { id: 'healthy', name: 'healthy.md', category: 'memory', selected: true }, text: 'Healthy' },
    { view: { id: brokenId, name: 'broken', category: 'memory', selected: true }, captureIssue: 'IMPORT_ITEM_FAILED', sourceFile: { root: memoryRoot, file: directory, ...(kind ? { kind } : {}) } },
  ];
  const [source] = await listCompanionImportSources('phone');
  const preview = await previewCompanionImport(source!.id, 'phone');
  const selection = { previewId: preview.id, requestId: 'retry-memory-directory', name: 'Ada', entryIds: ['healthy', brokenId], takeover: false, deferSetup: true };
  const first = await startCompanionImport(selection, 'phone');
  // Force acceptance to happen before the real memory write finishes. The API
  // deliberately returns running here, independently of filesystem speed.
  try { expect(first.status).toBe('running'); } finally { releaseMemoryWrite(); }
  const failed = await withBotProfileLocks([first.botId], () => getCompanionImportResult(selection.requestId));
  expect(failed?.status).toBe('needs-attention');
  expect(h.importDocument).toHaveBeenCalledTimes(1);
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'nested', 'note.md'), 'Recovered note');
  await fs.writeFile(path.join(directory, 'USER.md'), 'User preferences');
  await fs.writeFile(path.join(directory, 'ignored.txt'), 'Recovered TXT archive');
  await startCompanionImport(selection, 'reconnected-phone');
  const result = await withBotProfileLocks([first.botId], () => getCompanionImportResult(selection.requestId));
  expect(result).toMatchObject({ status: 'complete', botId: first.botId, savedEntryIds: ['healthy', brokenId] });
  expect(h.importDocument).toHaveBeenCalledTimes(4);
  expect(h.importDocument).toHaveBeenCalledWith(first.botId, expect.stringMatching(/^memory-[a-f0-9]{32}$/), 'broken/nested/note.md', 'Recovered note', 'reference');
  expect(h.importDocument).toHaveBeenCalledWith(first.botId, expect.stringMatching(/^memory-[a-f0-9]{32}$/), 'broken/USER.md', 'User preferences', 'user');
  expect((await storage.list()).map(record => [record.frontmatter.type, record.body.trim()])).toEqual(expect.arrayContaining([
    ['reference', 'Recovered TXT archive'], ['reference', 'Healthy'], ['reference', 'Recovered note'], ['user', 'User preferences'],
  ]));
  const environment = await h.store.read(h.root, first.botId, () => {});
  expect(Object.values(environment!.documents!)).toEqual(expect.arrayContaining(['Healthy', 'Recovered note', 'User preferences']));
  await startCompanionImport(selection, 'phone');
  expect(h.importDocument).toHaveBeenCalledTimes(4);
  expect(await storage.list()).toHaveLength(4);
});

it.each([false, true])('publishes completion after deferred setup without duplicate notices (legacy setup: %s)', async legacySetup => {
  const requestId = 'fixture-setup-to-ready';
  const rows = new Map<string, string>();
  if (legacySetup) rows.set(`chat:companion-import:${requestId}`, t('bots.import.chatSetup'));
  // Match createMessage's persisted (sessionId, clientId) uniqueness contract.
  vi.mocked(createMessage).mockImplementation(async (sessionId, body) => {
    const key = `${sessionId}:${body.clientId}`;
    if (typeof body.content !== 'string') throw new Error('Expected a text import notice');
    if (!rows.has(key)) rows.set(key, body.content);
    return {} as never;
  });
  const { continueCompanionImport } = await import('../host.js');
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId, previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true, deferSetup: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('needs-attention'));
  await vi.waitFor(() => expect(rows.size).toBe(1));
  const result = (await getCompanionImportResult(requestId))!;
  // An unsuccessful setup retry must not spam another setup notice.
  await continueCompanionImport(result.botId, h.root, () => {});
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('needs-attention'));
  expect(rows.size).toBe(1);
  h.verified = true;
  await continueCompanionImport(result.botId, h.root, () => {});
  await vi.waitFor(async () => expect((await getCompanionImportResult(requestId))?.status).toBe('complete'));
  await vi.waitFor(() => expect(rows.size).toBe(2));
  expect([...rows.values()]).toEqual([t('bots.import.chatSetup'), t('bots.import.chatReady')]);
  expect([...rows.keys()]).toEqual([`chat:companion-import:${requestId}`, `chat:companion-import:${requestId}:ready`]);
  await startCompanionImport(selection, 'fixture');
  expect(rows.size).toBe(2);
  expect(h.pause).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps the original deferred setup choice across retries and checkpoints (legacy receipt: %s)', async legacy => {
  const { continueCompanionImport } = await import('../host.js');
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-identity-setup', previewId: preview.id, name: 'Ada', entryIds: ['task'], takeover: true, deferSetup: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const result = (await getCompanionImportResult(selection.requestId))!;
  const receiptFile = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  if (legacy) {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
    delete receipt.deferSetup;
    receipt.selectionHash = fingerprint([selection.name, undefined, selection.entryIds, selection.takeover, h.snapshot.source.kind, h.snapshot.source.agentId, h.snapshot.source.root]);
    receipt.result.checks = [];
    await fs.writeFile(receiptFile, JSON.stringify(receipt));
  }
  const saved = await fs.readFile(receiptFile, 'utf8');
  h.verified = true;
  await expect(startCompanionImport({ ...selection, deferSetup: false }, 'fixture')).rejects.toThrow('REQUEST_ALREADY_USED');
  expect(await fs.readFile(receiptFile, 'utf8')).toBe(saved);
  expect(h.pause).not.toHaveBeenCalled();
  // A reconnected controller uses the checkpoint even after losing preview access.
  await expect(startCompanionImport({ ...selection, deferSetup: false }, 'reconnected')).rejects.toThrow('REQUEST_ALREADY_USED');
  await continueCompanionImport(result.botId, h.root, () => {});
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect(h.pause).toHaveBeenCalledOnce();
  expect(JSON.parse(await fs.readFile(receiptFile, 'utf8')).deferSetup).toBe(true);
});

it.each(['hermes', 'openclaw'] as const)('restores disabled %s skill metadata and private settings after an unreadable manifest is repaired', async kind => {
  const actual = await vi.importActual<typeof import('../sources.js')>('../sources.js');
  // The repaired manifest supplies a new mask during validateItems, after the
  // initial redactor was created; the source-wide scan need not know that mask.
  vi.mocked(createImportSourceReader).mockImplementation((...args) => ({ ...actual.createImportSourceReader(...args), readRedactions: async () => ({}) }));
  h.snapshot.source.kind = kind;
  const secret = 'fixture-repaired-skill-secret';
  const config = { skills: { disabled: ['report'], entries: { 'report-auth': { enabled: false, apiKey: secret, env: { REPORT_REGION: 'fixture' } } } } };
  await fs.writeFile(h.snapshot.source.configFile, JSON.stringify(config));
  const directory = path.join(h.root, 'skills', 'folder-name');
  await fs.mkdir(directory, { recursive: true });
  const manifest = path.join(directory, 'SKILL.md');
  await fs.writeFile(manifest, '');
  await fs.truncate(manifest, 16 * 1024 * 1024 + 1);
  const { discoverImportSkills } = await import('../skills.js');
  const { createImportBudget } = await import('../files.js');
  h.snapshot.items = await discoverImportSkills(h.snapshot.source, config, h.root, {}, createImportBudget());
  expect(h.snapshot.items[0]?.captureIssue).toBe('SOURCE_FILE_TOO_LARGE');
  const entryId = h.snapshot.items[0]!.view.id;
  h.snapshot.items.push({ view: { id: 'role', name: 'USER.md', category: 'memory', selected: true }, text: `Private value ${secret}`, role: 'user' });
  h.importDocument.mockRejectedValue(new Error('fixture write failure'));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-repair-manifest', previewId: preview.id, name: 'Ada', entryIds: [entryId, 'role'], takeover: false, deferSetup: true };
  await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const first = (await getCompanionImportResult(selection.requestId))!;
  await fs.writeFile(manifest, `---\nname: report\ndescription: Recovered report ${secret}\nmetadata:\n  openclaw:\n    skillKey: report-auth\n    primaryEnv: REPORT_TOKEN\n---\n# Report\nPrivate value ${secret}`);
  h.importDocument.mockResolvedValue(undefined);
  await startCompanionImport(selection, 'reconnected');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  const result = (await getCompanionImportResult(selection.requestId))!;
  expect(result).toMatchObject({ botId: first.botId, savedEntryIds: [entryId, 'role'] });
  expect(h.importDocument.mock.lastCall?.[3]).toMatch(/^Private value \[[^\]]+\]$/);
  expect(h.profile.userContextSource).toMatch(/^Private value \[[^\]]+\]$/);
  const environment = (await h.store.read(h.root, first.botId, () => {}))!;
  expect(environment.env).toMatchObject({ REPORT_TOKEN: secret, REPORT_REGION: 'fixture' });
  const readable = await fs.readFile(path.join(h.root, 'bots', first.botId, 'disabled-skills', 'report', 'SKILL.md'), 'utf8');
  expect(readable).toContain('name: report');
  expect(readable).not.toContain(secret);
  await expect(fs.stat(path.join(h.root, 'bots', first.botId, 'skills', 'report'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.stringify(result)).not.toContain(secret);
  const receipt = JSON.parse(await fs.readFile(path.join(h.root, 'companion-imports', `${selection.requestId}.json`), 'utf8'));
  expect(JSON.stringify(receipt.entryNames)).not.toContain(secret);
});

it.each(['short-legacy-document', `memory-${'a'.repeat(20)}-${'b'.repeat(20)}`])('resumes saved recovered documents with stable storage IDs across lost acknowledgements: %s', async originalId => {
  const storage = new MemoryStorage(path.join(h.root, 'real-memory'), DEFAULT_MEMORY_CONFIG);
  await storage.init(h.root);
  const memory = createBotMemoryService({ getStore: async () => storage as unknown as MakerMemoryStore, readBot: async () => ({ canonicalSessionId: null }), requestRefresh: async () => {} });
  h.importDocument.mockImplementation(memory.importDocument).mockImplementationOnce(async (...args: Parameters<typeof memory.importDocument>) => {
    await memory.importDocument(...args);
    throw new Error('fixture lost acknowledgement');
  });
  h.snapshot.items = [{ view: { id: 'memory-original-entry', name: 'Recovered subtree', category: 'memory', selected: true },
    documents: [{ id: originalId, name: 'subtree/note.md', text: 'Recovered content' }] }];
  const [source] = await listCompanionImportSources('phone');
  const preview = await previewCompanionImport(source!.id, 'phone');
  const selection = { previewId: preview.id, requestId: 'fixture-recovered-docs', name: 'Ada', entryIds: ['memory-original-entry'], takeover: false, deferSetup: true };
  await startCompanionImport(selection, 'phone');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const result = (await getCompanionImportResult(selection.requestId))!;
  // Simulate the old durable checkpoint, without an available source tree.
  await h.store.update(h.root, result.botId, () => {}, environment => {
    const snapshot = JSON.parse(environment.pendingImport!.snapshotJson);
    snapshot.items[0].documents[0].id = originalId;
    environment.pendingImport!.snapshotJson = JSON.stringify(snapshot);
  });
  const firstFiles = (await storage.list()).map(record => record.filename);
  expect(firstFiles).toHaveLength(1);
  await startCompanionImport(selection, 'reconnected');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('complete'));
  expect((await storage.list()).map(record => record.filename)).toEqual(firstFiles);
  const ids = h.importDocument.mock.calls.map(call => call[1] as string);
  expect(ids[0]).toBe(ids[1]);
  expect(ids.every(id => id.length <= 40)).toBe(true);
  if (originalId.length <= 40) expect(ids[0]).toBe(originalId);
});

it('publishes a partial-save notice with the failed filename and safe reason, then a distinct completion notice', async () => {
  h.snapshot.items = [{ view: { id: 'memory-doc', name: 'long-document.md', category: 'memory', selected: true }, text: 'Source text' }];
  h.importDocument.mockRejectedValueOnce(Object.assign(new Error('private filesystem path'), { code: 'ENOSPC', importProgress: { saved: 1, total: 3 } }));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-partial-notice', previewId: preview.id, name: 'Ada', entryIds: ['memory-doc'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(first).toMatchObject({ saved: true, status: 'needs-attention', savedEntryIds: [] });
  const notice = vi.mocked(createMessage).mock.calls.at(-1)![1];
  expect(notice.content).toContain(t('bots.import.chatPartial'));
  expect(notice.content).toContain('long-document.md');
  expect(notice.content).toContain(t('bots.import.diskFull'));
  expect(notice.content).not.toContain('private filesystem path');
  await startCompanionImport(selection, 'fixture');
  const completed = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(completed?.status).toBe('complete');
  expect(vi.mocked(createMessage).mock.calls.at(-1)![1]).toMatchObject({ clientId: `companion-import:${selection.requestId}:ready`, content: t('bots.import.chatReady') });
});

it.each([0, 1])('counts earlier recovered documents when a later document fails after %s chunks', async failedAfter => {
  const storage = new MemoryStorage(path.join(h.root, 'real-memory'), DEFAULT_MEMORY_CONFIG);
  await storage.init(h.root);
  const write = storage.write.bind(storage);
  let fail = true;
  vi.spyOn(storage, 'write').mockImplementation(async input => {
    if (fail && input.name === `import_second_${failedAfter}`) throw Object.assign(new Error('private disk path'), { code: 'ENOSPC' });
    return write(input);
  });
  const memory = createBotMemoryService({ getStore: async () => storage as unknown as MakerMemoryStore,
    readBot: async () => ({ canonicalSessionId: null }), requestRefresh: async () => {} });
  h.importDocument.mockImplementation(memory.importDocument);
  h.snapshot.items = [{ view: { id: 'memory-directory', name: 'Recovered directory', category: 'memory', selected: true }, documents: [
    { id: 'first', name: 'first.md', text: 'a'.repeat(BOT_MEMORY_BODY_MAX_BYTES + 1) },
    { id: 'second', name: 'second.md', text: 'b'.repeat(BOT_MEMORY_BODY_MAX_BYTES + 1) },
    { id: 'third', name: 'third.md', text: 'Still to save' },
  ] }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-directory-progress', previewId: preview.id, name: 'Ada', entryIds: ['memory-directory'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(first?.checks).toContainEqual({ entryId: 'memory-directory', status: 'needs-attention', message: 'IMPORT_DISK_FULL', progress: { saved: 3 + failedAfter, total: 5 } });
  expect(await storage.list()).toHaveLength(3 + failedAfter);
  fail = false;
  await startCompanionImport(selection, 'reconnected');
  const completed = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(completed).toMatchObject({ status: 'complete', savedEntryIds: ['memory-directory'] });
  expect(await storage.list()).toHaveLength(5);
});

it('keeps oversized profile text as original Unicode while preserving the entire source in memory', async () => {
  const text = 'Source instructions\n' + '😀原文'.repeat(20_000);
  h.snapshot.items = [{ view: { id: 'instructions', name: 'AGENTS.md', category: 'personality', selected: true }, role: 'instructions', text }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'fixture-original-profile', previewId: preview.id, name: 'Ada', entryIds: ['instructions'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.status).toBe('complete');
  const profile = h.writeProfile.mock.calls.at(-1)![2].systemPromptOverride as string;
  expect(text.startsWith(profile)).toBe(true);
  expect(Buffer.byteLength(profile, 'utf8')).toBeLessThanOrEqual(100_000);
  expect(Buffer.byteLength(profile, 'utf8')).toBeGreaterThan(99_996);
  expect(profile).not.toContain('�');
  expect(h.importDocument).toHaveBeenCalledWith(accepted.botId, 'instructions', 'AGENTS.md', text, 'reference');
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.documents?.instructions).toBe(text);
});


it('retries legacy text and empty memory assets without passing them to the media importer', async () => {
  h.snapshot.items = [
    { view: { id: 'old-json', name: 'state.json', category: 'memory', selected: true }, asset: { name: 'memory/state.json', bytes: Buffer.from('{"cursor":7}\n') } },
    { view: { id: 'old-marker', name: '.report.sent', category: 'memory', selected: true }, asset: { name: 'memory/.report.sent', bytes: Buffer.alloc(0) } },
  ];
  const [source] = await listCompanionImportSources('phone');
  const preview = await previewCompanionImport(source!.id, 'phone');
  const selection = { previewId: preview.id, requestId: 'legacy-memory-assets', name: 'Ada', entryIds: ['old-json', 'old-marker'], takeover: false, deferSetup: true };
  const first = await startCompanionImport(selection, 'phone');
  const result = await withBotProfileLocks([first.botId], () => getCompanionImportResult(selection.requestId));
  expect(result).toMatchObject({ status: 'complete', savedEntryIds: ['old-json', 'old-marker'] });
  expect(h.importDocument).toHaveBeenCalledOnce();
  expect(h.importDocument).toHaveBeenCalledWith(first.botId, expect.stringMatching(/^memory-[a-f0-9]{32}$/), 'memory/state.json', '{"cursor":7}\n', 'reference');
  const environment = await h.store.read(h.root, first.botId, () => {});
  expect(environment?.memoryFiles).toEqual({ 'memory/state.json': Buffer.from('{"cursor":7}\n').toString('base64'), 'memory/.report.sent': '' });
  expect(environment?.files).toEqual({});
  await startCompanionImport(selection, 'phone');
  expect(h.importDocument).toHaveBeenCalledOnce();
});

it('receives sparse selection chunks idempotently and starts only after the complete authorized selection', async () => {
  h.snapshot.items = Array.from({ length: 10_000 }, (_, index) => ({ view: { id: `memory-${index}`, name: `Note ${index}`, category: 'memory' as const, selected: index % 2 === 0 }, text: 'Original' }));
  const [source] = await listCompanionImportSources('phone');
  const preview = await previewCompanionImport(source!.id, 'phone');
  const chosen = preview.entries.filter(entry => entry.selected).map(entry => entry.id);
  const selection = { previewId: preview.id, requestId: 'sparse-selection-fixture', name: 'Ada', takeover: false, deferSetup: true, ...compactCompanionImportSelection(preview, chosen) };
  const parts = [...companionImportSubmissions(selection, preview.selectionChunks)];
  expect(parts.length).toBeGreaterThan(2);
  await expect(submitRemoteCompanionImport(parts[1]!, 'other-phone')).rejects.toThrow('PREVIEW_EXPIRED');
  expect(await submitRemoteCompanionImport(parts[0]!, 'phone')).toBeUndefined();
  expect(await submitRemoteCompanionImport(parts[0]!, 'phone')).toBeUndefined();
  expect(createBotProfile).not.toHaveBeenCalled();
  if (!('selectionChunk' in parts[0]!)) throw Error('expected chunks');
  await expect(submitRemoteCompanionImport({ selectionChunk: { ...parts[0]!.selectionChunk, text: 'x'.repeat(parts[0]!.selectionChunk.text.length) } }, 'phone')).rejects.toThrow('REQUEST_ALREADY_USED');
  h.boundary = true;
  await expect(submitRemoteCompanionImport(parts[1]!, 'phone')).rejects.toThrow('OWNER_CHANGED');
  h.boundary = false;
  let accepted;
  for (const part of parts) accepted = await submitRemoteCompanionImport(part, 'phone');
  const result = await withBotProfileLocks([accepted!.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.savedEntryIds).toEqual(chosen);
  expect(h.importDocument).toHaveBeenCalledTimes(chosen.length);
  for (const part of parts) await submitRemoteCompanionImport(part, 'phone');
  await withBotProfileLocks([accepted!.botId], () => getCompanionImportResult(selection.requestId));
  expect(createBotProfile).toHaveBeenCalledTimes(1);
  expect(h.importDocument).toHaveBeenCalledTimes(chosen.length);
});

it('archives unsupported automation definitions and blocks both management and runtime execution', async () => {
  const original = { id: 'native', schedule: { kind: 'source-specific' }, payload: { kind: 'heartbeat' }, delivery: { channel: 'missing-channel', to: 'original-recipient' } };
  h.snapshot.source.kind = 'openclaw';
  const item = normalizeAutomation(h.snapshot.source, original, indexAutomationDependencies([]), 'UTC');
  h.snapshot.items = [item];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'unsupported-original-task', previewId: preview.id, name: 'Ada', entryIds: [item.view.id], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result).toMatchObject({ savedEntryIds: [item.view.id], status: 'needs-attention' });
  const env = await h.store.read(h.root, accepted.botId, () => {});
  expect(env?.sourceAutomations?.[0]?.original).toEqual(original);
  const routine = h.routines[0]!;
  expect(routine).toMatchObject({ enabled: false, triggers: [] });
  expect(env?.automations?.[routine.id]?.original).toEqual(original);
  await expect(assertImportedAutomationReady(h.root, accepted.botId, routine.id, () => {})).rejects.toThrow('AUTOMATION_TRIGGER_NEEDS_ADAPTER');
  await expect(prepareImportedAutomation(h.root, routine, 'run', new AbortController().signal, () => {})).rejects.toThrow('AUTOMATION_TRIGGER_NEEDS_ADAPTER');
  expect(h.pause).not.toHaveBeenCalled();
  expect(verifyImportedAutomation).not.toHaveBeenCalled();
  await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.routines).toHaveLength(1);
});

it('keeps a whitespace-edited partial memory retry pending instead of reporting it copied', async () => {
  const directory = path.join(h.root, 'real-memory');
  const storage = new MemoryStorage(directory, DEFAULT_MEMORY_CONFIG);
  await storage.init(h.root);
  const memory = createBotMemoryService({ getStore: async () => storage as unknown as MakerMemoryStore, readBot: async () => ({ canonicalSessionId: null }), requestRefresh: async () => {} });
  h.importDocument.mockImplementation(memory.importDocument);
  const text = '  ' + 'x'.repeat(BOT_MEMORY_BODY_MAX_BYTES) + '\nLast paragraph';
  h.snapshot.items = [{ view: { id: 'memory', name: 'Original', category: 'memory', selected: true }, text }];
  const write = storage.write.bind(storage);
  const failure = vi.spyOn(storage, 'write').mockImplementation(async opts => {
    if (opts.name.endsWith('_1')) throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
    return write(opts);
  });
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'whitespace-memory-retry', previewId: preview.id, name: 'Ada', entryIds: ['memory'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(first?.checks).toContainEqual({ entryId: 'memory', status: 'needs-attention', message: 'IMPORT_DISK_FULL', progress: { saved: 1, total: 2 } });
  failure.mockRestore();
  const file = path.join(directory, 'reference_import_memory_0.md');
  await fs.appendFile(file, '\n  ');
  const edited = await fs.readFile(file, 'utf8');
  await startCompanionImport(selection, 'fixture');
  const retried = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(retried?.status).toBe('needs-attention');
  expect(retried?.checks).toContainEqual({ entryId: 'memory', status: 'needs-attention', message: 'MEMORY_CHANGED', progress: { saved: 0, total: 2 } });
  expect(retried?.savedEntryIds ?? []).not.toContain('memory');
  expect(await fs.readFile(file, 'utf8')).toBe(edited);
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.pendingImport).toBeDefined();
});

it('continues healthy recovered documents when a sibling attachment fails', async () => {
  h.importMedia.mockRejectedValueOnce(Object.assign(new Error('media failed'), { code: 'ENOSPC' }));
  h.snapshot.items = [{ view: { id: 'mixed', name: 'Recovered', category: 'memory', selected: true },
    documents: [{ id: 'healthy', name: 'healthy.md', text: 'Keep this note' }],
    files: [{ name: 'image.png', bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), executable: false }] }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'mixed-directory-retry', previewId: preview.id, name: 'Ada', entryIds: ['mixed'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.importDocument).toHaveBeenCalledWith(accepted.botId, 'healthy', 'healthy.md', 'Keep this note', 'reference');
  expect(first?.checks).toContainEqual({ entryId: 'mixed', status: 'needs-attention', message: 'IMPORT_DISK_FULL', progress: { saved: 1, total: 2 } });
  const pending = await h.store.read(h.root, accepted.botId, () => {});
  expect(pending?.files).toEqual({});
  expect(pending?.memoryFiles).toEqual({});
  const checkpoint = await deserializeImportSnapshotAsync(pending!.pendingImport!.snapshotJson, () => {});
  const original = h.snapshot.items[0]!.files![0]!;
  expect(checkpoint.items[0]!.files![0]!.bytes).toEqual(original.bytes);
  // An old failed import may already have mixed attachment bytes into files.
  await h.store.update(h.root, accepted.botId, () => {}, env => { env.files = { [original.name]: original.bytes.toString('base64') }; });
  await startCompanionImport(selection, 'fixture');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.savedEntryIds).toContain('mixed');
  const completed = await h.store.read(h.root, accepted.botId, () => {});
  expect(completed?.files).toEqual({});
  expect(completed?.pendingImport).toBeUndefined();
  expect(h.importMedia).toHaveBeenLastCalledWith(accepted.botId, 'chat', original.bytes, expect.any(Function));
});

it('applies healthy recovered role text even while an attachment keeps failing', async () => {
  const directory = path.join(h.root, 'memories', 'broken');
  const brokenId = `memory-${fingerprint('memories/broken').slice(0, 20)}`;
  h.snapshot.items = [{ view: { id: brokenId, name: 'broken', category: 'memory', selected: true },
    sourceFile: { root: path.dirname(directory), file: directory, kind: 'directory' }, captureIssue: 'IMPORT_PERMISSION_DENIED' }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'mixed-repaired-role-fixture', previewId: preview.id, name: 'Ada', entryIds: [brokenId], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'USER.md'), 'Healthy user preferences');
  await fs.writeFile(path.join(directory, 'bad.bin'), Buffer.from([0, 255, 0, 255]));
  await fs.mkdir(path.join(directory, 'later'));
  await fs.writeFile(path.join(directory, 'later/USER.md'), 'Later user preferences');
  let failRole = true; let failEarlierRole = false;
  h.importDocument.mockImplementation(async (_bot, _id, name) => {
    if ((failRole && name.endsWith('later/USER.md')) || (failEarlierRole && !name.endsWith('later/USER.md'))) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
  });
  h.importMedia.mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'SOURCE_MEMORY_ATTACHMENT_UNSUPPORTED' }));
  await startCompanionImport(selection, 'fixture');
  let result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile.userContextSource).toBe('Healthy user preferences');
  expect(result?.status).toBe('needs-attention');
  expect(result?.savedEntryIds ?? []).not.toContain(brokenId);
  expect(result?.checks.find(check => check.entryId === brokenId)?.progress).toEqual({ saved: 1, total: 3 });
  const stored = (await h.store.read(h.root, accepted.botId, () => {}))!;
  expect(Object.values(stored.documents ?? {})).toContain('Healthy user preferences');
  expect(stored.pendingImport).toBeDefined();
  expect(Object.values(stored.documents ?? {})).not.toContain('Later user preferences');
  failRole = false; failEarlierRole = true;
  await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile.userContextSource).toContain('Healthy user preferences');
  expect(h.profile.userContextSource).toContain('Later user preferences');
  failEarlierRole = false;
  // A later retry of the bad attachment must preserve edits to the applied profile.
  h.profile.userContextSource = 'User edited preferences';
  await startCompanionImport(selection, 'fixture');
  result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile.userContextSource).toBe('User edited preferences');
  expect(result?.status).toBe('needs-attention');
});

it.each([['file', true], ['directory', true], ['file', false], ['directory', false]] as const)('keeps both memory root prefixes when repairing %s entries (legacy=%s)', async (kind, legacy) => {
  const name = kind === 'directory' ? 'broken' : 'state.lock';
  h.snapshot.items = ['memories', 'memory'].map(prefix => ({
    view: { id: `memory-${fingerprint(`${prefix}/${name}`).slice(0, 20)}`, name, category: 'memory', selected: true },
    sourceFile: { root: path.join(h.root, prefix), file: path.join(h.root, prefix, name), kind, ...(legacy ? {} : { logicalPrefix: prefix }) }, captureIssue: 'IMPORT_PERMISSION_DENIED',
  }));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `memory-prefix-${kind}-fixture`, previewId: preview.id, name: 'Ada', entryIds: h.snapshot.items.map(item => item.view.id), takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  const suffix = kind === 'directory' ? 'broken/state.lock' : 'state.lock';
  const originals = { [`memories/${suffix}`]: Buffer.alloc(0), [`memory/${suffix}`]: Buffer.from('  \n') };
  for (const [name, bytes] of Object.entries(originals)) {
    await fs.mkdir(path.dirname(path.join(h.root, name)), { recursive: true });
    await fs.writeFile(path.join(h.root, name), bytes);
  }
  await startCompanionImport(selection, 'after-restart');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.status).toBe('complete');
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.memoryFiles)
    .toEqual(Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, bytes.toString('base64')])));
});

it('recovers the user role of an individually failed memory USER.md', async () => {
  const file = path.join(h.root, 'memories/USER.md');
  const id = `memory-${fingerprint('memories/USER.md').slice(0, 20)}`;
  h.snapshot.items = [{ view: { id, name: 'USER.md', category: 'memory', selected: true },
    sourceFile: { root: path.dirname(file), file, kind: 'file', logicalPrefix: 'memories' }, captureIssue: 'IMPORT_PERMISSION_DENIED' }];
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'memory-user-role-recovery', previewId: preview.id, name: 'Ada', entryIds: [id], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'User preferences');
  await startCompanionImport(selection, 'after-restart');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile.userContextSource).toBe('User preferences');
  expect(h.importDocument).toHaveBeenCalledWith(accepted.botId, id, 'USER.md', 'User preferences', 'user');
});

it('retains managed media by ledger reference without copying its bytes into execution assets', async () => {
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const script = Buffer.from('print("fixture")');
  h.snapshot.items = [
    { view: { id: 'image', name: 'image.png', category: 'memory', selected: true }, asset: { name: 'memory/image.png', bytes: image } },
    { view: { id: 'script', name: 'report.py', category: 'connections', selected: true }, asset: { name: 'scripts/report.py', bytes: script } },
  ];
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'media-ledger-only-fixture', previewId: preview.id, name: 'Ada', entryIds: ['image', 'script'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const result = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(result?.status).toBe('complete');
  expect(h.importMedia).toHaveBeenCalledWith(accepted.botId, 'chat', image, expect.any(Function));
  expect(h.importDocument).toHaveBeenCalledWith(accepted.botId, expect.any(String), 'memory/image.png', '![memory/image.png](cindy-media://blobs/fixture.png)', 'reference');
  const environment = await h.store.read(h.root, accepted.botId, () => {});
  expect(environment?.files).toEqual({ 'scripts/report.py': script.toString('base64') });
  expect(environment?.memoryFiles).toEqual({});
  expect(environment?.pendingImport).toBeUndefined();
  expect(JSON.stringify(environment)).not.toContain(image.toString('base64'));
});

it.each([false, true])('preserves script executable flags in the archive and checkpoint (retry: %s)', async retry => {
  h.snapshot.items = [
    { view: { id: 'helper', name: 'helper', category: 'connections', selected: true },
      asset: { name: 'scripts/helper', bytes: Buffer.from('#!/bin/sh\nprintf fixture'), executable: true } },
    { view: { id: 'data', name: 'data.txt', category: 'connections', selected: true },
      asset: { name: 'scripts/data.txt', bytes: Buffer.from('data'), executable: false } },
    { view: { id: 'legacy', name: 'legacy.py', category: 'connections', selected: true },
      asset: { name: 'scripts/legacy.py', bytes: Buffer.from('print("fixture")') } },
    { view: { id: 'memory', name: 'note', category: 'memory', selected: true }, text: 'Original note' },
  ];
  if (retry) h.importDocument.mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `script-executable-${retry}`, previewId: preview.id, name: 'Ada',
    entryIds: ['helper', 'data', 'legacy', 'memory'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  const expected = { 'scripts/helper': true, 'scripts/data.txt': false, 'scripts/legacy.py': false };
  let stored = (await h.store.read(h.root, accepted.botId, () => {}))!;
  expect(stored.fileExecutables).toEqual(expected);
  const bytes = stored.files;
  if (retry) {
    const checkpoint = await deserializeImportSnapshotAsync(stored.pendingImport!.snapshotJson, () => {});
    expect(checkpoint.items.find(item => item.view.id === 'helper')?.asset?.executable).toBe(true);
    await startCompanionImport(selection, 'after-restart');
    const completed = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
    expect(completed?.status).toBe('complete');
    stored = (await h.store.read(h.root, accepted.botId, () => {}))!;
    expect(stored.fileExecutables).toEqual(expected);
    expect(stored.files).toEqual(bytes);
  }
  expect(stored.pendingImport).toBeUndefined();
});

it('cleans a completed checkpoint after a crash without replaying import work', async () => {
  h.snapshot.items = [{ view: { id: 'memory', name: 'note', category: 'memory', selected: true }, text: 'Original' }];
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'completed-checkpoint-recovery', previewId: preview.id, name: 'Ada', entryIds: ['memory'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  await h.store.update(h.root, accepted.botId, () => {}, env => { env.pendingImport = { selection, snapshotJson: 'old encrypted source snapshot' }; });
  const receiptPath = path.join(h.root, 'companion-imports', `${selection.requestId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); delete receipt.checkpointCleared;
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  h.importDocument.mockClear();
  await recoverCompanionImports();
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.pendingImport).toBeUndefined();
  expect(h.importDocument).not.toHaveBeenCalled();
});

it.each((['identity', 'user', 'instructions'] as const).flatMap(role => [0, 1].map(failedAfter => ({ role, failedAfter }))))
('projects only fully saved $role documents after failure at chunk $failedAfter', async ({ role, failedAfter }) => {
  const storage = new MemoryStorage(path.join(h.root, 'real-memory'), DEFAULT_MEMORY_CONFIG);
  await storage.init(h.root);
  const write = storage.write.bind(storage);
  let fail = true;
  vi.spyOn(storage, 'write').mockImplementation(async input => {
    if (fail && input.name === `import_failed_${failedAfter}`) throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
    return write(input);
  });
  const memory = createBotMemoryService({ getStore: async () => storage as unknown as MakerMemoryStore,
    readBot: async () => ({ canonicalSessionId: null }), requestRefresh: async () => {} });
  h.importDocument.mockImplementation(memory.importDocument);
  const healthy = 'Saved original'; const failed = 'Not yet complete ' + 'x'.repeat(BOT_MEMORY_BODY_MAX_BYTES);
  h.snapshot.items = [healthy, failed].map((text, index) => ({
    view: { id: index ? 'failed' : 'healthy', name: index ? 'Failed.md' : 'Healthy.md', category: 'personality', selected: true }, role, text,
  }));
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `first-role-${role}-${failedAfter}`, previewId: preview.id, name: 'Ada', entryIds: ['healthy', 'failed'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  const field = { identity: 'identitySource', user: 'userContextSource', instructions: 'systemPromptOverride' }[role];
  expect(h.profile[field]).toBe(healthy);
  expect(first?.savedEntryIds).toEqual(['healthy']);
  expect(first?.checks).toContainEqual({ entryId: 'failed', status: 'needs-attention', message: 'IMPORT_DISK_FULL', progress: { saved: failedAfter, total: 2 } });
  expect(await storage.list()).toHaveLength(1 + failedAfter);
  const stored = (await h.store.read(h.root, accepted.botId, () => {}))!;
  expect(stored.documents).toEqual({ healthy });
  const checkpoint = await deserializeImportSnapshotAsync(stored.pendingImport!.snapshotJson, () => {});
  expect(checkpoint.items.find(item => item.view.id === 'failed')?.text).toBe(failed);
  // Retrying a failed original cannot treat its text as an already-applied baseline.
  h.profile[field] = 'User edited profile'; fail = false;
  await startCompanionImport(selection, 'reconnected');
  const conflict = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile[field]).toBe('User edited profile');
  expect(conflict?.checks.find(check => check.entryId === 'failed')?.message).toBe('PROFILE_CHANGED');
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.documents).toEqual({ healthy });
  h.profile[field] = healthy;
  await startCompanionImport(selection, 'reconnected');
  const complete = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(complete?.status).toBe('complete');
  expect(complete?.savedEntryIds).toEqual(['healthy', 'failed']);
  expect(String(h.profile[field])).toContain(`${healthy}\n\nNot yet complete`);
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.documents).toEqual({ healthy, failed });
  expect(await storage.list()).toHaveLength(3);
});

it('projects healthy role siblings on the first save even when their item is incomplete', async () => {
  const documents = [{ id: 'good-role', name: 'USER.md', text: 'Saved user', role: 'user' as const },
    { id: 'bad-role', name: 'later/USER.md', text: 'Pending user', role: 'user' as const }];
  h.snapshot.items = [{ view: { id: 'mixed-role', name: 'Mixed', category: 'memory', selected: true }, documents,
    files: [{ name: 'bad.bin', bytes: Buffer.from([0, 255, 0, 255]), executable: false }] }];
  h.importDocument.mockImplementation(async (_bot, id) => { if (id === 'bad-role') throw Object.assign(new Error('full'), { code: 'ENOSPC' }); });
  h.importMedia.mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'SOURCE_MEMORY_ATTACHMENT_UNSUPPORTED' }));
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'first-mixed-role-fixture', previewId: preview.id, name: 'Ada', entryIds: ['mixed-role'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  const first = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(first?.savedEntryIds).toEqual([]);
  expect(h.profile.userContextSource).toBe('Saved user');
  const stored = (await h.store.read(h.root, accepted.botId, () => {}))!;
  expect(stored.documents).toEqual({ 'good-role': 'Saved user' });
  expect((await deserializeImportSnapshotAsync(stored.pendingImport!.snapshotJson, () => {})).items[0]?.documents).toEqual(documents);
  h.importDocument.mockResolvedValue(undefined);
  await startCompanionImport(selection, 'reconnected');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(h.profile.userContextSource).toBe('Saved user\n\nPending user');
});

it('recovers saved role documents when the first profile write fails after copies commit', async () => {
  h.snapshot.items = [{ view: { id: 'identity', name: 'SOUL.md', category: 'personality', selected: true }, role: 'identity', text: 'Saved identity' }];
  h.writeProfile.mockRejectedValueOnce(Object.assign(new Error('profile full'), { code: 'ENOSPC' }));
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: 'role-before-environment-fixture', previewId: preview.id, name: 'Ada', entryIds: ['identity'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await vi.waitFor(async () => expect((await getCompanionImportResult(selection.requestId))?.status).toBe('needs-attention'));
  const receipt = JSON.parse(await fs.readFile(path.join(h.root, 'companion-imports', `${selection.requestId}.json`), 'utf8'));
  expect(receipt.copied).toEqual(['identity']);
  expect(receipt.environmentSaved).not.toBe(true);
  expect(h.profile.identitySource).toBeUndefined();
  h.importDocument.mockClear();
  await startCompanionImport(selection, 'reconnected');
  const complete = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(complete?.status).toBe('complete');
  expect(h.importDocument).not.toHaveBeenCalled();
  expect(h.profile.identitySource).toBe('Saved identity');
  expect((await h.store.read(h.root, accepted.botId, () => {}))?.documents).toEqual({ identity: 'Saved identity' });
});

it.each(['identity', 'user', 'instructions'] as const)('reapplies a repaired %s source to the profile, while preserving user edits', async role => {
  const file = path.join(h.root, 'repaired.md');
  h.snapshot.items = [{ view: { id: 'role-source', name: 'source.md', category: 'personality', selected: true }, role,
    sourceFile: { root: h.root, file, kind: 'file' }, captureIssue: 'IMPORT_PERMISSION_DENIED' }];
  const [source] = await listCompanionImportSources('fixture'); const preview = await previewCompanionImport(source!.id, 'fixture');
  const selection = { requestId: `repaired-role-${role}-fixture`, previewId: preview.id, name: 'Ada', entryIds: ['role-source'], takeover: false, deferSetup: true };
  const accepted = await startCompanionImport(selection, 'fixture');
  await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  const field = { identity: 'identitySource', user: 'userContextSource', instructions: 'systemPromptOverride' }[role];
  h.profile[field] = 'User edit';
  await fs.writeFile(file, 'Repaired original');
  await startCompanionImport(selection, 'fixture');
  const conflict = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(conflict?.savedEntryIds).not.toContain('role-source');
  expect(h.profile[field]).toBe('User edit');
  h.profile[field] = '';
  await startCompanionImport(selection, 'fixture');
  const saved = await withBotProfileLocks([accepted.botId], () => getCompanionImportResult(selection.requestId));
  expect(saved?.savedEntryIds).toContain('role-source');
  expect(h.profile[field]).toBe('Repaired original');
});

it.each([false, true])('pages setup without vault reads after one-time legacy metadata upgrade: %s', async legacy => {
  const secret = 'fixture-private-setup-name';
  const task = h.snapshot.items[0]!;
  h.snapshot.items = Array.from({ length: 23 }, (_, index) => ({ ...structuredClone(task),
    view: { ...task.view, id: `job-${index}`, name: `Report ${index} ${secret}` },
    automation: { ...structuredClone(task.automation!), sourceId: `job-${index}` },
  }));
  h.snapshot.items[22]!.view.name = `Report 22 ${'x'.repeat(178)}${secret}`;
  h.snapshot.items.push({ view: { id: 'env', name: 'API_KEY', category: 'connections', selected: true }, env: { API_KEY: secret } });
  const [source] = await listCompanionImportSources('fixture');
  const preview = await previewCompanionImport(source!.id, 'fixture');
  const requestId = 'fixture-setup-paging-12345';
  const result = await startCompanionImport({ requestId, previewId: preview.id, name: 'Ada',
    entryIds: h.snapshot.items.map(item => item.view.id), takeover: true, deferSetup: true }, 'fixture');
  // Acceptance precedes the 23 entries being saved. Join the existing write
  // lock rather than imposing waitFor's 1s wall-clock limit on real filesystem IO.
  const settled = await withBotProfileLocks([result.botId], () => getCompanionImportResult(requestId));
  expect(settled?.status).toBe('needs-attention');
  const receiptFile = path.join(h.root, 'companion-imports', `${requestId}.json`);
  const bindingFile = path.join(h.root, 'bots', result.botId, 'environment.json');
  const originalCheckpoint = (await h.store.read(h.root, result.botId, () => {}))!.pendingImport!.snapshotJson;
  if (legacy) {
    const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); delete receipt.entryNames;
    await fs.writeFile(receiptFile, JSON.stringify(receipt));
    const binding = JSON.parse(await fs.readFile(bindingFile, 'utf8')); delete binding.importRequestId;
    await fs.writeFile(bindingFile, JSON.stringify(binding));
    const migrated = await getCompanionImportSetupStatus(result.botId, h.root, () => {}, 0);
    expect(migrated).toMatchObject({ total: 23, nextOffset: 20 });
    expect((await h.store.read(h.root, result.botId, () => {}))!.pendingImport!.snapshotJson).toBe(originalCheckpoint);
  }
  const publicReceipt = await fs.readFile(receiptFile, 'utf8');
  expect(publicReceipt).not.toContain(secret);
  expect(publicReceipt).not.toContain(secret.slice(0, 10));
  expect(JSON.parse(publicReceipt).entryNames['job-22'].length).toBeLessThanOrEqual(200);
  // Even a locked/unavailable vault must not be opened merely to paginate names.
  const vaultRead = vi.spyOn(h.store, 'read').mockRejectedValue(new Error('status must not open vault'));
  const config = createCompanionConnectionsProvider().toClaudeSdkConfig!({} as never) as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fixture', version: '1' });
  await config.instance.connect(serverTransport); await client.connect(clientTransport);
  try {
    for (const offset of [0, 20, 0]) {
      const response = await client.callTool({ name: 'import_setup', arguments: { operation: 'status', offset } });
      expect(response.isError).not.toBe(true);
      const text = (response.content as Array<{ text: string }>)[0]!.text;
      expect(text).not.toContain(secret);
      const page = JSON.parse(text);
      expect(page.total).toBe(23);
      expect(page.items).toHaveLength(offset === 0 ? 20 : 3);
      expect(page.items[0].name).toContain(`Report ${offset} `);
    }
    expect(vaultRead).not.toHaveBeenCalled();
    h.boundary = true;
    await expect(client.callTool({ name: 'import_setup', arguments: { operation: 'status' } })).rejects.toThrow('OWNER_CHANGED');
  } finally { h.boundary = false; vaultRead.mockRestore(); await client.close(); await config.instance.close(); }
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')); receipt.result.botId = 'another-bot';
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  await expect(getCompanionImportSetupStatus(result.botId, h.root, () => {}, 0)).rejects.toThrow('INVALID_COMPANION');
});

it.each(['short', 'unicode', 'escaped'] as const)('checks serialized bytes for legacy %s previews without truncating entries', async kind => {
  const name = kind === 'unicode' ? '漢'.repeat(600_000) : kind === 'escaped' ? '\u0000'.repeat(300_000) : 'short';
  h.snapshot.items = [{ view: { id: 'skill', name, category: 'skills', selected: true } }];
  const [source] = await listCompanionImportSources('old-phone');
  const read = readRemoteCompanionImport(`preview:${source!.id}`, 'old-phone', false);
  if (kind === 'short') {
    const data = await read;
    expect(data).not.toHaveProperty('chunk');
    expect(data.preview).toMatchObject({ entries: h.snapshot.items.map(item => item.view) });
  } else {
    await expect(read).rejects.toThrow('IMPORT_CLIENT_UPGRADE_REQUIRED');
    expect(h.created).toBe(false);
  }
});

it('bounds legacy source lists and saved results while preserving the chunk-capable path', async () => {
  h.readName.mockResolvedValue('漢'.repeat(600_000));
  await expect(readRemoteCompanionImport('sources', 'old-phone', false)).rejects.toThrow('IMPORT_CLIENT_UPGRADE_REQUIRED');
  const requestId = 'fixture-legacy-large-result';
  const result = { requestId, botId: 'bot', status: 'needs-attention', saved: true,
    checks: Array.from({ length: 25_000 }, (_, index) => ({ entryId: `entry-${index}`, status: 'needs-attention', message: 'IMPORT_ITEM_FAILED' })) };
  await fs.mkdir(path.join(h.root, 'companion-imports'), { recursive: true });
  await fs.writeFile(path.join(h.root, 'companion-imports', `${requestId}.json`), JSON.stringify({
    result, companionCreated: true, checkpointSaved: true, handoverMarkers: true,
  }));
  await expect(readRemoteCompanionImport(`result:${requestId}`, 'old-phone', false)).rejects.toThrow('IMPORT_CLIENT_UPGRADE_REQUIRED');
  const api = remoteCompanionImportApi(async id => ({ blocks: [{ primitive: 'companion-import',
    data: await readRemoteCompanionImport(id, 'new-phone', true) }] }), async () => {});
  expect((await api.sources())[0]?.name).toBe('漢'.repeat(600_000));
  expect(await api.status(requestId)).toEqual(result);
  expect(h.created).toBe(false);
});
