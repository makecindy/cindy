import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { validateImportSelection, transferCompanion, type ImportReceipt, type TransferDeps } from '../transfer.js';
import { CompanionImportError, type ImportSnapshot } from '../types.js';
import type { CompanionImportSelection } from '@cindy/maker-shared/companion-import';
import { indexAutomationDependencies, normalizeAutomation } from '../sourceAutomations.js';
import { fingerprint } from '../files.js';

const snapshot: ImportSnapshot = { source: { kind: 'hermes', agentId: 'default', name: 'Ada', root: '/fixture/hermes', workspace: '/fixture/work', configFile: '/fixture/hermes/config.yaml' }, fingerprint: 'fixture', items: [
  { view: { id: 'memory', category: 'memory', name: 'memory', selected: true }, text: 'Keep this' },
  { view: { id: 'unselected', category: 'memory', name: 'private', selected: true }, text: 'Do not copy this' },
  { view: { id: 'env', category: 'connections', name: 'DATA_TOKEN', selected: true }, env: { DATA_TOKEN: 'fake-token-for-testing' } },
  { view: { id: 'task', category: 'automations', name: 'Report', selected: true, enabled: true, dependsOn: ['env'] }, automation: { sourceId: 'source-task', fingerprint: 'fixture', original: {}, input: { name: 'Report', prompt: 'Read my data', enabled: false, triggers: [{ id: 'daily', kind: 'interval', intervalMs: 60000 }] } } },
] };
const selection: CompanionImportSelection = { requestId: 'fixture-request-0001', previewId: 'preview', name: 'Ada', entryIds: ['memory', 'env', 'task'], takeover: true };
function harness() {
  let receipt: ImportReceipt | undefined;
  const deps: TransferDeps = { assertOwner: vi.fn(), readReceipt: async () => structuredClone(receipt), saveReceipt: async value => { receipt = structuredClone(value); },
    createCompanion: vi.fn(async () => {}), importItem: vi.fn(async () => {}), saveEnvironment: vi.fn(async () => {}), saveCheckpoint: vi.fn(async () => {}),
    createConversation: vi.fn(async () => 'chat'), createRoutine: vi.fn(async () => 'routine'),
    verifyAutomation: vi.fn(async () => ({ verified: true })), pauseSource: vi.fn(async () => {}), resumeSource: vi.fn(async () => {}), enableRoutine: vi.fn(async () => {}),
  };
  return { deps, receipt: () => receipt };
}

it('does not rerun failed verification while reconciling another task whose source pause is pending', async () => {
  const { deps } = harness();
  const first = structuredClone(snapshot.items.find(item => item.automation)!);
  const second = structuredClone(first); second.view.id = 'second'; second.automation!.sourceId = 'second';
  const source = { ...snapshot, items: [...snapshot.items.filter(item => !item.automation), first, second] };
  const chosen = { ...selection, entryIds: [...selection.entryIds, 'second'] };
  vi.mocked(deps.createRoutine).mockImplementation(async (_bot, _input, id) => id);
  vi.mocked(deps.verifyAutomation).mockImplementation(async (_bot, item) => ({ verified: item.view.id === 'second', reason: 'AUTOMATION_DATA_READ_FAILED' }));
  vi.mocked(deps.pauseSource).mockRejectedValue(new CompanionImportError('SOURCE_HANDOVER_PENDING'));
  expect((await transferCompanion(source, chosen, deps)).status).toBe('running');
  expect(deps.verifyAutomation).toHaveBeenCalledTimes(2);
  await transferCompanion(source, chosen, deps, true);
  await transferCompanion(source, chosen, deps, true);
  expect(deps.verifyAutomation).toHaveBeenCalledTimes(2);
  expect(deps.pauseSource).toHaveBeenCalledTimes(3);
  // Only a new explicit retry may attempt the failed read again.
  await transferCompanion(source, chosen, deps);
  expect(deps.verifyAutomation).toHaveBeenCalledTimes(3);
});

it('rejects an explicitly empty avatar before creating any receipt or credential checkpoint', async () => {
  const { deps, receipt } = harness();
  await expect(transferCompanion(snapshot, { ...selection, avatarImageBase64: '' }, deps)).rejects.toThrow('INVALID_SELECTION');
  expect(receipt()).toBeUndefined();
  expect(deps.saveCheckpoint).not.toHaveBeenCalled();
  expect(deps.saveEnvironment).not.toHaveBeenCalled();
  expect(deps.createCompanion).not.toHaveBeenCalled();
  // Omitting the optional avatar retains the normal companion default.
  expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
});

