/**
 * pendingFirstMessage —— 跨路由把"NewMaker 草稿首条消息"递交给真实 SessionView。
 *
 * 流程:
 *   NewMakerDraftRoute.handleSend
 *     → createSession() 拿到 newId
 *     → setPending(newId, { text, files })
 *     → navigate('/cc-agent/' + newId)
 *   CCAgentSessionView mount
 *     → consumePending(newId) → sendMessage(text, files)
 *
 * 仅内存(模块级 Map):app 重启意味着发送链路被打断,丢弃不持久化。
 * 一次性消费(consume 即删):防止重复发送。
 *
 * 例外见文件末尾「远程协同交接的可恢复副本」:device-link 开协同那条路径在 consume
 * 之后还要等被控端起 Worker,等待期间正文另存一份到 localStorage,重启后回填输入框。
 */

import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

/**
 * device-link 草稿开了协同时,把「开协同」这件事一起交接给 SessionView(issue #1170)。
 *
 * 为什么不在 draft route 就 await 掉:被控端起 Worker 是一次隧道往返,可能一路走到
 * invoke 默认 30s 超时。把它挡在 navigate 前面,既让新建页凭空卡住半分钟,又把
 * 「对端会话已建好、用户输入还只在内存里」的窗口拉到同样长度(greptile P1)。
 * 而首轮必须排在协同之后又是硬要求 —— 两者只能靠「导航后再协调」同时满足:
 * draft route 登记完就立刻 navigate,SessionView 消费时先 await 开协同、再发首轮。
 */
export interface PendingRemoteCollab {
  /** 被控设备 deviceId —— Worker 在这台机器上 spawn。 */
  deviceId: string;
  /** enableOrca 入参,已按被控端的模型 / 供应商目录收窄。 */
  options: Record<string, unknown>;
}

export interface PendingPayload {
  text: string;
  files?: AttachedFile[];
  mentions?: MentionedResource[];
  vendorOptions?: Record<string, unknown>;
  quotesEncoded?: boolean;
  agentReferences?: AgentInputReference[];
  pastedTextRanges?: PastedTextRange[];
  slashCommandRanges?: SlashCommandRange[];
  /** 非空 = 发首轮之前先在被控端开协同(见 PendingRemoteCollab)。 */
  remoteCollab?: PendingRemoteCollab;
  /** 调试用——createPending 时刻,过期清理时可参考(目前未做 GC,实际场景 navigate 立即消费)。 */
  createdAt: number;
}

const map = new Map<string, PendingPayload>();

/** 超过此时间未被 consumePending 消费的 payload 自动清理，防止导航失败时大体积附件泄漏。 */
const PENDING_TTL_MS = 60_000;

export function setPending(sessionId: string, payload: Omit<PendingPayload, 'createdAt'>): void {
  map.set(sessionId, { ...payload, createdAt: Date.now() });
  setTimeout(() => {
    if (map.has(sessionId)) {
      map.delete(sessionId);
    }
  }, PENDING_TTL_MS);
}

export function consumePending(sessionId: string): PendingPayload | null {
  const v = map.get(sessionId);
  if (!v) return null;
  map.delete(sessionId);
  return v;
}

export function hasPending(sessionId: string): boolean {
  return map.has(sessionId);
}

// ─── pendingGoal —— 跨路由把「远程草稿的新建目标」递交给真实 SessionView ────────
// device-link 远程草稿的 New Goal 流程不能在 /cc-agent/new 就发 maker:goal:set:
// 重 topic `session:<id>` 订阅要等 CCAgentSessionView mount 才建立,goal 首轮的
// maker:event/status 推送会掉在订阅建立前的窗口里(Codex review #548)。
// 与首条消息同款交接:先建会话 → setPendingGoal → navigate → SessionView 消费
// (此时订阅已随 mount 建立)→ goalApiFor(sessionId).setGoal。
// 本机草稿不走这里(本机推送不经订阅,原地 setGoal 即可)。

export interface PendingGoalPayload {
  objective: string;
  limits: { maxTurns: number | null; budgetTokens: number | null; noProgressLimit: number | null };
  /** 与首条消息同款:非空 = 起目标首轮之前先在被控端开协同。 */
  remoteCollab?: PendingRemoteCollab;
  createdAt: number;
}

const goalMap = new Map<string, PendingGoalPayload>();

export function setPendingGoal(
  sessionId: string,
  payload: Omit<PendingGoalPayload, 'createdAt'>,
): void {
  goalMap.set(sessionId, { ...payload, createdAt: Date.now() });
  setTimeout(() => {
    goalMap.delete(sessionId);
  }, PENDING_TTL_MS);
}

export function consumePendingGoal(sessionId: string): PendingGoalPayload | null {
  const v = goalMap.get(sessionId);
  if (!v) return null;
  goalMap.delete(sessionId);
  return v;
}

