/**
 * 每伙伴「交付物仓库」的只读投影。
 * ---------------------------------------------------------------------------
 * 纯派生,不新增 schema、不新增写入路径。三条来源(见 shared/botArtifact.ts):
 *
 *   1. `bot_delegations.output_artifacts_json`,按 **targetBotId** 归属 —— 产物是
 *      被委派方做出来的,不是发起方。
 *   2. 伙伴名下 Session(canonical / route / history)里的 `tool_use` 新建文件。
 *      **与对话里的交付物卡同源**,三条判据一条不少(否则会出现「对话里有卡、
 *      仓库里没有」这种自相矛盾):
 *        a. 文件工具的新建(Write / write / codex file_change add);
 *        b. 命令文本里带明确写出语义的位置(shared/commandOutputPaths,与 renderer
 *           共用同一份实现);
 *        c. checkpoint(turn change set)记录的**新建**文件 —— 脚本产物常常既没有
 *           文件工具记录、命令文本也认不出,这是它唯一的结构化证据。
 *   3. 同批 Session 消息里的文件附件(`content.files[]`)。
 *
 * 存在性门槛:有本机绝对路径的交付物在返回前 `stat` 一次,不存在 / 非普通文件的
 * 直接摘掉(DESIGN.md §14.5 「本机会话走真实存在性检查」)。协议引用类(cindy-media://
 * / xdt-*://)不 stat —— 媒体仓绝对路径不出主进程,存在性由协议 handler 自己兜底。
 *
 * 已知降级(如实登记,不隐藏):
 *   - SSH 远端 workingDir 的伙伴会话:`stat` 打在本机,一律失败 → 该会话的
 *     generated / attachment 交付物不出现。委派产物(协议引用)不受影响。
 *   - device-link 远程会话:本 channel **不进** REMOTE_INVOKE_ALLOWLIST,远端不可读;
 *     renderer 侧对应地隐藏仓库面板。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain } from 'electron';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { describeToolUse } from '@cindy/maker-shared/tool-use-descriptor';

import { getDbClient, tryGetDbClient } from '../client/current';
import { botDelegations, botProfiles, botSessionLinks, messages, sessions } from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { parseBotOutputArtifacts } from '../../../shared/botOutputArtifact.js';
import { extractCommandOutputPathCandidates } from '../../../shared/commandOutputPaths.js';
import type { TurnChangeSetSummary } from '../../../shared/turnChangeSet.js';
import {
  BOT_ARTIFACT_LIMIT,
  BOT_ARTIFACT_MESSAGE_SCAN_LIMIT,
  botArtifactDisplayName,
  makeBotArtifact,
  type BotArtifactItem,
  type BotArtifactProjection,
} from '../../../shared/botArtifact.js';

/** 委派行扫描上限。与消息扫描分开:委派表小得多,不必占消息预算。 */
const DELEGATION_SCAN_LIMIT = 300;

/** 每返回 1 件就最多 stat 这么多候选,给存在性过滤留余量,同时封住磁盘开销。 */
const STAT_CANDIDATE_FACTOR = 4;

/**
 * 读 checkpoint 索引的会话数上限。每个会话一次 sidecar 读 + 一次锚点查询,不能跟着
 * 伙伴历史会话数线性涨;超出的老会话仍有 tool / command 两条来源兜底。
 */
const CHANGE_SET_SESSION_LIMIT = 40;

/**
 * 命令候选的时钟余量。与对话卡同一常量口径:消息落库时间与文件真正写盘的时间差。
 */
const COMMAND_CANDIDATE_SLACK_MS = 120_000;

interface MessageRowLike {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  createdAt: number;
}

function parseContent(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `tool_use` 消息 → 本条新建的文件原始路径(与 generatedFiles.ts 同口径:只收新建)。 */
export function createdPathsFromToolUseContent(content: Record<string, unknown>): string[] {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return [];
  const descriptor = describeToolUse(toolName, content.input ?? null);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'create' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes
      .filter((change) => change.action === 'add' && change.path)
      .map((change) => change.path);
  }
  return [];
}

/**
 * `tool_use` 消息 → 命令文本里带明确写出语义的产物候选(与对话卡同一份实现)。
 * 这些只是启发式候选,还要过 mtime 下界复核,见 listBotArtifacts。
 */
export function commandOutputPathsFromToolUseContent(
  content: Record<string, unknown>,
): string[] {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return [];
  const descriptor = describeToolUse(toolName, content.input ?? null);
  if (descriptor.kind !== 'command' || !descriptor.command) return [];
  return extractCommandOutputPathCandidates(descriptor.command);
}