it('keeps the source running when a script sibling or resource is deselected', async () => {
  const items = ['reports/main.py', 'reports/helper.py', 'reports/data/input.json'].map(name => ({
    view: { id: name, name, category: 'connections' as const, selected: true }, asset: { name: `scripts/${name}`, bytes: Buffer.from('fixture') },
  }));
  const task = normalizeAutomation(snapshot.source, { id: 'report', script: 'reports/main.py', no_agent: true, schedule: { kind: 'interval', minutes: 5 } }, indexAutomationDependencies(items), 'UTC');
  const source = { ...snapshot, items: [...items, task] };
  for (const omitted of ['reports/helper.py', 'reports/data/input.json']) {
    const { deps } = harness();
    const entryIds = source.items.map(item => item.view.id).filter(id => id !== omitted);
    const result = await transferCompanion(source, { ...selection, entryIds }, deps);
    expect(result.checks.find(check => check.entryId === task.view.id)).toMatchObject({ status: 'needs-attention', message: 'AUTOMATION_DEPENDENCY_NOT_SELECTED' });
    expect(deps.pauseSource).not.toHaveBeenCalled();
    expect(deps.enableRoutine).not.toHaveBeenCalled();
    expect(deps.verifyAutomation).not.toHaveBeenCalled();
    expect(vi.mocked(deps.saveEnvironment).mock.calls[0]![1].some(item => item.view.id === omitted)).toBe(false);
  }
});

it.each([
  { kind: 'hermes' as const, job: { deliver: 'telegram:123' } },
  { kind: 'hermes' as const, job: { deliver: 'origin', origin: { platform: 'telegram', chat_id: '123' } } },
  { kind: 'openclaw' as const, job: { delivery: { mode: 'announce', channel: 'telegram', to: '123' } } },
])('does not guess an unspecified $kind Telegram account during takeover ($job)', async ({ kind, job }) => {
  const accounts = ['work', 'personal'].map(account => ({
    view: { id: account, name: account, category: 'connections' as const, selected: true },
    credential: { format: 'telegram', value: { account, token: `123:fake-${account}-token` } },
  }));
  for (const candidates of [accounts, [...accounts].reverse(), [accounts[0]!]]) {
    const source = { ...snapshot.source, kind };
    const task = normalizeAutomation(source, { id: 'reminder', prompt: 'Remember', payload: { message: 'Remember' }, schedule: { kind: 'interval', minutes: 5 }, ...job }, indexAutomationDependencies(candidates), 'UTC');
    const { deps } = harness();
    const items = [...candidates, task];
    const result = await transferCompanion({ ...snapshot, source, items }, { ...selection, entryIds: items.map(item => item.view.id) }, deps);
    expect(task.automation?.deliveries).toEqual([]);
    expect(result.status).toBe('complete');
    expect(deps.pauseSource).toHaveBeenCalledOnce();
    expect(deps.enableRoutine).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.saveEnvironment).mock.calls[0]![1]).toEqual(items);
  }
});

it.each(['personal', 'missing'])('uses local delivery even when the source names Telegram account %s', async accountId => {
  const source = { ...snapshot.source, kind: 'openclaw' as const };
  const accounts = ['work', 'personal'].map(account => ({
    view: { id: account, name: account, category: 'connections' as const, selected: true },
    credential: { format: 'telegram', value: { account, token: `123:fake-${account}-token` } },
  }));
  const task = normalizeAutomation(source, { id: 'reminder', payload: { message: 'Remember' }, schedule: { kind: 'every', everyMs: 60000 }, delivery: { mode: 'announce', channel: 'telegram', to: '123', accountId } }, indexAutomationDependencies(accounts), 'UTC');
  const { deps } = harness();
  const items = [...accounts, task];
  await transferCompanion({ ...snapshot, source, items }, { ...selection, entryIds: items.map(item => item.view.id) }, deps);
  expect(task.automation?.deliveries).toEqual([]);
  expect(task.view.issues ?? []).not.toContain('DELIVERY_NEEDS_ADAPTER');
  expect(deps.pauseSource).toHaveBeenCalledOnce();

});

