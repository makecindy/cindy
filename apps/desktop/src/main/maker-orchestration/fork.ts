/**
 * fork-session：消息级 fork 业务函数。
 *
 * 流程：读 source → 校验 target message (user / assistant) → 计算复制边界与
 *      agent 侧截断信息 → 调 SDK fork → SQLite 事务 insert + bulk copy messages。
 *
 * SDK 调用必须在事务外——SDK 失败时 DB 完全没动；DB 失败时 SDK jsonl 已落盘
 * 变成"孤儿 jsonl"，可接受（数量极少，留给后续清理脚本）。
 */

import { eq, and, lt, gt, asc, desc, isNull, or, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { CodexResumePreparationBlockedError, isCodexHistoryRecoveryRequired } from '@cindy/maker-core';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';

import { getDbClient } from '../localDb/client/current';
import { sessions, messages } from '../localDb/schema';
import { sessionToCamel } from '../localDb/mapper';
import { commitContextRebuild, createMessage } from '../localDb/ipc/messages.js';
import { getMaker } from '../maker-host/index.js';
import { inferProviderIdForModel } from '../maker-host/provider-route.js';
import { createBusinessSessionId } from '../sessionIds.js';
import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../shared/agentKindConversion.js';
import type { AgentMeta, Session } from '../../renderer/lib/ccAgent.types';
import { buildHandoffText, type HandoffSourceMessage } from '../maker-ipc/agentHandoff.js';
import {
  type ClaudeTranscriptAnchorIndex,
  loadClaudeTranscriptAnchorIndex,
  parseClaudeAgentMeta,
  resolveClaudeForkAssistantAnchor,
} from './claudeTranscriptAnchors';

/** fork 内部错误码——由 IPC 层 catch 后映射到对应 IPC 错误码。 */
export type ForkErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_USER_MESSAGE'
  | 'NOT_CODEX_SESSION'
  | 'REMOTE_NOT_SUPPORTED'
  | 'SOURCE_NEVER_RAN'
  | 'NO_PRIOR_ASSISTANT'
  | 'CODEX_FORK_STATE_UNAVAILABLE'
  | 'UNSUPPORTED_HISTORY';

const STRIP_FORK_TITLE_PREFIX = '[Fork·已剥离]';

function forkError(code: ForkErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

function codexForkFailureDetail(err: unknown): string {
  if (err instanceof CodexResumePreparationBlockedError) {
    return CODEX_RESUME_NOT_READY_WIRE_MESSAGE;
  }
  return err instanceof Error ? err.message : String(err);
}

function normalizePositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

const messageRowid = sql<number>`rowid`;

type DbAgentKind = 'cc' | 'codex' | 'pi';

interface MessagePosition {
  createdAt: number;
  rowid: number | null;
}

interface ForkNativeSource {
  agentKind: DbAgentKind;
  sdkSessionId: string | null;
  model: string;
  providerId: string | null;
  /** 目标所在原生 session 离场的位置；copy 不能把这条未来边界带进子会话。 */
  nextSwitch: MessagePosition | null;
  /** false = 原生会话已因同引擎换窗失效，只复制可见历史，首次发送走交接。 */
  reuseVendorSession: boolean;
  rebuildReason?: 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout' | 'native-session-recovery';
}

interface ForkTimelineMessage {
  id: string;
  clientId: string;
  role: string;
  content: string;
  toolUseId: string | null;
  agentMeta: string | null;
  agentKind: string | null;
  createdAt: number;
  rowid: number;
}

interface ParsedAgentSwitchBoundary {
  fromAgentKind: DbAgentKind;
  toAgentKind?: DbAgentKind;
  fromModel: string | null;
  fromProviderId?: string | null;
  toProviderId?: string | null;
  fromSdkSessionId: string | null;
  handoff?: string;
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

async function seedForkHandoffAfterSameEngineRebuild(opts: {
  sessionId: string;
  rows: ForkTimelineMessage[];
  agentKind: DbAgentKind;
  model: string;
  providerId: string | null;
  reason: 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout' | 'native-session-recovery';
}): Promise<void> {
  const handoffMessages: HandoffSourceMessage[] = opts.rows
    .filter(
      (row) =>
        row.role !== 'error' && row.role !== 'context_rebuild' && row.role !== 'agent_switch',
    )
    .map((row) => ({
      role: row.role,
      content: parseJsonContent(row.content),
      createdAt: row.createdAt,
      toolUseId: row.toolUseId,
    }));
  const lastUser = [...opts.rows].reverse().find((row) => row.role === 'user');
  const label =
    opts.agentKind === 'codex' ? 'Codex' : opts.agentKind === 'pi' ? 'Pi' : 'Claude Code';
  const handoff = buildHandoffText(handoffMessages, {
    fromLabel: label,
    toLabel: label,
    sessionId: opts.sessionId,
    reason: opts.reason,
  });
  await commitContextRebuild(opts.sessionId, handoff, {
    reason: opts.reason,
    sourceUserClientId: lastUser?.clientId ?? null,
    sourceAgentKind: opts.agentKind,
    sourceModel: opts.model,
    sourceProviderId: opts.providerId,
  });
  await createMessage(opts.sessionId, {
    clientId: `context-rebuild-card:${createId()}`,
    role: 'assistant',
    content: '',
    agentKind: opts.agentKind === 'cc' ? 'cc' : opts.agentKind,
    agentMeta: {
      contextRebuild: {
        reason: opts.reason,
        handoff,
      },
    } as AgentMeta,
  });
}

interface ParsedContextRebuildBoundary {
  reason: 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout' | 'native-session-recovery';
  sourceAgentKind?: DbAgentKind;
  sourceModel?: string | null;
  sourceProviderId?: string | null;
}

function parseContextRebuildBoundary(content: string): ParsedContextRebuildBoundary | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed.reason !== 'context-overflow' &&
      parsed.reason !== 'model-window-switch' &&
      parsed.reason !== 'pi-prompt-timeout' &&
      parsed.reason !== 'native-session-recovery'
    ) {
      return null;
    }
    return {
      reason: parsed.reason,
      ...(parsed.sourceAgentKind === 'cc' ||
      parsed.sourceAgentKind === 'codex' ||
      parsed.sourceAgentKind === 'pi'
        ? { sourceAgentKind: parsed.sourceAgentKind }
        : {}),
      ...(typeof parsed.sourceModel === 'string' ? { sourceModel: parsed.sourceModel } : {}),
      ...(Object.hasOwn(parsed, 'sourceProviderId')
        ? {
            sourceProviderId:
              typeof parsed.sourceProviderId === 'string' ? parsed.sourceProviderId : null,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseContextRebuildReason(
  content: string,
): 'context-overflow' | 'model-window-switch' | 'pi-prompt-timeout' | 'native-session-recovery' | null {
  return parseContextRebuildBoundary(content)?.reason ?? null;
}

function parseAgentSwitchBoundary(content: string): ParsedAgentSwitchBoundary | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      parsed.fromAgentKind !== 'cc' &&
      parsed.fromAgentKind !== 'codex' &&
      parsed.fromAgentKind !== 'pi'
    )
      return null;
    const toAgentKind =
      parsed.toAgentKind === 'cc' || parsed.toAgentKind === 'codex' || parsed.toAgentKind === 'pi'
        ? parsed.toAgentKind
        : undefined;
    return {
      fromAgentKind: parsed.fromAgentKind,
      toAgentKind,
      fromModel: typeof parsed.fromModel === 'string' ? parsed.fromModel : null,
      ...(Object.hasOwn(parsed, 'fromProviderId')
        ? {
            fromProviderId:
              typeof parsed.fromProviderId === 'string' ? parsed.fromProviderId : null,
          }
        : {}),
      ...(Object.hasOwn(parsed, 'toProviderId')
        ? {
            toProviderId: typeof parsed.toProviderId === 'string' ? parsed.toProviderId : null,
          }
        : {}),
      fromSdkSessionId:
        typeof parsed.fromSdkSessionId === 'string' && parsed.fromSdkSessionId
          ? parsed.fromSdkSessionId
          : null,
      handoff: typeof parsed.handoff === 'string' && parsed.handoff ? parsed.handoff : undefined,
    };
  } catch {
    return null;
  }
}

function parseCodexNativeForkAnchor(raw: string | null): {
  sdkSessionId: string;
  turnId: string;
} | null {
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as Record<string, unknown>;
    if (meta.turnCompleted !== true) return null;
    const anchor = meta.nativeForkAnchor;
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
    const candidate = anchor as Record<string, unknown>;
    if (
      candidate.agentKind !== 'codex' ||
      candidate.kind !== 'turn' ||
      typeof candidate.sdkSessionId !== 'string' ||
      !candidate.sdkSessionId ||
      typeof candidate.id !== 'string' ||
      !candidate.id
    ) {
      return null;
    }
    return { sdkSessionId: candidate.sdkSessionId, turnId: candidate.id };
  } catch {
    return null;
  }
}

function isBefore(left: MessagePosition, right: MessagePosition): boolean {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt;
  if (left.rowid === null) return false;
  if (right.rowid === null) return true;
  return left.rowid < right.rowid;
}

/**
 * 找出目标消息真正所属的 vendor session。
 *
 * - 目标之后第一条 agent_switch = 该片段的离场边界，from* 正好描述目标片段；
 * - 没有后续切换 = 目标位于当前片段，直接使用 sessions 当前绑定；
 * - context_rebuild 或 /clear 已让旧 transcript 失效时 fail closed，避免把已删除
 *   的上下文通过历史 vendor session 带回新分支。
 */
async function resolveForkNativeSource(
  sourceSessionId: string,
  source: {
    agentKind: string;
    sdkSessionId: string | null;
    model: string;
    providerId: string | null;
    clearedAt: number | null;
  },
  target: { createdAt: number; rowid: number },
): Promise<ForkNativeSource> {
  if (source.clearedAt !== null && target.createdAt <= source.clearedAt) {
    throw forkError('UNSUPPORTED_HISTORY', '目标消息位于已清除的上下文中');
  }
  const client = getDbClient();
  const positionParams = [sourceSessionId, target.createdAt, target.createdAt, target.rowid];
  const invalidated = await client.queryOne<{
    id: string;
    content: string;
    created_at: number;
    rowid: number;
  }>(
    `SELECT id, content, created_at, rowid FROM messages
      WHERE session_id = ?
        AND role = 'context_rebuild'
        AND (created_at > ? OR (created_at = ? AND rowid > ?))
      ORDER BY created_at ASC, rowid ASC
      LIMIT 1`,
    positionParams,
  );
  const rebuildBoundary = invalidated ? parseContextRebuildBoundary(invalidated.content) : null;
  const rebuildReason = rebuildBoundary?.reason ?? null;
  if (invalidated && !rebuildBoundary) {
    throw forkError('UNSUPPORTED_HISTORY', '目标消息对应的历史引擎会话已因上下文重建失效');
  }
  const nextSwitch = await client.queryOne<{
    content: string;
    created_at: number;
    rowid: number;
  }>(
    `SELECT content, created_at, rowid FROM messages
      WHERE session_id = ?
        AND role = 'agent_switch'
        AND rewind_at IS NULL
        AND (created_at > ? OR (created_at = ? AND rowid > ?))
      ORDER BY created_at ASC, rowid ASC
      LIMIT 1`,
    positionParams,
  );
  if (
    nextSwitch &&
    (!invalidated ||
      isBefore(
        { createdAt: nextSwitch.created_at, rowid: nextSwitch.rowid },
        { createdAt: invalidated.created_at, rowid: invalidated.rowid },
      ))
  ) {
    const parsed = parseAgentSwitchBoundary(nextSwitch.content);
    if (!parsed?.fromSdkSessionId) {
      throw forkError('UNSUPPORTED_HISTORY', '目标消息对应的历史引擎会话不可用');
    }
    const model = parsed.fromModel ?? source.model;
    let providerId: string | null;
    if (Object.hasOwn(parsed, 'fromProviderId')) {
      providerId = parsed.fromProviderId ?? null;
    } else {
      const previousSwitch = await client.queryOne<{ content: string }>(
        `SELECT content FROM messages
          WHERE session_id = ?
            AND role = 'agent_switch'
            AND rewind_at IS NULL
            AND (created_at < ? OR (created_at = ? AND rowid < ?))
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
        positionParams,
      );
      const previousBoundary = previousSwitch
        ? parseAgentSwitchBoundary(previousSwitch.content)
        : null;
      if (
        previousBoundary?.toAgentKind === parsed.fromAgentKind &&
        Object.hasOwn(previousBoundary, 'toProviderId')
      ) {
        providerId = previousBoundary.toProviderId ?? null;
      } else if (parsed.fromAgentKind === normalizeDbAgentKind(source.agentKind)) {
        providerId = source.providerId;
      } else if (parsed.fromAgentKind === 'codex') {
        providerId = inferProviderIdForModel(model, 'codex');
      } else {
        providerId = null;
      }
    }
    return {
      agentKind: parsed.fromAgentKind,
      sdkSessionId: parsed.fromSdkSessionId,
      model,
      providerId,
      nextSwitch: { createdAt: nextSwitch.created_at, rowid: nextSwitch.rowid },
      reuseVendorSession: true,
    };
  }
  if (rebuildReason) {
    if (rebuildBoundary?.sourceAgentKind) {
      return {
        agentKind: rebuildBoundary.sourceAgentKind,
        sdkSessionId: null,
        model: rebuildBoundary.sourceModel ?? source.model,
        providerId: Object.hasOwn(rebuildBoundary, 'sourceProviderId')
          ? (rebuildBoundary.sourceProviderId ?? null)
          : source.providerId,
        nextSwitch: null,
        reuseVendorSession: false,
        rebuildReason,
      };
    }
    // Legacy rebuild markers predate the source engine metadata. They are safe
    // only while the session stayed on the same engine after rebuilding; if a
    // later switch exists, fail closed instead of forking with the current engine.
    if (nextSwitch) {
      throw forkError('UNSUPPORTED_HISTORY', '无法确认目标消息对应的历史引擎');
    }
    return {
      agentKind: normalizeDbAgentKind(source.agentKind),
      sdkSessionId: null,
      model: source.model,
      providerId: source.providerId,
      nextSwitch: null,
      reuseVendorSession: false,
      rebuildReason,
    };
  }
  if (!source.sdkSessionId) {
    throw forkError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
  }
  return {
    agentKind: normalizeDbAgentKind(source.agentKind),
    sdkSessionId: source.sdkSessionId,
    model: source.model,
    providerId: source.providerId,
    nextSwitch: null,
    reuseVendorSession: true,
  };
}

function beforePosition(position: MessagePosition) {
  return position.rowid === null
    ? lt(messages.createdAt, position.createdAt)
    : or(
        lt(messages.createdAt, position.createdAt),
        and(eq(messages.createdAt, position.createdAt), lt(messageRowid, position.rowid)),
      );
}

function findFirstUserAfterSwitchBoundary(
  rows: ForkTimelineMessage[],
  targetRole: string,
  targetAgentKind: DbAgentKind,
): string | null {
  if (targetRole !== 'user') return null;
  let boundaryIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].role === 'agent_switch') {
      boundaryIndex = i;
      break;
    }
  }
  if (boundaryIndex < 0 || rows.slice(boundaryIndex + 1).some((row) => row.role === 'user')) {
    return null;
  }
  const boundary = parseAgentSwitchBoundary(rows[boundaryIndex].content);
  return boundary?.toAgentKind === targetAgentKind && boundary.handoff
    ? rows[boundaryIndex].clientId
    : null;
}

function resolveClaudeAssistantAnchor(
  rows: ForkTimelineMessage[],
  sourceSdkSessionId: string,
  index: ClaudeTranscriptAnchorIndex | null,
): string | undefined {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role === 'context_rebuild') {
      timelineSdkSessionId = null;
      continue;
    }
    if (row.role === 'agent_switch') {
      timelineSdkSessionId = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId ?? null;
      continue;
    }
    if (row.role !== 'assistant' || timelineSdkSessionId !== sourceSdkSessionId) continue;
    const resolved = resolveClaudeForkAssistantAnchor(parseClaudeAgentMeta(row.agentMeta), index);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveCodexTurnAnchor(
  rows: ForkTimelineMessage[],
  sourceSdkSessionId: string,
): string | undefined {
  let timelineSdkSessionId: string | null = sourceSdkSessionId;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.role === 'context_rebuild') {
      timelineSdkSessionId = null;
      continue;
    }
    if (row.role === 'agent_switch') {
      timelineSdkSessionId = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId ?? null;
      continue;
    }
    if (row.role === 'user' && timelineSdkSessionId === sourceSdkSessionId) {
      return undefined;
    }
    if (row.role !== 'assistant' || timelineSdkSessionId !== sourceSdkSessionId) continue;
    const anchor = parseCodexNativeForkAnchor(row.agentMeta);
    // The newest assistant in this native segment is the requested boundary.
    // If that row predates anchors, belongs to a failed turn, or is malformed,
    // fall back for the whole fork instead of silently truncating at an older turn.
    return anchor?.sdkSessionId === sourceSdkSessionId ? anchor.turnId : undefined;
  }
  return undefined;
}

async function countCodexTailTurns(
  sourceSessionId: string,
  sourceCurrentSdkSessionId: string | null,
  forkSourceSdkSessionId: string,
  sourceClearedAt: number | null,
  boundary: MessagePosition,
): Promise<number> {
  const rowPredicate =
    boundary.rowid === null
      ? 'created_at >= ?'
      : '(created_at > ? OR (created_at = ? AND rowid >= ?))';
  const rowParams =
    boundary.rowid === null
      ? [boundary.createdAt]
      : [boundary.createdAt, boundary.createdAt, boundary.rowid];
  const rows = await getDbClient().query<{
    role: string;
    content: string;
  }>(
    `SELECT role, content FROM messages
      WHERE session_id = ?
        AND (? IS NULL OR created_at > ?)
        AND ${rowPredicate}
        AND (role = 'user' OR role = 'agent_switch' OR role = 'context_rebuild')
        AND (role = 'context_rebuild' OR rewind_at IS NULL)
      ORDER BY created_at DESC, rowid DESC`,
    [sourceSessionId, sourceClearedAt, sourceClearedAt, ...rowParams],
  );
  let timelineSdkSessionId = sourceCurrentSdkSessionId;
  let count = 0;
  for (const row of rows) {
    if (row.role === 'context_rebuild') {
      timelineSdkSessionId = null;
    } else if (row.role === 'agent_switch') {
      timelineSdkSessionId = parseAgentSwitchBoundary(row.content)?.fromSdkSessionId ?? null;
    } else if (timelineSdkSessionId === forkSourceSdkSessionId) {
      count += 1;
    }
  }
  return count;
}

/** SDK 副作用前拒绝复制任何跨过 agent_switch 的混合引擎历史。 */
async function assertForkRangeDoesNotCrossAgentSwitch(
  sourceSessionId: string,
  clearedAt: number | null,
  boundaryCreatedAt: number,
): Promise<void> {
  const boundary = await getDbClient().queryOne<{ id: string }>(
    `SELECT id FROM messages
      WHERE session_id = ?
        AND role = 'agent_switch'
        AND rewind_at IS NULL
        AND created_at < ?
        AND (? IS NULL OR created_at > ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
    [sourceSessionId, boundaryCreatedAt, clearedAt, clearedAt],
  );
  if (boundary) {
    throw forkError(
      'UNSUPPORTED_HISTORY',
      '目标消息之前包含引擎切换边界,无法把混合引擎历史复制到单一原生会话',
    );
  }
}

function augmentClaudeForkUuidMapForSyntheticRows(
  rows: Array<{ agentMeta: string | null }>,
  uuidMap: Map<string, string>,
  anchorIndex: ClaudeTranscriptAnchorIndex | null,
): Map<string, string> {
  if (!anchorIndex || uuidMap.size === 0) return uuidMap;
  const augmented = new Map(uuidMap);
  for (const row of rows) {
    const meta = parseClaudeAgentMeta(row.agentMeta);
    if (!meta.uuid || augmented.has(meta.uuid)) continue;
    const realSourceUuid = resolveClaudeForkAssistantAnchor(meta, anchorIndex);
    if (!realSourceUuid || realSourceUuid === meta.uuid) continue;
    const newUuid = augmented.get(realSourceUuid);
    if (newUuid) augmented.set(meta.uuid, newUuid);
  }
  return augmented;
}

/**
 * Identify legacy Claude rows whose `parentUuid` actually stores transcript
 * parentage. The source transcript lets us distinguish those rows from real
 * tool-owned assistant output before the fork transaction copies metadata.
 */
function collectLegacyClaudeTranscriptParentUuids(
  rows: Array<{ agentMeta: string | null }>,
  index: ClaudeTranscriptAnchorIndex | null,
): string[] {
  if (!index) return [];
  const uuids = new Set<string>();
  for (const row of rows) {
    const meta = parseClaudeAgentMeta(row.agentMeta);
    if (!meta.uuid || !meta.parentUuid || meta.transcriptParentUuid) continue;
    // Imported Claude rows may use a synthetic per-content-block UUID. The
    // assistant request id is the stable bridge back to the real transcript
    // entry in that case; keep the database UUID as the migration key below.
    const entry =
      index.byUuid.get(meta.uuid) ??
      (meta.requestId ? index.assistantByRequestId.get(meta.requestId) : undefined);
    if (!entry) continue;
    // Top-level assistants and every non-assistant transcript record use
    // parentUuid as the legacy transcript edge. A legacy subagent assistant
    // can also have both edges in JSONL; when its stored parentUuid matches
    // the transcript edge, it is safe to recover that edge before copying.
    // sourceToolAssistantUUID is represented as both parent edges for legacy
    // assistant rows. It is a tool parent, not a transcript parent, so leave
    // it for the tool-parent remap instead of migrating it away.
    if (entry.type === 'assistant' && entry.toolParentUuid === meta.parentUuid) continue;
    if (
      entry.type !== 'assistant' ||
      index.assistantByUuid.has(entry.uuid) ||
      meta.parentUuid === entry.parentUuid
    ) {
      uuids.add(meta.uuid);
    }
  }
  return [...uuids];
}

function collectClaudeToolParentUuids(
  rows: Array<{ agentMeta: string | null }>,
  index: ClaudeTranscriptAnchorIndex | null,
): string[] {
  if (!index) return [];
  const uuids = new Set<string>();
  for (const row of rows) {
    const meta = parseClaudeAgentMeta(row.agentMeta);
    if (!meta.parentUuid) continue;
    const entry =
      (meta.uuid ? index.byUuid.get(meta.uuid) : undefined) ??
      (meta.requestId ? index.assistantByRequestId.get(meta.requestId) : undefined);
    if (entry?.toolParentUuid === meta.parentUuid) uuids.add(meta.parentUuid);
  }
  return [...uuids];
}

/**
 * 把 source 会话在 messageClientId 处 fork 成新会话。fork 点支持两种 role：
 *
 *   - user 消息：复制该提问 **之前** 的所有内容（不含提问本身）——经典
 *     "改写这条提问" 流，renderer 会把提问文本预填进新会话 composer。
 *   - assistant 消息：复制到该回复 **所在 turn 的末尾**（含该回复）——
 *     "从这条 AI 回复分叉" 流。取 turn 粒度而非精确到该消息，是因为
 *     Claude 锚点 / Codex rollback 都是 turn 级能力，截到 turn 中间会留下
 *     dangling tool_use（API 要求 tool_use 必跟 tool_result）。
 *
 * `messageClientId` 即 messages 表的 **clientId**（renderer 这一侧的 ChatMessage
 * 只暴露 clientId，不暴露 DB 主键 id；`(sessionId, clientId)` 已是 unique 索引，
 * 用它定位行同样安全且不向 renderer 泄露主键。）
 *
 * - 用复制边界之前最近一条 assistant 的 `agentMeta.uuid` 作为 SDK
 *   `upToMessageId`（SDK 仅接受 SDK 自己分配的 uuid）。
 * - 新会话：reset cost/token/cleared/pinned；user_send_at = now（让 sidebar 立刻置顶）。
 * - 复制 messages：保留 createdAt 原值，重新生成 id + clientId 避免 unique 冲突。
 */
export async function forkSessionAtMessage(
  sourceSessionId: string,
  messageClientId: string,
): Promise<Session> {
  const db = getDbClient().drizzle;

  // 1. 读 source session
  const [source] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sourceSessionId))
    .limit(1);
  if (!source) {
    throw forkError('SOURCE_NOT_FOUND', `Source session ${sourceSessionId} 不存在`);
  }

  // 轮 26 发现 5 防御深度:远端会话 fork 由 SDK 层拒绝(pi forkSdkSession 抛
  // NotSupportedError remoteFork;cc/codex 由 daemon 远端执行)。host 层显式
  // 守卫兜底 —— 若未来某 agent 的 SDK 守卫漏掉,这里阻止 DB 写入产生
  // 「remoteHostId 丢失的本地化僵尸会话」(轮 26 HIGH-1 同源)。
  if (source.remoteHostId) {
    throw forkError('REMOTE_NOT_SUPPORTED', '远端会话暂不支持在本地 fork');
  }

  // 2. 读 target message + rowid —— 同毫秒边界必须按真实插入顺序判断。
  const [target] = await db
    .select({
      id: messages.id,
      clientId: messages.clientId,
      role: messages.role,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(and(eq(messages.sessionId, sourceSessionId), eq(messages.clientId, messageClientId)))
    .limit(1);
  if (!target) {
    throw forkError('MESSAGE_NOT_FOUND', `Message ${messageClientId} 不存在于 ${sourceSessionId}`);
  }
  if (target.role !== 'user' && target.role !== 'assistant') {
    throw forkError('NOT_USER_MESSAGE', 'fork 只能在 user 或 assistant 消息上发起');
  }

  const forkSource = await resolveForkNativeSource(sourceSessionId, source, target);

  // 2.5 复制边界(exclusive)：user 不含自身；assistant 带完整 turn，到下一条 user
  // 为止。若目标片段先离场，则在 agent_switch 之前截断，不能把未来切换带进子分支。
  let copyBoundary: MessagePosition;
  if (target.role === 'user') {
    copyBoundary = { createdAt: target.createdAt, rowid: target.rowid };
  } else {
    const [nextUser] = await db
      .select({ createdAt: messages.createdAt, rowid: messageRowid })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          eq(messages.role, 'user'),
          or(
            gt(messages.createdAt, target.createdAt),
            and(eq(messages.createdAt, target.createdAt), gt(messageRowid, target.rowid)),
          ),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messageRowid))
      .limit(1);
    copyBoundary = nextUser
      ? { createdAt: nextUser.createdAt, rowid: nextUser.rowid }
      : { createdAt: Number.MAX_SAFE_INTEGER, rowid: null };
  }
  if (forkSource.nextSwitch && isBefore(forkSource.nextSwitch, copyBoundary)) {
    copyBoundary = forkSource.nextSwitch;
  }

  // SQLite 可见历史与 vendor transcript 分层：UI 仍复制完整可见前缀；agent 侧只
  // fork 目标所属的原生 session。/clear 前缀不属于当前上下文，不能在子会话复活。
  const sourceMessages = await db
    .select({
      id: messages.id,
      clientId: messages.clientId,
      role: messages.role,
      content: messages.content,
      toolUseId: messages.toolUseId,
      agentMeta: messages.agentMeta,
      agentKind: messages.agentKind,
      createdAt: messages.createdAt,
      rowid: messageRowid,
    })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sourceSessionId),
        source.clearedAt === null ? undefined : gt(messages.createdAt, source.clearedAt),
        beforePosition(copyBoundary),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));

  // 3. 计算 agent 侧截断信息。
  //
  // Claude: 反向找最近一条 assistant 且 agentMeta.uuid 存在 + **不是 subagent**
  // （parentUuid 不为空的是 subagent 的 assistant，不能当 fork 锚点；
  // CD 的 rewindSession 同样过滤 `!I.parent_tool_use_id`）
  // **跳过 rewind_at 已置位的行**：那些是上一次 rewind 软删的消息，再用它们当
  // 锚点会让 SDK upToMessageId 指向一条逻辑上已不存在的 assistant，jsonl 里找不到。
  //
  // Codex: 从当前时间线倒扫 agent_switch，把 copy boundary 之后、确实写入所选
  // 原生 thread 的 user turn 计为 rollback 数；其它引擎片段不能混算。
  const isCodex = forkSource.agentKind === 'codex';
  // pi 复用 codex 的粗粒度 tail-turn fork:countCodexTailTurns 只按 sdkSessionId
  // 数边界后的 user turn(引擎无关),pi 的 forkSdkSession 按 tailTurnsToDrop rewind
  // 到目标 user 消息。只有 Claude(cc)走 message-uuid 锚点路径。
  const usesTailTurnFork = isCodex || forkSource.agentKind === 'pi';
  let assistantUuid: string | undefined;
  let lastTurnId: string | undefined;
  let tailTurnsToDrop: number | undefined;
  let claudeAnchorIndex: ClaudeTranscriptAnchorIndex | null = null;
  const resetHandoffBoundaryClientId = findFirstUserAfterSwitchBoundary(
    sourceMessages,
    target.role,
    forkSource.agentKind,
  );
  if (!usesTailTurnFork && forkSource.sdkSessionId) {
    claudeAnchorIndex = await loadClaudeTranscriptAnchorIndex({
      sdkSessionId: forkSource.sdkSessionId,
      workingDir: source.workingDir,
    }).catch(() => null);
    assistantUuid = resolveClaudeAssistantAnchor(
      sourceMessages,
      forkSource.sdkSessionId,
      claudeAnchorIndex,
    );
    // 切换后的首条 user 自身不进子分支。fresh Claude session 在它之前没有可 fork
    // 的 assistant 锚点，此时创建未绑定的新会话，并把复制边界恢复为 pending handoff。
    if (!assistantUuid && !resetHandoffBoundaryClientId) {
      throw forkError('NO_PRIOR_ASSISTANT', '请在 AI 回复之后的提问上 fork');
    }
  } else if (forkSource.reuseVendorSession && forkSource.sdkSessionId) {
    if (isCodex) {
      lastTurnId = resolveCodexTurnAnchor(sourceMessages, forkSource.sdkSessionId);
    }
    tailTurnsToDrop = await countCodexTailTurns(
      sourceSessionId,
      source.sdkSessionId,
      forkSource.sdkSessionId,
      source.clearedAt,
      copyBoundary,
    );
  }

  // 4. 调 SDK forkSession (事务外)。fresh Claude 首条 user 特例没有合法的 prior
  // assistant 锚点：保留 pending handoff、让新会话首次发送时 lazy-create 即可。
  const newTitle = source.title.startsWith('[Fork') ? source.title : `[Fork] ${source.title}`;
  let newSdkSessionId: string | null = null;
  let uuidMap = new Map<string, string>();
  let initialContextTokens: number | undefined;
  let usedNativeForkAnchor = false;
  if (
    forkSource.reuseVendorSession &&
    forkSource.sdkSessionId &&
    (usesTailTurnFork || assistantUuid)
  ) {
    const agentKind = dbToMakerAgentKind(forkSource.agentKind);
    const forkResult = await getMaker()
      .forkSdkSession(agentKind, {
        sourceSdkSessionId: forkSource.sdkSessionId,
        ...(isCodex ? { model: forkSource.model, providerId: forkSource.providerId } : {}),
        upToMessageId: assistantUuid,
        ...(lastTurnId ? { lastTurnId } : {}),
        ...(tailTurnsToDrop !== undefined ? { tailTurnsToDrop } : {}),
        title: newTitle,
        workingDir: source.workingDir ?? undefined,
        // Pi 的 fork 守卫判定源 session 是否远端(用 DB 的 remoteHostId, 不用
        // agent 实例字段 —— R4 竞态 #1)。
        remoteHostId: source.remoteHostId ?? null,
      })
      .catch((err: unknown) => {
        // 这里刻意用 isCodex(非 usesTailTurnFork):CODEX_FORK_STATE_UNAVAILABLE 是 codex 专属
        // 错误码 + 文案,只有真 codex 失败才包装。pi 与 cc 一样裸抛原始错误(不会拿到指名道姓
        // 错对象的 "Codex 状态不可用" 提示)。改成 usesTailTurnFork 会让 pi 误报成 codex 错误。
        if (!isCodex) throw err;
        const detail = codexForkFailureDetail(err);
        throw forkError('CODEX_FORK_STATE_UNAVAILABLE', detail);
      });
    ({ newSdkSessionId, uuidMap, initialContextTokens, usedNativeForkAnchor = false } = forkResult);
  }
  const forkContextTokens = normalizePositiveInt(initialContextTokens);
  const forkContextWindow = normalizePositiveInt(source.contextWindow);

  // 5. SQLite 事务：insert 新 session + bulk copy messages
  const now = Date.now();
  const newSessionId = createBusinessSessionId();

  const newMessageIds = sourceMessages.map(() => ({ id: createId(), clientId: createId() }));
  // pi 与 codex 一样:uuidMap 空、无 Claude transcript 锚点,跳过 Claude 专用的
  // synthetic uuid 补全 / parentUuid 采集(只有 Claude cc 需要)。
  const txUuidMap = usesTailTurnFork
    ? uuidMap
    : augmentClaudeForkUuidMapForSyntheticRows(sourceMessages, uuidMap, claudeAnchorIndex);
  const legacyTranscriptParentUuids = usesTailTurnFork
    ? []
    : collectLegacyClaudeTranscriptParentUuids(sourceMessages, claudeAnchorIndex);
  const toolParentUuids = usesTailTurnFork
    ? []
    : collectClaudeToolParentUuids(sourceMessages, claudeAnchorIndex);
  try {
    await getDbClient().tx('fork.session', {
      sourceSessionId,
      sourceClearedAt: source.clearedAt,
      targetCreatedAt: copyBoundary.createdAt,
      targetRowid: copyBoundary.rowid,
      newSession: {
        id: newSessionId,
        title: newTitle,
        workingDir: source.workingDir,
        model: forkSource.model,
        // 同一 agent 的 fork 继承 providerId，避免凭证形态漂移；历史跨 agent 片段
        // 没有可靠的 provider 快照，使用 null 跟随目标 agent 的默认 provider。
        providerId: forkSource.providerId,
        effort: source.effort,
        permissionMode: source.permissionMode,
        status: 'active',
        sdkSessionId: newSdkSessionId,
        totalTokenUsage: 0,
        totalCostUsd: 0,
        contextTokens: forkContextTokens,
        contextWindow: forkContextWindow,
        fastMode: forkSource.agentKind === source.agentKind ? source.fastMode : false,
        clearedAt: null,
        pinnedAt: null,
        userSendAt: now,
        agentKind: forkSource.agentKind,
        workspaceKind: source.workspaceKind,
        // 轮 26 HIGH-1:远端会话 fork 必须继承 remoteHostId —— 缺失会落成
        // NULL, 子会话被下游当成本地会话处理(本地 transport/MCP 全错)。
        remoteHostId: source.remoteHostId ?? null,
        codexHistoryHasProductPrompt: source.codexHistoryHasProductPrompt,
        parentSessionId: source.id,
        forkedAtMessageId: messageClientId,
        createdAt: now,
        updatedAt: now,
      },
      uuidMap: Array.from(txUuidMap.entries()),
      ...(usedNativeForkAnchor && forkSource.sdkSessionId && newSdkSessionId
        ? { nativeForkAnchorSessionMap: [[forkSource.sdkSessionId, newSdkSessionId]] }
        : {}),
      ...(legacyTranscriptParentUuids.length > 0 ? { legacyTranscriptParentUuids } : {}),
      ...(toolParentUuids.length > 0 ? { toolParentUuids } : {}),
      detachAgentSwitchSessions: true,
      resetHandoffBoundaryClientId,
      newMessageIds,
    });
  } catch (err) {
    // 轮 40-w4-t13 HIGH:SDK 侧已创建新 session file(forkSdkSession), DB 事务
    // 失败时该文件成孤儿 —— 调用方收到失败, 但孤儿累积不可达。至少记录
    // 可恢复线索(sdkSessionId), 供诊断/清理; 错误照常上抛。
    if (newSdkSessionId) {
      console.error(
        `[fork] SDK session ${newSdkSessionId} created but DB transaction failed — orphan session file left behind`,
        { sourceSessionId, error: err instanceof Error ? err.message : String(err) },
      );
    }
    throw err;
  }

  // 6. 返回 mapper 转过的新 session（含 messageCount）
  const [row] = await db.select().from(sessions).where(eq(sessions.id, newSessionId));
  if (!row) {
    throw new Error('Fork session 创建后查询失败');
  }
  if (!forkSource.reuseVendorSession && forkSource.rebuildReason) {
    await seedForkHandoffAfterSameEngineRebuild({
      sessionId: newSessionId,
      rows: sourceMessages,
      agentKind: forkSource.agentKind,
      model: forkSource.model,
      providerId: forkSource.providerId,
      reason: forkSource.rebuildReason,
    });
  }
  return sessionToCamel({ ...row, messageCount: sourceMessages.length });
}

