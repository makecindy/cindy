import type Database from 'better-sqlite3';

/**
 * 任务导入（session-import）的数据库事务。Self-contained for file worker, inline worker
 * and in-process transport：函数体不能引用任何外部值（会被 toString 后内联进 worker）。
 *
 * 一次导入分四步：
 *  - begin：建一个隐藏任务行（hidden_at 非空，不进列表/搜索）+ 来源记录（importing）；
 *    同一来源任务重试得到同一个任务 id，已存在则只刷新来源记录；
 *  - messages：分批写消息，按 (session_id, client_id) 幂等；用户删除过（墓碑）或回退过的行不复活；
 *  - commit：写结论、可选补 sdk 编号 / 交接标记，显示任务（hidden_at 置空）；
 *  - abort：只删除仍然隐藏的任务行（消息、来源记录随外键级联删除），从不删除已显示的任务；
 *    带 requestId 时只删属于该请求的。
 */
export function runSessionImportTransaction(db: Database.Database, raw: unknown): unknown {
  const body = raw as Record<string, unknown>;
  const action = body.action;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const required = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value) throw Object.assign(new Error(`${label} is required`), { code: 'INVALID_ARGS' });
    return value;
  };
  const finite = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw Object.assign(new Error(`${label} must be a number`), { code: 'INVALID_ARGS' });
    return value;
  };
  const invalidateList = (sessionId: string) => {
    db.prepare('UPDATE sessions SET list_preview = NULL, list_preview_role = NULL, list_message_count = NULL WHERE id = ?').run(sessionId);
  };

  if (action === 'begin') {
    const s = body.session as Record<string, unknown>;
    const r = body.record as Record<string, unknown>;
    const sessionId = required(s.id, 'session.id');
    const now = finite(body.now, 'now');
    return db.transaction(() => {
      const existing = db.prepare('SELECT id, hidden_at AS hiddenAt, status FROM sessions WHERE id = ?').get(sessionId) as
        { id: string; hiddenAt: number | null; status: string } | undefined;
      let created = false;
      if (!existing) {
        db.prepare(`
          INSERT INTO sessions (
            id, title, working_dir, workspace_kind, model, provider_id, effort, permission_mode, status,
            sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode,
            user_send_at, agent_kind, source, used_project_context, extra_dirs,
            codex_history_has_product_prompt, hidden_at, created_at, updated_at
          ) VALUES (
            @id, @title, @workingDir, @workspaceKind, @model, @providerId, @effort, @permissionMode, @status,
            NULL, @tokensUsed, 0, 0, 0, 0,
            @userSendAt, @agentKind, 'desktop', 0, '[]',
            @codexHistoryHasProductPrompt, @hiddenAt, @createdAt, @updatedAt
          )
        `).run({
          id: sessionId,
          title: required(s.title, 'session.title'),
          workingDir: text(s.workingDir),
          workspaceKind: s.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
          model: required(s.model, 'session.model'),
          providerId: text(s.providerId),
          effort: text(s.effort) ?? 'high',
          permissionMode: text(s.permissionMode) ?? 'auto',
          status: s.status === 'archived' ? 'archived' : 'active',
          tokensUsed: typeof s.tokensUsed === 'number' && Number.isFinite(s.tokensUsed) ? s.tokensUsed : 0,
          userSendAt: finite(s.userSendAt, 'session.userSendAt'),
          agentKind: required(s.agentKind, 'session.agentKind'),
          codexHistoryHasProductPrompt: s.agentKind === 'codex' ? 0 : null,
          hiddenAt: now,
          createdAt: finite(s.createdAt, 'session.createdAt'),
          updatedAt: finite(s.updatedAt, 'session.updatedAt'),
        });
        created = true;
      } else if (existing.status === 'deleted' && existing.hiddenAt === null) {
        throw Object.assign(new Error('import target was deleted by the user'), { code: 'PRECONDITION_FAILED' });
      }
      // 同一来源任务之前导入过、但那个任务已被用户删除：清掉旧来源记录，允许重新导入。
      db.prepare(`
        DELETE FROM session_imports
        WHERE source = ? AND source_session_id = ? AND session_id != ?
          AND session_id IN (SELECT id FROM sessions WHERE status = 'deleted')
      `).run(required(r.source, 'record.source'), required(r.sourceSessionId, 'record.sourceSessionId'), sessionId);
      db.prepare(`
        INSERT INTO session_imports (
          session_id, source, source_session_id, source_fingerprint, source_version, mode, status,
          issue, original_cwd, request_id, imported_at, updated_at
        ) VALUES (@sessionId, @source, @sourceSessionId, @fingerprint, @version, @mode, 'importing', NULL, @originalCwd, @requestId, @now, @now)
        ON CONFLICT(session_id) DO UPDATE SET
          source_fingerprint = excluded.source_fingerprint,
          source_version = excluded.source_version,
          request_id = excluded.request_id,
          updated_at = excluded.updated_at
      `).run({
        sessionId,
        source: required(r.source, 'record.source'),
        sourceSessionId: required(r.sourceSessionId, 'record.sourceSessionId'),
        fingerprint: text(r.fingerprint),
        version: text(r.version),
        mode: r.mode === 'native' ? 'native' : 'handoff',
        originalCwd: text(r.originalCwd),
        requestId: text(r.requestId),
        now,
      });
      return { created };
    })();
  }

  if (action === 'messages') {
    const sessionId = required(body.sessionId, 'sessionId');
    const prefix = required(body.clientIdPrefix, 'clientIdPrefix');
    const idPrefix = required(body.idPrefix, 'idPrefix');
    const rows = Array.isArray(body.rows) ? body.rows as Array<Record<string, unknown>> : [];
    const upsert = db.prepare(`
      INSERT INTO messages
        (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
      VALUES
        (@id, @clientId, @sessionId, @role, @content, @toolUseId, @agentMeta, @agentKind, @createdAt, NULL)
      ON CONFLICT(session_id, client_id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        tool_use_id = excluded.tool_use_id,
        agent_meta = excluded.agent_meta,
        created_at = excluded.created_at
      WHERE
        messages.role != 'message_tombstone' AND
        messages.rewind_at IS NULL AND
        (
          messages.role != 'tool_result' OR
          json_valid(messages.content) = 0 OR
          json_type(messages.content) != 'object' OR
          json_extract(messages.content, '$.type') IS NOT 'tool_result_compacted'
        ) AND
        (
          messages.role IS NOT excluded.role OR
          messages.content IS NOT excluded.content OR
          messages.tool_use_id IS NOT excluded.tool_use_id OR
          messages.agent_meta IS NOT excluded.agent_meta OR
          messages.created_at IS NOT excluded.created_at
        )
    `);
    return db.transaction(() => {
      let changed = 0;
      for (const row of rows) {
        const key = required(row.key, 'row.key');
        changed += upsert.run({
          id: `${idPrefix}${key}`,
          clientId: `${prefix}${key}`,
          sessionId,
          role: required(row.role, 'row.role'),
          content: required(row.content, 'row.content'),
          toolUseId: text(row.toolUseId),
          agentMeta: text(row.agentMeta),
          agentKind: text(row.agentKind),
          createdAt: finite(row.createdAt, 'row.createdAt'),
        }).changes;
      }
      if (changed > 0) invalidateList(sessionId);
      return { changed };
    })();
  }

  if (action === 'commit') {
    const sessionId = required(body.sessionId, 'sessionId');
    const now = finite(body.now, 'now');
    const status = body.status === 'action' ? 'action' : body.status === 'failed' ? 'failed' : 'ready';
    return db.transaction(() => {
      const patch = (body.sessionPatch ?? {}) as Record<string, unknown>;
      if ('sdkSessionId' in patch) {
        db.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(text(patch.sdkSessionId), sessionId);
      }
      if (typeof patch.workingDir === 'string') {
        db.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(patch.workingDir, sessionId);
      }
      const marker = body.marker as Record<string, unknown> | undefined;
      if (marker) {
        const createdAt = finite(marker.createdAt, 'marker.createdAt');
        db.prepare(
          "INSERT OR IGNORE INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, 'context_rebuild', ?, ?, ?)",
        ).run(required(marker.id, 'marker.id'), required(marker.clientId, 'marker.clientId'), sessionId,
          required(marker.content, 'marker.content'), createdAt, createdAt);
      }
      db.prepare('UPDATE session_imports SET mode = COALESCE(?, mode), status = ?, issue = ?, updated_at = ? WHERE session_id = ?')
        .run(body.mode === 'native' || body.mode === 'handoff' ? body.mode : null, status, text(body.issue), now, sessionId);
      if (body.unhide === true) {
        db.prepare('UPDATE sessions SET hidden_at = NULL WHERE id = ? AND hidden_at IS NOT NULL').run(sessionId);
      }
      invalidateList(sessionId);
      return { ok: true };
    })();
  }

  if (action === 'adopt') {
    // 旧版导入的任务（codex-/claude- 前缀）接入来源记录；任务本身保持原样。
    const sessionId = required(body.sessionId, 'sessionId');
    const now = finite(body.now, 'now');
    const changes = db.prepare(`
      INSERT OR IGNORE INTO session_imports (
        session_id, source, source_session_id, source_fingerprint, source_version, mode, status,
        issue, original_cwd, request_id, imported_at, updated_at
      )
      SELECT id, @source, @sourceSessionId, NULL, NULL, 'native', 'ready', NULL, working_dir, NULL, created_at, @now
      FROM sessions WHERE id = @sessionId
    `).run({ sessionId, source: required(body.source, 'source'), sourceSessionId: required(body.sourceSessionId, 'sourceSessionId'), now }).changes;
    return { adopted: changes > 0 };
  }

  if (action === 'abort') {
    const sessionId = required(body.sessionId, 'sessionId');
    // 带 requestId 时只删这次请求建的隐藏任务：同一来源被另一次导入接手后，它的记录已改成那次的请求。
    const requestId = text(body.requestId);
    const removed = (requestId
      ? db.prepare(`
          DELETE FROM sessions WHERE id = @sessionId AND hidden_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM session_imports i WHERE i.session_id = sessions.id AND i.request_id = @requestId)
        `).run({ sessionId, requestId })
      : db.prepare('DELETE FROM sessions WHERE id = ? AND hidden_at IS NOT NULL').run(sessionId)).changes;
    return { removed };
  }

  throw Object.assign(new Error(`unknown session import action: ${String(action)}`), { code: 'INVALID_ARGS' });
}