it.each(['created', 'source-paused'] as const)('resumes a pre-upgrade %s receipt without recreating content or replacing its delivery binding', async phase => {
  const { deps } = harness();
  const legacy = structuredClone(snapshot);
  legacy.items = legacy.items.filter(item => selection.entryIds.includes(item.view.id));
  legacy.items.find(item => item.automation)!.automation!.deliveries = [{ connectionId: 'telegram', chatId: '123' }];
  await deps.saveReceipt({
    selectionHash: fingerprint([selection.name, undefined, selection.entryIds.toSorted(), true, legacy.source.kind, legacy.source.agentId, legacy.source.root]),
    result: { requestId: selection.requestId, botId: 'existing-bot', canonicalSessionId: 'chat', status: 'needs-attention', checks: [{ entryId: 'memory', status: 'copied' }, { entryId: 'task', status: 'needs-attention' }] },
    copied: ['memory'], environmentSaved: true, checkpointSaved: true, companionCreated: true,
    routines: { task: { id: 'existing-routine', phase } },
  });
  const result = await transferCompanion(legacy, selection, deps);
  expect(result).toMatchObject({ botId: 'existing-bot', status: 'complete', saved: true });
  // The host reconciles creation idempotently under the original bot ID.
  expect(deps.createCompanion).toHaveBeenCalledWith('existing-bot', selection);
  expect(deps.importItem).not.toHaveBeenCalled();
  expect(deps.saveCheckpoint).not.toHaveBeenCalled();
  expect(deps.saveEnvironment).not.toHaveBeenCalled();
  expect(deps.createRoutine).not.toHaveBeenCalled();
  expect(deps.pauseSource).toHaveBeenCalledTimes(phase === 'created' ? 1 : 0);
  expect(deps.enableRoutine).toHaveBeenCalledWith('existing-bot', 'existing-routine', expect.objectContaining({ automation: expect.objectContaining({ deliveries: [{ connectionId: 'telegram', chatId: '123' }] }) }));
});

