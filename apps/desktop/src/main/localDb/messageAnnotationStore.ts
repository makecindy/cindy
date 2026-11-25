import { randomUUID } from 'node:crypto';
import { stripInternalWebCitations } from '@cindy/maker-shared/internal-citation';
import type { DbClient } from './client/DbClient';
import { annotationSourceVersion, type MessageAnnotation, type MessageAnnotationAnchor, type MessageAnnotationRequest } from '../../shared/messageAnnotations';

type Ports = { db: Pick<DbClient, 'query' | 'queryOne' | 'exec'>; assertCurrent: () => void; canCreate: () => Promise<boolean> };
type Row = { id: string; sessionId: string; ordinal: number; anchorJson: string; comment: string; createdAt: number; sentAt: number | null };
function fail(message: string): never { throw new Error(`[ANNOTATION_INVALID] ${message}`); }
const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function validateAnnotationAnchor(value: unknown): asserts value is MessageAnnotationAnchor {
  const a = value as MessageAnnotationAnchor | null;
  if (!a || !string(a.messageClientId, 256) || !a.messageClientId || !string(a.sourceVersion, 128)
    || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end <= a.start
    || a.end > 10_000_000 || !string(a.quote, 16000) || a.quote.length !== a.end - a.start
    || !a.quote.trim() || !string(a.prefix, 80) || !string(a.suffix, 80)) fail('Invalid text anchor');
}

/** All writes use one SQL statement; allocating an ordinal cannot race another window. */
export async function executeMessageAnnotationRequest(raw: unknown, ports: Ports): Promise<MessageAnnotation[]> {
  const r = raw as MessageAnnotationRequest;
  if (!r || !string(r.sessionId, 256) || !r.sessionId) fail('Invalid task');
  const { db, assertCurrent } = ports;
  assertCurrent();
  const session = await db.queryOne<{ id: string }>('SELECT id FROM sessions WHERE id = ? AND status != ?', [r.sessionId, 'deleted']);
  assertCurrent();
  if (!session) fail('Task not found');
  if (r.action === 'add') {
    validateAnnotationAnchor(r.anchor);
    if (!string(r.comment, 8000) || !r.comment.trim()) fail('A reply is required (maximum 8000 characters)');
    if (!await ports.canCreate()) fail('Enable an approved annotation plugin first');
    assertCurrent();
    const message = await db.queryOne<{ id: string; content: string }>(
      "SELECT id, content FROM messages WHERE session_id = ? AND client_id = ? AND role = 'assistant' AND rewind_at IS NULL",
      [r.sessionId, r.anchor.messageClientId]);
    assertCurrent();
    if (!message) fail('Response is not saved yet');
    let content: unknown;
    try { content = JSON.parse(message.content); } catch { content = message.content; }
    if (typeof content !== 'string' || annotationSourceVersion(stripInternalWebCitations(content)) !== r.anchor.sourceVersion) fail('Response changed; select the text again');
    const result = await db.exec(`WITH RECURSIVE numbers(n) AS (
      SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 99
    ) INSERT INTO message_annotations
      (id, session_id, message_id, ordinal, anchor_json, comment, created_at)
      SELECT ?, ?, ?, n, ?, ?, ? FROM numbers
      WHERE NOT EXISTS (SELECT 1 FROM message_annotations WHERE message_id = ? AND ordinal = n)
      ORDER BY n LIMIT 1`,
    [randomUUID(), r.sessionId, message.id, JSON.stringify(r.anchor), r.comment.trim(), Date.now(), message.id]);
    if (!result.changes) fail('This response already has 99 annotations');
  } else if (r.action === 'remove') {
    if (!string(r.id, 100)) fail('Invalid annotation');
    await db.exec('DELETE FROM message_annotations WHERE session_id = ? AND id = ? AND sent_at IS NULL', [r.sessionId, r.id]);
  } else if (r.action !== 'list') fail('Unknown action');
  assertCurrent();
  const rows = await db.query<Row>(`SELECT a.id, a.session_id AS sessionId, a.ordinal, a.anchor_json AS anchorJson,
    a.comment, a.created_at AS createdAt, a.sent_at AS sentAt FROM message_annotations a
    JOIN messages m ON m.id = a.message_id WHERE a.session_id = ? AND m.rewind_at IS NULL
    AND m.role = 'assistant' ORDER BY a.created_at, a.ordinal`, [r.sessionId]);
  assertCurrent();
  return rows.map(({ anchorJson, ...row }) => ({ ...JSON.parse(anchorJson), ...row }));
}
