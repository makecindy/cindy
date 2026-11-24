import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DagHistoryEditAction,
  DagHistoryEditReceipt,
} from '../../../../shared/dagHistoryEdit.js';

type D = Database.Database;
type Row = {
  id: string;
  client_id: string;
  session_id: string;
  role: string;
  content: string;
  agent_meta: string | null;
  created_at: number;
  rewind_at: number | null;
  rowid: number;
};
type S = {
  id: string;
  status: string;
  source: string;
  side_chat_promoted: number;
  sdk_session_id: string | null;
  parent_session_id: string | null;
  forked_at_message_id: string | null;
  created_at: number;
  cleared_at: number | null;
  agent_kind: string;
  agent_device_id: string | null;
  remote_host_id: string | null;
  hidden_at: number | null;
  orca_role: string | null;
  orca_remote_lead: string | null;
  summary: string | null;
  list_preview: string | null;
  list_preview_role: string | null;
  list_message_count: number | null;
  codex_plan_json: string | null;
  context_tokens: number;
  context_window: number;
  active_turn_started_at: number | null;
  last_turn_ended_at: number | null;
};
type Journal = {
  id: string;
  session_id: string;
  client_id: string;
  action: DagHistoryEditAction;
  state: 'committed' | 'undone';
  undo_data: string;
  fingerprint: string;
};
type Undo = {
  sessions: S[];
  ids: string[];
  removed: { sessionId: string; ids: string[] }[];
  marker: string;
  question?: string;
};
export type DagTxRequest =
  | {
      kind: 'preview' | 'commit';
      id: string;
      sessionId: string;
      clientId: string;
      action: DagHistoryEditAction;
      fingerprint?: string;
      markerContent?: string;
    }
  | { kind: 'status' | 'undo'; id: string; fingerprint?: string };