export async function forkSessionStripEncrypted(sourceSessionId: string): Promise<Session> {
  const db = getDbClient().drizzle;

  const [source] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sourceSessionId))
    .limit(1);
  if (!source) {
    throw forkError('SOURCE_NOT_FOUND', `Source session ${sourceSessionId} 不存在`);
  }
  // 先校验"类型"再校验"运行状态":non-codex 会话(可能 sdkSessionId 也为空)应拿到
  // 更准确的 NOT_CODEX_SESSION 而不是 SOURCE_NEVER_RAN。
  if (source.agentKind !== 'codex') {
    throw forkError('NOT_CODEX_SESSION', '仅 Codex 会话支持剥离协议加密内容');
  }
  // 远端 Codex 会话的 rollout 在远端机器上,本地 forkSdkSession 走本地 host 找不到,
  // 会失败或建出指向远端 workdir 的本地会话。本期不支持 → 显式拒绝(UI 也已隐藏入口)。
  if (source.remoteHostId) {
    throw forkError(
      'REMOTE_NOT_SUPPORTED',
      '远端 Codex 会话暂不支持剥离 fork(rollout 在远端,本地无法剥离)',
    );
  }
  if (!source.sdkSessionId) {
    throw forkError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
  }

  const childRows = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.parentSessionId, sourceSessionId), isNull(sessions.forkedAtMessageId)),
    );
  const reused = childRows.reduce<(typeof childRows)[number] | null>((latest, row) => {
    if (row.status === 'deleted' || !String(row.title).startsWith(STRIP_FORK_TITLE_PREFIX)) {
      return latest;
    }
    if (!latest || Number(row.createdAt ?? 0) > Number(latest.createdAt ?? 0)) return row;
    return latest;
  }, null);

  const sourceMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sourceSessionId),
        source.clearedAt === null ? undefined : gt(messages.createdAt, source.clearedAt),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messageRowid));
  const maxCreatedAt = sourceMessages.reduce(
    (max, message) => Math.max(max, Number(message.createdAt ?? 0)),
    0,
  );
  if (reused) {
    const [latestCopied] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, reused.id),
          isNull(messages.rewindAt),
          lt(messages.createdAt, Number(reused.createdAt ?? 0)),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messageRowid))
      .limit(1);
    if (Number(latestCopied?.createdAt ?? 0) >= maxCreatedAt) {
      return sessionToCamel({ ...reused, messageCount: 0 });
    }
  }
  const copyBeforeCreatedAt = maxCreatedAt + 1;

  await assertForkRangeDoesNotCrossAgentSwitch(
    sourceSessionId,
    source.clearedAt,
    copyBeforeCreatedAt,
  );

  const newTitle = source.title.startsWith(STRIP_FORK_TITLE_PREFIX)
    ? source.title
    : `${STRIP_FORK_TITLE_PREFIX} ${source.title}`;
  const { newSdkSessionId, uuidMap } = await getMaker()
    .forkSdkSession('codex', {
      sourceSdkSessionId: source.sdkSessionId,
      model: source.model,
      providerId: source.providerId,
      upToMessageId: undefined,
      title: newTitle,
      workingDir: source.workingDir ?? undefined,
      stripEncryptedReasoning: true,
      // 轮 26:与 forkSessionAtMessage 对齐 —— 源必为本地(上方已拒远端), 显式
      // 传 null 保持 forkSdkSession 参数形态一致。
      remoteHostId: source.remoteHostId ?? null,
    })
    .catch((err: unknown) => {
      if (isCodexHistoryRecoveryRequired(err) && (sourceMessages.length > 0 || source.contextTokens === 0)) {
        return { newSdkSessionId: null, uuidMap: new Map<string, string>() };
      }
      const detail = codexForkFailureDetail(err);
      throw forkError('CODEX_FORK_STATE_UNAVAILABLE', detail);
    });

  const now = Date.now();
  const newSessionId = createBusinessSessionId();
  const newMessageIds = sourceMessages.map(() => ({ id: createId(), clientId: createId() }));
  const recoveryMarker = newSdkSessionId === null ? {
    id: createId(),
    clientId: createId(),
    createdAt: now,
    content: JSON.stringify({
      reason: 'native-session-recovery',
      consumed: false,
      sourceAgentKind: 'codex',
      sourceModel: source.model,
      sourceProviderId: source.providerId,
      sourceSdkSessionId: source.sdkSessionId,
      sourceUserClientId: newMessageIds[sourceMessages.findLastIndex((row) => row.role === 'user')]?.clientId ?? null,
      handoff: buildHandoffText(sourceMessages.filter((row) => row.role !== 'error').map((row) => ({
        role: row.role,
        content: parseJsonContent(row.content),
        createdAt: row.createdAt,
        toolUseId: row.toolUseId,
      })), {
        fromLabel: 'Codex',
        toLabel: 'Codex',
        sessionId: newSessionId,
        reason: 'native-session-recovery',
      }),
    }),
  } : undefined;
  await getDbClient().tx('fork.session', {
    sourceSessionId,
    sourceClearedAt: source.clearedAt,
    targetCreatedAt: copyBeforeCreatedAt,
    targetRowid: null,
    newSession: {
      id: newSessionId,
      title: newTitle,
      workingDir: source.workingDir,
      model: source.model,
      // 同 forkSessionAtMessage:providerId 必须继承,防止凭证形态漂移。
      providerId: source.providerId,
      effort: source.effort,
      permissionMode: source.permissionMode,
      status: 'active',
      sdkSessionId: newSdkSessionId,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: source.fastMode,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: now,
      agentKind: source.agentKind,
      workspaceKind: source.workspaceKind,
      codexHistoryHasProductPrompt: source.codexHistoryHasProductPrompt,
      parentSessionId: source.id,
      forkedAtMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
    uuidMap: Array.from(uuidMap.entries()),
    newMessageIds,
    recoveryMarker,
  });

  const [row] = await db.select().from(sessions).where(eq(sessions.id, newSessionId));
  if (!row) {
    throw new Error('Fork session 创建后查询失败');
  }
  return sessionToCamel({ ...row, messageCount: sourceMessages.length + (recoveryMarker ? 1 : 0) });
}