describe('companion takeover transaction', () => {
  it('copies exactly the selection and verifies before pausing source, idempotently', async () => {
    const { deps, receipt } = harness(); const order: string[] = [];
    vi.mocked(deps.verifyAutomation).mockImplementation(async () => { order.push('verify'); return { verified: true }; });
    vi.mocked(deps.pauseSource).mockImplementation(async () => { expect(receipt()?.routines.task?.phase).toBe('pausing-source'); order.push('pause'); });
    vi.mocked(deps.enableRoutine).mockImplementation(async () => { expect(receipt()?.routines.task?.phase).toBe('source-paused'); order.push('enable'); });
    const result = await transferCompanion(snapshot, selection, deps);
    expect(result.status).toBe('complete'); expect(order).toEqual(['verify', 'pause', 'enable']);
    expect(deps.importItem).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(deps.saveEnvironment).mock.calls[0]![1];
    expect(saved.map(item => item.view.id)).toEqual(['memory', 'env', 'task']);
    await expect(transferCompanion(snapshot, selection, deps)).resolves.toEqual(result);
    expect(deps.createRoutine).toHaveBeenCalledTimes(1); expect(deps.pauseSource).toHaveBeenCalledTimes(1);
  });
  it('retains source execution when a needed credential is deselected or read verification fails', async () => {
    const a = harness();
    const result = await transferCompanion(snapshot, { ...selection, entryIds: ['task'] }, a.deps);
    expect(result.status).toBe('needs-attention'); expect(a.deps.verifyAutomation).not.toHaveBeenCalled(); expect(a.deps.pauseSource).not.toHaveBeenCalled();
    const b = harness(); vi.mocked(b.deps.verifyAutomation).mockResolvedValue({ verified: false });
    await transferCompanion(snapshot, selection, b.deps);
    expect(b.deps.pauseSource).not.toHaveBeenCalled(); expect(b.deps.enableRoutine).not.toHaveBeenCalled();
  });
  it('restores the source if enabling the imported task fails and retries without duplicate creation', async () => {
    const { deps, receipt } = harness(); vi.mocked(deps.enableRoutine).mockRejectedValueOnce(new Error('fixture failure'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('needs-attention');
    expect(deps.resumeSource).toHaveBeenCalledTimes(1); expect(receipt()?.routines.task?.phase).toBe('verified');
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(deps.createRoutine).toHaveBeenCalledTimes(1);
  });
  it('imports disabled tasks without activating or pausing any source task', async () => {
    const source = structuredClone(snapshot); source.items[3]!.view.enabled = false;
    const { deps } = harness();
    const result = await transferCompanion(source, selection, deps);
    expect(result.checks.find(check => check.entryId === 'task')?.status).toBe('paused');
    expect(deps.verifyAutomation).not.toHaveBeenCalled(); expect(deps.enableRoutine).not.toHaveBeenCalled(); expect(deps.pauseSource).not.toHaveBeenCalled();
  });
  it('rejects reusing a request with a different selection', async () => {
    const { deps } = harness(); await transferCompanion(snapshot, selection, deps);
    await expect(transferCompanion(snapshot, { ...selection, entryIds: ['task'] }, deps)).rejects.toThrow('REQUEST_ALREADY_USED');
  });
  it('keeps the source paused when target acknowledgement is ambiguous, and reconciles on retry', async () => {
    const { deps, receipt } = harness();
    vi.mocked(deps.enableRoutine).mockRejectedValueOnce(new CompanionImportError('TARGET_HANDOVER_UNCERTAIN'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('running');
    expect(receipt()?.routines.task?.phase).toBe('source-paused');
    expect(deps.resumeSource).not.toHaveBeenCalled();
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(deps.pauseSource).toHaveBeenCalledTimes(1);
    expect(deps.saveEnvironment).toHaveBeenCalledTimes(1);
    expect(deps.saveCheckpoint).toHaveBeenCalledTimes(1);
  });
  it('reconciles a lost source pause acknowledgement instead of activating two schedulers', async () => {
    const { deps } = harness();
    vi.mocked(deps.pauseSource).mockRejectedValueOnce(new CompanionImportError('SOURCE_HANDOVER_UNCERTAIN'));
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('running');
    expect(deps.enableRoutine).not.toHaveBeenCalled();
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(vi.mocked(deps.pauseSource).mock.calls[1]?.[2]).toBe(true);
  });
  it('retains the pause intent on owner change and reconciles it only when that owner returns', async () => {
    const { deps, receipt } = harness(); let owns = true;
    vi.mocked(deps.assertOwner).mockImplementation(() => { if (!owns) throw new CompanionImportError('OWNER_CHANGED'); });
    vi.mocked(deps.pauseSource).mockImplementationOnce(async () => { owns = false; throw new CompanionImportError('OWNER_CHANGED'); });
    await expect(transferCompanion(snapshot, selection, deps)).rejects.toThrow('OWNER_CHANGED');
    expect(receipt()?.routines.task?.phase).toBe('pausing-source');
    expect(deps.enableRoutine).not.toHaveBeenCalled(); expect(deps.resumeSource).not.toHaveBeenCalled();
    await expect(transferCompanion(snapshot, selection, deps)).rejects.toThrow('OWNER_CHANGED');
    expect(deps.pauseSource).toHaveBeenCalledTimes(1);
    owns = true;
    expect((await transferCompanion(snapshot, selection, deps)).status).toBe('complete');
    expect(vi.mocked(deps.pauseSource).mock.calls[1]?.[2]).toBe(true);
    expect(deps.createRoutine).toHaveBeenCalledTimes(1); expect(deps.enableRoutine).toHaveBeenCalledTimes(1);
  });

});

it('checkpoints full selected skills before acknowledging or copying and resumes after source removal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-import-checkpoint-test-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.writeFile(path.join(root, 'SKILL.md'), 'Use scripts/query.py');
    await fs.writeFile(path.join(root, 'scripts/query.py'), 'print("rows")');
    const source: ImportSnapshot = { ...snapshot, items: [...snapshot.items,
      { view: { id: 'skill', name: 'report', category: 'skills', selected: true }, sourceDirectory: root },
    ] };
    const input = { ...selection, entryIds: [...selection.entryIds, 'skill'] };
    const { deps, receipt } = harness();
    let durable: ImportSnapshot | undefined;
    vi.mocked(deps.saveCheckpoint).mockImplementation(async (_botId, items) => {
      // Real JSON serialization mirrors the encrypted store across a process restart.
      durable = JSON.parse(JSON.stringify({ ...source, items }), (_key, value) => value?.type === 'Buffer' ? Buffer.from(value.data) : value);
    });
    vi.mocked(deps.importItem).mockImplementation(async () => {
      expect(durable?.items.some(item => item.view.id === 'unselected')).toBe(false);
      expect(durable?.items.find(item => item.view.id === 'skill')?.files?.map(file => file.name)).toEqual(['scripts/query.py', 'SKILL.md']);
    });
    vi.mocked(deps.importItem).mockRejectedValueOnce(new Error('process interrupted'));
    expect((await transferCompanion(source, input, deps)).status).toBe('needs-attention');
    expect(receipt()?.result.checks).toContainEqual({ entryId: 'memory', status: 'needs-attention', message: 'IMPORT_ITEM_FAILED' });
    expect(durable).toBeDefined();
    await fs.rm(root, { recursive: true, force: true });
    vi.mocked(deps.verifyAutomation).mockImplementation(async () => {
      expect(durable?.items.find(item => item.view.id === 'skill')?.files?.find(file => file.name === 'scripts/query.py')?.bytes.toString()).toBe('print("rows")');
      return { verified: true };
    });
    expect((await transferCompanion(durable!, input, deps)).status).toBe('complete');
    expect(deps.pauseSource).toHaveBeenCalledOnce();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


it('takes over with either credential profile, blocks missing credentials, and rejects conflicts before writing', async () => {
  const original = structuredClone(snapshot);
  original.items = original.items.filter(item => item.view.id !== 'env');
  const task = original.items.find(item => item.automation)!;
  task.envDependencies = { names: ['DATA_TOKEN'], entries: [] };
  original.items.push(...['first', 'second'].map(id => ({ view: { id, name: id, category: 'connections' as const, selected: false }, env: { DATA_TOKEN: `fixture-${id}` } })));
  for (const id of ['first', 'second']) {
    const h = harness();
    const result = await transferCompanion(original, { ...selection, entryIds: ['task', id] }, h.deps);
    expect(result.status).toBe('complete');
    expect(h.deps.verifyAutomation).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ view: expect.objectContaining({ dependsOn: [id] }) }));
    expect(h.deps.pauseSource).toHaveBeenCalledTimes(1);
  }
  const missing = harness();
  expect((await transferCompanion(original, { ...selection, entryIds: ['task'] }, missing.deps)).status).toBe('needs-attention');
  expect(missing.deps.pauseSource).not.toHaveBeenCalled();
  const conflict = harness();
  await expect(transferCompanion(original, { ...selection, entryIds: ['task', 'first', 'second'] }, conflict.deps)).rejects.toThrow('INVALID_SELECTION');
  expect(conflict.deps.saveCheckpoint).not.toHaveBeenCalled();
  expect(conflict.receipt()).toBeUndefined();
});

it('finishes saving before any login or read probe, then resumes takeover from chat', async () => {
  const { deps, receipt } = harness();
  const input = { ...selection, deferSetup: true };
  const saved = await transferCompanion(snapshot, input, deps);
  expect(saved.saved).toBe(true);
  expect(saved.canonicalSessionId).toBe('chat');
  expect(saved.checks).toContainEqual({ entryId: 'task', status: 'needs-attention', message: 'IMPORT_SETUP_DEFERRED' });
  expect(deps.verifyAutomation).not.toHaveBeenCalled();
  expect(deps.pauseSource).not.toHaveBeenCalled();
  expect(receipt()?.checkpointSaved).toBe(true);
  expect((await transferCompanion(snapshot, input, deps, false, true)).status).toBe('complete');
  expect(deps.createRoutine).toHaveBeenCalledOnce();
  expect(deps.pauseSource).toHaveBeenCalledOnce();
});

it.each([false, true])('rejects changing the original deferSetup=%s without writes or takeover', async deferSetup => {
  const { deps, receipt } = harness();
  vi.mocked(deps.verifyAutomation).mockResolvedValue({ verified: false });
  await transferCompanion(snapshot, { ...selection, deferSetup }, deps);
  const saved = structuredClone(receipt());
  vi.clearAllMocks();
  await expect(transferCompanion(snapshot, { ...selection, deferSetup: !deferSetup }, deps)).rejects.toThrow('REQUEST_ALREADY_USED');
  expect(receipt()).toEqual(saved);
  expect(deps.createCompanion).not.toHaveBeenCalled();
  expect(deps.verifyAutomation).not.toHaveBeenCalled();
  expect(deps.pauseSource).not.toHaveBeenCalled();
});

it('treats absent deferSetup as false and persists the choice before saving the checkpoint', async () => {
  const { deps, receipt } = harness();
  vi.mocked(deps.saveCheckpoint).mockImplementationOnce(async () => {
    expect(receipt()?.deferSetup).toBe(false);
    throw new Error('interrupted checkpoint');
  });
  await expect(transferCompanion(snapshot, selection, deps)).rejects.toThrow('interrupted checkpoint');
  await expect(transferCompanion(snapshot, { ...selection, deferSetup: true }, deps)).rejects.toThrow('REQUEST_ALREADY_USED');
  expect((await transferCompanion(snapshot, { ...selection, deferSetup: false }, deps)).status).toBe('complete');
});

it('upgrades a legacy deferred receipt from its saved choice, including a checkpoint interrupted before checks', async () => {
  const { deps, receipt } = harness();
  await transferCompanion(snapshot, { ...selection, deferSetup: true }, deps);
  const legacy = structuredClone(receipt()!);
  delete legacy.deferSetup;
  legacy.selectionHash = fingerprint([selection.name, undefined, selection.entryIds.toSorted(), selection.takeover, snapshot.source.kind, snapshot.source.agentId, snapshot.source.root]);
  legacy.result.checks = [];
  await deps.saveReceipt(legacy);
  deps.readLegacyDeferSetup = async () => true;
  await expect(transferCompanion(snapshot, selection, deps)).rejects.toThrow('REQUEST_ALREADY_USED');
  expect(receipt()).toEqual(legacy);
  expect((await transferCompanion(snapshot, { ...selection, deferSetup: true }, deps, false, true)).status).toBe('complete');
  expect(receipt()?.deferSetup).toBe(true);
  expect(receipt()?.selectionHash).not.toBe(legacy.selectionHash);
  expect(deps.pauseSource).toHaveBeenCalledOnce();
});

it('restores compact selections from a selected-only checkpoint without changing their meaning', async () => {
  const { deps } = harness();
  const indexed = { ...snapshot, items: snapshot.items.map((item, sourceIndex) => ({ ...item, sourceIndex })) };
  const input: CompanionImportSelection = { ...selection, entryIds: [], entryRanges: [[0, 0], [2, 3]], deferSetup: true };
  const first = await transferCompanion(indexed, input, deps);
  expect(first.savedEntryIds).toEqual(['memory', 'env', 'task']);
  const saved = vi.mocked(deps.saveCheckpoint).mock.calls[0]![1];
  expect(saved.map(item => item.sourceIndex)).toEqual([0, 2, 3]);
  expect((await transferCompanion({ ...indexed, items: saved }, input, deps, false, true)).status).toBe('complete');
  expect(deps.importItem).toHaveBeenCalledTimes(1);
});

it.each(([[[0, 2], [2, 3]], [[-1, 0]], [[3, 2]], [[0, 99999]]] as Array<Array<[number, number]>>).map(entryRanges => ({ entryRanges })))('rejects invalid compact ranges $entryRanges before creating a companion', async ({ entryRanges }) => {
  const { deps } = harness();
  const indexed = { ...snapshot, items: snapshot.items.map((item, sourceIndex) => ({ ...item, sourceIndex })) };
  await expect(transferCompanion(indexed, { ...selection, entryIds: [], entryRanges }, deps)).rejects.toThrow();
  expect(deps.createCompanion).not.toHaveBeenCalled();
});

it('saves healthy content and a conversation when a single routine cannot be created', async () => {
  const { deps } = harness();
  vi.mocked(deps.createRoutine).mockRejectedValue(new Error('fixture write failed'));
  const result = await transferCompanion(snapshot, { ...selection, deferSetup: true }, deps);
  expect(result).toMatchObject({ saved: true, canonicalSessionId: 'chat', savedEntryIds: ['memory', 'env'] });
  expect(result.checks).toContainEqual({ entryId: 'task', status: 'needs-attention', message: 'IMPORT_ITEM_FAILED' });
  expect(deps.pauseSource).not.toHaveBeenCalled();
});

it('returns a completed legacy deferred receipt even after its checkpoint was removed', async () => {
  const { deps, receipt } = harness();
  const input = { ...selection, deferSetup: true };
  await transferCompanion(snapshot, input, deps, false, true);
  const legacy = structuredClone(receipt()!);
  delete legacy.deferSetup;
  legacy.selectionHash = fingerprint([selection.name, undefined, selection.entryIds.toSorted(), selection.takeover, snapshot.source.kind, snapshot.source.agentId, snapshot.source.root]);
  await deps.saveReceipt(legacy);
  vi.clearAllMocks();
  await expect(transferCompanion(snapshot, input, deps)).resolves.toEqual(legacy.result);
  expect(deps.createCompanion).not.toHaveBeenCalled();
  expect(deps.pauseSource).not.toHaveBeenCalled();
});

it.each([
  { schedule: { kind: 'native-event', event: 'inbox' }, payload: { kind: 'agentTurn', message: 'Read' } },
  { schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'agentTurn', message: 'Read' } },
  { schedule: { kind: 'every', everyMs: 60_000 }, payload: { kind: 'heartbeat' } },
  { schedule: { kind: 'every', everyMs: 60_000 }, payload: { kind: 'future-native-task', message: 'Read' } },
  { schedule: { kind: 'every', everyMs: 60_000 }, payload: {} },
])('preserves unsupported automation $payload.kind without changing the source or enabling it', async job => {
  const { deps, receipt } = harness();
  const source = { ...snapshot.source, kind: 'openclaw' as const };
  const original = { id: 'unsupported', ...job, delivery: { channel: 'unavailable-channel', to: 'original-target' } };
  const item = normalizeAutomation(source, original, indexAutomationDependencies([]), 'UTC');
  expect(item.automation?.input).toMatchObject({ enabled: false });
  expect(item.view.issues?.length).toBeGreaterThan(0);
  const input = { ...selection, entryIds: [item.view.id], deferSetup: true, takeover: false };
  const content = { ...snapshot, source, items: [item] };
  const result = await transferCompanion(content, input, deps);
  expect(result.savedEntryIds).toContain(item.view.id);
  expect(result.checks).toContainEqual({ entryId: item.view.id, status: 'needs-attention', message: item.view.issues![0] });
  expect(deps.createRoutine).toHaveBeenCalledWith(expect.any(String), item.automation!.input, expect.any(String), item);
  expect(vi.mocked(deps.saveEnvironment).mock.calls[0]![1][0]!.automation?.original).toEqual(original);
  expect(receipt()?.routines[item.view.id]?.phase).toBe('created');
  await transferCompanion(content, input, deps);
  expect(deps.createRoutine).toHaveBeenCalledOnce();
  expect(deps.pauseSource).not.toHaveBeenCalled();
  expect(deps.enableRoutine).not.toHaveBeenCalled();
  expect(deps.verifyAutomation).not.toHaveBeenCalled();
});

it('recovers legacy checkpoints that had no converted routine input', async () => {
  const { deps } = harness();
  const item = normalizeAutomation(snapshot.source, { id: 'legacy', schedule: { kind: 'unknown' } }, indexAutomationDependencies([]), 'UTC');
  delete item.automation!.input;
  const result = await transferCompanion({ ...snapshot, items: [item] }, { ...selection, entryIds: [item.view.id], deferSetup: true }, deps);
  expect(result.savedEntryIds).toContain(item.view.id);
  expect(deps.createRoutine).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ enabled: false, triggers: [] }), expect.any(String), item);
  expect(deps.pauseSource).not.toHaveBeenCalled();
});