// ─── 远程协同交接的可恢复副本 ──────────────────────────────────────────────────
//
// 为什么只有 remoteCollab 这条路径要落盘(greptile P1):
// 其余创建路径的 setPending → navigate → mount → consume → sendMessage 是一串毫秒级
// 步骤,内存 Map 与渲染进程同生共死不构成实际风险。而 device-link 开协同这条不同 ——
// consume 之后要 await 被控端起 Worker:正常一两秒,慢设备会一路走到 30s 隧道超时
// 再加 6×3s 回查。这段时间用户输入只存在于渲染进程内存里,app 被关掉就永久消失,
// 被控端还留着一个没有首轮的空会话。窗口是本 PR 把等待挪到导航之后才拉长的,
// 所以由本 PR 补上可恢复副本,而不是留给"以后做持久化交接"。
//
// 取舍:
//  · 只存**正文**,不存附件 —— 与本仓既有取舍一致(newMakerDraft 头部:「附件 → 丢失
//    (产品决策)」),也避免把附件字节写进 localStorage。
//  · 恢复时**只回填输入框,绝不自动补发**。用户上次按下发送时的意图未必还成立,
//    重启后凭空冒出一条已发消息比丢失更难解释;回填后由用户自己决定。
//  · 与 PENDING_TTL_MS(60s,针对内存 payload)不同,这份副本要跨重启活着,
//    用天级 TTL 兜底,防止导航失败的残留无限堆积。

const RECOVERY_STORAGE_KEY = 'xdt:pendingHandoffRecovery:v1';
/** 跨重启保留,但不无限堆积:超过此年龄的残留在下次读写时清掉。 */
const RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RecoverableHandoffKind = 'message' | 'goal';

interface RecoverableHandoff {
  kind: RecoverableHandoffKind;
  text: string;
  createdAt: number;
}

let activeDataOwnerId: string | null = null;

function recoveryStorageKey(): string {
  return activeDataOwnerId
    ? `${RECOVERY_STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}`
    : RECOVERY_STORAGE_KEY;
}

/** 与 composerDraftStore / newMakerDraft 同款:按数据归属人分命名空间,换账号不串台。 */
export function setPendingHandoffOwner(ownerId: string | null): void {
  activeDataOwnerId = ownerId;
}

/** 读全表并顺手剔除过期项。localStorage 不可用 / schema 损坏时静默回退空表。 */
function readRecoveryTable(): Record<string, RecoverableHandoff> {
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(recoveryStorageKey());
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const now = Date.now();
  const table: Record<string, RecoverableHandoff> = {};
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<RecoverableHandoff>;
    if (typeof entry.text !== 'string' || entry.text === '') continue;
    if (entry.kind !== 'message' && entry.kind !== 'goal') continue;
    if (typeof entry.createdAt !== 'number') continue;
    if (now - entry.createdAt > RECOVERY_TTL_MS) continue;
    table[sessionId] = { kind: entry.kind, text: entry.text, createdAt: entry.createdAt };
  }
  return table;
}

function writeRecoveryTable(table: Record<string, RecoverableHandoff>): void {
  try {
    if (Object.keys(table).length === 0) {
      window.localStorage.removeItem(recoveryStorageKey());
      return;
    }
    window.localStorage.setItem(recoveryStorageKey(), JSON.stringify(table));
  } catch {
    // localStorage 满 / 私密窗口禁写 —— 忽略。副本是尽力而为的兜底,
    // 写不进去也不该把首轮发送本身弄失败。
  }
}

/** 进入远程协同等待**之前**调用:留下一份正文,等待期间 app 被关掉也能捞回来。 */
export function rememberRecoverableHandoff(
  sessionId: string,
  kind: RecoverableHandoffKind,
  text: string,
): void {
  if (!sessionId || text === '') return;
  const table = readRecoveryTable();
  table[sessionId] = { kind, text, createdAt: Date.now() };
  writeRecoveryTable(table);
}

/** 正文已经交给 sendMessage / setGoal(或明确不再需要)后调用。幂等。 */
export function forgetRecoverableHandoff(sessionId: string): void {
  if (!sessionId) return;
  const table = readRecoveryTable();
  if (!(sessionId in table)) return;
  delete table[sessionId];
  writeRecoveryTable(table);
}

/**
 * 取出并清除某会话的可恢复正文;kind 不匹配时不动它(首条消息与目标各自恢复各自的)。
 * 返回 null = 没有待恢复内容(绝大多数情况)。
 */
export function takeRecoverableHandoff(
  sessionId: string,
  kind: RecoverableHandoffKind,
): string | null {
  if (!sessionId) return null;
  const table = readRecoveryTable();
  const entry = table[sessionId];
  if (!entry || entry.kind !== kind) return null;
  delete table[sessionId];
  writeRecoveryTable(table);
  return entry.text;
}

/** 测试用。 */
export function __clearAllForTest(): void {
  map.clear();
  goalMap.clear();
  activeDataOwnerId = null;
  try {
    window.localStorage.removeItem(RECOVERY_STORAGE_KEY);
  } catch {
    // ignore
  }
}
