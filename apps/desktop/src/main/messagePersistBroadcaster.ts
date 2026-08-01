/**
 * messagePersistBroadcaster — 把 agent 消息的持久化从 renderer 收口到 main 单点。
 * ---------------------------------------------------------------------------
 * 背景(post-merge 数据正确性 HIGH bug):多窗下每个 renderer 各用各自随机
 * clientId 各落一份 assistant/tool 消息 → DB 重复行 + UI 重复 + 重开历史翻倍。根因
 * 是消息持久化留在 per-window 的 makerChatStore reducer 里。main 的 session.onEvent
 * 每会话只触发一次(Maker 是进程级单例)→ 把落库搬进 main = 天然单写,根除重复。
 * 对标已落地的 sessionSpendBroadcaster(把 status/cost 持久化从 renderer 收口到 main)。
 *
 * 本模块(Phase 2)先收口 **assistant 文本**:
 *   - 在 assistant 'text' 事件流上为一条 assistant message 分配 / 复用一个 persistId,
 *     贯穿该 block 的所有 delta;由 register.ts onEvent 把 persistId 盖到广播 payload,
 *     让 renderer 的在途流式气泡一开始就用同一个 id 当 clientId;
 *   - block 完成(text isFinal)或遇到边界(tool_use / done / error / 任一 interaction
 *     请求)时,把累积的全文落库(createMessage,(sessionId, clientId) 幂等);
 *   - createMessage 落库后会 broadcast local-db:messages:created,renderer 据此把在途
 *     气泡 hydrate 成权威内容(同 persistId 命中现有 dedup,替换而非新增一行)。
 *
 * clientId 由 main 用仓库现有 cuid(createId)生成,vendor 无关、不依赖 SDK uuid
 * (Codex assistant 无 uuid 的难题被自生成 id 直接消解);SDK uuid 仍按现状写进
 * agent_meta 列(rewind / fork 锚点)。
 *
 * 热路径约束(CLAUDE.md 规则19):session.onEvent 是**每事件**热路径,better-sqlite3
 * 是同步写。本模块在 onEvent 同步路径上只做 O(1) 的 persistId 查表 / 文本累积,**不
 * 落库**;真正的落库一律走 enqueueWrite 的串行异步队列(microtask drain),绝不在
 * onEvent 同步栈里执行 createMessage —— 它的首个 SELECT 是同步 sqlite,直接调会卡
 * 事件循环。调用方需保证"先 broadcastToAllWindows 再让本模块入队落库"。
 */

import { createId } from '@paralleldrive/cuid2';

import { BrowserWindow } from 'electron';
import { desc, eq } from 'drizzle-orm';

import {
  broadcastMessageAgentMetaUpdate,
  createMessage as createDbMessage,
  patchMessageAgentMetaWithResult,
  updateMessageContent as updateDbMessageContent,
} from './localDb/ipc/messages.js';
import { getDbClient } from './localDb/client/current.js';
import { messages as messagesTable } from './localDb/schema.js';
import { createLogger } from './logger.js';
import { tapWindowBroadcast } from './device-link/broadcast-tap.js';
import { takeMediaToolResult } from './mcp-integrations/mediaToolResultFallback.js';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { AgentMeta } from '../renderer/lib/ccAgent.types';

const log = createLogger('messagePersistBroadcaster');

/** 每会话当前在飞的 assistant 文本 block:分配一次 persistId、累积全文,边界落库后清。 */
interface AssistantBlock {
  persistId: string;
  text: string;
  agentMeta: AgentMeta | null;
  createdAt: number;
}

const assistantBlocks = new Map<string, AssistantBlock>();
const clearBoundaryBySession = new Map<string, number>();

export function noteSessionClearBoundary(sessionId: string, clearedAt: string | number | null | undefined): void {
  if (clearedAt === null || clearedAt === undefined) {
    clearBoundaryBySession.delete(sessionId);
    return;
  }
  const parsed = typeof clearedAt === 'number' ? clearedAt : new Date(clearedAt).getTime();
  if (!Number.isFinite(parsed)) return;
  const current = clearBoundaryBySession.get(sessionId);
  if (current === undefined || parsed > current) {
    clearBoundaryBySession.set(sessionId, parsed);
  }
}

type CreateDbMessageBody = Parameters<typeof createDbMessage>[1];

/**
 * session-agent-switch:每会话当前 agent 引擎('cc'/'codex'),由 register.ts
 * wireSessionToIpc 在 session 建立时登记。broadcaster 落库的 SDK 事件行
 * (assistant/tool/thinking/error)逐行 stamp 到 messages.agent_kind——切换后
 * session.agent_kind 只代表"当前引擎",历史行的 agent_meta 必须按写入时引擎解析。
 * clearSessionPersistState 时清理。
 */
const dbAgentKindBySession = new Map<string, 'cc' | 'codex' | 'pi'>();

export function noteSessionAgentKind(sessionId: string, dbAgentKind: 'cc' | 'codex' | 'pi'): void {
  dbAgentKindBySession.set(sessionId, dbAgentKind);
}

export function getSessionDbAgentKind(sessionId: string): 'cc' | 'codex' | 'pi' | null {
  return dbAgentKindBySession.get(sessionId) ?? null;
}

function withAgentKindStamp(sessionId: string, body: CreateDbMessageBody): CreateDbMessageBody {
  if (body.agentKind !== undefined) return body;
  const kind = dbAgentKindBySession.get(sessionId);
  return kind ? { ...body, agentKind: kind } : body;
}

function createVisibleDbMessage(sessionId: string, body: CreateDbMessageBody): ReturnType<typeof createDbMessage> {
  const createdAt = typeof body.createdAt === 'number' && Number.isFinite(body.createdAt)
    ? body.createdAt
    : undefined;
  if (createdAt === undefined) {
    return createDbMessage(sessionId, body);
  }
  return createDbMessage(sessionId, body, {
    shouldBroadcast: () => {
      const latestBoundary = clearBoundaryBySession.get(sessionId);
      return latestBoundary === undefined || createdAt > latestBoundary;
    },
  });
}

/**
 * 每会话最近一次见到的非空 agentMeta(镜像 renderer 的 state.lastAgentMeta)。
 * 用于 flush 落库时的最后一级兜底:interaction(ask_user / plan_review / permission)
 * 边界不携带 agentMeta、且其前的 assistant text delta 携带的 meta 可能是 null / 上一条
 * 的陈旧 meta,若只用 block.agentMeta 会让该 assistant 以 null agent_meta 落库 →
 * rewind / fork 找锚点丢(不可回退项④)。renderer 老逻辑正是用 state.lastAgentMeta
 * 兜底,这里 1:1 对齐。
 */
const lastAgentMetaBySession = new Map<string, AgentMeta>();

/** 每会话当前 turn 的开始时刻(由 register.ts 在 status:isRunning=true 时调用)。
 * 用于 onTurnErrorEvent 判断 error 是否属于 /clear 之前的旧 turn(stale pre-clear turn)：
 * 若 turnStartedAt <= clearBoundary，该 error 行必须 cap 在 clear 边界之下，防止出现在清空后的新会话。
 * resetTurnPersistState / clearSessionPersistState 时清除。 */
const _turnStartedAtBySession = new Map<string, number>();
const _turnDedupIdBySession = new Map<string, string>();
let _turnDedupSeq = 0;

/** 远程 auth retry 的 deferred 路径专用：在 resetTurnPersistState 清掉 _turnStartedAtBySession
 * 之前保存一份 turn 开始时刻，供 persistTurnErrorDeferred IPC 晚到时仍能正确做 /clear cap。
 * noteTurnStarted / clearSessionPersistState 时清除（新 turn 开始或会话关闭时旧值失效）。 */
