// Bot group chat transactions (docs/product-rules/bot-group-chat.md).
// Group rows, memberships and the Bot-owned hidden group lanes change together.

import type Database from 'better-sqlite3';

import type {
  BotGroupsAppendMessageArgs,
  BotGroupsAppendMessageResult,
  BotGroupsArchiveLanesArgs,
  BotGroupsCreateArgs,
  BotGroupsCreatePlanArgs,
  BotGroupsCreatePlanResult,
  BotGroupsDeleteArgs,
  BotGroupsMessageRow,
  BotGroupsRemovePlanStepArgs,
  BotGroupsSetMembersArgs,
  BotGroupsSetMembersResult,
  BotGroupsSettleStepArgs,
  BotGroupsSettleStepResult,
} from '../../client/tx/types.js';

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a number`);
  return value;
}

function requireIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item, index) => requireString(item, `${field}.${index}`));
}

function assertActiveBots(db: Database.Database, botIds: readonly string[]): void {
  const read = db.prepare('SELECT status FROM bot_profiles WHERE id = ?');
  for (const botId of botIds) {
    const row = read.get(botId) as { status?: string } | undefined;
    if (!row) throw coded(`Bot ${botId} 不存在`, 'MEMBER_UNAVAILABLE');
    if (row.status !== 'active' && row.status !== 'paused') {
      throw coded(`Bot ${botId} 当前不可加入群聊`, 'MEMBER_UNAVAILABLE');
    }
  }
}

function optionalString(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : requireString(value, field);
}

/** Lanes (`routeKey`) and, with a prefix, the group's 分工 Sessions (`<prefix><planId>`). */
function archiveLanes(
  db: Database.Database,
  routeKey: string,
  botIds: readonly string[] | null,
  at: number,
  planRouteKeyPrefix: string | null = null,
): string[] {
  const rows = db.prepare(`SELECT bot_id AS botId, session_id AS sessionId FROM bot_session_links
    WHERE role = 'group' AND archived_at IS NULL
      AND (route_key = ? OR (? IS NOT NULL AND substr(route_key, 1, length(?)) = ?))`)
    .all(routeKey, planRouteKeyPrefix, planRouteKeyPrefix, planRouteKeyPrefix) as Array<{
    botId: string;
    sessionId: string;
  }>;
  const targets = botIds ? rows.filter((row) => botIds.includes(row.botId)) : rows;
  const archiveLink = db.prepare('UPDATE bot_session_links SET archived_at = ? WHERE session_id = ?');
  const archiveSession = db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ?
    WHERE id = ? AND status = 'active'`);
  for (const row of targets) {
    archiveLink.run(at, row.sessionId);
    archiveSession.run(at, row.sessionId);
  }
  return targets.map((row) => row.sessionId);
}

export function botGroupsCreate(db: Database.Database, args: BotGroupsCreateArgs): void {
  const groupId = requireString(args.groupId, 'groupId');
  const name = requireString(args.name, 'name');
  const botIds = requireIds(args.botIds, 'botIds');
  const now = requireNumber(args.now, 'now');
  db.transaction(() => {
    assertActiveBots(db, botIds);
    db.prepare(`INSERT INTO bot_groups (id, name, reply_mode, created_at, updated_at)
      VALUES (?, ?, 'all', ?, ?)`).run(groupId, name, now, now);
    const insert = db.prepare(`INSERT INTO bot_group_members
      (group_id, bot_id, position, last_seen_sequence, joined_at) VALUES (?, ?, ?, 0, ?)`);
    botIds.forEach((botId, position) => insert.run(groupId, botId, position, now));
  })();
}

