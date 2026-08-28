/**
 * pendingFirstMessage —— 跨路由把「还不能在草稿页发出的首条」递交给真实 SessionView。
 *
 * 本机新建的普通文本不走这里:草稿路由 createSession 后直接 sendMessage,再 navigate。
 * 切走只换画面,发送在 makerChatStore 里继续,不依赖 SessionView hydrate。
 * SessionView 会当成斜杠命令的本机首条(列首 /cmd,以及 Pi 空白前缀)仍走 setPending:
 * desktop / Pi 分派必须等 SessionView 挂上(SSH 跳过控制端 skill、远端 /review 拒绝、
 * Pi runtime 重试),不能在草稿路由复制一套。
 *
 * 仍走这套交接的还有 device-link 远程草稿(含开协同):对端建会话之后,首条必须等
 * SessionView 挂上隧道订阅 / 开协同,不能挡在 navigate 前面。
 *
 *   NewMakerDraftRoute.handleSend(远程)
 *     → 对端 create-session 拿到 remoteSessionId
 *     → setPending(remoteSessionId, { text, files, remoteCollab? })
 *     → navigate('/cc-agent/' + remoteSessionId)
 *   CCAgentSessionView mount
 *     → consumePending(id) → (可选开协同) → sendMessage(text, files)
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
import type { DeferredUiAssignment } from '@/features/cc-agent/deferredUiAssignment';

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
  /** 老被控端不支持延迟派单时，保留新建 Lead 的待发送输入作为兼容上下文。 */
  pendingLeadInput?: string;
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
  /** 本机 Worker 已创建但尚未派单；首条消息 accepted 后再派。 */
  deferredUiAssignment?: DeferredUiAssignment;
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
// 本机普通文本已在草稿路由直接 sendMessage。仍走 setPending 的是 device-link
// 远程草稿,以及本机必须交给 SessionView 分派的斜杠命令首条(含 Pi 空白前缀)。
// **device-link 远程交接**和本机不同 ——
// consume 之后还要 await 隧道往返:开协同要等被控端起 Worker(正常一两秒,慢设备会一路走到
// 30s 隧道超时再加 6×3s 回查),起目标之前还要先 await 一次 `deviceLink.subscribe`
// (同样是 invoke,同样可能走到 30s)。这段时间用户输入只存在于渲染进程内存里,
// app 被关掉就永久消失,被控端还留着一个没有首轮的空会话。
//
// 所以判据是「**这是不是一次远程交接**」,不是「开没开协同」:只挡在开协同那一段前面,
// 非协同的 device-link 起目标照样会在 subscribe 那次 await 里丢掉目标正文。
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

/**
 * 读全表并剔除过期 / 损坏项。localStorage 不可用或 schema 损坏时静默回退空表。
 *
 * **剔除必须落盘**:只从返回值里过滤掉,原始条目会一直留在磁盘上 —— 之后如果这个账号
 * 再没写过新的交接项,就永远没人重写那份 JSON,用户的正文实际上被无限期保存,
 * 与声明的 TTL 和「持久数据要有明确生命周期」不符(codex P2 第三轮)。
 * 所以这里回传是否发生过剔除,由 `loadRecoveryTable` 立刻写回清理后的表。
 */
function parseRecoveryTable(raw: string): {
  table: Record<string, RecoverableHandoff>;
  pruned: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 整份 JSON 都读不懂:当空表处理,并按"有剔除"落盘覆盖掉这份垃圾。
    return { table: {}, pruned: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { table: {}, pruned: true };
  }
  const now = Date.now();
  const table: Record<string, RecoverableHandoff> = {};
  let pruned = false;
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = (value ?? {}) as Partial<RecoverableHandoff>;
    const usable =
      !!value &&
      typeof value === 'object' &&
      typeof entry.text === 'string' &&
      entry.text !== '' &&
      (entry.kind === 'message' || entry.kind === 'goal') &&
      typeof entry.createdAt === 'number' &&
      now - entry.createdAt <= RECOVERY_TTL_MS;
    if (!usable) {
      pruned = true;
      continue;
    }
    table[sessionId] = {
      kind: entry.kind as RecoverableHandoffKind,
      text: entry.text as string,
      createdAt: entry.createdAt as number,
    };
  }
  return { table, pruned };
}

/** 读全表;发生过剔除就立刻把清理后的表写回,不让过期正文赖在磁盘上。 */
function readRecoveryTable(): Record<string, RecoverableHandoff> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(recoveryStorageKey());
  } catch {
    return {};
  }
  if (!raw) return {};
  const { table, pruned } = parseRecoveryTable(raw);
  if (pruned) writeRecoveryTable(table);
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

/**
 * 丢掉副本。**模块私有** —— 唯一的公开入口是 `deliverRecoverableHandoff`。
 *
 * 不导出是刻意的:副本的删除条件("正文已经有了新的归宿")在本 PR 的 review 里被反复
 * 判错,每次都是某个调用点自己就地判断"这算交付了吧"。只要还能裸调它,下一处就还会
 * 再判错一次。收进 deliver 之后,"什么时候可以删"只剩一处可改。
 */
function forgetRecoverableHandoff(sessionId: string): void {
  if (!sessionId) return;
  const table = readRecoveryTable();
  if (!(sessionId in table)) return;
  delete table[sessionId];
  writeRecoveryTable(table);
}

/**
 * 把正文交出去,**只有确认交付成功才丢副本**。
 *
 * 这是删除副本的唯一途径。三处交接(命令派发 / 首轮 sendMessage / 起目标 setGoal)
 * 全部走这里,于是"交付成功"只有一个判据:
 *
 *  · `deliver()` resolve `true`  → 确实交出去了 → 丢副本;
 *  · `deliver()` resolve `false` → **没交出去**,副本必须留着;
 *  · `deliver()` 抛错             → 同样没交出去 → 保留副本,错误照常向上冒泡。
 *
 * 第二条是本轮 codex P1 的要害:`sendMessage` 在设备离线 / 访问被撤销 / 远端
 * `maker:input:enqueue` 拒绝时**不抛错**,而是 resolve `false`,并且对远程会话还会
 * 把那条乐观气泡从 transcript 里撤掉 —— 不 await 就删副本,等于正文从界面和磁盘上
 * 同时消失,而内存 pending 早已消费、新建页草稿也已清空。
 */
export async function deliverRecoverableHandoff(
  sessionId: string,
  deliver: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const delivered = await deliver();
  if (delivered) forgetRecoverableHandoff(sessionId);
  return delivered;
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
