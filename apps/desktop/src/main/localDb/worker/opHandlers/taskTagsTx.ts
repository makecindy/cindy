import type Database from 'better-sqlite3';
import type { TaskTag, TaskTagRequest, TaskTagResult } from '@cindy/maker-shared';

/** Self-contained so the legacy inline worker can embed the same implementation. */
export function runTaskTagsTransaction(db: Database.Database, raw: unknown): TaskTagResult {
  const fail = (code: string): never => {
    throw new Error(`[${code}] Task tag operation failed`);
  };
  const body = raw as TaskTagRequest & { newId?: string; callerSessionId?: string };
  const text = (value: unknown, max = 128): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
      return fail('INVALID_PARAMS');
    return value.trim();
  };
  const ids = (value: unknown, max: number): string[] => {
    if (!Array.isArray(value) || !value.length || value.length > max) return fail('INVALID_PARAMS');
    return [...new Set(value.map((id) => text(id)))];
  };
  const color = (value: unknown): string => {
    if (
      ![
        'red',
        'orange',
        'yellow',
        'green',
        'blue',
        'purple',
        'gray',
        'pink',
        'coral',
        'teal',
        'indigo',
        'white',
        'none',
      ].includes(String(value))
    )
      return fail('INVALID_PARAMS');
    return value === 'none' ? 'white' : String(value);
  };
  const allTags = () =>
    db
      .prepare(
        'SELECT id,name,name_customized AS nameCustomized,color,favorite_order AS favoriteOrder,sort_order AS sortOrder,revision FROM task_tags ORDER BY sort_order IS NULL,sort_order,favorite_order IS NULL,favorite_order,name,id',
      )
      .all()
      .map((row) => ({
        ...(row as TaskTag),
        nameCustomized: !!(row as TaskTag).nameCustomized,
      })) as TaskTag[];
  const tag = (id: string) => {
    const found = allTags().find((t) => t.id === id);
    return found ?? fail('NOT_FOUND');
  };
  const associatedCount = (id: string) =>
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM session_task_tags t JOIN sessions s ON s.id=t.session_id WHERE t.tag_id=? AND s.status <> 'deleted'",
        )
        .get(id) as {
        n: number;
      }
    ).n;
  const project = (sessionIds: string[]) =>
    sessionIds.map((sessionId) => ({
      sessionId,
      tags: db
        .prepare(
          'SELECT t.id,t.name,t.name_customized AS nameCustomized,t.color,t.favorite_order AS favoriteOrder,t.sort_order AS sortOrder,t.revision FROM task_tags t JOIN session_task_tags s ON s.tag_id=t.id WHERE s.session_id=? ORDER BY t.sort_order IS NULL,t.sort_order,t.favorite_order IS NULL,t.favorite_order,t.name,t.id',
        )
        .all(sessionId)
        .map((row) => ({
          ...(row as TaskTag),
          nameCustomized: !!(row as TaskTag).nameCustomized,
        })) as TaskTag[],
    }));
  return db.transaction(() => {
    if (!body || typeof body !== 'object') return fail('INVALID_PARAMS');
    if (body.callerSessionId) {
      if (
        !db
          .prepare(
            "SELECT id FROM sessions WHERE id=? AND status <> 'deleted' AND coalesce(source,'') <> 'bot' AND NOT EXISTS (SELECT 1 FROM bot_session_links b WHERE b.session_id=sessions.id)",
          )
          .get(body.callerSessionId)
      )
        return fail('NOT_FOUND');
    }
    let affected: string[] = [];
    let deletion: TaskTagResult['deletion'];
    let hasMore: boolean | undefined;
    switch (body.action) {
      case 'list':
        break;
      case 'create': {
        const name = text(body.name, 80);
        if (allTags().some((t) => t.id === body.newId)) return fail('ALREADY_EXISTS');
        if (allTags().length >= 256) return fail('LIMIT_EXCEEDED');
        if (allTags().some((t) => t.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
          return fail('ALREADY_EXISTS');
        if (body.favorite !== undefined && typeof body.favorite !== 'boolean')
          return fail('INVALID_PARAMS');
        const favorites = allTags().filter((t) => t.favoriteOrder !== null);
        if (body.favorite && favorites.length >= 7) return fail('FAVORITES_FULL');
        let appendOrder = Math.max(-1, ...allTags().map((t) => t.sortOrder ?? -1)) + 1;
        for (const legacy of allTags().filter((t) => t.sortOrder == null)) {
          db.prepare('UPDATE task_tags SET sort_order=?,revision=revision+1 WHERE id=?').run(
            appendOrder++,
            legacy.id,
          );
        }
        db.prepare(
          'INSERT INTO task_tags(id,name,color,favorite_order,sort_order) VALUES(?,?,?,?,?)',
        ).run(
          text(body.newId),
          name,
          color(body.color),
          body.favorite ? Math.max(-1, ...favorites.map((t) => t.favoriteOrder!)) + 1 : null,
          appendOrder,
        );
        break;
      }
      case 'reorder': {
        const order = ids(body.tagIds, 256);
        const expected = ids(body.expectedOrder, 256);
        const current = allTags();
        if (order.length !== body.tagIds.length || expected.length !== body.expectedOrder.length)
          return fail('INVALID_PARAMS');
        if (current.length !== expected.length || current.some((t, i) => t.id !== expected[i]))
          return fail('CONFLICT');
        if (order.length !== current.length || order.some((id) => !expected.includes(id)))
          return fail('INVALID_PARAMS');
        const update = db.prepare(
          'UPDATE task_tags SET sort_order=?,revision=revision+1 WHERE id=? AND (sort_order IS NULL OR sort_order<>?)',
        );
        order.forEach((id, index) => update.run(index, id, index));
        break;
      }
      case 'update': {
        const id = text(body.tagId);
        const current = tag(id);
        if (body.revision !== current.revision) return fail('CONFLICT');
        const name = body.name === undefined ? current.name : text(body.name, 80);
        if (
          body.nameCustomized !== undefined &&
          (body.nameCustomized !== true || body.name === undefined)
        )
          return fail('INVALID_PARAMS');
        if (
          allTags().some(
            (t) => t.id !== id && t.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          )
        )
          return fail('ALREADY_EXISTS');
        const nextColor = body.color === undefined ? current.color : color(body.color);
        if (body.favorite !== undefined && typeof body.favorite !== 'boolean')
          return fail('INVALID_PARAMS');
        let order = current.favoriteOrder;
        if (body.favorite === false) order = null;
        if (body.favorite === true && order === null) {
          const favorites = allTags().filter((t) => t.favoriteOrder !== null);
          if (favorites.length >= 7) return fail('FAVORITES_FULL');
          order = Math.max(-1, ...favorites.map((t) => t.favoriteOrder!)) + 1;
        }
        db.prepare(
          'UPDATE task_tags SET name=?,name_customized=?,color=?,favorite_order=?,revision=revision+1 WHERE id=?',
        ).run(
          name,
          Number(current.nameCustomized || body.nameCustomized || name !== current.name),
          nextColor,
          order,
          id,
        );
        break;
      }
      case 'previewDelete': {
        const current = tag(text(body.tagId));
        deletion = {
          tagId: current.id,
          revision: current.revision,
          count: associatedCount(current.id),
        };
        break;
      }
      case 'delete': {
        const current = tag(text(body.tagId));
        if (
          body.revision !== current.revision ||
          body.expectedCount !== associatedCount(current.id)
        )
          return fail('CONFLICT');
        db.prepare('DELETE FROM task_tags WHERE id=?').run(current.id);
        break;
      }
      case 'attach':
      case 'detach':
      case 'get': {
        affected = ids(body.sessionIds, 100);
        for (const id of affected) {
          if (!db.prepare("SELECT id FROM sessions WHERE id=? AND status <> 'deleted'").get(id))
            return fail('NOT_FOUND');
          if (
            body.callerSessionId &&
            db
              .prepare(
                "SELECT id FROM sessions WHERE id=? AND (source='bot' OR EXISTS (SELECT 1 FROM bot_session_links b WHERE b.session_id=sessions.id))",
              )
              .get(id)
          )
            return fail('NOT_FOUND');
        }
        if (body.action !== 'get') {
          const tagIds = ids(body.tagIds, 32);
          tagIds.forEach(tag);
          const statement = db.prepare(
            body.action === 'attach'
              ? 'INSERT OR IGNORE INTO session_task_tags(session_id,tag_id) VALUES(?,?)'
              : 'DELETE FROM session_task_tags WHERE session_id=? AND tag_id=?',
          );
          for (const sessionId of affected) {
            const existing = project([sessionId])[0].tags;
            if (
              body.action === 'attach' &&
              new Set([...existing.map((t) => t.id), ...tagIds]).size > 32
            )
              return fail('LIMIT_EXCEEDED');
            for (const tagId of tagIds) {
              if (statement.run(sessionId, tagId).changes)
                db.prepare('UPDATE task_tags SET revision=revision+1 WHERE id=?').run(tagId);
            }
          }
        }
        break;
      }
      case 'find': {
        const id = text(body.tagId);
        tag(id);
        const offset = body.offset ?? 0;
        const limit = body.limit ?? 50;
        if (
          !Number.isInteger(offset) ||
          offset < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          return fail('INVALID_PARAMS');
        const rows = db
          .prepare(
            "SELECT s.session_id AS id FROM session_task_tags s JOIN sessions ON sessions.id=s.session_id WHERE s.tag_id=? AND sessions.status <> 'deleted' AND (? IS NULL OR (coalesce(sessions.source,'') <> 'bot' AND NOT EXISTS (SELECT 1 FROM bot_session_links b WHERE b.session_id=sessions.id))) ORDER BY sessions.updated_at DESC,s.session_id LIMIT ? OFFSET ?",
          )
          .all(id, body.callerSessionId ?? null, limit + 1, offset) as { id: string }[];
        hasMore = rows.length > limit;
        affected = rows.slice(0, limit).map((r) => r.id);
        break;
      }
      default:
        return fail('INVALID_PARAMS');
    }
    return {
      supportedColors: [
        'red',
        'orange',
        'yellow',
        'green',
        'blue',
        'purple',
        'gray',
        'pink',
        'coral',
        'teal',
        'indigo',
        'white',
      ] as TaskTagResult['supportedColors'],
      tags: allTags(),
      sessions: project(affected),
      ...(deletion ? { deletion } : {}),
      ...(hasMore === undefined ? {} : { hasMore }),
    };
  })();
}
