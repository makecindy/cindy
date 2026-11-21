import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { commitVolatileAppSession, getActiveAppSession } from '../../appSessionState';
import type { DbClient } from '../../localDb/client/DbClient';
import { clearCurrentDbClient, getCurrentDbClientSnapshot, setCurrentDbClient } from '../../localDb/client/current';
import * as markers from '../../localDb/sessionActiveTurn';
import * as schema from '../../localDb/schema';
import { SilentStopAutoResumeGuard } from '../silentStopAutoResume';
import { handleDesktopSilentStopTurnEnd } from '../silentStopTurnEnd.desktop';
import { SilentStopTurnLeaseGate } from '../sessionTurnLease';
import { ProductTurnWallClockTracker } from '../turnWallClock';
import type { SessionEventDependencies } from '../sessionEventPipeline';

const { botProfiles, botSessionLinks, messages, sessions } = schema;
const source = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const names = new Set(['wireSessionToIpc', 'handleSilentStopTurnEnd', 'markTurnEndedAfterPersistDrain']);
const bodies = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text));
if (bodies.length !== names.size) throw new Error('Desktop continuation registration entry not found');
const compiled = ts.transpileModule(bodies.map(node => node.getText(source).replace(/^export /, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function compileRegister(ports: Record<string, unknown>) {
  return new Function(...Object.keys(ports), compiled + '\nreturn { wireSessionToIpc, markTurnEndedAfterPersistDrain };')(
    ...Object.values(ports),
  ) as { wireSessionToIpc(session: Session): void; markTurnEndedAfterPersistDrain(sessionId: string, event: AgentEvent): void };
}

// Guard-tier integration L341. Execute the exact register declarations, including
// the installed Session listener, without starting Electron or booting unrelated
// providers. A provider entering continuation with an old completed timestamp
// would lose the accepted input from the real restart list in all three cases.
it.each(['quit', 'logout', 'crash', 'done'] as const)('register wiring records the restart state after %s', async (boundary) => {
  const original = getActiveAppSession();
  commitVolatileAppSession('cloud', 'register-fixture-owner');
  const directory = mkdtempSync(join(tmpdir(), 'cindy-silent-stop-register-'));
  const filename = join(directory, 'account.sqlite');
  const id = 'registered-task';
  let sqlite = new Database(filename);
  const bindDb = () => {
    const db = drizzle(sqlite, { schema });
    const client = {
      drizzle: db,
      exec: async (sql: string, args: unknown[] = []) => sqlite.prepare(sql).run(...args),
    } as Pick<DbClient, 'drizzle' | 'exec'> as DbClient;
    setCurrentDbClient(client, 'register-fixture-owner');
    return client;
  };
  for (const table of [sessions, messages, botProfiles, botSessionLinks]) {
    const { name, columns } = getTableConfig(table);
    sqlite.exec(`CREATE TABLE "${name}" (${columns.map(column => `"${column.name}" ${column.getSQLType()}`).join(', ')})`);
  }
  const client = bindDb();
  await client.drizzle.insert(sessions).values({ id, status: 'active', source: 'desktop', createdAt: 1, updatedAt: 1 });
  let eventReceived = Promise.withResolvers<{ deps: SessionEventDependencies; event: AgentEvent }>();
  const events: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let providerMarker: number | null | undefined;
  const sent: unknown[] = [];
  const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => log };
  const runtime = new Session({ id, workDir: directory, agentKind: 'claude-code', capabilities: {} as never,
    handle: {
      agentKind: 'claude-code',
      async send(message: { content: unknown }) {
        sent.push(message.content);
        if (sent.length > 1) {
          const row = sqlite.prepare('SELECT active_turn_started_at AS started FROM sessions WHERE id = ?').get(id) as { started?: number };
          providerMarker = row.started;
        }
      },
      setInteractionResolver() {},
      close: async () => { closed = true; wake?.(); },
      abort: async () => {},
      async *events() {
        while (!closed) {
          if (events.length > 0) yield events.shift()!;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      },
    } as unknown as AgentSessionHandle, logger: log, turnStallMs: 0 });
  const noop = () => {};
  const gate = new SilentStopTurnLeaseGate();
  const guard = new SilentStopAutoResumeGuard({ isEnabled: () => true, log });
  const clock = new ProductTurnWallClockTracker();
  const registration = { disposers: [] as Array<() => void> };
  const register = compileRegister({
    getActiveAppSession, getCurrentDbClientSnapshot, log,
    handleDesktopSilentStopTurnEnd,
    sessionTurnObserverDependencies: {}, installSessionTurnObserver: () => noop,
    noteSessionAgentKind: noop, makerToDbEngineKind: () => 'cc',
    createGhostSessionTap: () => ({ dispose: noop, handleEvent: noop }),
    clearPendingTurnChangeSets: noop, noteTurnDiffEvent: noop, isFencedStaleSessionTerminal: () => false,
    sessionBindings: { beginBinding: () => registration, getSession: () => runtime, attachStatusListener: noop },
    sessionEventDependencies: {}, installDesktopInteractionListener: noop, installInteractionLifecycleObserver: noop,
    silentStopTurnLeaseGate: gate, agentInputCoordinatorHolder: null, silentStopAutoResumeGuard: guard,
    sessionListActivityTracker: { captureContinuation: () => noop },
    productTurnWallClockTracker: clock, advanceRuntimeRecoveryNotice: noop,
    createDbMessage: async (_sessionId: string, message: { clientId: string; content: string }) => {
      await client.drizzle.insert(messages).values({
        id: message.clientId, clientId: message.clientId, sessionId: id, role: 'user',
        content: JSON.stringify(message.content), createdAt: Date.now(),
      });
    },
    settleSilentStopDone: () => { throw new Error('fixture should resume'); },
    surfaceSilentStopExhaustedBanner: () => { throw new Error('fixture should not show a failure banner'); },
    drainPersistQueue: () => Promise.resolve(), markSessionTurnEndedAfterBarrier: markers.markSessionTurnEndedAfterBarrier,
    handleSessionEvent(deps: SessionEventDependencies, _session: Session, event: AgentEvent) {
      if (event.type === 'done') eventReceived.resolve({ deps, event });
    },
  });
  try {
    register.wireSessionToIpc(runtime);
    markers.markSessionTurnStarted(id);
    await markers.drainSessionActiveTurnWrites(id);
    guard.noteUserSend(id);
    await runtime.send('original input');
    events.push({ type: 'done', data: { silentStop: true }, source: 'claude-code' });
    wake?.();
    const { deps, event } = await eventReceived.promise;
    const oldEndedAt = Date.now();
    expect(gate.schedule(id, event, 'fixture-lease')).toBe(true);
    register.markTurnEndedAfterPersistDrain(id, event);
    await Promise.resolve();
    await markers.drainSessionActiveTurnWrites(id);
    const now = oldEndedAt + 1500;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await deps.handleSilentStopTurnEnd(runtime, oldEndedAt, 'fixture-lease');
    expect(sent).toEqual(['original input', '继续']);
    if (boundary === 'done') {
      eventReceived = Promise.withResolvers<{ deps: SessionEventDependencies; event: AgentEvent }>();
      events.push({ type: 'done', data: {}, source: 'claude-code' });
      wake?.();
      const terminal = await eventReceived.promise;
      expect(terminal.event.sessionTurnGeneration).toBe(runtime.getTurnGeneration());
      register.markTurnEndedAfterPersistDrain(id, terminal.event);
    }
    if (boundary === 'quit') markers.freezeSessionActiveTurnMarkers();
    const unsuppress = boundary === 'logout' ? markers.beginSessionTurnEndedSuppression() : undefined;
    if (boundary === 'quit' || boundary === 'logout') {
      register.markTurnEndedAfterPersistDrain(id, {
        ...event, sessionTurnGeneration: runtime.getTurnGeneration(),
      });
    }
    await Promise.resolve();
    await markers.drainSessionActiveTurnWrites(id);
    unsuppress?.();
    clearCurrentDbClient();
    sqlite.close();
    markers._resetSessionActiveTurnStateForTests();
    markers._setBootAtMsForTests(now + 100);
    sqlite = new Database(filename);
    bindDb();
    expect(await markers.listInterruptedPendingSessionIds()).toEqual(boundary === 'done' ? [] : [id]);
    if (boundary !== 'done') expect(providerMarker).toBe(now);
  } finally {
    for (const dispose of registration.disposers) dispose();
    await runtime.close();
    clearCurrentDbClient();
    sqlite.close();
    rmSync(directory, { force: true, recursive: true });
    commitVolatileAppSession(original.mode, original.dataOwnerId);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  markers._resetSessionActiveTurnStateForTests();
});
