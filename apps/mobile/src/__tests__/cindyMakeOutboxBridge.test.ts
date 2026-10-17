import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { cindyMakeOutboxPolicy } from '@/session/cindyMakeOutboxPolicy';
import { isDurableOutboxHandedOff, isDurableOutboxSettled, type DurableOutboxRecord } from '@/session/durableOutbox';
import type { OutboxSessionPolicy } from '@/session/durableOutboxDelivery';

const source = ts.createSourceFile('MobileOutboxBridge.tsx', readFileSync(resolve(
  process.cwd(), 'src/session/MobileOutboxBridge.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = new Map<string, string>();
const names = ['knownSession', 'hidden', 'invokeOwned', 'canRun', 'sessionPolicy'];
function visit(node: ts.Node) {
  if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)
      && ['canRun', 'sessionPolicy'].includes(node.name.getText(source))) && node.initializer
      && names.includes(node.name.getText(source))) expressions.set(node.name.getText(source), node.initializer.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
for (const name of names) if (!expressions.has(name)) throw new Error('Missing outbox callback: ' + name);
const compiled = ts.transpileModule(
  'function create(deps) { const { remoteSessionStore, mobileDurableOutbox, latest, guard, AppState, CINDY_MAKE_ENABLED, isCindyMakeSource, isDurableOutboxSettled, isDurableOutboxHandedOff, cindyMakeOutboxPolicy, isCurrent } = deps;'
  + ['knownSession', 'hidden', 'invokeOwned'].map(name => 'const ' + name + ' = ' + expressions.get(name) + ';').join('')
  + 'const needsReconciliation = () => true; const isDurableOutboxCreationHeld = () => false; const getNewSessionCreationTask = () => null;'
  + 'const maker = (record) => ({ getSession: (sessionId) => invokeOwned(record)(record.deviceId, "local-db:sessions:get", [sessionId]) });'
  + 'return { hidden, invokeOwned, canRun: ' + expressions.get('canRun') + ', sessionPolicy: ' + expressions.get('sessionPolicy') + ' }; }',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness(sessions: Array<{ id: string; source?: string; deviceLinkDeviceId: string }>) {
  const record = { deviceId: 'desktop', state: 'queued', uploads: [],
    item: { sessionId: 'session', clientId: 'client', attachmentSlots: [] } } as unknown as DurableOutboxRecord;
  const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[], options: { preSend(): void }) => {
    options.preSend(); return { id: 'session', source: 'cc' };
  });
  const latest = { current: { link: { status: 'online', getPresenceAvailability: () => true, invoke } } };
  const deps = { remoteSessionStore: { getSessions: () => sessions }, mobileDurableOutbox: { getSnapshot: () => [record] },
    latest, guard: () => {}, AppState: { currentState: 'active' }, CINDY_MAKE_ENABLED, isCindyMakeSource,
    isDurableOutboxSettled, isDurableOutboxHandedOff, cindyMakeOutboxPolicy, isCurrent: () => true };
  const callbacks = new Function(compiled + '; return create;')()(deps) as {
    hidden(record: DurableOutboxRecord): boolean;
    canRun(record: DurableOutboxRecord): boolean;
    sessionPolicy(record: DurableOutboxRecord): Promise<OutboxSessionPolicy>;
    invokeOwned(record: DurableOutboxRecord): (device: string, channel: string, args: unknown[]) => Promise<unknown>;
  };
  return { record, callbacks, invoke, latest, deps };
}

describe('Cindy Make outbox bridge guards', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('selects a suspended hidden %s record for local cleanup even offline', async source => {
    const { record, callbacks, invoke, latest } = harness([{ id: 'session', source, deviceLinkDeviceId: 'desktop' }]);
    record.suspended = true;
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(true);
    expect(callbacks.canRun(record)).toBe(true);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not confuse the same session ID on another computer with a hidden task', async () => {
    const { record, callbacks, invoke } = harness([{ id: 'session', source: 'cindy-make', deviceLinkDeviceId: 'other-desktop' }]);
    expect(callbacks.hidden(record)).toBe(false);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    expect(invoke).toHaveBeenCalledWith('desktop', 'local-db:sessions:get', ['session'], expect.anything());
  });

  it.each(['cindy-make', 'cindy-make-merge'])('checks raw metadata again before enqueue when %s arrives late', async source => {
    const sessions = [{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }];
    const { record, callbacks, invoke } = harness(sessions);
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('deliver');
    const sent = vi.fn();
    invoke.mockImplementationOnce(async (_device, _channel, _args, options) => {
      sessions[0].source = source;
      options.preSend();
      sent();
      return { id: 'session', source };
    });
    await expect(callbacks.invokeOwned(record)('desktop', 'maker:input:enqueue', ['session'])).rejects.toThrow('OUTBOX_SESSION_DISABLED');
    expect(sent).not.toHaveBeenCalled();
    await expect(callbacks.sessionPolicy(record)).resolves.toBe('discard');
  });

  it('keeps ordinary offline records suspended instead of deleting or delivering them', () => {
    const { record, callbacks, latest } = harness([{ id: 'session', source: 'cc', deviceLinkDeviceId: 'desktop' }]);
    latest.current.link.status = 'offline';
    expect(callbacks.hidden(record)).toBe(false);
    expect(callbacks.canRun(record)).toBe(false);
    latest.current.link.status = 'online';
    record.suspended = true;
    expect(callbacks.canRun(record)).toBe(false);
  });
});
