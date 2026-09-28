import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { transferCompanion, type ImportReceipt, type TransferDeps } from '../transfer.js';
import { CompanionImportError, type ImportSnapshot } from '../types.js';
import type { CompanionImportSelection } from '@cindy/maker-shared/companion-import';
import { normalizeAutomation } from '../sourceAutomations.js';

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
  const task = normalizeAutomation(snapshot.source, { id: 'report', script: 'reports/main.py', no_agent: true, schedule: { kind: 'interval', minutes: 5 } }, items, 'UTC');
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
    const task = normalizeAutomation(source, { id: 'reminder', prompt: 'Remember', payload: { message: 'Remember' }, schedule: { kind: 'interval', minutes: 5 }, ...job }, candidates, 'UTC');
    const { deps } = harness();
    const items = [...candidates, task];
    const result = await transferCompanion({ ...snapshot, source, items }, { ...selection, entryIds: items.map(item => item.view.id) }, deps);
    // Both accounts could pass the fake reachability check; ambiguity must stop before it.
    if (candidates.length > 1) {
      expect(task.automation?.deliveries).toEqual([]);
      expect(result.checks.find(check => check.entryId === task.view.id)).toMatchObject({ status: 'needs-attention', message: 'DELIVERY_NEEDS_ADAPTER' });
      expect(deps.verifyAutomation).not.toHaveBeenCalled();
      expect(deps.pauseSource).not.toHaveBeenCalled();
      expect(deps.enableRoutine).not.toHaveBeenCalled();
    } else {
      expect(task.automation?.deliveries).toEqual([{ connectionId: 'work', chatId: '123' }]);
      expect(result.status).toBe('complete');
      expect(deps.pauseSource).toHaveBeenCalledOnce();
      expect(deps.enableRoutine).toHaveBeenCalledOnce();
    }
    expect(vi.mocked(deps.saveEnvironment).mock.calls[0]![1]).toEqual(items);
  }
});

it.each(['personal', 'missing'])('binds an explicit Telegram account %s without falling back to another bot', async accountId => {
  const source = { ...snapshot.source, kind: 'openclaw' as const };
  const accounts = ['work', 'personal'].map(account => ({
    view: { id: account, name: account, category: 'connections' as const, selected: true },
    credential: { format: 'telegram', value: { account, token: `123:fake-${account}-token` } },
  }));
  const task = normalizeAutomation(source, { id: 'reminder', payload: { message: 'Remember' }, schedule: { kind: 'every', everyMs: 60000 }, delivery: { mode: 'announce', channel: 'telegram', to: '123', accountId } }, accounts, 'UTC');
  const { deps } = harness();
  const items = [...accounts, task];
  await transferCompanion({ ...snapshot, source, items }, { ...selection, entryIds: items.map(item => item.view.id) }, deps);
  if (accountId === 'personal') {
    expect(task.automation?.deliveries).toEqual([{ connectionId: 'personal', chatId: '123' }]);
    expect(deps.pauseSource).toHaveBeenCalledOnce();
  } else {
    expect(task.view.issues).toContain('DELIVERY_NEEDS_ADAPTER');
    expect(task.automation?.deliveries).toEqual([]);
    expect(deps.pauseSource).not.toHaveBeenCalled();
    expect(deps.enableRoutine).not.toHaveBeenCalled();
  }
});

describe('companion takeover transaction', () => {
  it('copies exactly the selection and verifies before pausing source, idempotently', async () => {
    const { deps } = harness(); const order: string[] = [];
    vi.mocked(deps.verifyAutomation).mockImplementation(async () => { order.push('verify'); return { verified: true }; });
    vi.mocked(deps.pauseSource).mockImplementation(async () => { order.push('pause'); });
    vi.mocked(deps.enableRoutine).mockImplementation(async () => { order.push('enable'); });
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
    await expect(transferCompanion(source, input, deps)).rejects.toThrow('process interrupted');
    expect(receipt()?.result.status).toBe('running');
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