const _savedTurnStartedAtForDeferred = new Map<string, number>();
const _savedTurnDedupIdForDeferred = new Map<string, string>();

/** register.ts 在 status:isRunning=true 时调用，记录新 turn 开始时刻。
 * 只在首次调用（Map 中无条目）时写入，忽略后续 isRunning:true 的覆盖，
 * 防止 Claude 工具进度 / Codex stage 等 mid-turn 进度事件在 /clear 之后
 * 用 post-clear 时间戳覆盖原始 pre-clear 起点，导致 /clear 竞态 cap 失效。 */
export function noteTurnStarted(sessionId: string): void {
  if (!_turnStartedAtBySession.has(sessionId)) {
    const now = Date.now();
    _turnStartedAtBySession.set(sessionId, now);
    _turnDedupIdBySession.set(sessionId, `${now}:${++_turnDedupSeq}`);
    // 新 turn 第一次记录时，旧的 deferred 保存值已无效，清掉防止 deferred IPC 用到旧 turn 的时刻。
    _savedTurnStartedAtForDeferred.delete(sessionId);
    _savedTurnDedupIdForDeferred.delete(sessionId);
  }
}

/** register.ts 在 isRemoteAuthRetry=true 时调用，把当前 turn 开始时刻保存到 deferred 专用 Map，
 * 使 persistTurnErrorDeferred IPC 在 resetTurnPersistState 清掉主 Map 后仍能取到正确时刻。 */
export function saveTurnStartedAtForDeferred(sessionId: string): void {
  const ts = _turnStartedAtBySession.get(sessionId);
  if (ts !== undefined) _savedTurnStartedAtForDeferred.set(sessionId, ts);
  const dedupId = _turnDedupIdBySession.get(sessionId);
  if (dedupId !== undefined) _savedTurnDedupIdForDeferred.set(sessionId, dedupId);
}

/** 记录最近一次非空 agentMeta(由 register.ts onEvent 在每个带 meta 的事件上调用)。 */
export function noteAgentMeta(sessionId: string, meta: AgentMeta): void {
  lastAgentMetaBySession.set(sessionId, meta);
}

/**
 * 每会话最近一条顶层 assistant 的 SDK uuid。不要在 turn 结束时清：
 * 下一条 user 消息需要把它写成 transcriptParentUuid，形成可用于 rewind 的因果链。
 */
const lastAssistantTranscriptUuidBySession = new Map<string, string>();

function noteAssistantTranscriptUuid(sessionId: string, meta: AgentMeta | null): void {
  const uuid = typeof meta?.uuid === 'string' && meta.uuid ? meta.uuid : undefined;
  const parentToolUseId = typeof meta?.parentUuid === 'string' && meta.parentUuid ? meta.parentUuid : undefined;
  if (uuid && !parentToolUseId) lastAssistantTranscriptUuidBySession.set(sessionId, uuid);
}

export function getLastAssistantTranscriptUuid(sessionId: string): string | undefined {
  return lastAssistantTranscriptUuidBySession.get(sessionId);
}

export function setLastAssistantTranscriptUuid(sessionId: string, uuid: string | undefined): void {
  if (uuid) {
    lastAssistantTranscriptUuidBySession.set(sessionId, uuid);
  } else {
    lastAssistantTranscriptUuidBySession.delete(sessionId);
  }
}

/**
 * 每会话"最后一条已入队落库的消息"(role + 内容 + persistId)。镜像 renderer 老 reducer
 * 的 isFinal burst DUP-SKIP(makerChatStore 旧 757-762:"最后一条是内容相同的非流式
 * assistant 就跳过 create")—— 落库收口 main 后,这道去重必须在 main 对称存在,否则重复
 * isFinal(translator 兜底边缘 / result 补推在 block 已 flush 后又来同内容)会让 main 落
 * 第二行、renderer DUP-SKIP 只挡显示不挡库 → 重开会话 assistant 翻倍(正是本 MR 要消灭
 * 的重复行)。
 *
 * 只去重"相邻且内容完全相同"的 assistant:任何其它消息(tool_use / tool_result / thinking /
 * ask_user / plan_review)入队都会刷新这条记录 → role 不再是 assistant,从而"中间夹了别的
 * 消息"的两条相同文本不会被误删(与 renderer messages[last] 语义 1:1,避免误吞合法重复回复)。
 */
const lastPersistedMsgBySession = new Map<string, { role: string; text: string; persistId: string }>();

function notePersistedMessage(sessionId: string, role: string, persistId: string, text = ''): void {
  lastPersistedMsgBySession.set(sessionId, { role, text, persistId });
}

/**
 * 每会话"本 turn 最后一条已入队落库的 assistant 文本"的 persistId。turn 结束(done)
 * 时由 register.ts 经 consumeLastAssistantPersistId 取走,用于把 per-turn 费用挂到该
 * 条消息的 agent_meta 上。consume 即清(get + delete):纯 tool 轮取到 undefined 不挂;
 * terminal error 结束的轮也 consume 丢弃,防 persistId 串到下一轮。
 */
const lastAssistantPersistIdBySession = new Map<string, string>();

/** 取出并清除本 turn 最后一条 assistant 的 persistId(没有则 undefined)。 */
export function consumeLastAssistantPersistId(sessionId: string): string | undefined {
  const id = lastAssistantPersistIdBySession.get(sessionId);
  lastAssistantPersistIdBySession.delete(sessionId);
  return id;
}

/**
 * SDK done 是比 user 消息更细的真实 turn 边界。把它盖到本 turn 的收尾 assistant
 * 上，供 Desktop / Mobile 在后台任务自动续跑新 SDK turn 时分别保留两轮正式回复。
 * 返回 false 表示本轮没有 assistant 文本；调用方无需广播。
 */
export function markAssistantTurnCompleted(
  sessionId: string,
  clientId: string | undefined,
): Promise<boolean> {
  if (!sessionId || !clientId) return Promise.resolve(false);
  return enqueueDurableWrite(`turn-completed:${sessionId}:${clientId}`, async () => {
    const patched = await patchMessageAgentMetaWithResult(sessionId, clientId, {
      turnCompleted: true,
    });
    if (!patched) return false;
    return broadcastMessageAgentMetaUpdate(sessionId, clientId);
  });
}

/**
 * 给一条自动续跑（中断自愈）的 user 消息补上**结果**。
 *
 * 为什么必须有这一步:那条消息在「续跑指令发出去」的瞬间就落库了,而那时还完全不知道
 * 有没有真的连上。只按落库渲染就会出现「明明重连失败了,历史里却写着已重新连接」——
 * 连续 5 次全失败会留下 5 句假话。所以结果由后续事件回填:
 *  - `succeeded`:模型产出了实质内容(text / tool_use),这才是"连上了"的证据。
 *  - `failed`:又被打断、或最终落到 error。
 * 未回填(两者都没发生)= 还在等结果,renderer 继续显示"重新连接中"。
 */
export function markAutoResumeOutcome(
  sessionId: string,
  clientId: string | undefined,
  outcome: 'succeeded' | 'failed',
): Promise<boolean> {
  if (!sessionId || !clientId) return Promise.resolve(false);
  return enqueueDurableWrite(`auto-resume-outcome:${sessionId}:${clientId}`, async () => {
    const patched = await patchMessageAgentMetaWithResult(sessionId, clientId, {
      autoResumeOutcome: outcome,
    });
    if (!patched) return false;
    return broadcastMessageAgentMetaUpdate(sessionId, clientId);
  });
}

