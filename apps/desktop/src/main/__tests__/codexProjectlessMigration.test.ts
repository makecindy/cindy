import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Production keeps migration helpers CommonJS; Vitest loads the TS helper through
// its transformer and consumes the CommonJS default export.
const { default: migration } = (await import('../../../drizzle/scripts/0025_reclassify_codex_projectless_dialogues')) as {
  default: { run: (db: unknown, options?: { codexHomes?: string[] }) => void };
};

let codexHome: string;

interface FakeSession {
  id: string;
  agentKind: string;
  sdkSessionId: string;
  workspaceKind: string;
}

beforeEach(() => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-codex-home-'));
});

afterEach(() => {
  fs.rmSync(codexHome, { recursive: true, force: true });
});

function createSessions(): FakeSession[] {
  return [
    {
      id: 'codex-dialogue',
      agentKind: 'codex',
      sdkSessionId: 'thread-dialogue',
      workspaceKind: 'project',
    },
    {
      id: 'codex-project',
      agentKind: 'codex',
      sdkSessionId: 'thread-project',
      workspaceKind: 'project',
    },
    {
      id: 'claude-same-sdk',
      agentKind: 'cc',
      sdkSessionId: 'thread-dialogue',
      workspaceKind: 'project',
    },
  ];
}

function createFakeDb(sessions: FakeSession[]) {
  return {
    prepare(sql: string) {
      if (sql.startsWith("PRAGMA table_info('sessions')")) {
        return {
          all: () =>
            ['id', 'agent_kind', 'sdk_session_id', 'workspace_kind'].map((name) => ({ name })),
        };
      }
      if (sql.includes('UPDATE sessions')) {
        return {
          run: (threadId: string) => {
            let changes = 0;
            for (const session of sessions) {
              if (
                session.agentKind === 'codex' &&
                session.sdkSessionId === threadId &&
                session.workspaceKind !== 'dialogue'
              ) {
                session.workspaceKind = 'dialogue';
                changes += 1;
              }
            }
            return { changes };
          },
        };
      }
      throw new Error(`Unexpected SQL in fake migration DB: ${sql}`);
    },
  };
}

function workspaceKind(sessions: FakeSession[], id: string): string {
  const session = sessions.find((item) => item.id === id);
  if (!session) throw new Error(`missing fake session: ${id}`);
  return session.workspaceKind;
}

describe('0025 reclassify Codex projectless dialogues migration', () => {
  it('marks existing Codex rows from projectless-thread-ids as dialogue', () => {
    fs.writeFileSync(
      path.join(codexHome, '.codex-global-state.json'),
      JSON.stringify({ 'projectless-thread-ids': ['thread-dialogue'] }),
    );
    const sessions = createSessions();
    const db = createFakeDb(sessions);

    migration.run(db, { codexHomes: [codexHome] });

    expect(workspaceKind(sessions, 'codex-dialogue')).toBe('dialogue');
    expect(workspaceKind(sessions, 'codex-project')).toBe('project');
    expect(workspaceKind(sessions, 'claude-same-sdk')).toBe('project');
  });

  it('is a no-op when Codex global state is missing', () => {
    const sessions = createSessions();
    const db = createFakeDb(sessions);

    migration.run(db, { codexHomes: [codexHome] });

    expect(workspaceKind(sessions, 'codex-dialogue')).toBe('project');
  });
});
