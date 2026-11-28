import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { projectSessionActivity, type SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { getIssueConfirmBridge, IssueConfirmBridge, setIssueConfirmBridge } from '../../github-issue/issueConfirmBridge.js';
import * as schema from '../../localDb/schema.js';
import { getSessionInterruptionBootAt, setSessionInterruptionBootAtForTests } from '../../localDb/sessionInterruptionBoot.js';
import {
  createCanonicalSessionRightStatusBatchReader,
  createSessionActivityReader,
  type PersistedSessionActivityFacts,
} from '../sessionActivityProjection.js';

const desktopFlags = vi.hoisted(() => new Map<string, Pick<SessionActivitySnapshot, 'phase' | 'attention'>>());
vi.mock('../../agent-island/current.js', () => ({
  getAgentIslandService: () => ({ getSessionActivityFlags: () => desktopFlags }),
}));

function facts(
  patch: Partial<PersistedSessionActivityFacts> = {},
): PersistedSessionActivityFacts {
  return {
    status: 'active',
    title: '任务',
    source: 'desktop',
    remoteHostId: null,
    startedAt: null,
    endedAt: null,
    clearedAt: null,
    ...patch,
  };
}

function setup(opts?: {
  live?: ReturnType<typeof projectSessionActivity> | null;
  persisted?: PersistedSessionActivityFacts | null;
  terminal?: { status: 'error'; createdAt?: number };
}) {
  const deps = {
    getLiveSnapshot: vi.fn(() => opts?.live ?? null),
    getPersistedFacts: vi.fn(async () =>
      opts && 'persisted' in opts ? (opts.persisted ?? null) : facts(),
    ),
    getLatestTerminal: vi.fn(async () => opts?.terminal),
  };
  return { deps, read: createSessionActivityReader(deps) };
}

describe('canonical session activity reader', () => {
  it('uses the live Agent Island snapshot without consulting cold storage', async () => {
    const live = projectSessionActivity({
      sessionId: 'live',
      recordStatus: 'active',
      source: 'live',
      livePhase: 'needs-interaction',
      startedAtMs: 10,
      lastActivityAtMs: 20,
      currentActionSummary: '等待用户确认',
      attention: true,
    });
    const { deps, read } = setup({ live });

    await expect(read('live')).resolves.toBe(live);
    expect(deps.getPersistedFacts).not.toHaveBeenCalled();
    expect(deps.getLatestTerminal).not.toHaveBeenCalled();
  });

  it('projects a durable normal completion, record lifecycle and title workflow', async () => {
    const { read } = setup({
      persisted: facts({
        status: 'archived',
        title: '🚧#2804 会话控制面 · 待bot',
        startedAt: 100,
        endedAt: 200,
      }),
    });

    await expect(read('completed')).resolves.toMatchObject({
      sessionId: 'completed',
      recordStatus: 'archived',
      phase: 'completed',
      source: 'persisted',
      startedAtMs: 100,
      lastActivityAtMs: 200,
      currentActionSummary: '上次运行已正常结束',
      attention: false,
      workflow: {
        key: 'awaiting-bot',
        label: '待bot',
        waitingOn: 'automation',
      },
    });
  });

  it('projects an error terminal without exposing its persisted body', async () => {
    const { deps, read } = setup({
      persisted: facts({ startedAt: 100, endedAt: 150, clearedAt: 80 }),
      terminal: { status: 'error', createdAt: 175 },
    });

    await expect(read('failed')).resolves.toMatchObject({
      phase: 'error',
      lastActivityAtMs: 175,
      currentActionSummary: '上次运行出错',
      attention: true,
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('failed', 80);
  });

  it('marks a started turn beyond every durable close boundary as interrupted', async () => {
    const { read } = setup({
      persisted: facts({ startedAt: 300, endedAt: 200, clearedAt: 250 }),
    });

    await expect(read('interrupted')).resolves.toMatchObject({
      phase: 'error',
      startedAtMs: 300,
      lastActivityAtMs: 300,
      currentActionSummary: '上次运行未正常结束',
      attention: true,
    });
  });

  it('does not resurrect terminal state from before the clear boundary', async () => {
    const { deps, read } = setup({
      persisted: facts({
        status: 'deleted',
        title: '任务 · 等待外部系统',
        startedAt: 100,
        endedAt: 150,
        clearedAt: 200,
      }),
    });

    await expect(read('cleared')).resolves.toMatchObject({
      recordStatus: 'deleted',
      phase: 'idle',
      attention: false,
      currentActionSummary: null,
      workflow: { key: 'title:等待外部系统' },
    });
    expect(deps.getLatestTerminal).toHaveBeenCalledWith('cleared', 200);
  });

  it('fails closed to an idle fallback when the session row disappears', async () => {
    const { read } = setup({ persisted: null });
    await expect(read('missing')).resolves.toMatchObject({
      sessionId: 'missing',
      phase: 'idle',
      source: 'fallback',
    });
  });
});

// Unit regression: the sidebar restores unresolved alerts from active rows on their owning host.
// The MCP reader above intentionally reports historical interruptions without the sidebar's boot boundary.
it('restores pre-boot interruptions and visible error tails only while the native alert is pending', async () => {
  const sqlite = new Database(':memory:');
  const bootAt = getSessionInterruptionBootAt();
  onTestFinished(() => {
    setSessionInterruptionBootAtForTests(bootAt);
    sqlite.close();
  });
  setSessionInterruptionBootAtForTests(200);
  sqlite.exec(`CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, created_at INTEGER, rewind_at INTEGER);
    INSERT INTO messages VALUES ('archived-tail', 'error', '{}', 100, NULL), ('cleared-tail', 'error', '{}', 100, NULL),
      ('dismissed-tail', 'error', '{"dismissed":true}', 100, NULL), ('visible-tail', 'error', '{}', 100, NULL);`);
  const cases = [
    ['pre-boot', { startedAt: 199 }, 'error'],
    ['at-boot', { startedAt: 200 }, 'time'],
    ['post-boot', { startedAt: 201 }, 'time'],
    ['archived', { startedAt: 100, status: 'archived' }, 'time'],
    ['archived-tail', { status: 'archived' }, 'time'],
    ['closed-turn', { startedAt: 100, endedAt: 100 }, 'time'],
    ['cleared-turn', { startedAt: 100, clearedAt: 100 }, 'time'],
    ['cleared-tail', { clearedAt: 100 }, 'time'],
    ['dismissed-tail', {}, 'time'],
    ['visible-tail', {}, 'error'],
  ] as const;
  const persisted = new Map(cases.map(([id, patch]) => [id, facts(patch)]));
  const read = createCanonicalSessionRightStatusBatchReader(persisted, drizzle(sqlite, { schema }), () => undefined);
  expect(await Promise.all(cases.map(([id]) => read(id)))).toEqual(cases.map(([, , status]) => status));
});

// Unit regression: the Issue bridge owns these confirmations outside Agent Island's live phase.
// Exercise a real pending card and its dismissal without reading a draft or querying messages.
it('shows an owner-local Issue confirmation above running and below error until dismissed', async () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  const bridge = new IssueConfirmBridge({ broadcast: () => {} });
  const previous = getIssueConfirmBridge();
  const ids = ['waiting', 'failed', 'ssh', 'switched'];
  const rows = new Map(ids.map(id => [id, facts({ remoteHostId: id === 'ssh' ? 'ssh-host' : null })]));
  onTestFinished(() => {
    for (const id of ids) bridge.cleanupForSession(id, 'session_closed');
    setIssueConfirmBridge(previous);
    desktopFlags.clear();
    sqlite.close();
  });
  setIssueConfirmBridge(bridge);
  let sameOwner = true;
  for (const id of ids) {
    desktopFlags.set(id, id === 'failed' ? { phase: 'error', attention: true } : { phase: 'running', attention: false });
    void bridge.request(id, { title: 'Issue', get body(): string { throw new Error('draft body read'); }, type: 'bug' },
      { appVersion: '1', platform: 'test', arch: 'test', osVersion: '1', harness: 'Codex', modelId: 'test', region: 'cn' },
      { platform: { kind: 'platform', login: 'test' } }, undefined, () => sameOwner);
  }
  const read = createCanonicalSessionRightStatusBatchReader(rows, db);
  expect(await Promise.all(ids.map(read))).toEqual(['awaiting', 'error', 'running', 'awaiting']);
  const readHost = createCanonicalSessionRightStatusBatchReader(rows, db, () => desktopFlags);
  await expect(readHost('waiting')).resolves.toBe('running');
  bridge.cleanupForSession('waiting', 'session_aborted');
  await expect(createCanonicalSessionRightStatusBatchReader(rows, db)('waiting')).resolves.toBe('running');
  sameOwner = false;
  await expect(createCanonicalSessionRightStatusBatchReader(rows, db)('switched')).resolves.toBe('running');
});
