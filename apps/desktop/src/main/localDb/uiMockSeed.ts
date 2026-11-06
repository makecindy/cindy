/**
 * Dev-only UI mock data (`pnpm restart:desktop:remote -- --mock`).
 *
 * The launcher sets XDT_UI_MOCK=1 and main/index.ts keeps it only for an
 * unpackaged isolated sandbox. A fresh mock sandbox starts account-free and its
 * local owner database receives the shared demo tasks from
 * `@cindy/maker-shared/ui-mock`. Existing rows are never overwritten, so edits
 * made while testing survive restarts. See docs/dev-rules/ui-mock-data.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { buildUiMockRows, UI_MOCK_PROJECTS } from '@cindy/maker-shared/ui-mock';

import { messages, sessions } from './schema.js';
import type * as schema from './schema.js';

export const UI_MOCK_ENV = 'XDT_UI_MOCK';

export function isUiMockDataEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UI_MOCK_ENV] === '1';
}

/** Write the demo project files once; later edits made while testing are kept. */
export function ensureUiMockProjects(projectRoot: string): void {
  for (const project of UI_MOCK_PROJECTS) {
    for (const [relativePath, content] of Object.entries(project.files)) {
      const file = path.join(projectRoot, project.name, relativePath);
      if (fs.existsSync(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
}

/** Insert the missing demo tasks and the messages of unfinished ones. Returns the number of new tasks. */
export async function seedUiMockData({
  db,
  projectRoot,
  dialogueDir,
  now = Date.now(),
}: {
  db: BetterSQLite3Database<typeof schema>;
  projectRoot: string;
  /** App-managed folder for a dialogue task, as created for real dialogues. */
  dialogueDir(sessionId: string, createdAt: number): string;
  now?: number;
}): Promise<number> {
  ensureUiMockProjects(projectRoot);
  const rows = buildUiMockRows({ now, projectRoot });
  const inserted = await db
    .insert(sessions)
    .values(rows.sessions.map((row) => ({
      id: row.id,
      title: row.title,
      workingDir: row.workingDir ?? dialogueDir(row.id, row.createdAt),
      workspaceKind: row.workspaceKind,
      agentKind: row.agentKind,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      fastMode: row.fastMode,
      status: row.status,
      source: row.source,
      pinnedAt: row.pinnedAt,
      userSendAt: row.userSendAt,
      listPreview: row.preview,
      listPreviewRole: 'assistant',
      listMessageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })))
    .onConflictDoNothing()
    .returning({ id: sessions.id });
  const newTaskIds = new Set(inserted.map((row) => row.id));
  // Tasks and messages are two writes. A start interrupted between them leaves a mock
  // task without history, so a catalog task that has no message row at all is finished
  // too. A message the developer deleted leaves a tombstone row, so it is not restored.
  const catalogIds = rows.sessions.map((row) => row.id);
  const withHistory = new Set(
    (await db.selectDistinct({ id: messages.sessionId }).from(messages)
      .where(inArray(messages.sessionId, catalogIds))).map((row) => row.id),
  );
  const existing = await db.select({ id: sessions.id }).from(sessions)
    .where(inArray(sessions.id, catalogIds));
  const seedMessagesFor = new Set([
    ...newTaskIds,
    ...existing.map((row) => row.id).filter((id) => !withHistory.has(id)),
  ]);
  const newMessages = rows.messages.filter((row) => seedMessagesFor.has(row.sessionId));
  if (newMessages.length > 0) {
    await db
      .insert(messages)
      .values(newMessages.map((row) => ({
        id: row.id,
        clientId: row.clientId,
        sessionId: row.sessionId,
        role: row.role,
        content: JSON.stringify(row.content),
        toolUseId: row.toolUseId,
        ...(row.agentMeta ? { agentMeta: JSON.stringify(row.agentMeta) } : {}),
        createdAt: row.createdAt,
      })))
      .onConflictDoNothing();
  }
  return newTaskIds.size;
}
