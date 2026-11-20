import type { DbClient } from '../localDb/client/DbClient.js';

/** Companion tasks add their profile tools to the ordinary transport's helper surface. */
export function classifyHelperSurface(
  source: string | null | undefined,
  hasBotLink: boolean,
  main?: { role: string | null | undefined; status: string | null | undefined; remoteHostId: string | null | undefined },
): 'bot' | 'bot-main' | 'default' {
  if (source !== 'bot' && !hasBotLink) return 'default';
  // A private-chat topic is the owner's own Bot Chat, so it gets the main Chat's surface.
  return source === 'bot' && hasBotLink && (main?.role === 'canonical' || main?.role === 'thread' || main?.role === 'routine')
    && main.status === 'active' && !main.remoteHostId
    ? 'bot-main'
    : 'bot';
}

export type HelperSurface = 'bot' | 'bot-main' | 'default' | 'restricted';

interface HelperSurfaceRow {
  source: string; botId: string | null; botRole: string | null; status: string | null; remoteHostId: string | null;
}

function readHelperSurfaceRow(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<HelperSurfaceRow | null | undefined> {
  return db.queryOne<HelperSurfaceRow>(
    `SELECT s.source AS source, b.bot_id AS botId,
       CASE WHEN b.archived_at IS NULL THEN b.role ELSE NULL END AS botRole, s.status AS status,
       s.remote_host_id AS remoteHostId
       FROM sessions s
       LEFT JOIN bot_session_links b ON b.session_id = s.id
      WHERE s.id = ? LIMIT 1`,
    [sessionId],
  );
}

function classifyRow(row: HelperSurfaceRow): HelperSurface {
  return classifyHelperSurface(row.source, Boolean(row.botId), {
    role: row.botRole,
    status: row.status,
    remoteHostId: row.remoteHostId,
  });
}

/** Agent tools depend on the task's account and role, not who created the task. */
export async function resolveHelperSurface(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
): Promise<HelperSurface> {
  const row = await readHelperSurfaceRow(db, sessionId);
  if (!row) return 'restricted';
  return classifyRow(row);
}

/** 查不到会话行时的等待预算(毫秒)与轮询间隔(毫秒)。 */
const DEFAULT_ROW_WAIT_MS = 3_000;
const DEFAULT_ROW_POLL_MS = 100;

/**
 * 等待预算(进程内可调)。
 *
 * 单测要把这个值调到 0:「行始终不出现」那条用例否则会真的等满预算。
 * 生产路径不调它。
 */
export const helperSurfaceRowWait = {
  budgetMs: DEFAULT_ROW_WAIT_MS,
  pollMs: DEFAULT_ROW_POLL_MS,
};

type RestrictedReason = 'row-missing' | 'query-failed';

interface HelperSurfaceLedgerEntry {
  /** 已经为这个会话等过一次行(创建竞态只补一次)。 */
  waited: boolean;
  /** 已经记过的受限原因,避免同一会话反复刷日志。 */
  logged: Set<RestrictedReason>;
}

// 只为缺行或查询失败保留记录，按数据库实例隔离。成功读取时清理对应记录。
const MAX_TRACKED_SESSIONS = 512;
let ledgers = new WeakMap<Pick<DbClient, 'queryOne'>, Map<string, HelperSurfaceLedgerEntry>>();

/** 测试缝:清掉进程内账本,避免用例之间互相看到对方的等待记录。 */
export function __resetHelperSurfaceLedger(): void {
  ledgers = new WeakMap();
}

function ledgerEntry(db: Pick<DbClient, 'queryOne'>, sessionId: string): HelperSurfaceLedgerEntry {
  let ledger = ledgers.get(db);
  if (!ledger) {
    ledger = new Map();
    ledgers.set(db, ledger);
  }
  let entry = ledger.get(sessionId);
  if (!entry) {
    const oldest = ledger.keys().next().value;
    if (ledger.size >= MAX_TRACKED_SESSIONS && oldest !== undefined) ledger.delete(oldest);
    entry = { waited: false, logged: new Set() };
    ledger.set(sessionId, entry);
  }
  return entry;
}

export interface ResolveHelperSurfaceForToolsOptions {
  /** 等这一行落库的总预算(毫秒);0 表示不等。 */
  waitMs?: number;
  /** 轮询间隔(毫秒)。 */
  pollMs?: number;
  /** 等待实现(测试注入)。 */
  sleep?: (ms: number) => Promise<void>;
  /** 判定为受限时的诊断回调。 */
  onRestricted?: (reason: RestrictedReason) => void;
}

/**
 * 工具面判定:查不到会话行时先给一个很短的等待窗口再判一次。
 *
 * 远程控制新建的会话会撞上这个竞态:agent 先起、首份 MCP 工具清单随后才发,
 * 而库里的会话行是 agent 起来之后才写的 —— 那一刻查不到行就被判成
 * 'restricted',整轮少了 ask_user_question_async 等工具(#11671)。
 *
 * 等待只是把时序竞态补平:行始终不出现仍然按 'restricted' 收口,工具面不会
 * 因为「查不到」就放宽。
 */
export async function resolveHelperSurfaceForTools(
  db: Pick<DbClient, 'queryOne'>,
  sessionId: string,
  options: ResolveHelperSurfaceForToolsOptions = {},
): Promise<HelperSurface> {
  const waitMs = options.waitMs ?? helperSurfaceRowWait.budgetMs;
  const pollMs = options.pollMs ?? helperSurfaceRowWait.pollMs;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let reason: RestrictedReason = 'row-missing';
  try {
    let row = await readHelperSurfaceRow(db, sessionId);
    if (!row && waitMs > 0) {
      const entry = ledgerEntry(db, sessionId);
      if (!entry.waited) {
        entry.waited = true;
        const attempts = Math.ceil(waitMs / pollMs);
        for (let attempt = 0; attempt < attempts && !row; attempt += 1) {
          await sleep(pollMs);
          row = await readHelperSurfaceRow(db, sessionId);
        }
      }
    }
    if (row) {
      ledgers.get(db)?.delete(sessionId);
      return classifyRow(row);
    }
  } catch {
    reason = 'query-failed';
  }

  const entry = ledgerEntry(db, sessionId);
  if (options.onRestricted && !entry.logged.has(reason)) {
    entry.logged.add(reason);
    options.onRestricted(reason);
  }
  return 'restricted';
}