/**
 * `tool_use` 消息 → 本条**修改**过的文件路径。它们是编辑不是新建,命令文本里再
 * 出现也不算产物(跑测试 / 构建命令引用刚编辑过的源码是高发误报)。与对话卡的
 * editedKeys 同一条防线。
 */
export function editedPathsFromToolUseContent(content: Record<string, unknown>): string[] {
  const toolName = typeof content.toolName === 'string' ? content.toolName : '';
  if (!toolName) return [];
  const descriptor = describeToolUse(toolName, content.input ?? null);
  if (descriptor.kind === 'file') {
    return descriptor.action === 'edit' && descriptor.filePath ? [descriptor.filePath] : [];
  }
  if (descriptor.kind === 'fileChange') {
    return descriptor.changes
      .filter((change) => change.action !== 'add' && change.path)
      .map((change) => change.path);
  }
  return [];
}

/** checkpoint 里算「新建」的状态。改名 / 修改 / 删除都不是「做出来的东西」。 */
export function createdPathsFromChangeSet(changeSet: TurnChangeSetSummary): string[] {
  return changeSet.files
    .filter((file) => file.status === 'added' || file.status === 'untracked')
    .map((file) => resolveArtifactPath(file.path, changeSet.cwd || null));
}

/** 消息 `content.files[]`(FileRef:{ name, path, size?, sha256? })→ 附件条目原料。 */
export function attachmentRefsFromContent(
  content: Record<string, unknown>,
): Array<{ name: string; path: string; size: number | null }> {
  const files = content.files;
  if (!Array.isArray(files)) return [];
  const out: Array<{ name: string; path: string; size: number | null }> = [];
  for (const entry of files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as { name?: unknown; path?: unknown; size?: unknown };
    if (typeof candidate.path !== 'string' || !candidate.path) continue;
    const name = typeof candidate.name === 'string' && candidate.name
      ? candidate.name
      : botArtifactDisplayName(candidate.path);
    out.push({
      name,
      path: candidate.path,
      size:
        typeof candidate.size === 'number' && Number.isFinite(candidate.size) && candidate.size >= 0
          ? candidate.size
          : null,
    });
  }
  return out;
}

/** 相对路径按会话 workingDir 解析;拿不到 workingDir 时保持原样(后续 stat 会摘掉)。 */
function resolveArtifactPath(rawPath: string, workingDir: string | null): string {
  if (!rawPath) return rawPath;
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) return rawPath;
  if (!workingDir) return rawPath;
  return path.resolve(workingDir, rawPath);
}

/**
 * 同一件东西可能被多条来源看到 —— 保留**最早**的那次交付时间(那才是「做出来的
 * 时刻」),但让来源优先级高的条目决定展示信息:generated > attachment > delegation。
 */
const SOURCE_RANK: Record<BotArtifactItem['source'], number> = {
  generated: 0,
  attachment: 1,
  delegation: 2,
};