/**
 * 串行异步写队列。把同步 sqlite 写挪出 onEvent 同步栈(microtask 才 drain),且天然
 * 序列化(sqlite 本就单写者)。每个 link 单独 catch,失败只 warn、不打断后续写。
 */
let writeChain: Promise<unknown> = Promise.resolve();
function enqueueWrite(label: string, fn: () => Promise<unknown>): void {
  writeChain = writeChain
    .then(fn)
    .catch((err) => {
      log.warn('message persist failed', {
        label,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** 在事件入队时冻结 agent_kind，避免 writeChain 延迟执行时读到切换后的可变 Map。 */
function enqueueVisibleDbMessage(
  label: string,
  sessionId: string,
  body: CreateDbMessageBody,
): void {
  const stamped = withAgentKindStamp(sessionId, body);
  enqueueWrite(label, () => createVisibleDbMessage(sessionId, stamped));
}

/**
 * 把外部 db write 串到同一 writeChain FIFO, 返回 typed 结果。给 session storage /
 * 其他 desktop-side 持久化用 — 让它们跟 message + cursor 写共享 FIFO 序列化,
 * 消除"两本帐"race (典型: 旧版 cursor 写跟 sdkSessionId 写 storage.update 不在同
 * FIFO, init event 已推 cursor 但 sdkSessionId 没落盘时 crash → 下次 reattach
 * 从 cursor 起跳, init event 永远丢, sdkSessionId 空)。
 *
 * `fn` 在 microtask 里跑, 内部用 sync drizzle write OK; reject 透传给调用方, 单
 * 个 link reject 不打断后续 chain (跟 enqueueWrite 的吞错语义对齐, log.warn 即可)。
 */
export function enqueueDurableWrite<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    writeChain = writeChain
      .then(async () => {
        try {
          const value = await fn();
          resolve(value);
        } catch (err) {
          log.warn('durable write failed', {
            label,
            error: err instanceof Error ? err.message : String(err),
          });
          reject(err);
        }
      })
      // 防止单个 reject 把 writeChain 整条 promise 弄 rejected (后续 .then 不跑),
      // 跟内部 enqueueWrite 同款防御。
      .catch(() => undefined);
  });
}

/**
 * 等当前 chain 上排队的所有写完成。给 cc-remote seq cursor 持久化用:
 * cursor flush 前先 await drain, 保证 DB 里 message 已落到对应 seq 才推 cursor,
 * desktop crash 时不会出现 cursor 已推但 message 没存的 hole。
 * 只 await 调用瞬间的 chain snapshot — 之后新 enqueue 的写不算 (那些是后续 seq,
 * 下一次 flush 时再 drain)。
 */
export async function drainPersistQueue(): Promise<void> {
  // capture snapshot — 后面 enqueueWrite 重新赋值 writeChain 不影响这次 await
  const snapshot = writeChain;
  try {
    await snapshot;
  } catch {
    // 每个 link 自己 catch 过了, 这里不会抛; 兜底防御。
  }
}

function enqueuePersistAssistant(
  sessionId: string,
  clientId: string,
  content: string,
  agentMeta: AgentMeta | null,
  createdAt: number,
): void {
  noteAssistantTranscriptUuid(sessionId, agentMeta);
  enqueueVisibleDbMessage(`assistant:${sessionId}:${clientId}`, sessionId, {
    clientId,
    role: 'assistant',
    content,
    agentMeta: agentMeta ?? null,
    createdAt,
  });
  notePersistedMessage(sessionId, 'assistant', clientId, content);
  lastAssistantPersistIdBySession.set(sessionId, clientId);
}

/**
 * 每会话已落库过的 tool_use 的 toolUseId 集合。tool_result_full 早到(无对应
 * tool_result 映射)时,用它判断"tool_use 是否已到"决定 eager-create 还是 buffer
 * (对齐 renderer 老逻辑的 hasKnownToolUse 检查)。Phase 3 先填充,Phase 4 消费。
 */
const knownToolUseIdsBySession = new Map<string, Set<string>>();
const toolUseCreatedAtBySession = new Map<string, Map<string, number>>();
/**
 * 每会话 toolUseId → { toolName, input }。媒体 echo 兜底用:flushOrphanToolResults
 * 需要按 tool_use 的 input.args 去 mediaToolResultFallback 池里认领结果。
 */
const toolUseInfoBySession = new Map<string, Map<string, { toolName: string; input: unknown }>>();
const updatableToolUsePersistIdBySession = new Map<string, Map<string, string>>();

function rememberToolUseId(sessionId: string, toolUseId: string, createdAt: number): void {
  let set = knownToolUseIdsBySession.get(sessionId);
  if (!set) {
    set = new Set();
    knownToolUseIdsBySession.set(sessionId, set);
  }
  set.add(toolUseId);
  let createdAtMap = toolUseCreatedAtBySession.get(sessionId);
  if (!createdAtMap) {
    createdAtMap = new Map();
    toolUseCreatedAtBySession.set(sessionId, createdAtMap);
  }
  createdAtMap.set(toolUseId, createdAt);
}

function clampAfterToolUse(sessionId: string, toolUseId: string, createdAt: number): number {
  const toolUseCreatedAt = toolUseCreatedAtBySession.get(sessionId)?.get(toolUseId);
  if (toolUseCreatedAt === undefined || createdAt > toolUseCreatedAt) return createdAt;
  return toolUseCreatedAt + 1;
}

function clampAfterLatestToolUse(sessionId: string, toolUseIds: string[], createdAt: number): number {
  const createdAtMap = toolUseCreatedAtBySession.get(sessionId);
  if (!createdAtMap) return createdAt;
  let latestToolUseCreatedAt: number | undefined;
  for (const toolUseId of toolUseIds) {
    const toolUseCreatedAt = createdAtMap.get(toolUseId);
    if (toolUseCreatedAt === undefined) continue;
    if (latestToolUseCreatedAt === undefined || toolUseCreatedAt > latestToolUseCreatedAt) {
      latestToolUseCreatedAt = toolUseCreatedAt;
    }
  }
  if (latestToolUseCreatedAt === undefined || createdAt > latestToolUseCreatedAt) return createdAt;
  return latestToolUseCreatedAt + 1;
}

function isUpdatableToolUse(toolName: string): boolean {
  return toolName === 'update_plan' || toolName === 'web_search';
}

function rememberUpdatableToolUsePersistId(sessionId: string, toolUseId: string, persistId: string): void {
  let idMap = updatableToolUsePersistIdBySession.get(sessionId);
  if (!idMap) {
    idMap = new Map();
    updatableToolUsePersistIdBySession.set(sessionId, idMap);
  }
  idMap.set(toolUseId, persistId);
}

/**
 * 处理 tool_use 事件:生成 persistId(cuid)、落库 tool_use 消息,返回 persistId 供
 * onEvent 盖进广播 payload(renderer 在途 tool_use 气泡用同一 id → onCreated dedup)。
 * agentMeta:tool_use 与前面 assistant 同属一条 SDK message,事件自带 meta 即正确;
 * 兜底用会话最近一次非空 meta(与 renderer 老逻辑 incomingMeta ?? lastAgentMeta 对齐)。
 */
export function onToolUseEvent(
  sessionId: string,
  data: { toolUseId?: unknown; toolName?: unknown; input?: unknown },
  agentMeta: AgentMeta | null,
): string {
  const createdAt = Date.now();
  const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : '';
  const toolName = typeof data.toolName === 'string' ? data.toolName : '';
  if (toolUseId) {
    rememberToolUseId(sessionId, toolUseId, createdAt);
    getOrCreateSessionMap(toolUseInfoBySession, sessionId).set(toolUseId, {
      toolName,
      input: data.input,
    });
  }
  const existingPersistId = isUpdatableToolUse(toolName) && toolUseId
    ? updatableToolUsePersistIdBySession.get(sessionId)?.get(toolUseId)
    : undefined;
  if (existingPersistId) {
    const content = { toolUseId, toolName, input: data.input };
    enqueueWrite(`tool_use_update:${sessionId}:${existingPersistId}`, () =>
      updateDbMessageContent(sessionId, existingPersistId, content),
    );
    notePersistedMessage(sessionId, 'tool_use', existingPersistId);
    return existingPersistId;
  }
  const persistId = createId();
  const meta = agentMeta ?? lastAgentMetaBySession.get(sessionId) ?? null;
  noteAssistantTranscriptUuid(sessionId, meta);
  enqueueVisibleDbMessage(`tool_use:${sessionId}:${persistId}`, sessionId, {
    clientId: persistId,
    role: 'tool_use',
    content: { toolUseId, toolName, input: data.input },
    toolUseId: toolUseId || undefined,
    agentMeta: meta,
    createdAt,
  });
  if (isUpdatableToolUse(toolName) && toolUseId) {
    rememberUpdatableToolUsePersistId(sessionId, toolUseId, persistId);
  }
  notePersistedMessage(sessionId, 'tool_use', persistId);
  return persistId;
}

/**
 * Main 侧合成 tool 事件也必须遵守 renderer 的展示契约:
 * tool_result / tool_result_full 只有带 persistId + resolvedContent 才会渲染。
 *
 * 普通 agent 事件在 maker-ipc/register.ts 的 session.onEvent 热路径里逐类调用
 * onToolUseEvent / onToolResultFullEvent / onToolResultEvent 后再 broadcast；但 Codex
 * imageGeneration、Mivo button action 等本地合成事件不一定经过那段分支。这个 helper
 * 把同一套持久化 / 内容归并逻辑暴露给合成事件,避免直接 broadcast 后 renderer no-op。
 */
export function prepareSyntheticToolEventForBroadcast(
  sessionId: string,
  event: { type: 'tool_use' | 'tool_result' | 'tool_result_full'; data: unknown },
  agentMeta: AgentMeta | null,
): { persistId?: string; resolvedContent?: string } {
  if (agentMeta) noteAgentMeta(sessionId, agentMeta);

  if (event.type === 'tool_use') {
    flushAssistantBlock(sessionId, agentMeta);
    return {
      persistId: onToolUseEvent(
        sessionId,
        event.data as { toolUseId?: unknown; toolName?: unknown; input?: unknown },
        agentMeta,
      ),
    };
  }

  if (event.type === 'tool_result_full') {
    const r = onToolResultFullEvent(
      sessionId,
      event.data as { toolUseId?: unknown; fullText?: unknown },
      agentMeta,
    );
    return { persistId: r?.persistId, resolvedContent: r?.content };
  }

  const r = onToolResultEvent(
    sessionId,
    event.data as { summary?: unknown; toolUseIds?: unknown },
    agentMeta,
  );
  return { persistId: r?.persistId, resolvedContent: r?.content };
}

/**
 * 处理 thinking 事件,在 final / redacted 阶段落库(write-once)。clientId 用 SDK 稳定
 * 的 blockId(本就跨窗幂等,renderer 也用 data.blockId 当气泡 id,main/renderer 同源,
 * 无需 persistId 回传)。start / delta 阶段不落库(纯 UI 流式)。
 */
export function onThinkingEvent(
  sessionId: string,
  data: { stage?: unknown; blockId?: unknown; text?: unknown; durationMs?: unknown },
  agentMeta: AgentMeta | null,
): void {
  const blockId = typeof data.blockId === 'string' ? data.blockId : '';
  if (!blockId) return;
  const meta = agentMeta ?? lastAgentMetaBySession.get(sessionId) ?? null;
  noteAssistantTranscriptUuid(sessionId, meta);

  if (data.stage === 'final') {
    const finishedAt = Date.now();
    const text = typeof data.text === 'string' ? data.text : '';
    const durationMs = typeof data.durationMs === 'number' ? data.durationMs : 0;
    enqueueVisibleDbMessage(`thinking:${sessionId}:${blockId}`, sessionId, {
      clientId: blockId,
      role: 'thinking',
      content: { kind: 'thinking', text, durationMs, isRedacted: false, finishedAt },
      agentMeta: meta,
      createdAt: finishedAt,
    });
    notePersistedMessage(sessionId, 'thinking', blockId);
  } else if (data.stage === 'redacted') {
    const finishedAt = Date.now();
    enqueueVisibleDbMessage(`thinking_redacted:${sessionId}:${blockId}`, sessionId, {
      clientId: blockId,
      role: 'thinking',
      content: { kind: 'thinking', text: '', durationMs: 0, isRedacted: true, finishedAt },
      agentMeta: meta,
      createdAt: finishedAt,
    });
    notePersistedMessage(sessionId, 'thinking', blockId);
  }
}

// ── tool_result 内容重排状态机(Option C:全在 main 一份,renderer 纯展示)──────
// 三个 per-session Map,语义对齐被收口前的 renderer reducer:
//   toolResultIdByToolUseId: toolUseId → 这条 tool_result 消息的 persistId(clientId)
//   pendingFullTextByToolUseId: toolUseId → 早到的全文 buffer(对应 tool_result/tool_use 还没到)
//   toolResultContentByClientId: persistId → 当前已解析内容(判断是否需要 update / 是否变化)
const toolResultIdByToolUseId = new Map<string, Map<string, string>>();
const pendingFullTextByToolUseId = new Map<string, Map<string, { text: string; createdAt: number }>>();
const toolResultContentByClientId = new Map<string, Map<string, string>>();

function getOrCreateSessionMap<V>(
  outer: Map<string, Map<string, V>>,
  sessionId: string,
): Map<string, V> {
  let m = outer.get(sessionId);
  if (!m) {
    m = new Map<string, V>();
    outer.set(sessionId, m);
  }
  return m;
}

function toolResultMeta(sessionId: string, agentMeta: AgentMeta | null): AgentMeta | null {
  return agentMeta ?? lastAgentMetaBySession.get(sessionId) ?? null;
}

/**
 * 处理 tool_result 事件(摘要 + toolUseIds[]),解析出这条 tool_result 的
 * { persistId, content } 供 onEvent 盖进 payload 让 renderer 即时显示,并落库(create
 * 或 content 增长时 update)。返回 null 仅当无任何 toolUseId 可定位(理论不出现)。
 *
 * 内容解析对齐老 renderer:摘要为底,若 buffer 里有更长的全文则用全文并消费 buffer;
 * 多 toolUseId 命中已有消息则归并到同一条(content 增长才 update)。
 */
export function onToolResultEvent(
  sessionId: string,
  data: { summary?: unknown; toolUseIds?: unknown },
  agentMeta: AgentMeta | null,
): { persistId: string; content: string } | null {
  const summary = typeof data.summary === 'string' ? data.summary : '';
  const ids = Array.isArray(data.toolUseIds)
    ? data.toolUseIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];

  const idMap = getOrCreateSessionMap(toolResultIdByToolUseId, sessionId);
  const pending = getOrCreateSessionMap(pendingFullTextByToolUseId, sessionId);
  const contentMap = getOrCreateSessionMap(toolResultContentByClientId, sessionId);
  let createdAt = Date.now();
  let usedBufferedContent = false;

  // 摘要 vs buffer 全文:取更长者;消费 buffer。
  let content = summary;
  for (const id of ids) {
    const buffered = pending.get(id);
    if (buffered && buffered.text.length > content.length) {
      content = buffered.text;
      createdAt = clampAfterToolUse(sessionId, id, buffered.createdAt);
      usedBufferedContent = true;
    }
    pending.delete(id);
  }
  if (usedBufferedContent) {
    createdAt = clampAfterLatestToolUse(sessionId, ids, createdAt);
  }
  const primaryToolUseId = ids[0];

  // 已有映射(多 toolUseId 归并到同一条)?
  let existing: string | undefined;
  for (const id of ids) {
    const c = idMap.get(id);
    if (c) {
      existing = c;
      break;
    }
  }

  if (existing) {
    for (const id of ids) idMap.set(id, existing);
    const prev = contentMap.get(existing);
    // 内容没增长 → 不写库;renderer 已显示该条,返回现有内容即可(upsert 命中后无变化)。
    if (prev === undefined || content.length <= prev.length) {
      return { persistId: existing, content: prev ?? content };
    }
    contentMap.set(existing, content);
    enqueueWrite(`tool_result_update:${sessionId}:${existing}`, () =>
      updateDbMessageContent(sessionId, existing!, content),
    );
    notePersistedMessage(sessionId, 'tool_result', existing);
    return { persistId: existing, content };
  }

  const persistId = createId();
  for (const id of ids) idMap.set(id, persistId);
  contentMap.set(persistId, content);
  enqueueVisibleDbMessage(`tool_result:${sessionId}:${persistId}`, sessionId, {
    clientId: persistId,
    role: 'tool_result',
    content,
    toolUseId: primaryToolUseId,
    agentMeta: toolResultMeta(sessionId, agentMeta),
    createdAt,
  });
  notePersistedMessage(sessionId, 'tool_result', persistId);
  return { persistId, content };
}

/**
 * 处理 tool_result_full 事件(toolUseId + 全文)。返回 { persistId, content } 让
 * renderer 把对应 tool_result 气泡内容更新成全文;返回 null 表示无需显示变更
 * (已 buffer 等 tool_result / tool_use,或内容未变)。
 *
 * 对齐老 renderer:有映射 → 覆盖更新;无映射但 tool_use 已到 → eager-create;
 * tool_use 也没到 → buffer。
 */
export function onToolResultFullEvent(
  sessionId: string,
  data: { toolUseId?: unknown; fullText?: unknown },
  agentMeta: AgentMeta | null,
): { persistId: string; content: string } | null {
  const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : '';
  const fullText = typeof data.fullText === 'string' ? data.fullText : null;
  if (!toolUseId || fullText === null) return null; // guard,对齐老 renderer

  const idMap = getOrCreateSessionMap(toolResultIdByToolUseId, sessionId);
  const pending = getOrCreateSessionMap(pendingFullTextByToolUseId, sessionId);
  const contentMap = getOrCreateSessionMap(toolResultContentByClientId, sessionId);
  const createdAt = Date.now();

  const target = idMap.get(toolUseId);
  if (!target) {
    const known = knownToolUseIdsBySession.get(sessionId);
    if (known?.has(toolUseId)) {
      // tool_use 已到但还没 tool_result 摘要 → 直接建一条带全文的 tool_result。
      const persistId = createId();
      idMap.set(toolUseId, persistId);
      pending.delete(toolUseId);
      contentMap.set(persistId, fullText);
      enqueueVisibleDbMessage(`tool_result_eager:${sessionId}:${persistId}`, sessionId, {
        clientId: persistId,
        role: 'tool_result',
        content: fullText,
        toolUseId,
        agentMeta: toolResultMeta(sessionId, agentMeta),
        createdAt,
      });
      notePersistedMessage(sessionId, 'tool_result', persistId);
      return { persistId, content: fullText };
    }
    // tool_use 也没到 → buffer,等 tool_result 摘要 / done 兜底消费;renderer 不显示。
    pending.set(toolUseId, { text: fullText, createdAt });
    return null;
  }

  const prev = contentMap.get(target);
  if (prev === fullText) return null; // 幂等:内容没变,renderer 无需更新。
  contentMap.set(target, fullText);
  enqueueWrite(`tool_result_full:${sessionId}:${target}`, () =>
    updateDbMessageContent(sessionId, target, fullText),
  );
  notePersistedMessage(sessionId, 'tool_result', target);
  return { persistId: target, content: fullText };
}

/**
 * 处理 interaction 请求里需要落库的 chat 消息(ask_user_question / plan_review)。
 * 这两类不走 session.onEvent、而走 setInteractionListener,且今天也是各窗各 create
 * (随机 clientId)→ 同属 F1 重复家族,这里收口 main 单点:生成 persistId、落库 pending
 * 消息,返回 persistId 供 onEvent 盖进 INTERACTION_REQUEST payload,让 renderer 用同一
 * id 建气泡(onCreated dedup;answered 回写也命中这条 persistId 单行)。
 *
 * permission 不建 chat 消息 → 返回 undefined。plan_review 缺 plan → 返回 undefined
 * (对齐 renderer 老 guard)。agentMeta 用会话最近一次非空 meta(对齐老 renderer 的
 * state.lastAgentMeta 兜底)。
 */
export function onInteractionMessage(
  sessionId: string,
  req: { kind?: unknown; requestId?: unknown; questions?: unknown; plan?: unknown; planFilePath?: unknown },
): string | undefined {
  const createdAt = Date.now();
  const requestId = typeof req.requestId === 'string' ? req.requestId : '';
  if (!requestId) return undefined;
  const meta = lastAgentMetaBySession.get(sessionId) ?? null;

  if (req.kind === 'ask_user_question') {
    const persistId = createId();
    enqueueVisibleDbMessage(`ask_user:${sessionId}:${persistId}`, sessionId, {
      clientId: persistId,
      role: 'ask_user',
      content: { requestId, questions: req.questions ?? [], status: 'pending', answers: null },
      agentMeta: meta,
      createdAt,
    });
    notePersistedMessage(sessionId, 'ask_user', persistId);
    return persistId;
  }

  if (req.kind === 'plan_review') {
    if (typeof req.plan !== 'string' || !req.plan) return undefined;
    const planFilePath = typeof req.planFilePath === 'string' ? req.planFilePath : '';
    const persistId = createId();
    enqueueVisibleDbMessage(`plan_review:${sessionId}:${persistId}`, sessionId, {
      clientId: persistId,
      role: 'plan_review',
      content: { requestId, plan: req.plan, planFilePath, status: 'pending', feedback: null },
      agentMeta: meta,
      createdAt,
    });
    notePersistedMessage(sessionId, 'plan_review', persistId);
    return persistId;
  }

  return undefined; // permission 等:不建 chat 消息
}

/**
 * interaction 被解决(answered / approved / revised)时,把 `onInteractionMessage` 落的那条
 * pending 行回写成最终状态 —— **被控端单点权威落库**,对称于 onInteractionMessage。
 *
 * 背景:answered 状态过去纯靠 renderer 调 `local-db:messages:updateContent` 写库,而该 channel
 * 不在 device-link allowlist;远程会话被控端的 row 因此永留 pending,reload 经 mapServerMessages
 * 被映射成 expired → 用户回答/批准记录丢失。这里在 RESOLVE_INTERACTION(任何调用方:本机 renderer /
 * 远程控制端隧道 / 未来手机)成功后由 main 落库,使被控端 DB 成为真相,所有端 reload 拿到正确状态。
 * 复用 onInteractionMessage 同款 enqueueWrite 串行写队列;不广播(对齐 updateMessageContent 语义,
 * 其它端 panel 已由 INTERACTION_DISMISSED 清,reload 时读这条真值)。
 *
 * 仅 ask_user_question / plan_review 落库(permission 无 chat 消息,persistId 为空时直接跳过)。
 */
export function onInteractionResolved(
  sessionId: string,
  persistId: string | undefined,
  kind: 'ask_user_question' | 'plan_review',
  request: { requestId?: unknown; questions?: unknown; plan?: unknown; planFilePath?: unknown },
  decision: Record<string, unknown>,
): void {
  if (!persistId) return;
  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  if (!requestId) return;

  if (kind === 'ask_user_question') {
    const answers = (decision.answers as Record<string, string> | undefined) ?? {};
    enqueueWrite(`ask_user_resolved:${sessionId}:${persistId}`, () =>
      updateDbMessageContent(sessionId, persistId, {
        requestId,
        questions: request.questions ?? [],
        status: 'answered',
        answers,
      }),
    );
    return;
  }

  // plan_review:approve → approved + editedPlan(用户改过的版本);reject → revised + feedback;
  // deny + dismissed 标记 → cancelled(「取消本次审阅」/ 系统兜底 deny,reason 是系统代码
  // 而非用户反馈,不落 feedback,见 maker-core InteractionDecision.dismissed)。
  const behavior = decision.behavior === 'allow' ? 'allow' : 'deny';
  const dismissed = behavior === 'deny' && decision.dismissed === true;
  const status = behavior === 'allow' ? 'approved' : dismissed ? 'cancelled' : 'revised';
  const plan =
    typeof decision.editedPlan === 'string'
      ? decision.editedPlan
      : typeof request.plan === 'string'
        ? request.plan
        : '';
  const planFilePath = typeof request.planFilePath === 'string' ? request.planFilePath : '';
  const feedback =
    behavior === 'deny' && !dismissed ? ((decision.reason as string | undefined) ?? null) : null;
  enqueueWrite(`plan_review_resolved:${sessionId}:${persistId}`, () =>
    updateDbMessageContent(sessionId, persistId, {
      requestId,
      plan,
      planFilePath,
      status,
      feedback,
    }),
  );
}

/**
 * turn 结束(done)时把残留 pendingFullText flush 成 orphan tool_result(典型:返回
 * image content block、SDK 不发摘要的 MCP 工具)。orphan 落库后经 onCreated append 到
 * renderer(turn 末、边缘场景,不需即时)。
 */
export function flushOrphanToolResults(sessionId: string, agentMeta: AgentMeta | null): void {
  const idMap = getOrCreateSessionMap(toolResultIdByToolUseId, sessionId);
  const contentMap = getOrCreateSessionMap(toolResultContentByClientId, sessionId);
  const meta = toolResultMeta(sessionId, agentMeta);
  const persistOrphan = (toolUseId: string, text: string, createdAt: number): void => {
    const persistId = createId();
    idMap.set(toolUseId, persistId);
    contentMap.set(persistId, text);
    enqueueVisibleDbMessage(`tool_result_orphan:${sessionId}:${persistId}`, sessionId, {
      clientId: persistId,
      role: 'tool_result',
      content: text,
      toolUseId,
      agentMeta: meta,
      createdAt: clampAfterToolUse(sessionId, toolUseId, createdAt),
    });
    notePersistedMessage(sessionId, 'tool_result', persistId);
  };

  const pending = pendingFullTextByToolUseId.get(sessionId);
  if (pending && pending.size > 0) {
    for (const [toolUseId, fullText] of pending) {
      persistOrphan(toolUseId, fullText.text, fullText.createdAt);
    }
    pending.clear();
  }

  // 媒体 echo 兜底:本 turn 已落库 tool_use、但 echo(tool_result/full)始终没到
  // 的 lizi_art / lizi_mivo 调用,按 input.args 去 mediaToolResultFallback 池认领
  // 工具在 main 内产出的结果直接落库(stdout echo 被日志污染损坏的场景;见
  // mcp-integrations/mediaToolResultFallback.ts)。echo 正常时 idMap 已有映射,
  // 这里不会触发,不产生重复。
  const known = knownToolUseIdsBySession.get(sessionId);
  const infoMap = toolUseInfoBySession.get(sessionId);
  if (known && infoMap) {
    for (const toolUseId of known) {
      if (idMap.has(toolUseId)) continue;
      const info = infoMap.get(toolUseId);
      if (!info) continue;
      if (!info.toolName.startsWith('mcp__lizi_art__') && !info.toolName.startsWith('mcp__lizi_mivo__')) {
        continue;
      }
      const reclaimed = takeMediaToolResult(info.input);
      if (reclaimed !== null) {
        log.info('media tool_result reclaimed via fallback pool (echo lost)', {
          sessionId,
          toolUseId,
          toolName: info.toolName,
        });
        persistOrphan(toolUseId, reclaimed, Date.now());
      }
    }
  }
}

/**
 * turn 结束(done)时重置 per-turn 状态(对齐老 renderer 在 done case 把两个 Map 置空 +
 * lastAgentMeta 清空)。assistant block 已在 done 边界 flush;此处清 tool_result 相关 Map
 * + knownToolUseIds + lastAgentMeta。必须在 flushOrphanToolResults 之后调用。
 */
export function resetTurnPersistState(sessionId: string): void {
  toolResultIdByToolUseId.delete(sessionId);
  pendingFullTextByToolUseId.delete(sessionId);
  toolResultContentByClientId.delete(sessionId);
  knownToolUseIdsBySession.delete(sessionId);
  toolUseCreatedAtBySession.delete(sessionId);
  toolUseInfoBySession.delete(sessionId);
  updatableToolUsePersistIdBySession.delete(sessionId);
  lastAgentMetaBySession.delete(sessionId);
  _turnStartedAtBySession.delete(sessionId);
  _turnDedupIdBySession.delete(sessionId);
  // turn 边界必须清 lastPersistedMsgBySession:within-turn 的重复 isFinal / result 兜底
  // 补推都在 done 之前已去重(translator fallback isFinal@translator.ts:897 早于 done@922,
  // 补推那条 burst 在本次 reset 之前就 dedup 过了,清掉不漏接)。**跨 turn 绝不复用**:
  // main 的 lastPersistedMsg 不含用户消息(用户消息走 renderer 落库 makerChatStore:2129、
  // 不经 notePersistedMessage),若跨 turn 保留,turn1 burst "X" → 用户发消息(不更新 main
  // tracker)→ turn2 又 burst "X" 会被误判重复、跳 create → turn2 回复丢失。清在这里堵死。
  lastPersistedMsgBySession.delete(sessionId);
}

/**
 * 处理 assistant 'text' 事件,返回该消息的 persistId 供 onEvent 盖进广播 payload。
 *
 *  - delta(isFinal=false):首 delta 分配 persistId、建 block;后续累积全文。**不落库**。
 *  - isFinal 且有在飞 block(流式确认):**不在此落库**,把全文留给边界(done / tool_use /
 *    interaction)flush —— 对齐 renderer 老逻辑的落库时机与 agentMeta 取法(boundary
 *    事件携带这条 assistant 的 uuid;text delta 往往不带 meta,在此落会丢 agent_meta)。
 *  - isFinal 且无在飞 block(非流式 isFinal burst):新 persistId **立即落库**(对齐
 *    renderer 老逻辑在 isFinal burst 处的即时落库),agentMeta 用事件自带的。
 *
 * 返回 undefined 表示这条 text 不对应任何持久化消息(空 isFinal),renderer 走原逻辑。
 */
export function onAssistantTextEvent(
  sessionId: string,
  data: { text?: unknown; isFinal?: unknown },
  agentMeta: AgentMeta | null,
): string | undefined {
  const text = typeof data.text === 'string' ? data.text : '';
  const isFinal = data.isFinal === true;

  if (isFinal) {
    const block = assistantBlocks.get(sessionId);
    if (block) {
      // 流式确认:不落库,留给边界 flush。delta 已累积全文,isFinal.text 是冗余确认;
      // 仅当 isFinal 带了更全的文本时兜底覆盖。meta 若带则更新。
      if (text.length > block.text.length) block.text = text;
      if (agentMeta) block.agentMeta = agentMeta;
      return block.persistId;
    }
    // 非流式 isFinal burst(result 兜底补推也走这):无在飞 block,立即落库。
    if (text) {
      // DUP-SKIP(对齐 renderer 老 757-762):若紧邻的上一条已落库消息正是内容完全
      // 相同的 assistant(典型:重复 isFinal / block flush 后又来同内容补推),复用其
      // persistId、不再 create,把重复行挡在 main 落库层。中间夹过别的消息则 last.role
      // 不是 assistant,不会误删合法的相同文本回复。
      const last = lastPersistedMsgBySession.get(sessionId);
      if (last && last.role === 'assistant' && last.text === text) {
        return last.persistId;
      }
      const persistId = createId();
      enqueuePersistAssistant(sessionId, persistId, text, agentMeta, Date.now());
      return persistId;
    }
    return undefined;
  }

  // delta
  let block = assistantBlocks.get(sessionId);
  if (!block) {
    block = { persistId: createId(), text, agentMeta, createdAt: Date.now() };
    assistantBlocks.set(sessionId, block);
  } else {
    block.text += text;
    if (agentMeta) block.agentMeta = agentMeta;
  }
  return block.persistId;
}

/**
 * block 边界(tool_use / done / error / 任一 interaction 请求)落库在飞的 assistant。
 * 与 text isFinal 互斥幂等:isFinal 已落库则 block 已清,这里 no-op。无累积文本(纯
 * 边界、前面没 assistant 文本)也 no-op。
 *
 * agentMetaFallback:边界事件自带的 agentMeta(如 tool_use 与前面 assistant 同属一条
 * SDK message),仅在 block 自身没攒到 meta 时兜底。
 */
export function flushAssistantBlock(
  sessionId: string,
  agentMetaFallback: AgentMeta | null = null,
): void {
  const block = assistantBlocks.get(sessionId);
  if (!block) return;
  assistantBlocks.delete(sessionId);
  if (!block.text) return;
  // 三级兜底,对齐 renderer 老逻辑:本 block 自带 meta → 边界事件 meta(tool_use/done
  // 同属或携带这条 assistant 的 meta)→ 会话最近一次非空 meta(interaction 边界靠这级)。
  const meta = block.agentMeta ?? agentMetaFallback ?? lastAgentMetaBySession.get(sessionId) ?? null;
  enqueuePersistAssistant(sessionId, block.persistId, block.text, meta, block.createdAt);
}

/**
 * 查询 session 中最新一条消息的 createdAt（任意 role），作为 error 行时间戳 fallback。
 * 写队列 FIFO，此刻本轮所有 tool_use / tool_result / assistant 均已入库，
 * 取最新值可让 error 行排在本轮末尾而非 user 消息之后（user 消息是全轮最早的时间戳）。
 * 确保 /clear 后 messages:list 能正确过滤该行（error 行时间 <= 本轮最新已入库时间 <= clearedAt）。
 */
async function latestMessageCreatedAt(sessionId: string): Promise<number | undefined> {
  try {
    const [row] = await getDbClient()
      .drizzle.select({ createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(1);
    return row?.createdAt ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 多窗 dedup:多个 BrowserWindow 可能为同一次失败各自触发 persistTurnErrorDeferred IPC,
 * onTurnErrorEvent 在每次调用里用 createId() 生成新 clientId,不限制就会落多条相同 error 行。
 *
 * key 策略:
 *   - 优先用 agentMeta.requestId/uuid 唯一标识 turn(不同 turn 即便 message 相同也不会误 dedup)。
 *   - 无 agentMeta 但有 noteTurnStarted 记录时,用本进程单调 turnDedupId + message 前 100 字;
 *     同 turn 多窗/隧道重复会 dedup,快速 retry 进入新 turn 后不会误 dedup。
 *   - 完全没有 turn identity 时才回退 message前100字 + 短窗口(300ms),仅防多窗近乎同时的并发。
 *
 * clearSessionPersistState 时一并清理。
 */
const _recentErrorPersistKeys = new Map<string, number>();
/** message-only fallback 窗口:完全无 turn identity 时仅防多窗近乎同时(<100ms)并发。 */
const DEDUP_WINDOW_MS_MESSAGE = 300;

/**
 * terminal error(turn 失败终态)持久化 —— 让失败在会话历史里留下可追溯的痕迹。
 *
 * 背景:error 此前只存内存(coordinator projection + renderer store.error),
 * 用户没开着会话时发生的失败(scheduler 后台 run 等),事后点进会话 / 重启 app
 * 只剩提示音和红点,消息流里毫无出错迹象(2026-07-03 PR #471 心跳事故实锤)。
 * 这里在 register 的 isTerminalTurnErrorEvent 分支落一条 role='error' 行,
 * mapServerMessages 历史加载时渲染成静态错误卡。
 *
 * **不走 messages:created 广播**:live 会话的错误展示由既有 ErrorBanner
 * (store.error + coordinator projection)负责,若广播,messages:created 会把这行
 * push 进 live 消息流,与 banner 双显示同一段文案。error 行的使命是"事后可追溯"。
 *
 * **发送 local-db:session:error-persisted 脏信号**:对于已加载历史(historyLoaded=true)
 * 但当前不在流式中的后台会话,renderer 收到信号后将 historyLoaded 置 false,
 * 下次用户打开该会话时 ensureInitialMessages 从 DB 重拉,error 行正常浮现。
 *
 * 先 flushAssistantBlock:error 是 turn 终结边界,在飞 assistant 文本必须先落库,
 * 否则 error 行会排在它产出的正文之前(时序错乱),与 tool_use / interaction 边界
 * 的 flush 语义对齐。本函数在 register.ts 里于 flushAssistantBlock + flushOrphanToolResults
 * 之后调用(保证 orphan tool_result 排在 error 行之前);agentMeta 显式透传,
 * 兜底"失败轮只有 error 边界携带 SDK uuid"场景的 rewind/fork 锚点(greptile P1)。
 *
 * content 存结构化 { message, reason?, sdkError? }:reason 是 maker-core 的稳定
 * key('empty-response' / 'turn-failed' 等),renderer 渲染时按它走 i18n(规则 18),
 * message 是给非 renderer 消费方(IM / orca / 旧版本客户端)的兜底文案。
 */
export function onTurnErrorEvent(
  sessionId: string,
  data: { message?: unknown; reason?: unknown; sdkError?: unknown } | null | undefined,
  agentMeta: AgentMeta | null = null,
): string | undefined {
  const message = typeof data?.message === 'string' ? redactSensitiveText(data.message) : '';
  if (!message) return undefined;
  const capturedAt = Date.now();
  const recordedTurnStartedAt =
    _turnStartedAtBySession.get(sessionId) ??
    _savedTurnStartedAtForDeferred.get(sessionId);
  const turnStartedAtSnapshot = recordedTurnStartedAt ?? capturedAt;
  const turnDedupId =
    _turnDedupIdBySession.get(sessionId) ??
    _savedTurnDedupIdForDeferred.get(sessionId) ??
    null;
  // 多窗 dedup:防止多个 BrowserWindow 各自触发 persistTurnErrorDeferred 导致重复 error 行。
  // 优先用 agentMeta.requestId/uuid 作 turn 级 key(唯一,不同 turn 不误 dedup);
  // 无 agentMeta 时优先使用 register 记录的 turnDedupId,最后才回退 message 短窗口。
  const turnId = agentMeta?.requestId ?? agentMeta?.uuid ?? null;
  const messageKey = message.slice(0, 100);
  const dedupKey = `${sessionId}:${turnId ?? (turnDedupId ? `turn:${turnDedupId}:${messageKey}` : `message:${messageKey}`)}`;
  const hasTurnIdentity = turnId !== null || turnDedupId !== null;
  const lastT = _recentErrorPersistKeys.get(dedupKey);
  if (lastT !== undefined && (hasTurnIdentity || capturedAt - lastT < DEDUP_WINDOW_MS_MESSAGE)) {
    return undefined;
  }
  _recentErrorPersistKeys.set(dedupKey, capturedAt);
  // 同步捕获当前时刻作为上界，防止异步写入延迟时 latestMessageCreatedAt
  // 取到 /clear 之后的新消息时间戳，导致 error 行出现在清空后的会话里。
  // 同步捕获 turn 开始时刻，防止 enqueueWrite 异步回调执行时 register.ts 已调
  // resetTurnPersistState 删掉 _turnStartedAtBySession 条目，导致 /clear 竞态 cap 失效。
  // 与 capturedAt / blockCreatedAt 同样在入队前同步取值，让 async 回调拿到的是快照。
  // 主路径：_turnStartedAtBySession 在同步阶段（入队前）取值。
  // deferred 路径：register.ts 在 isRemoteAuthRetry=true 时调用 saveTurnStartedAtForDeferred，
  // 在 resetTurnPersistState 清掉主 Map 之前保留一份；此处优先取保留值，防 /clear 竞态 cap 失效。
  // 在 flush 前取 block.createdAt 作为 turn 开始时间戳。
  // 有 block 时：error 行用 blockCreatedAt + 1 确保时间戳严格晚于 assistant 行。
  //   desktop 按 (createdAt, rowid) 排序，同 createdAt 可靠；但 mobile 排序无
  //   rowid tie-breaker，同 createdAt 时依赖 server 响应原始顺序，不可控，+1ms 消除歧义。
  //   /clear 语义不受影响：blockCreatedAt 在 /clear 之前产生，+1 仍满足 error.createdAt <= clearedAt。
  // 无 block 时：enqueueWrite 内异步查最新消息时间戳（=本轮最后入库时间），
  //   避免 Date.now() 落在 /clear 之后导致 error 行在清空后的历史中浮现。
  const blockCreatedAt = assistantBlocks.get(sessionId)?.createdAt;
  flushAssistantBlock(sessionId, agentMeta);
  const persistId = createId();
  const content: Record<string, unknown> = { message };
  if (typeof data?.reason === 'string' && data.reason) content.reason = data.reason;
  if (typeof data?.sdkError === 'string' && data.sdkError) {
    content.sdkError = redactSensitiveText(data.sdkError);
  }
  const meta = agentMeta ?? lastAgentMetaBySession.get(sessionId) ?? null;
  const dbAgentKindSnapshot = getSessionDbAgentKind(sessionId) ?? undefined;
  enqueueWrite(`turn_error:${sessionId}:${persistId}`, async () => {
    // 两个分支统一 +1：保证 error.createdAt 严格晚于本轮所有已入库行。
    // 注意：register.ts 在 flushAssistantBlock 之后调本函数，blockCreatedAt
    // 在生产路径恒为 undefined（block 已 delete）；latestMessageCreatedAt
    // 返回本轮最后入库行的 createdAt，与 error 行同值会让 mobile 排序不可控
    // （mobile 无 rowid tie-breaker，同 createdAt 依赖 server 响应原始顺序）。
    // 统一 +1 确保 error 行始终排在本轮所有正文/工具行之后。
    // Math.min(..., capturedAt)：把异步查询结果的上界锁定在 onTurnErrorEvent 调用时刻，
    // 防止写队列延迟消费时（用户已 /clear 并发了新消息）取到 post-clear 时间戳，
    // 使 error.createdAt > clearedAt 从而出现在清空后的新会话历史里。
    const rawLatestTs =
      blockCreatedAt != null
        ? blockCreatedAt
        : await latestMessageCreatedAt(sessionId);
    const latestTs = rawLatestTs != null ? Math.min(rawLatestTs, capturedAt) : capturedAt;
    // /clear 边界 cap:防止 pre-clear 旧 turn 的 error 行在清空后的新会话中浮现。
    // 用 turnStartedAtSnapshot（入队前同步捕获，不受 resetTurnPersistState 影响）
    // 判定 "stale pre-clear turn"，而非 rawLatestTs（异步查询，write queue 延迟消费时可能返回
    // post-clear 新消息时间戳，导致误判竞态：旧 turn error 在 /clear 后且用户已发新消息后才入队，
    // rawLatestTs > clearBoundary → 跳过 cap → error.createdAt > clearedAt → 串入新会话）。
    // turnStartedAtSnapshot <= clearBoundary：turn 在 /clear 之前启动 → stale → cap。
    // turnStartedAtSnapshot > clearBoundary：turn 在 /clear 之后启动 → 新 turn → 不 cap。
    // 无 noteTurnStarted：回退到 capturedAt 作保守锚，行为等价于
    //   "error 事件到达时刻" 作 stale 判定（边缘 case，如 status:isRunning=true 未发的 agent）。
    const clearBoundary = clearBoundaryBySession.get(sessionId);
    const turnStartedAt = turnStartedAtSnapshot;
    const createdAt =
      clearBoundary != null && turnStartedAt <= clearBoundary
        ? Math.min(latestTs + 1, clearBoundary)
        : latestTs + 1;
    await createDbMessage(
      sessionId,
      {
        clientId: persistId,
        role: 'error',
        content,
        agentMeta: meta,
        agentKind: dbAgentKindSnapshot,
        createdAt,
      },
      { shouldBroadcast: () => false },
    );
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('local-db:session:error-persisted', { sessionId });
      } catch {
        /* swallow per-window broadcast failures */
      }
    }
    // device-link:把脏信号也转发给远控端,让已加载该会话历史的控制端窗口同样失效。
    tapWindowBroadcast('local-db:session:error-persisted', { sessionId });
  });
  notePersistedMessage(sessionId, 'error', persistId);
  return persistId;
}

/** session 关闭时清掉该会话所有 per-session 持久化状态,避免 Map 泄漏 / 跨会话串状态。 */
export function clearSessionPersistState(sessionId: string): void {
  assistantBlocks.delete(sessionId);
  lastAgentMetaBySession.delete(sessionId);
  knownToolUseIdsBySession.delete(sessionId);
  toolUseCreatedAtBySession.delete(sessionId);
  toolUseInfoBySession.delete(sessionId);
  updatableToolUsePersistIdBySession.delete(sessionId);
  toolResultIdByToolUseId.delete(sessionId);
  pendingFullTextByToolUseId.delete(sessionId);
  toolResultContentByClientId.delete(sessionId);
  lastPersistedMsgBySession.delete(sessionId);
  lastAssistantPersistIdBySession.delete(sessionId);
  lastAssistantTranscriptUuidBySession.delete(sessionId);
  dbAgentKindBySession.delete(sessionId);
  _turnStartedAtBySession.delete(sessionId);
  _turnDedupIdBySession.delete(sessionId);
  _savedTurnStartedAtForDeferred.delete(sessionId);
  _savedTurnDedupIdForDeferred.delete(sessionId);
  // dedup 守卫:清本 session 相关的所有 key(前缀 `${sessionId}:`)
  for (const key of _recentErrorPersistKeys.keys()) {
    if (key.startsWith(`${sessionId}:`)) _recentErrorPersistKeys.delete(key);
  }
}