it('preserves concrete memory failures and partial progress in a retryable receipt', async () => {
  const { deps } = harness();
  vi.mocked(deps.importItem).mockRejectedValueOnce(Object.assign(new Error('private disk path'), { code: 'ENOSPC', importProgress: { saved: 1, total: 3 } }));
  const result = await transferCompanion(snapshot, selection, deps);
  expect(result.checks).toContainEqual({ entryId: 'memory', status: 'needs-attention', message: 'IMPORT_DISK_FULL', progress: { saved: 1, total: 3 } });
  expect(JSON.stringify(result)).not.toContain('private disk path');
  expect(result.savedEntryIds).not.toContain('memory');
  const retried = await transferCompanion(snapshot, selection, deps);
  expect(retried.savedEntryIds).toContain('memory');
  expect(retried.checks.find(check => check.entryId === 'memory')?.progress).toBeUndefined();
});

it('validates 100,000 sparse selections in linear work and rejects oversized ranges before expansion', () => {
  const size = 100_000;
  let reads = 0;
  const entryRanges: Array<[number, number]> = Array.from({ length: size / 2 }, (_, i) => {
    const range: [number, number] = [i * 2, i * 2];
    Object.defineProperty(range, 0, { get() { reads++; return i * 2; } });
    return range;
  });
  const indexed = { ...snapshot, items: Array.from({ length: size }, (_, sourceIndex) => ({
    sourceIndex, view: { id: `memory-${sourceIndex}`, name: 'Memory', category: 'memory' as const, selected: true },
  })) };
  const chosen = validateImportSelection({ ...selection, entryIds: [], entryRanges }, indexed);
  expect(chosen.map(item => item.sourceIndex)).toEqual(Array.from({ length: size / 2 }, (_, i) => i * 2));
  expect(reads).toBeLessThan(size * 10);
  // Selected-only checkpoints need not be contiguous or in index order.
  expect(validateImportSelection({ ...selection, entryIds: [], entryRanges }, { ...indexed, items: chosen.toReversed() }))
    .toEqual(chosen.toReversed());
  expect(() => validateImportSelection({ ...selection, entryIds: [], entryRanges: [[0, Number.MAX_SAFE_INTEGER - 1]] }, indexed))
    .toThrow('SELECTION_CHANGED');
});

