import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';
import { ensureInvokeLinkReady } from '../linkRecovery';

// Execute the production probe adapter without starting Electron or a real relay.
const source = ts.createSourceFile('index.ts', readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let probe!: ts.PropertyAssignment;
function findProbe(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'probeInvoke') probe = node;
  ts.forEachChild(node, findProbe);
}
findProbe(source);
const compiled = ts.transpileModule(`const probeInvoke = ${probe.initializer.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness() {
  let release!: () => void;
  let scope = 'owner-a';
  let disabled = false;
  const revoked = new Set<string>();
  const epochs = new Map<string, number>();
  const reopen = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const invoke = vi.fn(async (_peer, _payload, _timeout, options) => {
    options.preSend();
    return { ok: true, result: [] };
  });
  const dependencies = {
    DeviceLinkError, ensureInvokeLinkReady,
    client: { needsLinkRecovery: (peer: string) => peer === 'recovering', invoke },
    parseSharedTaskPeer: () => null,
    activeOwnerScopeKey: () => scope,
    linkTornDown: false,
    isAppSessionBoundaryPending: () => false,
    arbiter: { isOwner: () => true },
    openLinkCloseEpochs: epochs,
    revokedByRemote: revoked,
    assertRemoteControlTargetEnabled: () => { if (disabled) throw new Error('disabled'); },
    openRemoteLink: reopen,
    resolveRemoteInvokeTimeoutMs: () => 15_000,
  };
  const run = new Function(...Object.keys(dependencies), compiled + '; return probeInvoke;')(...Object.values(dependencies));
  return { run, reopen, invoke, revoked, epochs, release: () => release(),
    changeOwner: () => { scope = 'owner-b'; }, disable: () => { disabled = true; } };
}

it('repairs a suspended reliable link before probing while a healthy peer keeps responding', async () => {
  const h = harness();
  const pending = h.run('recovering', 'local-db:sessions:list', []);
  expect(h.invoke).not.toHaveBeenCalled();
  await expect(h.run('healthy', 'local-db:sessions:list', [])).resolves.toEqual({ ok: true, result: [] });
  expect(h.reopen).toHaveBeenCalledExactlyOnceWith('recovering', { observed: false });
  h.release();
  await expect(pending).resolves.toEqual({ ok: true, result: [] });
  expect(h.invoke.mock.calls.map(call => call[0])).toEqual(['healthy', 'recovering']);
});

it.each(['closed', 'revoked', 'owner changed', 'disabled'])(
  'does not send a probe after its pending recovery is %s', async change => {
    const h = harness();
    const pending = h.run('recovering', 'local-db:sessions:list', []);
    if (change === 'closed') h.epochs.set('recovering', 1);
    if (change === 'revoked') h.revoked.add('recovering');
    if (change === 'owner changed') h.changeOwner();
    if (change === 'disabled') h.disable();
    h.release();
    await expect(pending).rejects.toThrow();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it('does not reopen a peer whose access was already revoked', async () => {
  const h = harness();
  h.revoked.add('recovering');
  await expect(h.run('recovering', 'local-db:sessions:list', [])).rejects.toMatchObject({ code: 'ACCESS_REVOKED' });
  expect(h.reopen).not.toHaveBeenCalled();
  expect(h.invoke).not.toHaveBeenCalled();
});