export function botGroupsSetMembers(
  db: Database.Database,
  args: BotGroupsSetMembersArgs,
): BotGroupsSetMembersResult {
  const groupId = requireString(args.groupId, 'groupId');
  const botIds = requireIds(args.botIds, 'botIds');
  const routeKey = requireString(args.routeKey, 'routeKey');
  const planPrefix = optionalString(args.planRouteKeyPrefix, 'planRouteKeyPrefix');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const group = db.prepare('SELECT id FROM bot_groups WHERE id = ?').get(groupId);
    if (!group) throw coded('群聊不存在', 'NOT_FOUND');
    const current = (db.prepare('SELECT bot_id AS botId FROM bot_group_members WHERE group_id = ?')
      .all(groupId) as Array<{ botId: string }>).map((row) => row.botId);
    const added = botIds.filter((botId) => !current.includes(botId));
    const removed = current.filter((botId) => !botIds.includes(botId));
    assertActiveBots(db, added);
    const latest = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM bot_group_messages WHERE group_id = ?')
      .get(groupId) as { sequence: number };
    const remove = db.prepare('DELETE FROM bot_group_members WHERE group_id = ? AND bot_id = ?');
    for (const botId of removed) remove.run(groupId, botId);
    // New members start from the current tail: joining does not replay older history.
    const insert = db.prepare(`INSERT INTO bot_group_members
      (group_id, bot_id, position, last_seen_sequence, joined_at) VALUES (?, ?, ?, ?, ?)`);
    const reorder = db.prepare('UPDATE bot_group_members SET position = ? WHERE group_id = ? AND bot_id = ?');
    botIds.forEach((botId, position) => {
      if (added.includes(botId)) insert.run(groupId, botId, position, latest.sequence, now);
      else reorder.run(position, groupId, botId);
    });
    db.prepare('UPDATE bot_groups SET updated_at = ? WHERE id = ?').run(now, groupId);
    return { archivedSessionIds: archiveLanes(db, routeKey, removed, now, planPrefix) };
  })();
}

export function botGroupsDelete(db: Database.Database, args: BotGroupsDeleteArgs): { archivedSessionIds: string[] } {
  const groupId = requireString(args.groupId, 'groupId');
  const routeKey = requireString(args.routeKey, 'routeKey');
  const planPrefix = optionalString(args.planRouteKeyPrefix, 'planRouteKeyPrefix');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const deleted = db.prepare('DELETE FROM bot_groups WHERE id = ?').run(groupId);
    if (deleted.changes !== 1) throw coded('群聊不存在', 'NOT_FOUND');
    return { archivedSessionIds: archiveLanes(db, routeKey, null, now, planPrefix) };
  })();
}

export function botGroupsArchiveLanes(
  db: Database.Database,
  args: BotGroupsArchiveLanesArgs,
): { archivedSessionIds: string[] } {
  const routeKey = requireString(args.routeKey, 'routeKey');
  const botIds = args.botIds === null ? null : requireIds(args.botIds, 'botIds');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => ({ archivedSessionIds: archiveLanes(db, routeKey, botIds, now) }))();
}

/** Inside a transaction: idempotent per clientId, sequence = max + 1. */
function insertMessage(db: Database.Database, m: BotGroupsMessageRow): BotGroupsAppendMessageResult {
  const groupId = requireString(m.groupId, 'message.groupId');
  const group = db.prepare('SELECT id FROM bot_groups WHERE id = ?').get(groupId);
  if (!group) throw coded('群聊不存在', 'NOT_FOUND');
  if (m.clientId) {
    const existing = db.prepare(`SELECT id, sequence FROM bot_group_messages
      WHERE group_id = ? AND client_id = ?`).get(groupId, m.clientId) as
      { id: string; sequence: number } | undefined;
    if (existing) return { id: existing.id, sequence: existing.sequence, created: false };
  }
  const latest = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM bot_group_messages WHERE group_id = ?')
    .get(groupId) as { sequence: number };
  const sequence = latest.sequence + 1;
  const createdAt = requireNumber(m.createdAt, 'message.createdAt');
  db.prepare(`INSERT INTO bot_group_messages
    (id, group_id, sequence, kind, author_kind, author_bot_id, author_name, content,
     mentions_json, notice_code, client_id, plan_id, files_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(requireString(m.id, 'message.id'), groupId, sequence, m.kind, m.authorKind,
      m.authorBotId ?? null, m.authorName, m.content, m.mentionsJson, m.noticeCode ?? null,
      m.clientId ?? null, m.planId ?? null, m.filesJson ?? '[]', createdAt);
  db.prepare('UPDATE bot_groups SET updated_at = ? WHERE id = ?').run(createdAt, groupId);
  return { id: m.id, sequence, created: true };
}

export function botGroupsAppendMessage(
  db: Database.Database,
  args: BotGroupsAppendMessageArgs,
): BotGroupsAppendMessageResult {
  return db.transaction(() => insertMessage(db, args.message))();
}

export function botGroupsCreatePlan(
  db: Database.Database,
  args: BotGroupsCreatePlanArgs,
): BotGroupsCreatePlanResult {
  const planId = requireString(args.plan.id, 'plan.id');
  const groupId = requireString(args.plan.groupId, 'plan.groupId');
  const now = requireNumber(args.now, 'now');
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps must not be empty');
  if (args.message.groupId !== groupId || args.message.planId !== planId) throw new Error('message must belong to the plan');
  return db.transaction(() => {
    const superseded = (db.prepare(`SELECT id FROM bot_group_plans WHERE group_id = ? AND status = 'proposed'`)
      .all(groupId) as Array<{ id: string }>).map((row) => row.id);
    // A running or waiting plan must end first; the service never proposes over one.
    const open = db.prepare(`SELECT 1 FROM bot_group_plans
      WHERE group_id = ? AND status IN ('running', 'waiting')`).get(groupId);
    if (open) throw coded('群里还有没结束的分工', 'PLAN_OPEN');
    db.prepare(`UPDATE bot_group_plans SET status = 'superseded', updated_at = ?
      WHERE group_id = ? AND status = 'proposed'`).run(now, groupId);
    db.prepare(`INSERT INTO bot_group_plans
      (id, group_id, status, request_text, organizer_bot_id, organizer_name, current_step,
       work_dir, branch, created_at, updated_at)
      VALUES (?, ?, 'proposed', ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
      .run(planId, groupId, requireString(args.plan.requestText, 'plan.requestText'),
        requireString(args.plan.organizerBotId, 'plan.organizerBotId'),
        requireString(args.plan.organizerName, 'plan.organizerName'), now, now);
    const insertStep = db.prepare(`INSERT INTO bot_group_plan_steps
      (plan_id, position, bot_id, bot_name, task, status, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)`);
    args.steps.forEach((step, position) => insertStep.run(planId, position,
      requireString(step.botId, `steps.${position}.botId`),
      requireString(step.botName, `steps.${position}.botName`),
      requireString(step.task, `steps.${position}.task`)));
    const appended = insertMessage(db, args.message);
    return { messageId: appended.id, sequence: appended.sequence, supersededPlanIds: superseded };
  })();
}