it.each([{ count: 100_000, name: 'Note' }, { count: 5_000, name: '长名称'.repeat(60) }])('bounds serialized receipt bytes for $count entries including the name index', async ({ count, name }) => {
  const { deps } = harness();
  const items = Array.from({ length: count }, (_, index) => ({ view: { id: `memory-${index}`, name, category: 'memory' as const, selected: true }, text: 'Original' }));
  const entryNames = Object.fromEntries(items.map(item => [item.view.id, item.view.name]));
  let serializedBytes = 0, finalBytes = 0;
  deps.saveReceipt = async receipt => {
    receipt.entryNames = entryNames;
    finalBytes = Buffer.byteLength(JSON.stringify(receipt)); serializedBytes += finalBytes;
    return finalBytes;
  };
  const result = await transferCompanion({ ...snapshot, items }, { ...selection, entryIds: items.map(item => item.view.id), takeover: false, deferSetup: true }, deps);
  expect(result.savedEntryIds).toHaveLength(count);
  expect(result.checks).toHaveLength(count);
  expect(serializedBytes).toBeLessThan(finalBytes * 10);
  expect(deps.importItem).toHaveBeenCalledTimes(count);
}, 30_000);

it('batches disabled and deferred routine records without losing their durable states', async () => {
  const { deps } = harness();
  const count = 10_000;
  const template = snapshot.items.find(item => item.automation)!;
  const items = Array.from({ length: count }, (_, index) => ({ ...template,
    view: { ...template.view, id: `task-${index}`, enabled: index % 2 === 0, dependsOn: [] },
  }));
  let bytes = 0, finalText = '';
  deps.saveReceipt = async value => { finalText = JSON.stringify(value); const length = Buffer.byteLength(finalText); bytes += length; return length; };
  const result = await transferCompanion({ ...snapshot, items }, { ...selection, entryIds: items.map(item => item.view.id), deferSetup: true }, deps);
  expect(bytes).toBeLessThan(Buffer.byteLength(finalText) * 10);
  const saved = JSON.parse(finalText) as ImportReceipt;
  expect(Object.keys(saved.routines)).toHaveLength(count);
  expect(saved.routines['task-0']?.phase).toBe('created');
  expect(saved.routines['task-1']?.phase).toBe('complete');
  expect(saved.result).toEqual(result);
  expect(result.savedEntryIds).toHaveLength(count);
  expect(deps.pauseSource).not.toHaveBeenCalled(); expect(deps.enableRoutine).not.toHaveBeenCalled();
}, 10_000);

