import type Database from 'better-sqlite3';
import {
  createAutoReviewIntentProjection,
  type AutoReviewHistoryMessage,
  type AutoReviewUserIntent,
} from '@cindy/maker-shared/auto-review-intent';

export interface StoredAutoReviewProjection {
  revision: number;
  sessionIntent: AutoReviewUserIntent;
  reviewIntent: AutoReviewUserIntent;
}

/** Self-contained for the inline worker fallback; never closes over Main services. */
export function readAutoReviewProjection(
  db: Database.Database,
  args: unknown,
  createProjection: typeof createAutoReviewIntentProjection,
): StoredAutoReviewProjection {
  const input = args as { sessionId?: unknown; leadId?: unknown } | null;
  if (!input || typeof input.sessionId !== 'string' || typeof input.leadId !== 'string') {
    throw new Error('Invalid authorization projection identity');
  }
  const { sessionId, leadId } = input;
  const installed = db
    .prepare(
      `SELECT count(*) AS count FROM sqlite_master WHERE type='trigger'
    AND name IN ('auto_review_message_insert','auto_review_message_update',
      'auto_review_message_delete','auto_review_session_clear')`,
    )
    .get() as { count: number };
  if (installed.count !== 4)
    throw new Error('Authorization projection invalidation is unavailable');
  type State = {
    sessionIntent: AutoReviewUserIntent;
    reviewIntent: AutoReviewUserIntent;
    lastEventAt: number;
    sessionAmbiguous: boolean;
    reviewUnverified: boolean;
  };
  const validIntent = (intent: unknown): boolean => {
    if (typeof intent === 'string') return intent.length <= 2000;
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return false;
    const value = intent as Record<string, unknown>;
    return (
      typeof value.currentUserMessage === 'string' &&
      Array.isArray(value.earlierUserMessages) &&
      value.earlierUserMessages.every((x) => typeof x === 'string') &&
      (value.historyOmitted === undefined || value.historyOmitted === true) &&
      JSON.stringify(value).length <= 2100
    );
  };
  const parseState = (raw: unknown): State | null => {
    try {
      const value = JSON.parse(String(raw)) as State | null;
      return value &&
        typeof value.reviewUnverified === 'boolean' &&
        typeof value.sessionAmbiguous === 'boolean' &&
        Number.isFinite(value.lastEventAt) &&
        validIntent(value.sessionIntent) && validIntent(value.reviewIntent)
        ? value : null;
    } catch {
      return null;
    }
  };
  const projector = createProjection();
  // Durable triggers only invalidate. The connection-local trigger is allowed
  // to call a UDF; older clients can still write, but can never retain a valid
  // stale projection. No user data or function names are stored in migrations.
  if (
    !db
      .prepare(
        "SELECT 1 FROM temp.sqlite_master WHERE type='trigger' AND name='auto_review_project'",
      )
      .get()
  ) {
    db.function('cindy_authority_projection_valid_v1', (raw) => parseState(raw) ? 1 : 0);
    db.function('cindy_authority_projection_v1', (raw, target, previous, event) => {
      if (raw === null) {
        const state = JSON.parse(String(previous)) as State;
        const row = JSON.parse(String(event)) as AutoReviewHistoryMessage & { sessionId: string };
        try {
          row.agentMeta = JSON.parse(String(row.agentMeta));
        } catch {
          row.agentMeta = null;
        }
        if (projector.isSynthetic(row))
          return JSON.stringify(state);
        const reset = projector.readText(row.content) === null;
        if (row.sessionId === target && !state.sessionAmbiguous) {
          const text = projector.restore([row]) as string;
          state.sessionIntent = projector.append(reset ? '' : state.sessionIntent, text);
        }
        const review = projector.reviewState([row]);
        if (review.unverified) state.reviewUnverified = true;
        if (!review.unverified || review.intent !== '')
          state.reviewIntent = projector.append(
            reset ? '' : state.reviewIntent,
            review.intent as string,
          );
        state.lastEventAt = row.createdAt!;
        return JSON.stringify(state);
      }
      const rows = JSON.parse(String(raw)) as Array<
        AutoReviewHistoryMessage & { sessionId: string }
      >;
      const history = rows.flatMap((row) => {
        let meta: unknown = row.agentMeta;
        try {
          if (typeof meta === 'string') meta = JSON.parse(meta);
        } catch {
          meta = null;
        }
        row.agentMeta =
          meta && typeof meta === 'object' && !Array.isArray(meta)
            ? (meta as Record<string, unknown>)
            : null;
        if (projector.isSynthetic(row)) return [];
        return [row];
      });
      const own = history.filter((row) => row.sessionId === target);
      const review = projector.reviewState(history);
      return JSON.stringify({
        sessionIntent: projector.restore(history.filter((row) => row.sessionId === target)),
        reviewIntent: review.intent,
        reviewUnverified: review.unverified,
        sessionAmbiguous: projector.ambiguousAnswers(own),
        lastEventAt: history.reduce((at, row) => {
          const receipt = row.agentMeta?.autoReviewUserText as
            { acceptedAt?: unknown; text?: unknown } | undefined;
          const value =
            (row.role === 'ask_user' || row.role === 'plan_review') &&
            typeof receipt?.acceptedAt === 'number' &&
            typeof receipt.text === 'string'
              ? receipt.acceptedAt
              : (row.createdAt ?? 0);
          return Math.max(at, value);
        }, 0),
      });
    });
    // Ambiguous trigger receipts use full replay. Once history is omitted, only
    // a canonical text-only event can use the string append fast path.
    // The source query is evaluated by SQLite, not a reentrant database call
    // inside the UDF. Both summaries and the transcript commit or roll back together.
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS auto_review_projection_batch(depth INTEGER NOT NULL);
      INSERT INTO auto_review_projection_batch SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM auto_review_projection_batch);
      CREATE TEMP TRIGGER auto_review_project AFTER UPDATE OF revision ON main.auto_review_projections
      WHEN (SELECT depth FROM auto_review_projection_batch) = 0
      BEGIN
        UPDATE auto_review_projections SET payload = cindy_authority_projection_v1(CASE WHEN OLD.projected_revision = OLD.revision AND OLD.version = 3
          AND cindy_authority_projection_valid_v1(OLD.payload) = 1
          AND json_extract(NEW.payload, '$.appendEvent.role') = 'user'
          AND json_extract(NEW.payload, '$.appendEvent.visible') = 1
          AND (coalesce(CASE WHEN json_valid(OLD.payload) THEN json_extract(OLD.payload, '$.sessionIntent.historyOmitted') ELSE NULL END, 0) = 0
            OR CASE WHEN json_valid(json_extract(NEW.payload, '$.appendEvent.agentMeta')) THEN
              json_type(json_extract(NEW.payload, '$.appendEvent.agentMeta'), '$.autoReviewUserText') = 'text'
              AND json_extract(json_extract(NEW.payload, '$.appendEvent.agentMeta'), '$.delivery') IN ('turn','steer')
              AND json_extract(NEW.payload, '$.appendEvent.content') = json_object('text',
                json_extract(json_extract(NEW.payload, '$.appendEvent.agentMeta'), '$.autoReviewUserText'))
              ELSE 0 END)
          AND coalesce(CASE WHEN json_valid(json_extract(NEW.payload, '$.appendEvent.agentMeta'))
            THEN substr(json_extract(json_extract(NEW.payload, '$.appendEvent.agentMeta'), '$.autoReviewUserText'), 1, 19)
            ELSE NULL END, '') <> '[UI_ACTION_TRIGGER]'
          AND json_extract(NEW.payload, '$.appendEvent.createdAt') > (CASE WHEN json_valid(OLD.payload) THEN json_extract(OLD.payload, '$.lastEventAt') ELSE NULL END)
          THEN NULL ELSE (
          SELECT json_group_array(json_object('sessionId', session_id, 'clientId', client_id,
            'role', role, 'content', content, 'createdAt', created_at, 'agentMeta', agent_meta))
          FROM (SELECT m.* FROM messages m JOIN sessions s ON s.id = m.session_id
            WHERE m.session_id IN (NEW.session_id, NEW.lead_id) AND m.rewind_at IS NULL
              AND (s.cleared_at IS NULL OR m.created_at > s.cleared_at)
              AND m.role IN ('user','ask_user','plan_review')
            ORDER BY CASE WHEN m.role IN ('ask_user','plan_review') AND json_valid(m.agent_meta)
              THEN CASE WHEN json_type(m.agent_meta,'$.autoReviewUserText.acceptedAt') IN ('integer','real')
                AND json_type(m.agent_meta,'$.autoReviewUserText.text') = 'text'
                THEN json_extract(m.agent_meta,'$.autoReviewUserText.acceptedAt') ELSE m.created_at END
              ELSE m.created_at END,
              CASE WHEN m.session_id = NEW.lead_id THEN 0 ELSE 1 END, m.rowid)
        ) END, NEW.session_id, OLD.payload, json_extract(NEW.payload, '$.appendEvent')), projected_revision = NEW.revision, version = 3
        WHERE session_id = NEW.session_id AND lead_id = NEW.lead_id;
      END`);
  }
  return db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO auto_review_projections(session_id, lead_id) VALUES (?, ?)',
    ).run(sessionId, leadId);
    type Row = {
      revision: number;
      projected_revision: number;
      version: number;
      payload: string | null;
    };
    const select = db.prepare(
      'SELECT revision, projected_revision, version, payload FROM auto_review_projections WHERE session_id = ? AND lead_id = ?',
    );
    let row = select.get(sessionId, leadId) as Row;
    // First use after upgrade or a legacy writer rebuilds from current evidence
    // inside this transaction. Never fall back to the previous payload.
    if (row.version !== 3 || row.projected_revision !== row.revision || !parseState(row.payload)) {
      db.prepare(
        "UPDATE auto_review_projections SET revision = revision + 1, payload = CASE WHEN json_valid(payload) THEN json_remove(payload, '$.appendEvent') ELSE NULL END WHERE session_id = ? AND lead_id = ?",
      ).run(sessionId, leadId);
      row = select.get(sessionId, leadId) as Row;
    }
    if (row.version !== 3 || row.projected_revision !== row.revision || !row.payload)
      throw new Error('Authorization projection is not synchronized');
    const value = parseState(row.payload);
    if (!Number.isSafeInteger(row.revision) || !value) {
      throw new Error('Invalid authorization projection');
    }
    return {
      revision: row.revision,
      sessionIntent: value.sessionIntent,
      reviewIntent: projector.withOmission(value.reviewIntent, value.reviewUnverified),
    };
  })();
}

/** Batch existing bulk transcript transactions; one rebuild per affected projection at commit. */
export function batchAutoReviewProjection<T>(
  db: Database.Database,
  name: string,
  operation: () => T,
): T {
  if (
    ![
      'codex.importMessages',
      'claude.importMessages',
      'rewind.commit',
      'session.treeRehydrate',
      'fork.session',
      'session.importShare',
      'context.rebuild',
      'message.delete',
    ].includes(name) ||
    !db.prepare("SELECT 1 FROM temp.sqlite_master WHERE name='auto_review_projection_batch'").get()
  )
    return operation();
  return db.transaction(() => {
    db.prepare('UPDATE auto_review_projection_batch SET depth=depth+1').run();
    const result = operation();
    db.prepare('UPDATE auto_review_projection_batch SET depth=depth-1').run();
    if (
      (db.prepare('SELECT depth FROM auto_review_projection_batch').get() as { depth: number })
        .depth === 0
    ) {
      db.prepare(
        "UPDATE auto_review_projections SET revision=revision, payload=CASE WHEN json_valid(payload) THEN json_remove(payload,'$.appendEvent') ELSE NULL END WHERE projected_revision != revision",
      ).run();
    }
    return result;
  })();
}

export function readAutoReviewProjectionTransaction(
  db: Database.Database,
  args: unknown,
): StoredAutoReviewProjection {
  return readAutoReviewProjection(db, args, createAutoReviewIntentProjection);
}