export function mergeBotArtifacts(items: BotArtifactItem[]): BotArtifactItem[] {
  const byKey = new Map<string, BotArtifactItem>();
  for (const item of items) {
    if (!item.id) continue;
    const existing = byKey.get(item.id);
    if (!existing) {
      byKey.set(item.id, item);
      continue;
    }
    const winner = SOURCE_RANK[item.source] < SOURCE_RANK[existing.source] ? item : existing;
    const loser = winner === item ? existing : item;
    byKey.set(item.id, {
      ...winner,
      createdAt: Math.min(winner.createdAt, loser.createdAt),
      sizeBytes: winner.sizeBytes ?? loser.sizeBytes,
      sessionId: winner.sessionId ?? loser.sessionId,
      delegationId: winner.delegationId ?? loser.delegationId,
    });
  }
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/**
 * 存在性过滤 + 用 stat 补齐体积。协议引用直接放行。
 *
 * `notBefore` 是命令候选专用的时间下界(id → 最早那条命令的执行时间 − 余量):
 * 命令文本里出现路径 ≠ 命令创建了它,所以还要求文件的创建时间不早于命令。对话卡
 * 有 turn 上界可用,仓库是全生命周期聚合、没有上界,这一点如实登记为更宽。
 */
async function keepExistingFiles(
  items: BotArtifactItem[],
  notBefore?: ReadonlyMap<string, number>,
): Promise<BotArtifactItem[]> {
  const checked = await Promise.all(
    items.map(async (item) => {
      if (!item.path) return item;
      try {
        const stat = await fs.stat(item.path);
        if (!stat.isFile()) return null;
        const floor = notBefore?.get(item.id);
        if (typeof floor === 'number') {
          // birthtime 优先(与对话卡同策);拿不到(部分 Linux FS)才回退 mtime。
          const bornAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
          if (!(bornAt >= floor)) return null;
        }
        return item.sizeBytes === null ? { ...item, sizeBytes: stat.size } : item;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((item): item is BotArtifactItem => item !== null);
}

export interface ListBotArtifactsInput {
  botId?: string;
  sessionId?: string;
  limit?: number;
}

/**
 * checkpoint 读取口。注入而不是直接 import:turn-change-set/store 拖着 electron
 * `app` / BrowserWindow / git-review / device-link 一整串主进程依赖,静态 import
 * 会把它们全塞进这条纯数据投影的模块图(以及它的单测)。省略 = 不读 checkpoint,
 * 仍有 tool / command 两条来源。
 */
export interface BotArtifactSources {
  listTurnChangeSets?: (sessionId: string) => Promise<TurnChangeSetSummary[]>;
}

/**
 * 解析归属伙伴:显式 botId 优先,否则用会话反查 `bot_session_links`。
 * 两者都给不出 → NOT_FOUND(不猜、不回落到「全部伙伴」)。
 */
async function resolveBotId(input: ListBotArtifactsInput): Promise<string> {
  const db = getDbClient().drizzle;
  if (typeof input.botId === 'string' && input.botId) {
    const [profile] = await db
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(eq(botProfiles.id, input.botId))
      .limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile.id;
  }
  if (typeof input.sessionId === 'string' && input.sessionId) {
    const [link] = await db
      .select({ botId: botSessionLinks.botId })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, input.sessionId))
      .limit(1);
    if (!link) throwIpcError('NOT_FOUND', '该任务不属于任何伙伴');
    return link.botId;
  }
  return throwIpcError('INVALID_PARAMS', 'botId 或 sessionId 至少给一个');
}

export async function listBotArtifacts(
  input: ListBotArtifactsInput,
  sources?: BotArtifactSources,
): Promise<BotArtifactProjection> {
  const botId = await resolveBotId(input);
  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(BOT_ARTIFACT_LIMIT, Math.floor(input.limit)))
    : BOT_ARTIFACT_LIMIT;
  const db = getDbClient().drizzle;

  // ── 来源 1:委派回传的协议引用(按被委派方归属)。
  const delegationRows = await db
    .select({
      id: botDelegations.id,
      childSessionId: botDelegations.childSessionId,
      outputArtifactsJson: botDelegations.outputArtifactsJson,
      completedAt: botDelegations.completedAt,
      updatedAt: botDelegations.updatedAt,
    })
    .from(botDelegations)
    .where(eq(botDelegations.targetBotId, botId))
    .orderBy(desc(botDelegations.updatedAt))
    .limit(DELEGATION_SCAN_LIMIT);

  const raw: BotArtifactItem[] = [];
  /** 命令候选的时间下界(id → 最早那条命令的执行时刻 − 余量)。 */
  const commandNotBefore = new Map<string, number>();
  /** 有结构化证据(文件工具 / checkpoint / 附件 / 委派)的件:不受命令时间下界约束。 */
  const structuralIds = new Set<string>();
  const addCommandCandidate = (item: BotArtifactItem, commandAtMs: number): void => {
    raw.push(item);
    const floor = commandAtMs - COMMAND_CANDIDATE_SLACK_MS;
    const current = commandNotBefore.get(item.id);
    if (current === undefined || floor < current) commandNotBefore.set(item.id, floor);
  };
  const addStructural = (item: BotArtifactItem): void => {
    raw.push(item);
    structuralIds.add(item.id);
  };
  for (const row of delegationRows) {
    for (const artifact of parseBotOutputArtifacts(row.outputArtifactsJson)) {
      addStructural(
        makeBotArtifact({
          source: 'delegation',
          target: artifact.ref,
          isRef: true,
          createdAt: row.completedAt ?? row.updatedAt,
          sessionId: row.childSessionId,
          delegationId: row.id,
        }),
      );
    }
  }

  // ── 来源 2 / 3:伙伴名下会话的消息。
  const links = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId));
  const sessionIds = links.map((link) => link.sessionId);

  if (sessionIds.length > 0) {
    const workdirRows = await db
      .select({ id: sessions.id, workingDir: sessions.workingDir })
      .from(sessions)
      .where(inArray(sessions.id, sessionIds));
    const workdirBySession = new Map(workdirRows.map((row) => [row.id, row.workingDir]));

    const messageRows: MessageRowLike[] = await db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(inArray(messages.sessionId, sessionIds), isNull(messages.rewindAt)))
      .orderBy(desc(messages.createdAt))
      .limit(BOT_ARTIFACT_MESSAGE_SCAN_LIMIT);

    // 命令候选与「本轮被编辑过的文件」的对撞要跨整批消息判定,所以先把编辑集扫出来。
    const editedTargets = new Set<string>();
    for (const row of messageRows) {
      if (row.role !== 'tool_use') continue;
      const content = parseContent(row.content);
      if (!content) continue;
      const workingDir = workdirBySession.get(row.sessionId) ?? null;
      for (const rawPath of editedPathsFromToolUseContent(content)) {
        editedTargets.add(resolveArtifactPath(rawPath, workingDir));
      }
    }

    const commandCandidates: Array<{ item: BotArtifactItem; at: number }> = [];
    for (const row of messageRows) {
      const content = parseContent(row.content);
      if (!content) continue;
      const workingDir = workdirBySession.get(row.sessionId) ?? null;
      if (row.role === 'tool_use') {
        for (const rawPath of createdPathsFromToolUseContent(content)) {
          addStructural(
            makeBotArtifact({
              source: 'generated',
              target: resolveArtifactPath(rawPath, workingDir),
              isRef: false,
              createdAt: row.createdAt,
              sessionId: row.sessionId,
              delegationId: null,
            }),
          );
        }
        for (const rawPath of commandOutputPathsFromToolUseContent(content)) {
          const target = resolveArtifactPath(rawPath, workingDir);
          if (editedTargets.has(target)) continue;
          commandCandidates.push({
            item: makeBotArtifact({
              source: 'generated',
              target,
              isRef: false,
              createdAt: row.createdAt,
              sessionId: row.sessionId,
              delegationId: null,
            }),
            at: row.createdAt,
          });
        }
        continue;
      }
      for (const file of attachmentRefsFromContent(content)) {
        addStructural(
          makeBotArtifact({
            source: 'attachment',
            target: resolveArtifactPath(file.path, workingDir),
            isRef: false,
            name: file.name,
            sizeBytes: file.size,
            createdAt: row.createdAt,
            sessionId: row.sessionId,
            delegationId: null,
          }),
        );
      }
    }
    for (const candidate of commandCandidates) {
      addCommandCandidate(candidate.item, candidate.at);
    }

    // ── 来源 2c:checkpoint 记录的新建文件。脚本产物常常两条来源都认不出,这是
    // 它唯一的结构化证据 —— 少了它,对话里出得来的交付物卡在仓库里会消失。
    const listChangeSets = sources?.listTurnChangeSets;
    if (listChangeSets) {
      const scanned = sessionIds.slice(0, CHANGE_SET_SESSION_LIMIT);
      const perSession = await Promise.all(
        scanned.map(async (sessionId) => {
          try {
            return await listChangeSets(sessionId);
          } catch {
            // sidecar 读不到不该让整张仓库空掉;其余来源照常。
            return [] as TurnChangeSetSummary[];
          }
        }),
      );
      for (const changeSets of perSession) {
        for (const changeSet of changeSets) {
          for (const target of createdPathsFromChangeSet(changeSet)) {
            if (editedTargets.has(target)) continue;
            addStructural(
              makeBotArtifact({
                source: 'generated',
                target,
                isRef: false,
                createdAt: changeSet.completedAt || changeSet.createdAt,
                sessionId: changeSet.sessionId,
                delegationId: null,
              }),
            );
          }
        }
      }
    }
  }

  const merged = mergeBotArtifacts(raw);
  const commandOnlyNotBefore = new Map(
    [...commandNotBefore].filter(([id]) => !structuralIds.has(id)),
  );
  // stat 是这条链上唯一的磁盘开销,不能跟着历史长度线性增长。列表已按时间倒序,
  // 只核验够填满一屏上限的那批候选(留出被存在性过滤掉的余量)。
  const candidates = merged.slice(0, limit * STAT_CANDIDATE_FACTOR);
  const existing = await keepExistingFiles(candidates, commandOnlyNotBefore);
  return {
    botId,
    items: existing.slice(0, limit),
    truncated: existing.length > limit || merged.length > candidates.length,
  };
}

export function registerBotArtifactIpc(): void {
  ipcMain.handle('local-db:bots:artifacts', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!tryGetDbClient()) {
      return { botId: '', items: [], truncated: false } satisfies BotArtifactProjection;
    }
    const body = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    return listBotArtifacts(
      {
        ...(typeof body.botId === 'string' ? { botId: body.botId.slice(0, 128) } : {}),
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId.slice(0, 128) } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      },
      {
        // 延迟 import:见 BotArtifactSources 的说明,静态引会把 turn-change-set/store
        // 的一整串主进程依赖拖进这条纯数据投影。
        listTurnChangeSets: async (sessionId) => {
          const store = await import('../../turn-change-set/store.js');
          return store.listTurnChangeSets(sessionId);
        },
      },
    );
  });
}