export function botGroupsSettleStep(
  db: Database.Database,
  args: BotGroupsSettleStepArgs,
): BotGroupsSettleStepResult {
  const planId = requireString(args.planId, 'planId');
  const position = requireNumber(args.position, 'position');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const plan = db.prepare('SELECT status, current_step AS currentStep FROM bot_group_plans WHERE id = ?')
      .get(planId) as { status: string; currentStep: number | null } | undefined;
    if (!plan || plan.status !== args.expectedPlanStatus || plan.currentStep !== position) return { settled: false };
    const posted = args.message ? insertMessage(db, args.message) : null;
    // A finished step's hand-off is what later steps read; a failure keeps the previous one.
    db.prepare(`UPDATE bot_group_plan_steps
      SET status = ?, finished_at = ?,
          result_message_id = CASE WHEN ? = 'done' AND ? IS NOT NULL THEN ? ELSE result_message_id END
      WHERE plan_id = ? AND position = ?`)
      .run(args.stepStatus, now, args.stepStatus, posted?.id ?? null, posted?.id ?? null, planId, position);
    db.prepare('UPDATE bot_group_plans SET status = ?, updated_at = ? WHERE id = ?')
      .run(args.planStatus, now, planId);
    if (args.endMessage) insertMessage(db, args.endMessage);
    return { settled: true };
  })();
}

/** Proposed plans only; renumbers the following steps and keeps at least one. */
export function botGroupsRemovePlanStep(
  db: Database.Database,
  args: BotGroupsRemovePlanStepArgs,
): { removed: boolean } {
  const planId = requireString(args.planId, 'planId');
  const position = requireNumber(args.position, 'position');
  const now = requireNumber(args.now, 'now');
  return db.transaction(() => {
    const plan = db.prepare('SELECT status FROM bot_group_plans WHERE id = ?').get(planId) as { status: string } | undefined;
    if (!plan || plan.status !== 'proposed') return { removed: false };
    const count = db.prepare('SELECT COUNT(*) AS n FROM bot_group_plan_steps WHERE plan_id = ?').get(planId) as { n: number };
    if (count.n <= 1) return { removed: false };
    const deleted = db.prepare('DELETE FROM bot_group_plan_steps WHERE plan_id = ? AND position = ?').run(planId, position);
    if (deleted.changes !== 1) return { removed: false };
    // Two passes keep the (plan_id, position) key unique while shifting.
    db.prepare(`UPDATE bot_group_plan_steps SET position = -position WHERE plan_id = ? AND position > ?`).run(planId, position);
    db.prepare(`UPDATE bot_group_plan_steps SET position = -position - 1 WHERE plan_id = ? AND position < 0`).run(planId);
    db.prepare('UPDATE bot_group_plans SET updated_at = ? WHERE id = ?').run(now, planId);
    return { removed: true };
  })();
}