it('resumes an interrupted progress batch using stable item IDs without replaying saved batches', async () => {
  const { deps, receipt } = harness();
  const items = Array.from({ length: 3_000 }, (_, index) => ({ view: { id: `memory-${index}`, name: 'Note', category: 'memory' as const, selected: true }, text: 'Original' }));
  const input = { ...selection, entryIds: items.map(item => item.view.id), takeover: false, deferSetup: true };
  let interrupted = false, durableCount = 0;
  const calls: string[] = [];
  const save = deps.saveReceipt;
  deps.saveReceipt = async value => { await save(value); durableCount = value.copied.length; };
  deps.assertOwner = () => { if (interrupted) throw new Error('OWNER_CHANGED'); };
  deps.importItem = async (_bot, item) => { calls.push(item.view.id); if (durableCount && calls.length === durableCount + 2) interrupted = true; };
  await expect(transferCompanion({ ...snapshot, items }, input, deps)).rejects.toThrow('OWNER_CHANGED');
  const savedCount = durableCount;
  expect(savedCount).toBeGreaterThan(0); expect(savedCount).toBeLessThan(items.length - 2);
  expect(receipt()?.copied).toEqual(items.slice(0, savedCount).map(item => item.view.id));
  interrupted = false;
  const result = await transferCompanion({ ...snapshot, items }, input, deps);
  expect(result.savedEntryIds).toHaveLength(items.length);
  expect(calls.filter(id => id === 'memory-0')).toHaveLength(1);
  expect(calls.filter(id => id === `memory-${savedCount}`)).toHaveLength(2);
  expect(calls.filter(id => id === `memory-${savedCount + 1}`)).toHaveLength(2);
});

it('does not reuse a legacy boolean link exception to read an external credential on retry', async ctx => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-legacy-memory-link-'));
  try {
    const memory = path.join(root, 'memory'); await fs.mkdir(memory);
    const secret = path.join(root, 'credential'); await fs.writeFile(secret, 'fixture-private-token');
    const file = path.join(memory, 'note.json');
    try { await fs.symlink(secret, file, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
    const sourceFile = { root: memory, file, nativeFileLinks: true };
    const input = { ...snapshot, items: [{ view: { id: 'memory', name: 'Note', category: 'memory' as const, selected: true }, captureIssue: 'IMPORT_ITEM_FAILED', sourceFile }] };
    const { deps } = harness();
    const chosen = { ...selection, entryIds: ['memory'], takeover: false };
    await transferCompanion(input, chosen, deps);
    const result = await transferCompanion(input, chosen, deps);
    expect(result.checks).toContainEqual({ entryId: 'memory', status: 'needs-attention', message: 'SOURCE_LINK_OUTSIDE_FOLDER' });
    expect(deps.importItem).not.toHaveBeenCalled();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