const fail = (s: string): never => {
  throw new Error(s);
};
const changed = '会话或历史已变化，请重新预览。';
const cap = 3000;
function session(db: D, id: string) {
  const x = db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as S | undefined;
  if (!x) throw new Error(changed);
  return x;
}
function rows(db: D, id: string) {
  const size = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(content AS BLOB))+IFNULL(LENGTH(CAST(agent_meta AS BLOB)),0)),0) AS bytes FROM messages WHERE session_id=?',
    )
    .get(id) as { n: number; bytes: number };
  if (size.n > cap || size.bytes > 8 * 1024 * 1024) fail('此会话记录过大，无法核实可恢复范围。');
  return db
    .prepare('SELECT rowid,* FROM messages WHERE session_id=? ORDER BY created_at,rowid')
    .all(id) as Row[];
}
function children(db: D, id: string) {
  return db
    .prepare(
      // Promoted side chats retain their parent for provenance, not for history ownership.
      `SELECT id,status,parent_session_id,forked_at_message_id,source FROM sessions
       WHERE parent_session_id=? AND NOT (source='side-chat' AND side_chat_promoted=1) ORDER BY id`,
    )
    .all(id) as Pick<
    S,
    'id' | 'status' | 'parent_session_id' | 'forked_at_message_id' | 'source'
  >[];
}
function fingerprint(db: D, ids: string[]) {
  const hash = createHash('sha256');
  for (const id of [...ids].sort()) {
    // Presentation-only observations (sidebar backfill, focus, pin, last activity)
    // are not history revisions. Route/ownership, lineage, runtime and messages are.
    const s = db
      .prepare(
        'SELECT id,status,source,side_chat_promoted,sdk_session_id,parent_session_id,forked_at_message_id,created_at,cleared_at,agent_kind,agent_device_id,remote_host_id,orca_remote_lead,orca_role,hidden_at,model,provider_id,working_dir,project_dir,workspace_kind,permission_mode,extra_dirs,writable_dirs,active_turn_started_at,last_turn_ended_at FROM sessions WHERE id=?',
      )
      .get(id);
    hash.update(JSON.stringify([s, children(db, id), rows(db, id)]));
  }
  return hash.digest('hex');
}
function plain(r: Row): string | undefined {
  try {
    const v: unknown = JSON.parse(r.content);
    if (typeof v === 'string') return v;
    if (
      v &&
      typeof v === 'object' &&
      'text' in v &&
      typeof v.text === 'string' &&
      Object.keys(v).every((k) => k === 'text')
    )
      return v.text;
  } catch {
    /* unsupported historical format */
  }
  return undefined;
}
function guard(db: D, s: S) {
  if (
    s.status !== 'active' ||
    s.hidden_at ||
    s.cleared_at !== null ||
    s.orca_role ||
    s.orca_remote_lead ||
    !['desktop', 'side-chat'].includes(s.source) ||
    s.remote_host_id ||
    s.agent_device_id ||
    s.agent_kind !== 'cc' ||
    s.sdk_session_id !== null
  )
    fail('此会话有原生引擎上下文、远程归属或非普通状态，无法保证完整撤销。');
  if ((s.active_turn_started_at ?? 0) > (s.last_turn_ended_at ?? 0))
    fail('任务仍有尚未结束的运行。');
  for (const [table, column] of [
    ['session_goals', 'session_id'],
    ['agent_input_queue_snapshots', 'session_id'],
    ['session_imports', 'session_id'],
    ['subagent_runs', 'session_id'],
    ['bot_session_links', 'session_id'],
    ['shared_task_events', 'session_id'],
    ['media_refs', 'ref_id'],
    ['schedules', 'target_session_id'],
    ['im_bindings', 'target_session_id'],
    ['mcp_app_view_states', 'session_id'],
    ['ghost_cards', 'session_id'],
    ['media_refs', 'origin_session_id'],
  ] as const) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`).get(s.id))
      fail('会话含排队、调度、共享或其他活动记录，未修改。');
  }
}
function collect(db: D, sessionId: string, clientId: string, action: DagHistoryEditAction) {
  const root = session(db, sessionId);
  guard(db, root);
  const removed: Undo['removed'] = [],
    sessions: S[] = [],
    seen = new Set<string>();
  let count = 0,
    totalBytes = 0,
    totalRows = 0;
  let question: string | undefined;
  function visit(s: S, targetId: string | null, inherited: Row[]) {
    guard(db, s);
    if (seen.has(s.id) || sessions.length >= 64) fail('分支关系不完整或过大。');
    seen.add(s.id);
    sessions.push(s);
    const full = rows(db, s.id);
    totalRows += full.length;
    totalBytes += full.reduce(
      (n, r) => n + Buffer.byteLength(r.content) + Buffer.byteLength(r.agent_meta ?? ''),
      0,
    );
    if (totalRows > cap || totalBytes > 16 * 1024 * 1024) fail('子树过大，无法核实可恢复范围。');
    const rs = full.filter((r) => r.rewind_at === null);
    const oldBoundary = full.filter((r) => r.role === 'context_rebuild').at(-1);
    if (rs.length) {
      let pending: { consumed?: boolean; handoff?: string; handoffCoverage?: string } | null = null;
      try {
        pending = oldBoundary ? JSON.parse(oldBoundary.content) : null;
      } catch {
        /* refuse an unproven restore */
      }
      if (
        !pending ||
        pending.consumed !== false ||
        pending.handoffCoverage !== 'complete' ||
        typeof pending.handoff !== 'string' ||
        !pending.handoff.trim()
      )
        fail('原会话没有可验证的完整交接检查点，不能保证撤销后可继续。');
    }
    if (
      rs.some(
        (r) =>
          (r.role !== 'user' && r.role !== 'assistant') ||
          plain(r) === undefined ||
          r.agent_meta !== null ||
          r.content.includes('[UI_ACTION_TRIGGER]'),
      )
    )
      fail('此路径包含附件、工具、合成输入或无法可靠恢复的消息。');
    if (inherited.length > rs.length) fail(changed);
    const offset =
      s.source === 'side-chat' && inherited.length ? inherited[0].created_at - rs[0].created_at : 0;
    for (let i = 0; i < inherited.length; i++)
      if (
        inherited[i].role !== rs[i].role ||
        inherited[i].content !== rs[i].content ||
        inherited[i].created_at - offset !== rs[i].created_at
      )
        fail('子会话的继承前缀与分叉锚点不一致。');
    const start =
      targetId === null ? inherited.length : rs.findIndex((r) => r.client_id === targetId);
    if (targetId !== null && (start < 0 || rs[start]?.role !== 'user')) fail('找不到原问题。');
    if (targetId !== null && action === 'withdraw') question = plain(rs[start]);
    count += rs.slice(start).filter((r) => r.role === 'user').length;
    removed.push({
      sessionId: s.id,
      ids: rs.slice(targetId === null ? 0 : start).map((r) => r.id),
    });
    for (const c of children(db, s.id)) {
      if (c.status === 'deleted') continue;
      const i = rs.findIndex((r) => r.client_id === c.forked_at_message_id);
      if (i < 0) fail('子分支的原生锚点已缺失。');
      // A fork before the selected question is a sibling, not a descendant.
      const end =
        rs[i].role === 'user'
          ? i
          : (() => {
              const j = rs.findIndex((r, k) => k > i && r.role === 'user');
              return j < 0 ? rs.length : j;
            })();
      if (end <= start) {
        if (targetId === null) fail('存在从继承前缀分出的独立分支，不能一并移除。');
        continue;
      }
      visit(session(db, c.id), null, rs.slice(0, end));
    }
  }
  // When the source is itself a fork, inherited copies are not independently editable.
  if (root.parent_session_id && !(root.source === 'side-chat' && root.side_chat_promoted === 1)) {
    const parent = session(db, root.parent_session_id);
    const pr = rows(db, parent.id).filter((r) => r.rewind_at === null);
    const ai = pr.findIndex((r) => r.client_id === root.forked_at_message_id);
    if (ai < 0) fail('无法核实来源分叉边界。');
    const next = pr.findIndex((r, i) => i > ai && r.role === 'user');
    const end = pr[ai].role === 'user' ? ai : next < 0 ? pr.length : next;
    const copy = rows(db, root.id).filter((r) => r.rewind_at === null);
    if (copy.findIndex((r) => r.client_id === clientId) < end)
      fail('不能从子分支删除继承来的问题。');
    visit(root, clientId, pr.slice(0, end));
  } else visit(root, clientId, []);
  const ids = sessions.map((s) => s.id);
  return {
    fingerprint: fingerprint(db, ids),
    turnCount: count,
    branchCount: ids.length - 1,
    ids,
    sessions,
    removed,
    question,
  };
}
function journal(db: D, id: string) {
  return db.prepare('SELECT * FROM dag_history_edits WHERE id=?').get(id) as Journal | undefined;
}
function receipt(j: Journal, u: Undo): DagHistoryEditReceipt {
  return {
    operationId: j.id,
    sessionId: j.session_id,
    status: j.state,
    removedSessionIds: u.ids.filter((id) => id !== j.session_id),
    ...(j.action === 'withdraw' && j.state === 'committed' ? { question: u.question } : {}),
  };
}
export function dagHistoryTx(db: D, req: DagTxRequest) {
  const run = db.transaction(() => {
    const existing = journal(db, req.id);
    if (req.kind === 'status')
      return existing ? receipt(existing, JSON.parse(existing.undo_data)) : null;
    if (req.kind === 'undo') {
      if (!existing) fail('操作不存在或无法恢复。');
      const j = existing!;
      const u = JSON.parse(j.undo_data) as Undo;
      if (j.state === 'undone') return receipt(j, u);
      if (fingerprint(db, u.ids) !== j.fingerprint) fail('删除后已有新的历史或分支，不能覆盖。');
      for (const id of u.ids) guard(db, { ...session(db, id), status: 'active' });
      const restore = db.prepare('UPDATE messages SET rewind_at=NULL WHERE id=? AND session_id=?');
      for (const m of u.removed) for (const id of m.ids) restore.run(id, m.sessionId);
      for (const id of u.ids)
        db.prepare(
          "DELETE FROM messages WHERE session_id=? AND id=? AND role='context_rebuild'",
        ).run(id, `${u.marker}:${id}`);
      for (const s of u.sessions)
        db.prepare(
          'UPDATE sessions SET status=?,summary=?,list_preview=?,list_preview_role=?,list_message_count=?,context_tokens=?,context_window=?,codex_plan_json=? WHERE id=?',
        ).run(
          s.status,
          s.summary,
          s.list_preview,
          s.list_preview_role,
          s.list_message_count,
          s.context_tokens,
          s.context_window,
          s.codex_plan_json,
          s.id,
        );
      db.prepare("UPDATE dag_history_edits SET state='undone' WHERE id=?").run(j.id);
      return receipt({ ...j, state: 'undone' }, u);
    }
    if (req.kind !== 'commit' && req.kind !== 'preview') return fail('无效操作。');
    if (existing) return receipt(existing, JSON.parse(existing.undo_data));
    const scope = collect(db, req.sessionId, req.clientId, req.action);
    if (req.kind === 'preview')
      return {
        ids: scope.ids,
        turnCount: scope.turnCount,
        branchCount: scope.branchCount,
        fingerprint: scope.fingerprint,
      };
    if (scope.fingerprint !== req.fingerprint || typeof req.markerContent !== 'string')
      fail(changed);
    const selectedRows = rows(db, req.sessionId).filter((r) => r.rewind_at === null);
    const prefix = selectedRows.slice(
      0,
      selectedRows.findIndex((r) => r.client_id === req.clientId),
    );
    const context = JSON.parse(req.markerContent!) as {
      handoff?: string;
      handoffCoverage?: string;
      consumed?: boolean;
      reason?: string;
    };
    if (
      context.consumed !== false ||
      context.reason !== 'message-rewind' ||
      typeof context.handoff !== 'string' ||
      (prefix.length
        ? context.handoffCoverage !== 'complete' || !context.handoff
        : context.handoff !== '')
    )
      fail('无法完整重建保留的模型上下文，未修改。');
    const marked = Date.now();
    const marker = randomUUID();
    const hide = db.prepare(
      'UPDATE messages SET rewind_at=? WHERE id=? AND session_id=? AND rewind_at IS NULL',
    );
    for (const m of scope.removed)
      for (const id of m.ids) if (hide.run(marked, id, m.sessionId).changes !== 1) fail(changed);
    for (const id of scope.ids)
      db.prepare(
        'UPDATE sessions SET status=?,summary=NULL,list_preview=NULL,list_preview_role=NULL,list_message_count=NULL,context_tokens=0,context_window=0,codex_plan_json=NULL WHERE id=?',
      ).run(id === req.sessionId ? 'active' : 'deleted', id);
    for (const sid of scope.ids) {
      const last = (
        db.prepare('SELECT MAX(created_at) AS t FROM messages WHERE session_id=?').get(sid) as {
          t: number;
        }
      ).t;
      const mid = `${marker}:${sid}`;
      db.prepare(
        "INSERT INTO messages(id,session_id,client_id,role,content,created_at,rewind_at) VALUES(?,?,?,'context_rebuild',?,?,?)",
      ).run(
        mid,
        sid,
        `context-rebuild:${mid}`,
        sid === req.sessionId
          ? req.markerContent
          : JSON.stringify({ handoff: '', consumed: false, reason: 'message-rewind' }),
        Math.max(marked, last),
        marked,
      );
    }
    const u: Undo = {
      sessions: scope.sessions.map(
        (s) =>
          ({
            id: s.id,
            status: s.status,
            summary: s.summary,
            list_preview: s.list_preview,
            list_preview_role: s.list_preview_role,
            list_message_count: s.list_message_count,
            context_tokens: s.context_tokens,
            context_window: s.context_window,
            codex_plan_json: s.codex_plan_json,
          }) as S,
      ),
      removed: scope.removed,
      ids: scope.ids,
      marker,
      question: scope.question,
    };
    const j: Journal = {
      id: req.id,
      session_id: req.sessionId,
      client_id: req.clientId,
      action: req.action,
      state: 'committed',
      undo_data: JSON.stringify(u),
      fingerprint: fingerprint(db, u.ids),
    };
    db.prepare(
      'INSERT INTO dag_history_edits(id,session_id,client_id,action,state,undo_data,fingerprint,created_at) VALUES(@id,@session_id,@client_id,@action,@state,@undo_data,@fingerprint,@at)',
    ).run({ ...j, at: marked });
    return receipt(j, u);
  });
  return req.kind === 'preview' || req.kind === 'status' ? run.deferred() : run.immediate();
}
