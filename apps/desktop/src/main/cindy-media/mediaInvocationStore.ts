import type { MediaCapability } from '@cindy/model-providers';
import {
  parsePreparedMediaInvocationGuide,
  type PreparedMediaInvocationGuide,
} from '../../shared/mediaInvocation.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { getDbClient } from '../localDb/client/current.js';

export type MediaInvocationState =
  'prepared' | 'submitting' | 'pending' | 'complete' | 'failed' | 'unknown';

export interface StoredMediaInvocation {
  id: string;
  owner: string;
  modelId: string;
  capability: MediaCapability;
  guideRevision: string;
  guide: PreparedMediaInvocationGuide;
  state: MediaInvocationState;
  taskId?: string;
  responseJson?: string;
  createdAt: number;
  updatedAt: number;
}

interface MediaInvocationRow {
  id: string;
  owner: string;
  modelId: string;
  capability: string;
  guideRevision: string;
  guideJson: string;
  state: MediaInvocationState;
  taskId: string | null;
  responseJson: string | null;
  createdAt: number;
  updatedAt: number;
}

function fromRow(row: MediaInvocationRow): StoredMediaInvocation {
  let rawGuide: unknown;
  try {
    rawGuide = JSON.parse(row.guideJson) as unknown;
  } catch {
    throw new Error(`媒体调用 ${row.id} 的 guide 快照不是合法 JSON`);
  }
  const parsed = parsePreparedMediaInvocationGuide(rawGuide);
  if (!parsed.ok) throw new Error(`媒体调用 ${row.id} 的 guide 快照不合法: ${parsed.error}`);
  if (
    parsed.value.modelId !== row.modelId ||
    parsed.value.capability !== row.capability ||
    parsed.value.revision !== row.guideRevision
  ) {
    throw new Error(`媒体调用 ${row.id} 的 guide 快照与索引字段不一致`);
  }
  return {
    id: row.id,
    owner: row.owner,
    modelId: row.modelId,
    capability: parsed.value.capability,
    guideRevision: row.guideRevision,
    guide: parsed.value,
    state: row.state,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    ...(row.responseJson ? { responseJson: row.responseJson } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function recoverInterruptedMediaInvocations(
  owner: string,
  db: DbClient = getDbClient(),
): Promise<number> {
  const result = await db.exec(
    `UPDATE media_invocations
       SET state = 'unknown', updated_at = ?
     WHERE owner = ? AND state = 'submitting'`,
    [Date.now(), owner],
  );
  return Number(result.changes);
}

export async function pruneMediaInvocations(
  input: {
    owner: string;
    preparedBefore: number;
    terminalBefore: number;
  },
  db: DbClient = getDbClient(),
): Promise<void> {
  await db.exec(
    `DELETE FROM media_invocations
     WHERE owner = ? AND (
       (state = 'prepared' AND created_at < ?)
       OR (state IN ('pending', 'complete', 'failed', 'unknown') AND updated_at < ?)
     )`,
    [input.owner, input.preparedBefore, input.terminalBefore],
  );
}

export async function countMediaInvocations(
  owner: string,
  db: DbClient = getDbClient(),
): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM media_invocations
     WHERE owner = ? AND state IN ('prepared', 'submitting', 'pending')`,
    [owner],
  );
  return Number(row?.count ?? 0);
}

export async function createMediaInvocation(
  input: {
    id: string;
    owner: string;
    guide: PreparedMediaInvocationGuide;
    createdAt: number;
  },
  db: DbClient = getDbClient(),
): Promise<void> {
  await db.exec(
    `INSERT INTO media_invocations (
       id, owner, model_id, capability, guide_revision, guide_json,
       state, task_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
    [
      input.id,
      input.owner,
      input.guide.modelId,
      input.guide.capability,
      input.guide.revision,
      JSON.stringify(input.guide),
      input.createdAt,
      input.createdAt,
    ],
  );
}

export async function getMediaInvocation(
  id: string,
  owner: string,
  db: DbClient = getDbClient(),
): Promise<StoredMediaInvocation | null> {
  const row = await db.queryOne<MediaInvocationRow>(
    `SELECT
       id,
       owner,
       model_id AS modelId,
       capability,
       guide_revision AS guideRevision,
       guide_json AS guideJson,
       state,
       task_id AS taskId,
       response_json AS responseJson,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM media_invocations
     WHERE id = ? AND owner = ?`,
    [id, owner],
  );
  return row ? fromRow(row) : null;
}

export async function transitionMediaInvocation(
  input: {
    id: string;
    owner: string;
    from: MediaInvocationState;
    to: MediaInvocationState;
    taskId?: string;
    responseJson?: string;
  },
  db: DbClient = getDbClient(),
): Promise<boolean> {
  const result =
    input.taskId !== undefined
      ? await db.exec(
          `UPDATE media_invocations
           SET state = ?, task_id = ?, updated_at = ?
         WHERE id = ? AND owner = ? AND state = ?`,
          [input.to, input.taskId, Date.now(), input.id, input.owner, input.from],
        )
      : input.responseJson !== undefined
        ? await db.exec(
            `UPDATE media_invocations
             SET state = ?, response_json = ?, updated_at = ?
           WHERE id = ? AND owner = ? AND state = ?`,
            [input.to, input.responseJson, Date.now(), input.id, input.owner, input.from],
          )
        : await db.exec(
            `UPDATE media_invocations
           SET state = ?, updated_at = ?
         WHERE id = ? AND owner = ? AND state = ?`,
            [input.to, Date.now(), input.id, input.owner, input.from],
          );
  return Number(result.changes) === 1;
}
