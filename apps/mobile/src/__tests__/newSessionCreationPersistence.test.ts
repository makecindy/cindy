import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '../auth/authOwnerGeneration';
import type { DurableOutboxRecord } from '../session/durableOutbox';
import { cancelledCreationDraft, outboxCreationRetryIdentity } from '../session/cancelledCreationDraft';
import { buildOutboxItem } from '../session/sessionOutbox';

const disk = vi.hoisted(() => ({ data: new Map<string, string>(), fail: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...disk.data.keys()],
  getItem: async (key: string) => disk.data.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (disk.fail) throw new Error('disk unavailable');
    disk.data.set(key, value);
  },
  removeItem: async (key: string) => { disk.data.delete(key); },
} }));
vi.mock('../session/durableOutboxFiles', () => ({ durableOutboxUploadUri: vi.fn(), removeOutboxFiles: vi.fn() }));
vi.mock('../session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: vi.fn() }));
import { getCurrentMobileOutboxRecords, mobileDurableOutbox, persistCancelledCreationDraft } from '../session/mobileDurableOutbox';

// Run the page's actual recovery -> durable save -> worktree creation statements.
// Extract AST nodes, as in newSessionWorktreeSync, so ordering is tested without
// duplicating the production pipeline or mounting unrelated native UI modules.
const source = ts.createSourceFile('new.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let statements: readonly ts.Statement[] | undefined;
function visit(node: ts.Node) {
  if (ts.isBlock(node) && node.statements.some((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(source) === 'previousRecovery'))) {
    const start = node.statements.findIndex((s) => ts.isVariableStatement(s)
      && s.declarationList.declarations.some((d) => d.name.getText(source) === 'previousRecovery'));
    const end = node.statements.findIndex((s) => ts.isBlock(s)
      && s.getText(source).includes('resolveSubmitGuardCatalog'));
    if (end < start) throw new Error('Missing page creation persistence boundary');
    statements = node.statements.slice(start, end);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!statements) throw new Error('Missing page creation pipeline');

beforeEach(async () => {
  setMobileAuthOwner(null);
  await mobileDurableOutbox.activate('');
  disk.data.clear();
  disk.fail = false;
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
});

function harness(previous: DurableOutboxRecord | null = null) {
  let sequence = 0;
  const draft = { agentKind: 'codex', workspaceKind: 'project', workingDir: '/repo', model: 'model',
    providerId: null, effort: 'high', permissionMode: 'ask', fastMode: false, firstMessage: 'keep my input' };
  const bindings = {
    effectiveDraft: { ...draft, ...previous?.creation?.draft },
    outboxRecoveryRef: { current: previous },
    getCurrentMobileOutboxRecords, mobileDurableOutbox, outboxCreationRetryIdentity, buildOutboxItem,
    selectedDeviceId: 'pc', selectedDeviceName: 'PC', authOwnerAtCreate: getMobileAuthOwner(),
    worktreeAccountId: 'alice', creatingWorktree: true,
    worktreeIntent: { applicable: true, enabled: true, eligibility: { status: 'eligible', baseRepo: '/repo' }, sourceBranch: 'main' },
    isCurrentOwner: () => true, ensureDeviceAlive: () => true, isWorktreeCreateIntentCurrent: () => true,
    createNewSessionId: () => `session-${++sequence}`, createOutboxClientId: () => 'message',
    runtimeOptions: { permissionOptions: [] }, prePlanPermissionModeRef: { current: null },
    planModeCapability: false, planModeDraftOn: false,
    holdDurableOutboxCreation: () => () => {}, holdPrecreatedWorktreeRegistration: () => () => {},
    sendAttachments: [{ id: 'photo', path: 'oss://photo', name: 'photo.png', ext: 'png', size: 3, category: 'image', mimeType: 'image/png' }],
    attachmentPreviews: {}, getUploadedSource: () => ({ uri: 'file:///photo.png' }),
    retainOutboxFile: vi.fn(async () => ({ slot: 0, fileName: 'slot-0.png', name: 'photo.png', size: 3, kind: 'image' })),
    removeRetainedOutboxFiles: vi.fn(async () => {}), releaseUploadedSources: vi.fn(),
    outboxAttachmentNeedsLocalBytes: () => true,
    registerPendingPrecreatedWorktree: vi.fn(async () => true), forgetPendingPrecreatedWorktree: vi.fn(),
    buildWorktreeCreateRequest: (input: unknown) => input,
    parseWorktreeCreateResult: (input: unknown) => input,
    maker: { getSession: vi.fn(async () => null), worktree: {
      suggestName: vi.fn(async () => ({ name: 'new' })),
      create: vi.fn(async () => ({ ok: true, meta: { path: '/repo/.cindy-worktrees/new' } })),
    } },
    t: (key: string) => key, setError: vi.fn(), setDraft: vi.fn(),
    formatRemoteError: (error: Error) => error.message,
  };
  const compiled = ts.transpileModule(`async function run(bindings) {
    let { ${Object.keys(bindings).join(', ')} } = bindings;
    let releaseDurableCreation, releasePrecreatedRegistration;
    try {
      ${statements!.map((node) => node.getText(source)).join('\n')}
      return { effectiveDraft, sessionId };
    } finally { releaseDurableCreation?.(); releasePrecreatedRegistration?.(); }
  }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function(`${compiled}; return run;`)() as (input: typeof bindings) => Promise<unknown>;
  return { bindings, run: () => run(bindings) };
}

it('persists the draft and attachments before reserving and dispatching worktree creation', async () => {
  const h = harness();
  h.bindings.registerPendingPrecreatedWorktree.mockImplementation(async () => {
    const saved = [...disk.data.values()].map((value) => JSON.parse(value) as DurableOutboxRecord)[0];
    expect(saved).toMatchObject({ suspended: true, item: { text: 'keep my input' },
      creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo' } },
      uploads: [{ fileName: 'slot-0.png' }] });
    return true;
  });
  await h.run();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledOnce();
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: false,
    creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
});

it('recovers the input after a lost create reply and cold outbox activation', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockRejectedValueOnce(new Error('reply lost'));
  await h.run();
  expect(h.bindings.setError).toHaveBeenCalledWith('session.new.worktreeCleanupPending');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, state: 'failed',
    item: { text: 'keep my input', attachmentSlots: [{ id: 'photo' }] }, uploads: [{ fileName: 'slot-0.png' }],
    creation: { cancelled: true, draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
});

it('does not reserve or dispatch a worktree if saving its draft fails', async () => {
  const h = harness();
  disk.fail = true;
  await expect(h.run()).rejects.toThrow('disk unavailable');
  expect(h.bindings.registerPendingPrecreatedWorktree).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(h.bindings.removeRetainedOutboxFiles).toHaveBeenCalledOnce();
});

it('keeps the original durable input when patching the successful worktree path fails', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockImplementationOnce(async () => {
    disk.fail = true;
    return { ok: true, meta: { path: '/repo/.cindy-worktrees/new' } };
  });
  await expect(h.run()).rejects.toThrow('disk unavailable');
  disk.fail = false;
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true,
    creation: { draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it.each([true, false])('reprobes a restored directory instead of submitting old eligibility (enabled=%s)', async (enabled) => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  Object.assign(h.bindings.worktreeIntent, { enabled, eligibility: { status: 'ineligible', reason: 'alreadyInWorktree' } });
  h.bindings.creatingWorktree = false;
  expect(await h.run()).toBeUndefined();
  expect(h.bindings.setDraft).toHaveBeenCalledOnce();
  const restored = h.bindings.setDraft.mock.calls[0][0](h.bindings.effectiveDraft);
  expect(restored).toMatchObject({ workingDir: '/repo', firstMessage: 'keep my input' });
  expect(h.bindings.maker.getSession).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it('retries a cancelled draft under one durable key and patches its new worktree path', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  const cancelled = await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(cancelled);
  h.bindings.createNewSessionId = () => 'retry-session';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ storageSessionId: 'session-1',
    item: { sessionId: 'retry-session', clientId: 'message' }, suspended: false,
    creation: { draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBeUndefined();
});

it('preserves a directory explicitly selected by the user while cancellation completes', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  h.bindings.effectiveDraft.workingDir = '/other-repo';
  h.bindings.worktreeIntent.eligibility.baseRepo = '/other-repo';
  h.bindings.createNewSessionId = () => 'user-retry';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledWith(expect.objectContaining({
    eligibility: expect.objectContaining({ baseRepo: '/other-repo' }),
  }));
  expect(getCurrentMobileOutboxRecords()[0].creation?.originalWorkingDir).toBe('/other-repo');
});
