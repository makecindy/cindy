/**
 * 伙伴工具调用的宿主判定入口：把 `botTurnAuthority.ts` 的分档与规则接到真实数据上。
 *
 * - 不是伙伴的任务一律放行（普通任务、插件任务各有自己的能力面）。
 * - 远程伙伴保持原有的窄能力面；只有经隧道挂到的本机自动化（远程 Pi）按同样的分档判定。
 * - 伙伴的群专线、历史等非主任务一律按最低档（other）判定。
 * - 「自己的任务」= 这个伙伴的 bot_session_links，或它开的后台任务（bot_delegations）。
 * - 「已接手项目里的任务」与工作台继续同一判据（isWorkbenchProjectSession）。
 */
import { and, eq } from 'drizzle-orm';

import type { ToolCallAuthorization, ToolCallAuthorizer } from '@cindy/mcps';

import type { DbClient } from '../localDb/client/DbClient.js';
import { botDelegations, botSessionLinks, sessions } from '../localDb/schema.js';
import {
  decideBotToolCall,
  resolveBotTurnAuthority,
  type BotTurnAuthority,
  type BotTurnExecution,
} from './botTurnAuthority.js';

export type BotCallerAuthority =
  | { kind: 'not-bot' }
  | { kind: 'remote-bot'; botId: string; authority: BotTurnAuthority }
  | { kind: 'bot'; botId: string; main: boolean; authority: BotTurnAuthority };

export interface BotToolCallAuthorizerDeps {
  getDb(): Pick<DbClient, 'drizzle'> | null;
  readExecution(sessionId: string): BotTurnExecution;
  isWorkbenchProjectSession(botId: string, sessionId: string): Promise<boolean>;
  /** 账号切换中或数据库换了：拒绝，不在旧账号的数据上判定。 */
  isScopeCurrent?(db: Pick<DbClient, 'drizzle'>): boolean;
}

export async function resolveBotCallerAuthority(
  db: Pick<DbClient, 'drizzle'>,
  sessionId: string,
  readExecution: (sessionId: string) => BotTurnExecution,
): Promise<BotCallerAuthority> {
  const [row] = await db.drizzle
    .select({
      botId: botSessionLinks.botId,
      role: botSessionLinks.role,
      linkArchivedAt: botSessionLinks.archivedAt,
      source: sessions.source,
      status: sessions.status,
      remoteHostId: sessions.remoteHostId,
    })
    .from(sessions)
    .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row || (!row.botId && row.source !== 'bot')) return { kind: 'not-bot' };
  // 伙伴来源但链接坏了：按伙伴最低档处理，绝不退回普通任务的能力。
  if (!row.botId) return { kind: 'bot', botId: '', main: false, authority: 'other' };
  const main = row.role === 'canonical' && row.linkArchivedAt === null && row.source === 'bot' && row.status === 'active';
  const authority = main ? await resolveBotTurnAuthority(db, sessionId, readExecution(sessionId)) : 'other';
  if (row.remoteHostId) return { kind: 'remote-bot', botId: row.botId, authority };
  return { kind: 'bot', botId: row.botId, main, authority };
}

async function isOwnTask(db: Pick<DbClient, 'drizzle'>, botId: string, sessionId: string): Promise<boolean> {
  if (!botId) return false;
  const [[link], [delegation]] = await Promise.all([
    db.drizzle.select({ id: botSessionLinks.id }).from(botSessionLinks)
      .where(and(eq(botSessionLinks.sessionId, sessionId), eq(botSessionLinks.botId, botId))).limit(1),
    db.drizzle.select({ id: botDelegations.id }).from(botDelegations)
      .where(and(eq(botDelegations.childSessionId, sessionId), eq(botDelegations.requestingBotId, botId))).limit(1),
  ]);
  return Boolean(link || delegation);
}

const SCOPE_CHANGED: ToolCallAuthorization = {
  ok: false,
  errorCode: 'OWNER_SCOPE_CHANGED',
  message: '账号正在切换，请稍后重试。',
};

export function createBotToolCallAuthorizer(deps: BotToolCallAuthorizerDeps): ToolCallAuthorizer {
  const judge = async (
    db: Pick<DbClient, 'drizzle'>,
    { sessionId, server, tool, args }: Parameters<ToolCallAuthorizer>[0] & { sessionId: string },
  ): Promise<ToolCallAuthorization> => {
    const caller = await resolveBotCallerAuthority(db, sessionId, deps.readExecution);
    if (caller.kind === 'not-bot') return { ok: true };
    // Remote Bots keep their unchanged helper surface. Automations live on this
    // computer (tunneled to remote Pi), so they follow the same per-turn rules.
    if (caller.kind === 'remote-bot' && server !== 'cindy_scheduler') return { ok: true };
    const decision = decideBotToolCall(server, tool, args, caller.authority);
    if (decision.kind === 'allow') return { ok: true };
    if (decision.kind === 'deny') return { ok: false, errorCode: decision.errorCode, message: decision.message };
    for (const target of decision.sessionIds) {
      if (await isOwnTask(db, caller.botId, target)) continue;
      if (decision.scope === 'own-or-handed' && await deps.isWorkbenchProjectSession(caller.botId, target)) continue;
      return {
        ok: false,
        errorCode: 'TASK_OUT_OF_SCOPE',
        message: decision.scope === 'own-or-handed'
          ? '这一轮只能操作你自己开的任务，或主人交给你的项目里的任务。'
          : '这一轮只能操作你自己开的任务；动主人的其他任务要等主人本人发话。',
      };
    }
    return { ok: true };
  };
  return async (input) => {
    // 权限闸门:认不出调用方就拒绝。普通任务的自动化调用本来也要求 session(withAccountDataAccess)。
    if (!input.sessionId) {
      return { ok: false, errorCode: 'CAPABILITY_NOT_AVAILABLE', message: '认不出这次调用来自哪个任务，已拒绝。' };
    }
    const db = deps.getDb();
    if (!db) return { ok: false, errorCode: 'HOST_NOT_READY', message: '本机数据还没准备好，请稍后重试。' };
    const result = await judge(db, { ...input, sessionId: input.sessionId });
    // 判定期间换了账号：不在旧账号的数据上放行。
    if (result.ok && deps.isScopeCurrent && !deps.isScopeCurrent(db)) return SCOPE_CHANGED;
    return result;
  };
}
