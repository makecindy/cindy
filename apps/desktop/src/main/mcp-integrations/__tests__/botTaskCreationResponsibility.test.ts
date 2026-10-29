import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Run the actual Desktop callback without importing unrelated Electron services.
const source = readFileSync(new URL('../mcp-providers.ts', import.meta.url), 'utf8');
const start = source.indexOf('      sendToSession: async ({');
const callback = source.slice(start, source.indexOf('      sessionTasks:', start));
const wired = ts.transpileModule(`return {${callback}}.sendToSession;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  const record = vi.fn(async (_id: string) => { void _id; });
  const capture = vi.fn(async (_caller: string) => { void _caller; return record; });
  const send = vi.fn(async (_params: unknown) => { void _params; return { ok: true, wakeKind: 'created', targetSessionId: 'new-task' }; });
  const call = new Function('tryGetOrcaCollabService', 'captureBotCreatedTaskResponsibility', wired)(
    () => ({ sendToSession: send }), capture,
  ) as (params: { targetSessionId?: string; dispatcherSessionId: string; message: string; workingDir?: string }) => Promise<Record<string, unknown>>;
  return { call, record, capture, send };
}

it('records only a successful fresh creation, using the original caller and the returned ID', async () => {
  const f = fixture();
  const result = await f.call({ dispatcherSessionId: 'canonical-bot', message: 'Work', workingDir: '/other-project' });
  expect(result).toMatchObject({ ok: true, targetSessionId: 'new-task' });
  expect(f.capture).toHaveBeenCalledWith('canonical-bot');
  expect(f.record).toHaveBeenCalledWith('new-task');
  expect(f.send).toHaveBeenCalledOnce();
});

it('does not turn a message to an existing task into responsibility', async () => {
  const f = fixture();
  f.send.mockResolvedValueOnce({ ok: true, wakeKind: 'queued', targetSessionId: 'existing' });
  await f.call({ targetSessionId: 'existing', dispatcherSessionId: 'canonical-bot', message: 'A message' });
  expect(f.capture).not.toHaveBeenCalled();
  expect(f.record).not.toHaveBeenCalled();
});

it('preserves creation success if the relationship write fails, without replaying execution', async () => {
  const f = fixture();
  f.record.mockRejectedValueOnce(new Error('OWNER_SCOPE_CHANGED'));
  expect(await f.call({ dispatcherSessionId: 'canonical-bot', message: 'Work' }))
    .toMatchObject({ ok: true, targetSessionId: 'new-task', responsibilityRecorded: false });
  expect(f.send).toHaveBeenCalledOnce();
});

it('records no relationship when creation fails', async () => {
  const f = fixture();
  f.send.mockResolvedValueOnce({ ok: false, wakeKind: 'created', targetSessionId: 'missing' });
  expect(await f.call({ dispatcherSessionId: 'canonical-bot', message: 'Work' })).toMatchObject({ ok: false });
  expect(f.record).not.toHaveBeenCalled();
});


it.each(['ordinary-caller', 'remote-target', 'worker-target', 'owner-switch'])('does not record an unverified creator/target after %s', async reason => {
  const captureSource = readFileSync(new URL('../../maker-ipc/botWorkbenchTools.ts', import.meta.url), 'utf8');
  const begin = captureSource.indexOf('export async function captureBotCreatedTaskResponsibility');
  const chunk = captureSource.slice(begin, captureSource.indexOf('type Failure = {', begin)).replace('export ', '');
  const js = ts.transpileModule(`${chunk}; return captureBotCreatedTaskResponsibility;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let owner = 'owner-one';
  const save = vi.fn(async () => {});
  const deps = {
    isAppSessionBoundaryPending: () => false,
    activeOwnerScopeKey: () => owner,
    ownerScopedUserDataPath: () => '/synthetic-owner-home',
    resolveBotTaskCreator: async () => reason === 'ordinary-caller' ? null : 'creator',
    readWorkbenchTarget: async () => ({ status: 'active', botLinked: false, remoteHostId: reason === 'remote-target' ? 'remote' : null, orcaRole: reason === 'worker-target' ? 'worker' : null }),
    setTaskResponsibility: save,
    broadcastBotWorkbenchChanged: vi.fn(),
  };
  const capture = new Function(...Object.keys(deps), js)(...Object.values(deps));
  const recorder = await capture('caller');
  if (reason === 'owner-switch') {
    owner = 'owner-two';
    await expect(recorder('new-task')).rejects.toThrow('OWNER_SCOPE_CHANGED');
  } else if (recorder) await recorder('new-task');
  expect(save).not.toHaveBeenCalled();
});
