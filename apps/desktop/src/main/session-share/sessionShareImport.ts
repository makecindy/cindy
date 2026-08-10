/**
 * 会话分享导入编排:inspect / unlock / commit / cancel 三段式 + draft registry。
 *
 * 解密后的 zip 驻留 main 内存 draft(TTL 10 分钟),避免向导每步重复解密/重复要
 * 密码;commit 前置校验全过才开始写,写入顺序「先文件后 DB」:
 *   媒体还原 → CC 转录落位(按 B 机 workdir 重新转码目录) / Codex rollout+state /
 *   Pi 转录落入本机 pi-agent-home
 *   → 最后单事务落 DB(tx session.importShare,原子)。
 * 任何一步失败 → RollbackJournal 逆序清理已写文件(best-effort),DB 因 tx 原子
 * 天然无残留 —— 保证导入中断不留半截会话。
 *
 * 协同包(manifest.orca):lead 是顶层会话,Worker 会话从 orca/workers/<i>/
 * 逐个按同样的三层策略还原(转录/rollout/pi 转录落位与单会话导入同机制),
 * lead + 全部 Worker + orca_teams/orca_workers 关系图在同一 DB 事务落库;
 * 冲突预检覆盖 lead 与每个 Worker 的 resume id。Worker 的 orca_workers.status
 * 里 running 归一为 idle(导入端没有正在跑的 turn)。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { isClaudeProjectKeyExact, sanitizeClaudeProjectKey } from '@cindy/maker-core';
import { app } from 'electron';

import type { DbClient } from '../localDb/client/DbClient.js';
import { isDbTransportOutcomeUnknown } from '../localDb/client/DbTransport.js';
import type {
  SessionImportShareMessageRow,
  SessionImportShareSessionRow,
} from '../localDb/client/tx/types.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import { createLogger } from '../logger.js';
import {
  importSharedCodexThread,
  removeSharedCodexThread,
} from '../maker-host/codex-local-sessions.js';
import { defaultClaudeConfigDirCandidates } from '../maker-orchestration/claudeTranscriptAnchors.js';
import {
  createWorktree,
  detectCwd,
  removeWorktreeForSession,
  suggestName as suggestWorktreeName,
} from '../worktree/WorktreeManager.js';
import {
  getCacheRoot,
  getSessionDir,
  removeSession as removeSessionImages,
  resolveSafe as resolveImageUrl,
} from '../imageCacheStore.js';
import { resolveSafe as resolveVideoUrl } from '../videoCacheStore.js';
import { resolveSafe as resolveModelUrl } from '../modelCacheStore.js';
import {
  parseBlobUrl,
  mimeForExt,
  resolveHashRef as resolveBlobHashRef,
} from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import type { MediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import {
  removeSessionRefs as removeSessionMediaRefs,
  removeSessionRefsIfDeleted,
  type LedgerDb,
} from '../cindy-media/ledger.js';
import { withSessionRouteLocks } from '../localDb/sessionRouteLock.js';

import { openPayload } from './xdtshareCrypto.js';
import {
  XdtshareError,
  validateManifest,
  type XdtshareFidelity,
  type XdtshareManifest,
  type XdtshareOrcaWorkerManifest,
} from './xdtshareFormat.pure.js';
import { buildLooseUrl, parseImageUrl, rewriteMediaUrls } from './mediaUrlRewrite.pure.js';
import type { MediaMapEntry } from './sessionShareExport.js';

const log = createLogger('session-share-import');

const DRAFT_TTL_MS = 10 * 60 * 1000;
/** 读入内存的 .xdtshare 文件大小上限(明文 zip 或密文,防误选巨型文件)。 */
const SHARE_FILE_READ_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

interface ShareDraft {
  filePath: string;
  /** 加密文件在 unlock 前保留原始字节;解锁后释放。 */
  lockedBytes: Buffer | null;
  zip: JSZip | null;
  manifest: XdtshareManifest | null;
  encrypted: boolean;
  createdAt: number;
}

const drafts = new Map<string, ShareDraft>();

function sweepExpiredDrafts(): void {
  const now = Date.now();
  for (const [id, draft] of drafts) {
    if (now - draft.createdAt > DRAFT_TTL_MS) drafts.delete(id);
  }
}

export interface SharePreview {
  title: string;
  agentKind: 'cc' | 'codex' | 'pi';
  workspaceKind: 'project' | 'dialogue';
  originalWorkingDir: string | null;
  exportedAt: string;
  appVersion: string;
  fidelity: XdtshareFidelity;
  messageCount: number;
  mediaCount: number;
  /** 协同包携带的 Worker 会话数;普通包为 0。 */
  orcaWorkerCount: number;
}

export type InspectResult =
  | { draftId: string; encrypted: true }
  | { draftId: string; encrypted: false; preview: SharePreview };

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toPreview(manifest: XdtshareManifest): SharePreview {
  return {
    title: manifest.title,
    agentKind: manifest.agentKind,
    workspaceKind: manifest.workspaceKind,
    originalWorkingDir: manifest.originalWorkingDir,
    exportedAt: manifest.exportedAt,
    appVersion: manifest.appVersion,
    fidelity: manifest.exportFidelity,
    messageCount: manifest.counts.messages,
    mediaCount: manifest.counts.media,
    orcaWorkerCount: manifest.orca?.workers.length ?? 0,
  };
}

async function loadZipAndManifest(
  zipBytes: Buffer,
): Promise<{ zip: JSZip; manifest: XdtshareManifest }> {
  const zip = await JSZip.loadAsync(zipBytes).catch(() => {
    throw new XdtshareError('SHARE_FILE_INVALID', 'payload is not a readable zip');
  });
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new XdtshareError('SHARE_FILE_INVALID', 'manifest.json missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await manifestFile.async('string'));
  } catch {
    throw new XdtshareError('SHARE_FILE_INVALID', 'manifest.json is not valid JSON');
  }
  return { zip, manifest: validateManifest(parsed) };
}

/** 第一段:读文件、解头。明文直接出预览;加密只报 encrypted,等 unlock。 */
export async function inspectShareFile(filePath: string): Promise<InspectResult> {
  sweepExpiredDrafts();
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw codedError('SHARE_FILE_INVALID', 'file not found');
  if (stat.size > SHARE_FILE_READ_LIMIT_BYTES) {
    throw codedError('SHARE_FILE_INVALID', 'file too large');
  }
  const fileBytes = await fsp.readFile(filePath);
  const draftId = randomUUID();

  // 先探测头:加密文件不需要密码也能识别出「这是加密的 .xdtshare」。
  let opened: ReturnType<typeof openPayload> | null = null;
  try {
    opened = openPayload(fileBytes);
  } catch (err) {
    if (err instanceof XdtshareError && err.code === 'SHARE_PASSWORD_REQUIRED') {
      drafts.set(draftId, {
        filePath,
        lockedBytes: fileBytes,
        zip: null,
        manifest: null,
        encrypted: true,
        createdAt: Date.now(),
      });
      return { draftId, encrypted: true };
    }
    throw err;
  }

  const { zip, manifest } = await loadZipAndManifest(opened.zipBytes);
  drafts.set(draftId, {
    filePath,
    lockedBytes: null,
    zip,
    manifest,
    encrypted: false,
    createdAt: Date.now(),
  });
  return { draftId, encrypted: false, preview: toPreview(manifest) };
}

/** 第二段:密码解锁加密 draft。 */
export async function unlockShareDraft(draftId: string, password: string): Promise<SharePreview> {
  sweepExpiredDrafts();
  const draft = drafts.get(draftId);
  if (!draft) throw codedError('NOT_FOUND', 'draft expired or not found');
  if (!draft.encrypted || !draft.lockedBytes) {
    if (draft.manifest) return toPreview(draft.manifest);
    throw codedError('SHARE_FILE_INVALID', 'draft is in an invalid state');
  }
  const { zipBytes } = openPayload(draft.lockedBytes, password);
  const { zip, manifest } = await loadZipAndManifest(zipBytes);
  draft.lockedBytes = null;
  draft.zip = zip;
  draft.manifest = manifest;
  draft.createdAt = Date.now();
  return toPreview(manifest);
}

export function cancelShareDraft(draftId: string): void {
  drafts.delete(draftId);
}

/**
 * 导入端"新建会话"默认值 —— renderer 从 New Maker 草稿(newMakerDraft store)读出
 * 分享包 agentKind 对应 vendor 的偏好后随 commit 传入。导入语义 = 用本地草稿默认值
 * 新建会话(只有 agent 跟随分享包),因此 model/effort/permissionMode/planMode/
 * fastMode/providerId 不采用分享包 snapshot(导出方的模型/供应商在导入端不一定存在)。
 */
export interface ShareImportDraftPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
  planMode?: boolean;
  fastMode?: boolean;
  providerId?: string | null;
}

export interface CommitShareImportOptions {
  draftId: string;
  /** project 会话必填:B 机上对应的工作目录。dialogue 忽略。 */
  workingDir?: string | null;
  /** 导入端草稿默认值;缺省(旧调用方 / 测试)按 agentKind 内置默认兜底,仍不读 snapshot。 */
  draftPrefs?: ShareImportDraftPrefs | null;
  /**
   * 在 worktree 中创建(仅 project 会话):以所选 workingDir 的 git 仓库根为
   * baseRepo 建会话级 worktree,导入会话的 workingDir 指向 worktree 路径——与
   * New Maker 草稿开 worktree 创建同语义。创建/落库任一步失败经 journal 回滚
   * 移除 worktree,不留孤儿。
   */
  useWorktree?: boolean;
  /** 仅测试用:覆盖 CC projectsRoot(默认 defaultClaudeConfigDirCandidates()[0]/projects)。 */
  projectsRootOverride?: string;
  /** 仅测试用:覆盖 loose 媒体落盘根目录(默认 userData/cc-agent/shared-media)。 */
  sharedMediaRootOverride?: string;
  /** 仅测试用:覆盖 Pi 分享转录根目录(默认 userData/pi-agent-home/sessions/shared)。 */
  piSessionsRootOverride?: string;
  /** 冲突覆盖:同 resume id 的存活会话已存在时,软删旧会话后继续导入(替换而非叠加)。 */
  overwrite?: boolean;
}

/** Stable owner-bound resources captured synchronously by the production IPC entry. */
export interface CommitShareImportRuntimeScope {
  dbClient: DbClient;
  assertStillValid(): void;
  refCompensationScope: MediaRefCompensationScope;
}

export interface CommitShareImportResult {
  sessionId: string;
  fidelity: XdtshareFidelity;
  /** 需要用户知晓的降档/提示信息 key(renderer 翻译)。 */
  notes: string[];
  /** 随协同包一并导入的 Worker 会话数;普通包为 0。 */
  orcaWorkers: number;
}

/** main 内部结果：额外携带覆盖成功后的旧会话图，供 IPC 层做 runtime/UI 收尾。 */
export interface CommitShareImportInternalResult extends CommitShareImportResult {
  replacedSessions: Array<{ id: string; status: 'active' | 'archived' }>;
}

interface BundleMessageRow {
  id: string;
  clientId: string;
  role: string;
  content: string;
  toolUseId: string | null;
  agentMeta: string | null;
  agentKind: string | null;
  createdAt: number;
  rewindAt: number | null;
}

/** manifest.transcripts 里实际随包携带(path 非 null)的条目。 */
type BundledTranscript = { sdkSessionId: string; path: string };

/** 协同包单个 Worker 的导入计划(只读解析结果 + 逐步补齐的派生字段)。 */
interface WorkerImportPlan {
  manifest: XdtshareOrcaWorkerManifest;
  /** zip 内前缀 orca/workers/<index>/。 */
  prefix: string;
  newId: string;
  snapshot: Record<string, unknown>;
  messages: BundleMessageRow[];
  bundledTranscripts?: BundledTranscript[];
  /** pi 便携 id 已映射为本机绝对路径;codex/cc 为包内 id 原样。 */
  activeSdkSessionId: string | null;
}

/**
 * 覆盖事务提交后的旧会话媒体账本收尾。只删旧 session 名下的引用行；共享 blob
 * 字节不直接删除，引用归零后由 recycler 统一回收。失败不反转已经提交的新会话图，
 * 与普通会话删除的媒体清理保持 best-effort 语义。
 */
export async function cleanupReplacedSessionMediaRefs(
  sessions: ReadonlyArray<{ id: string }>,
  db: LedgerDb,
): Promise<void> {
  for (const session of sessions) {
    try {
      const removed = await removeSessionRefsIfDeleted(session.id, db);
      if (removed > 0) {
        log.info('replaced session media refs removed', {
          sessionId: session.id,
          count: removed,
        });
      }
    } catch (err) {
      log.warn('replaced session media ref cleanup failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 第三段:落三层数据。前置校验全过才写;文件步登记 journal,失败逆序回滚。 */
export async function commitShareImport(
  opts: CommitShareImportOptions,
  runtimeScope: CommitShareImportRuntimeScope,
): Promise<CommitShareImportInternalResult> {
  const dbClient = runtimeScope.dbClient;
  const mediaDb = dbClient.drizzle;
  const assertStillValid = runtimeScope.assertStillValid;
  const guarded = async <T>(task: () => Promise<T>): Promise<T> => {
    assertStillValid();
    const result = await task();
    assertStillValid();
    return result;
  };
  assertStillValid();
  sweepExpiredDrafts();
  const draft = drafts.get(opts.draftId);
  if (!draft) throw codedError('NOT_FOUND', 'draft expired or not found');
  if (!draft.zip || !draft.manifest) {
    throw codedError('SHARE_PASSWORD_REQUIRED', 'draft is still locked');
  }
  const { zip, manifest } = draft;

  // ── 解析包内数据(仍属只读阶段) ──
  const sessionSnapshot = await guarded(() => readJsonEntry(zip, 'session.json'));
  const messages = await guarded(() => readMessagesJsonl(zip, 'messages.jsonl'));
  if (messages.length === 0) throw codedError('SHARE_FILE_INVALID', 'bundle has no messages');
  const mediaMap = await guarded(() => readMediaMap(zip));

  // 协同包:逐个读 Worker 的包内数据(Worker 允许 0 条消息——刚创建未派活)。
  const workerPlans: WorkerImportPlan[] = [];
  if (manifest.orca) {
    for (const workerManifest of manifest.orca.workers) {
      const prefix = `orca/workers/${workerManifest.index}/`;
      workerPlans.push({
        manifest: workerManifest,
        prefix,
        newId: randomUUID(),
        snapshot: await guarded(() => readJsonEntry(zip, `${prefix}session.json`)),
        messages: await guarded(() => readMessagesJsonl(zip, `${prefix}messages.jsonl`)),
        activeSdkSessionId: null,
      });
    }
  }

  // ── 前置校验 ──
  const now = Date.now();
  const newId = randomUUID();
  let workingDir: string;
  if (manifest.workspaceKind === 'project') {
    const dir = typeof opts.workingDir === 'string' ? opts.workingDir.trim() : '';
    if (!dir) throw codedError('INVALID_PARAMS', 'workingDir is required for project sessions');
    const stat = await guarded(() => fsp.stat(dir).catch(() => null));
    if (!stat?.isDirectory()) {
      throw codedError('PRECONDITION_FAILED', 'workingDir does not exist or is not a directory');
    }
    workingDir = dir;
  } else {
    assertStillValid();
    workingDir = ensureDialogueWorkspaceDir(newId, now);
    assertStillValid();
  }

  // activeSdkSessionId 同样是不可信输入,且会流入落盘路径:codex 侧
  // importSharedCodexThread 的 rollout 文件名兜底会把 threadId 拼进 filename,
  // CC 侧 resume 也按 `<id>.jsonl` 定位转录——非单路径段一律拒整包(审查 P0)。
  // 协同包的每个 Worker 与 lead 同口径校验。
  const portableActiveSdkSessionId = manifest.activeSdkSessionId;
  if (portableActiveSdkSessionId && !isSafePathSegment(portableActiveSdkSessionId)) {
    throw new XdtshareError(
      'SHARE_FILE_INVALID',
      `unsafe activeSdkSessionId: ${portableActiveSdkSessionId}`,
    );
  }
  // .xdtshare 是他人给的不可信输入:sdkSessionId 会拼进落盘路径(`<id>.jsonl`),
  // 恶意包塞 `../../evil` 可逃出转码目录写任意文件(review bot P1)。写盘/预检前
  // 先整体校验为单路径段,非法直接拒绝整包。
  const filterBundled = (
    transcripts: XdtshareManifest['transcripts'],
    label: string,
  ): BundledTranscript[] => {
    const bundled = transcripts.filter((t): t is BundledTranscript => t.path !== null);
    for (const t of bundled) {
      if (!isSafePathSegment(t.sdkSessionId)) {
        throw new XdtshareError(
          'SHARE_FILE_INVALID',
          `unsafe sdkSessionId in ${label}: ${t.sdkSessionId}`,
        );
      }
    }
    return bundled;
  };
  const bundledTranscripts = filterBundled(manifest.transcripts, 'transcripts');
  for (const plan of workerPlans) {
    if (plan.manifest.activeSdkSessionId && !isSafePathSegment(plan.manifest.activeSdkSessionId)) {
      throw new XdtshareError(
        'SHARE_FILE_INVALID',
        `unsafe worker activeSdkSessionId: ${plan.manifest.activeSdkSessionId}`,
      );
    }
    plan.bundledTranscripts = filterBundled(
      plan.manifest.transcripts,
      `orca.workers[${plan.manifest.index}].transcripts`,
    );
  }
  const piSessionsRoot = path.resolve(
    opts.piSessionsRootOverride ??
      path.join(app.getPath('userData'), 'pi-agent-home', 'sessions', 'shared'),
  );
  // pi 便携 id 是内容散列,lead 与 Worker 共用一张全局映射表(同内容同 id,
  // 落盘目标天然一致)。
  const piTranscriptTargets = new Map<string, string>();
  const registerPiTargets = (bundled: BundledTranscript[]): void => {
    for (const transcript of bundled) {
      // 只有包内实际存在的转录才映射成可 resume 的本机绝对路径。
      if (zip.file(transcript.path)) {
        piTranscriptTargets.set(
          transcript.sdkSessionId,
          path.join(piSessionsRoot, transcript.sdkSessionId),
        );
      }
    }
  };
  if (manifest.agentKind === 'pi') registerPiTargets(bundledTranscripts);
  for (const plan of workerPlans) {
    if (plan.manifest.agentKind === 'pi') registerPiTargets(plan.bundledTranscripts ?? []);
  }
  const resolveActiveSdkSessionId = (
    agentKind: 'cc' | 'codex' | 'pi',
    portableId: string | null,
  ): string | null =>
    agentKind === 'pi'
      ? portableId
        ? (piTranscriptTargets.get(portableId) ?? null)
        : null
      : portableId;
  const activeSdkSessionId = resolveActiveSdkSessionId(
    manifest.agentKind,
    portableActiveSdkSessionId,
  );
  for (const plan of workerPlans) {
    plan.activeSdkSessionId = resolveActiveSdkSessionId(
      plan.manifest.agentKind,
      plan.manifest.activeSdkSessionId,
    );
  }
  // 互斥判定的唯一权威:DB 里是否已有同 agent + 同 resume id 的**存活**会话行。
  // 刻意排除 status='deleted'——删除会话不清理盘上的转录/rollout/state,重导同一
  // 分享包时下方文件层一律「存在即复用、绝不覆盖」,不把盘上残留当成冲突。
  // overwrite = 用户在冲突弹窗确认"覆盖导入":记下旧会话,写入阶段先软删它,
  // 再走既有的"已删除会话重导"路径(盘上转录复用)——净效果是替换而非叠加。
  // 协同包对 lead 与每个 Worker 逐一预检,任一命中即冲突;覆盖导入软删全部命中。
  const conflictExisting: Array<{ id: string; status: 'active' | 'archived' }> = [];
  const conflictProbes: Array<{ agentKind: string; resumeId: string }> = [
    ...(activeSdkSessionId
      ? [{ agentKind: manifest.agentKind as string, resumeId: activeSdkSessionId }]
      : []),
    ...workerPlans.flatMap((plan) =>
      plan.activeSdkSessionId
        ? [{ agentKind: plan.manifest.agentKind as string, resumeId: plan.activeSdkSessionId }]
        : [],
    ),
  ];
  for (const probe of conflictProbes) {
    const existing = await guarded(() =>
      dbClient.queryOne<{
        id: string;
        status: 'active' | 'archived';
      }>(
        `SELECT id, status FROM sessions
         WHERE agent_kind = ? AND sdk_session_id = ? AND status != 'deleted' LIMIT 1`,
        [probe.agentKind, probe.resumeId],
      ),
    );
    if (existing) {
      if (!opts.overwrite) {
        throw codedError(
          'SHARE_CONFLICT',
          `session with same resume id already imported: ${existing.id}`,
        );
      }
      if (!conflictExisting.some((c) => c.id === existing.id)) conflictExisting.push(existing);
    }
  }

  // 无论冲突行是旧 Orca lead 还是 Worker，覆盖语义都必须替换它所属的
  // 完整图，而不是只删 manifest 本次碰巧探测到的 resume ids。从 lead
  // 命中其历次 team，从 Worker 反查所属 team，再把对应 lead 与全部 Worker
  // session 纳入同一事务，防止旧隐藏 Worker/关系残留成孤儿或与新图并存。
  for (const existing of [...conflictExisting]) {
    const graphRows = await guarded(() =>
      dbClient.query<{
        id: string;
        status: 'active' | 'archived';
      }>(
        `WITH related_leads AS (
         SELECT lead_session_id AS id FROM orca_teams WHERE lead_session_id = ?
         UNION
         SELECT t.lead_session_id AS id
         FROM orca_workers w
         JOIN orca_teams t ON t.id = w.team_id
         WHERE w.session_id = ?
       ), related_sessions AS (
         SELECT id FROM related_leads
         UNION
         SELECT w.session_id AS id
         FROM related_leads l
         JOIN orca_teams t ON t.lead_session_id = l.id
         JOIN orca_workers w ON w.team_id = t.id
       )
       SELECT s.id, s.status
       FROM related_sessions r
       JOIN sessions s ON s.id = r.id
         WHERE s.status != 'deleted'`,
        [existing.id, existing.id],
      ),
    );
    for (const row of graphRows) {
      if (!conflictExisting.some((candidate) => candidate.id === row.id)) {
        conflictExisting.push(row);
      }
    }
  }

  const projectsRoot =
    opts.projectsRootOverride ?? path.join(defaultClaudeConfigDirCandidates()[0], 'projects');
  // codex:desktop state DB / rollout 里的残留 thread 不再单独当冲突拦截,
  // 存活会话行已由上方 DB 预检兜住;落位层 INSERT OR IGNORE + wx 复用。

  // ── 写入阶段:journal 逆序回滚 ──
  /** 非 null = 本次导入建了 worktree,session 行的 worktree_path 同步落它。 */
  let worktreePath: string | null = null;
  const journal: Array<() => Promise<void>> = [];
  const notes: string[] = [];
  const rollback = async (): Promise<void> => {
    for (const undo of journal.reverse()) {
      await undo().catch((err) => {
        log.warn('share import rollback step failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  };
  // Keep this in a mutable cell: the assignments happen inside the route-lock
  // callback, which TypeScript does not include in outer control-flow narrowing.
  const finalTxState: {
    outcome: 'not-started' | 'in-flight' | 'committed';
  } = { outcome: 'not-started' };

  try {
    // 0. 覆盖导入命中的旧 session 不在编排层提前软删。patchSessionMetaInDb
    // 会异步清理图片、媒体引用、附件目录与 worktree,这些副作用无法随 journal
    // 回滚。旧 session id 改由最后的 session.importShare 事务一并标 deleted:
    // 新图落库失败则 SQLite 原子恢复旧状态,成功才完成替换。

    // 0b. worktree(仅 project 会话 + 用户勾选):以所选目录的 git 仓库根为
    //     baseRepo 建会话级 worktree,后续所有 workingDir 相关落位(CC 转录转码
    //     目录 / codex cwd / session 行)一律指向 worktree 路径——与 New Maker
    //     草稿开 worktree 创建同语义。失败即中止导入;成功登记 journal,后续
    //     任一步失败逆序回滚时移除 worktree,不留孤儿。
    if (opts.useWorktree && manifest.workspaceKind === 'project') {
      const detect = await guarded(() => detectCwd(workingDir).catch(() => null));
      if (!detect?.isGitRepo || !detect.repoRoot) {
        throw codedError(
          'SHARE_WORKTREE_NOT_GIT',
          'selected workingDir is not inside a git repository',
        );
      }
      const baseRepo = detect.repoRoot;
      let wtName = (await guarded(() => suggestWorktreeName(baseRepo).catch(() => ''))).trim();
      assertStillValid();
      const resp = await createWorktree({
        sessionId: newId,
        baseRepo,
        name: wtName,
        sourceBranch: detect.currentBranch || 'main',
      });
      if (!resp.ok) {
        throw codedError('SHARE_WORKTREE_FAILED', resp.error.message ?? resp.error.kind);
      }
      workingDir = resp.meta.path;
      worktreePath = resp.meta.path;
      journal.push(async () => {
        await removeWorktreeForSession(newId);
      });
      assertStillValid();
      log.info('share import created worktree', { newId, baseRepo, worktreePath });
    }

    // CC 转录转码目录依赖**最终** workingDir(可能已切到 worktree),必须在
    // worktree 步之后计算。盘上已有同名转录不算冲突(典型是删除 Maker 会话后
    // 重导——软删不清理转录):写入步用 wx 独占写,已存在则复用盘上副本,绝不
    // 覆盖(sdk id 是 UUID,同名即同一会话,且盘上副本可能含删除前 resume 产生
    // 的更新内容)。协同包的 cc Worker 与 lead 落同一转码目录(同 workingDir)。
    const hasCcTranscripts =
      (manifest.agentKind === 'cc' && bundledTranscripts.length > 0) ||
      workerPlans.some(
        (plan) => plan.manifest.agentKind === 'cc' && (plan.bundledTranscripts?.length ?? 0) > 0,
      );
    let claudeTargetDir: string | null = null;
    let transcriptsPlaceable = true;
    if (hasCcTranscripts) {
      if (!isClaudeProjectKeyExact(workingDir)) {
        // 超长路径无法精确复算转码目录:降档为仅历史,不阻断导入。
        transcriptsPlaceable = false;
      } else {
        claudeTargetDir = path.join(projectsRoot, sanitizeClaudeProjectKey(workingDir));
      }
    }

    // 1. 媒体还原 + URL 重写规则收集。session 图片按「原 URL → 新 URL」逐条进
    //    urlMap(而非单一 host 替换):fork 链会话可能同时带多个旧 session host
    //    的图片(祖先消息 + 自己的),逐 URL 映射才能全部指到新目录(review bot P2)。
    const urlMap = new Map<string, string>();
    let sessionImagesWritten = false;
    let blobRefsWritten = false;
    const sharedMediaRoot =
      opts.sharedMediaRootOverride ??
      path.join(app.getPath('userData'), 'cc-agent', 'shared-media');
    for (const entry of mediaMap) {
      if (!entry.zipPath) continue;
      const file = zip.file(entry.zipPath);
      if (!file) continue;
      const buffer = Buffer.from(await guarded(() => file.async('nodebuffer')));
      const restored = await restoreMediaEntry({
        entry,
        buffer,
        newSessionId: newId,
        sharedMediaRoot,
        journal,
        db: mediaDb,
        assertStillValid,
        refCompensationScope: runtimeScope.refCompensationScope,
      });
      assertStillValid();
      if (!restored) continue;
      if (restored.kind === 'session-image') {
        // 入仓形态只挂引用行(回滚走 removeSessionMediaRefs);老目录回落形态
        // 才有 per-session 文件要在回滚时清(removeSessionImages)。
        if (restored.viaBlob) blobRefsWritten = true;
        else sessionImagesWritten = true;
        urlMap.set(entry.url, restored.newUrl);
      } else if (restored.kind === 'loose') {
        if (restored.viaBlob) blobRefsWritten = true;
        urlMap.set(entry.url, restored.newUrl);
      } else if (restored.kind === 'blob') {
        blobRefsWritten = true;
      }
    }
    if (sessionImagesWritten) {
      journal.push(async () => {
        await removeSessionImages(newId).catch(() => undefined);
      });
    }
    if (blobRefsWritten) {
      // 回滚只删引用行(账本);字节本身内容寻址无害,留给对账/回收器,
      // 与 ingest 的"先字节后记账"崩溃语义一致。
      journal.push(async () => {
        await removeSessionMediaRefs(newId, mediaDb).catch(() => undefined);
      });
    }

    // 会话级还原描述:lead + 全部 Worker 走同一套转录/rollout 落位流程。
    const restorePlans: Array<{
      agentKind: 'cc' | 'codex' | 'pi';
      prefix: string;
      title: string;
      bundled: BundledTranscript[];
      activeSdkSessionId: string | null;
    }> = [
      {
        agentKind: manifest.agentKind,
        prefix: '',
        title: manifest.title,
        bundled: bundledTranscripts,
        activeSdkSessionId,
      },
      ...workerPlans.map((plan) => ({
        agentKind: plan.manifest.agentKind,
        prefix: plan.prefix,
        title: plan.manifest.title,
        bundled: plan.bundledTranscripts ?? [],
        activeSdkSessionId: plan.activeSdkSessionId,
      })),
    ];

    // 2a. CC 转录落位(B 机 workdir 重新转码目录)。wx 独占写:已存在(删除后
    //     重导 / 同源 CLI 转录)则复用盘上副本不覆盖,也不进 journal——回滚
    //     只删本次真实写入的文件。复用同样计入 transcriptsWritten(resume 可用,
    //     保真度不降档)。
    let transcriptsWritten = 0;
    if (claudeTargetDir && transcriptsPlaceable) {
      await guarded(() => fsp.mkdir(claudeTargetDir, { recursive: true }).then(() => undefined));
      for (const restore of restorePlans) {
        if (restore.agentKind !== 'cc') continue;
        for (const t of restore.bundled) {
          const file = zip.file(t.path);
          if (!file) continue;
          const target = path.join(claudeTargetDir, `${t.sdkSessionId}.jsonl`);
          try {
            const transcriptBytes = Buffer.from(await guarded(() => file.async('nodebuffer')));
            assertStillValid();
            await fsp.writeFile(target, transcriptBytes, { flag: 'wx' });
            journal.push(async () => {
              await fsp.rm(target, { force: true });
            });
            assertStillValid();
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            log.info('transcript already on disk, reusing', { sdkSessionId: t.sdkSessionId });
            assertStillValid();
          }
          transcriptsWritten += 1;
        }
      }
    }

    // 2a-2. Pi 转录恢复到本机 pi-agent-home；DB 与消息元数据在下方统一改写为
    // 这里的绝对路径。wx 复用/回滚语义与 CC 一致(lead 与 Worker 同一张全局
    // piTranscriptTargets,重复 id 由 wx 天然去重,只计一次)。
    const piTargetsWritten = new Set<string>();
    for (const restore of restorePlans) {
      if (restore.agentKind !== 'pi') continue;
      for (const transcript of restore.bundled) {
        const target = piTranscriptTargets.get(transcript.sdkSessionId);
        const file = zip.file(transcript.path);
        if (!target || !file || piTargetsWritten.has(target)) continue;
        piTargetsWritten.add(target);
        await writeIfMissing(
          target,
          Buffer.from(await guarded(() => file.async('nodebuffer'))),
          journal,
          assertStillValid,
        );
        transcriptsWritten += 1;
      }
    }

    // 2b. Codex rollout + state 落位(lead 与 codex Worker 各自的 thread 独立落位)
    for (const restore of restorePlans) {
      if (restore.agentKind !== 'codex' || !restore.activeSdkSessionId) continue;
      const threadId = restore.activeSdkSessionId;
      const stateEntry = zip.file(`${restore.prefix}codex-state/thread.json`);
      const stateRows = stateEntry
        ? (JSON.parse(await guarded(() => stateEntry.async('string'))) as {
            threads: Array<Record<string, unknown>>;
            threadDynamicTools: Array<Record<string, unknown>>;
            threadSpawnEdges: Array<Record<string, unknown>>;
          })
        : { threads: [], threadDynamicTools: [], threadSpawnEdges: [] };
      const rolloutRef = restore.bundled[0] ?? null;
      const rolloutFile = rolloutRef ? zip.file(rolloutRef.path) : null;
      const rolloutBuffer = rolloutFile
        ? Buffer.from(await guarded(() => rolloutFile.async('nodebuffer')))
        : null;
      assertStillValid();
      const written = await importSharedCodexThread({
        threadId,
        stateRows,
        rolloutBuffer,
        rolloutFilename: rolloutRef ? path.posix.basename(rolloutRef.path) : null,
        newCwd: workingDir,
        title: restore.title,
        updatedAt: now,
      });
      journal.push(async () => {
        await removeSharedCodexThread(threadId, written);
      });
      assertStillValid();
      if (written.rolloutPath) transcriptsWritten += 1;
      // 降档提示看 statePresent(state 行最终在不在),不能看 stateWritten——
      // 删除后重导时行已存在、本次零插入,state 依然完好,不该提示。
      if (
        !written.statePresent &&
        stateRows.threads.length > 0 &&
        !notes.includes('codexStateSkipped')
      ) {
        notes.push('codexStateSkipped');
      }
    }

    // 3. DB 最后一步(tx 原子):message id 重新生成防撞库,content 过媒体重写;
    //    协同包把 Worker 会话 + 关系图放进同一事务。
    const rewriteRules = urlMap.size > 0 ? { urlMap } : {};
    const toDbMessages = (
      rows: BundleMessageRow[],
      agentKind: 'cc' | 'codex' | 'pi',
    ): SessionImportShareMessageRow[] =>
      rows.map((m) => ({
        id: randomUUID(),
        clientId: m.clientId,
        role: m.role,
        content: rewriteMediaUrls(m.content, rewriteRules),
        toolUseId: m.toolUseId,
        agentMeta:
          agentKind === 'pi'
            ? rewritePiAgentMetaForImport(m.agentMeta, piTranscriptTargets)
            : m.agentMeta,
        agentKind: m.agentKind,
        createdAt: m.createdAt,
        rewindAt: m.rewindAt,
      }));
    const dbMessages = toDbMessages(messages, manifest.agentKind);
    const draftPrefs = opts.draftPrefs ?? null;
    const teamId = randomUUID();
    // 恶意/损坏包可能带多个 focused=true(源库有 partial unique 保证唯一);
    // 归一为只保留第一个,避免整包因索引冲突白白失败。
    let focusedSeen = false;
    const orcaTxArgs = manifest.orca
      ? {
          team: {
            id: teamId,
            leadSessionId: newId,
            status: manifest.orca.teamStatus,
            completedAt: manifest.orca.teamStatus === 'active' ? null : now,
            createdAt: now,
            updatedAt: now,
          },
          workers: workerPlans.map((plan) => {
            const focused = plan.manifest.focused && !focusedSeen;
            if (focused) focusedSeen = true;
            return {
              record: {
                id: randomUUID(),
                teamId,
                sessionId: plan.newId,
                // running 归一为 idle:导入端没有正在跑的 turn,保留 running 会
                // 让 UI 呈现一个不存在的活跃状态。
                status: plan.manifest.status === 'running' ? 'idle' : plan.manifest.status,
                label: plan.manifest.label,
                role: plan.manifest.role,
                focused,
                createdAt: now,
                updatedAt: now,
              },
              session: buildSessionRow({
                newId: plan.newId,
                agentKind: plan.manifest.agentKind,
                title:
                  (typeof plan.snapshot.title === 'string' && plan.snapshot.title) ||
                  plan.manifest.title ||
                  'Worker',
                workspaceKind: manifest.workspaceKind,
                orcaRole: 'worker' as const,
                snapshot: plan.snapshot,
                draftPrefs,
                // 导入端草稿偏好按 vendor 存,跨 vendor 的 Worker 用内置兜底模型。
                applyDraftPrefs: plan.manifest.agentKind === manifest.agentKind,
                // 与 OrcaWorkerCreationService 同口径:Worker 固定 auto,不继承。
                permissionModeOverride: 'auto',
                workingDir,
                worktreePath,
                activeSdkSessionId: plan.activeSdkSessionId,
                now,
              }),
              messages: toDbMessages(plan.messages, plan.manifest.agentKind),
            };
          }),
        }
      : undefined;
    await withSessionRouteLocks(
      conflictExisting.map((session) => session.id),
      async () => {
        assertStillValid();
        finalTxState.outcome = 'in-flight';
        await dbClient.tx('session.importShare', {
          session: buildSessionRow({
            newId,
            agentKind: manifest.agentKind,
            title: manifest.title || 'Shared session',
            workspaceKind: manifest.workspaceKind,
            orcaRole: manifest.orca ? ('lead' as const) : null,
            snapshot: sessionSnapshot,
            draftPrefs,
            applyDraftPrefs: true,
            workingDir,
            worktreePath,
            activeSdkSessionId,
            now,
          }),
          messages: dbMessages,
          ...(conflictExisting.length > 0 ? { replaceSessions: conflictExisting } : {}),
          ...(orcaTxArgs ? { orca: orcaTxArgs } : {}),
        });
        finalTxState.outcome = 'committed';
        // The transaction is now durable. Consume the in-memory draft before
        // revalidating the owner so a stale completion cannot be retried into
        // another profile and duplicate the already committed import.
        drafts.delete(opts.draftId);
        assertStillValid();
      },
    );

    // ── 最终保真度(lead + 全部 Worker 聚合) ──
    const bundledKeys = new Set(
      restorePlans.flatMap((restore) =>
        restore.bundled.map((transcript) => `${restore.agentKind}:${transcript.sdkSessionId}`),
      ),
    );
    const fidelity = resolveFinalFidelity({
      exportFidelity: manifest.exportFidelity,
      bundledCount: bundledKeys.size,
      transcriptsWritten,
    });
    if (hasCcTranscripts && !transcriptsPlaceable) notes.push('workdirKeyInexact');
    log.info('session share imported', {
      newId,
      agentKind: manifest.agentKind,
      fidelity,
      messages: dbMessages.length,
      orcaWorkers: workerPlans.length,
      transcriptsWritten,
      notes,
    });
    // 回传被原子替换的旧图，IPC 层在 commit 成功后执行可逆性不再需要的
    // 运行时/UI 收尾（closeSession + patched 广播）。资源字节不立即删除，避免
    // 与同 resume id 的新任务复用转录/媒体发生竞态，交既有对账/回收路径处理。
    return {
      sessionId: newId,
      fidelity,
      notes,
      orcaWorkers: workerPlans.length,
      replacedSessions: conflictExisting,
    };
  } catch (err) {
    // A resolved final transaction is the import commit point. A dispatched
    // worker RPC can also commit and then lose its ACK during an owner switch,
    // timeout, or worker termination. In that explicitly classified ambiguous
    // state, preserve staged files/refs: an orphan leak is recoverable, while
    // deleting bytes that committed messages reference is permanent corruption.
    // Deterministic worker/business failures still roll back normally.
    const preserveStagedArtifacts =
      finalTxState.outcome === 'in-flight' && isDbTransportOutcomeUnknown(err);
    if (preserveStagedArtifacts) {
      log.warn('share import final transaction outcome is unknown; preserving staged artifacts', {
        sessionId: newId,
        error: err instanceof Error ? err.message : String(err),
      });
    } else if (finalTxState.outcome !== 'committed') {
      await rollback();
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== 'ALREADY_EXISTS') throw err;
    throw codedError('SHARE_IMPORT_FAILED', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function readJsonEntry(zip: JSZip, entryPath: string): Promise<Record<string, unknown>> {
  const file = zip.file(entryPath);
  if (!file) throw codedError('SHARE_FILE_INVALID', `${entryPath} missing`);
  try {
    const parsed = JSON.parse(await file.async('string')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw codedError('SHARE_FILE_INVALID', `${entryPath} is not valid JSON`);
  }
}

async function readMessagesJsonl(zip: JSZip, entryPath: string): Promise<BundleMessageRow[]> {
  const file = zip.file(entryPath);
  if (!file) throw codedError('SHARE_FILE_INVALID', `${entryPath} missing`);
  const text = await file.async('string');
  const rows: BundleMessageRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw codedError('SHARE_FILE_INVALID', 'messages.jsonl contains invalid JSON line');
    }
    const m = raw as Record<string, unknown>;
    if (
      typeof m.clientId !== 'string' ||
      typeof m.role !== 'string' ||
      typeof m.content !== 'string' ||
      typeof m.createdAt !== 'number'
    ) {
      throw codedError('SHARE_FILE_INVALID', 'messages.jsonl row missing required fields');
    }
    rows.push({
      id: typeof m.id === 'string' ? m.id : '',
      clientId: m.clientId,
      role: m.role,
      content: m.content,
      toolUseId: typeof m.toolUseId === 'string' ? m.toolUseId : null,
      agentMeta: typeof m.agentMeta === 'string' ? m.agentMeta : null,
      agentKind: typeof m.agentKind === 'string' ? m.agentKind : null,
      createdAt: m.createdAt,
      rewindAt: typeof m.rewindAt === 'number' ? m.rewindAt : null,
    });
  }
  return rows;
}

async function readMediaMap(zip: JSZip): Promise<MediaMapEntry[]> {
  const file = zip.file('media-map.json');
  if (!file) return [];
  try {
    const parsed = JSON.parse(await file.async('string')) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as MediaMapEntry[]) : [];
  } catch {
    return [];
  }
}

type RestoredMedia =
  | { kind: 'session-image'; newUrl: string; viaBlob?: boolean }
  | { kind: 'reserved' }
  | { kind: 'loose'; newUrl: string; viaBlob?: boolean }
  /** cindy-media blob:内容寻址,URL 不重写;引用行已挂到导入会话名下。 */
  | { kind: 'blob' };

/**
 * 单路径段校验:.xdtshare 来自他人,包内自由字段(filename / sdkSessionId)拼进
 * 落盘路径前必须确认不含分隔符/越级,防路径穿越写任意文件(review bot P1)。
 */
function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    path.basename(value) === value
  );
}

/** 将分享包中的 Pi 便携 id 改成本机 sessionFile；无对应转录的 id 不保留。 */
function rewritePiAgentMetaForImport(
  agentMeta: string | null,
  transcriptTargets: ReadonlyMap<string, string>,
): string | null {
  if (!agentMeta) return agentMeta;
  try {
    const parsed = JSON.parse(agentMeta) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const meta = parsed as Record<string, unknown>;
    if (typeof meta.sdkSessionId !== 'string') return agentMeta;
    const target = transcriptTargets.get(meta.sdkSessionId);
    if (target) meta.sdkSessionId = target;
    else delete meta.sdkSessionId;
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

/**
 * 还原一个媒体文件到 B 机对应位置。
 * - session 图片(老包里的 xdt-image per-session 地址)→ **入媒体总仓**(导入
 *   是新写入,不再往 cc-agent/images 添字节),URL 重写为
 *   cindy-media://(消息 content 本来就要重写);入仓失败回落老目录写法;
 * - reserved 缓存(feishu/art/confluence/jira 图、video、model)→ 写回同名位置
 *   (目标路径同样来自 resolveSafe 验证过的 URL),已存在则跳过复用,URL 不变
 *   (这些 URL 不重写,文件必须在老位置才解析得到——服务老地址属存量豁免);
 * - loose(file/audio 绝对路径引用)→ **媒体 mime 入总仓**(URL 的 ?path= 重写
 *   为仓内绝对路径,xdt-file/xdt-audio 直读协议照常工作);非媒体落
 *   shared-media/<newId>/ 老路径;
 * 单个失败只记日志返回 null,不阻断导入(渲染端按缺失占位)。
 */
async function restoreMediaEntry(params: {
  entry: MediaMapEntry;
  buffer: Buffer;
  newSessionId: string;
  sharedMediaRoot: string;
  journal: Array<() => Promise<void>>;
  db: LedgerDb;
  assertStillValid: () => void;
  refCompensationScope: MediaRefCompensationScope;
}): Promise<RestoredMedia | null> {
  const { entry, buffer, newSessionId, sharedMediaRoot, journal } = params;
  // 老包媒体入总仓的统一小工具:字节 → blob + import 引用,mime 按已验证来源
  // 的扩展名反查;白名单外/账本不可用返回 null 由调用方走各自回落路径。
  // 白名单即 blobStore 全集(含 .glb 模型)——比"图/音/视频"口径略宽是有意的:
  // xdt-file 直读协议本就放行 .glb,入仓只是换了字节的住处。
  const ingestLegacyMedia = async (
    ext: string,
  ): Promise<{ url: string; absPath: string } | null> => {
    const mimeType = mimeForExt(ext.toLowerCase());
    if (!mimeType) return null;
    try {
      const written = await ingestMedia(
        {
          buffer,
          mimeType,
          refs: [{ refKind: 'import', refId: newSessionId, originKind: 'user' }],
          assertStillValid: params.assertStillValid,
          refCompensationScope: params.refCompensationScope,
        },
        params.db,
      );
      return { url: written.url, absPath: resolveBlobHashRef(written.hash, written.ext).absPath };
    } catch (err) {
      params.assertStillValid();
      log.warn('import media ingest failed, falling back to legacy dir', {
        url: entry.url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
  try {
    if (entry.kind === 'image') {
      const { absPath } = resolveImageUrl(entry.url);
      const cacheRoot = path.resolve(getCacheRoot());
      const parsed = parseImageUrl(entry.url);
      if (absPath.startsWith(cacheRoot + path.sep) && parsed) {
        // per-session 图片:文件名从已验证 URL 解析(resolveSafe 已保证单段),
        // 双保险再过一次单段校验。
        if (!isSafePathSegment(parsed.filename)) return null;
        // 老包 xdt-image 图入总仓,消息里的地址重写为 cindy-media。
        const ingested = await ingestLegacyMedia(path.extname(parsed.filename));
        if (ingested) {
          return { kind: 'session-image', newUrl: ingested.url, viaBlob: true };
        }
        // 回落:老目录写法(白名单外扩展名 / 账本不可用),行为与迁移前一致。
        const targetDir = getSessionDir(newSessionId);
        await fsp.mkdir(targetDir, { recursive: true });
        const target = path.join(targetDir, parsed.filename);
        await writeIfMissing(target, buffer, journal, params.assertStillValid);
        return {
          kind: 'session-image',
          newUrl: `xdt-image://${newSessionId}/${encodeURIComponent(parsed.filename)}`,
        };
      }
      await writeIfMissing(absPath, buffer, journal, params.assertStillValid);
      return { kind: 'reserved' };
    }
    if (entry.kind === 'video') {
      const { absPath } = resolveVideoUrl(entry.url);
      await writeIfMissing(absPath, buffer, journal, params.assertStillValid);
      return { kind: 'reserved' };
    }
    if (entry.kind === 'blob') {
      // cindy-media 内容寻址 blob:不信包内文件名/指纹,**先**按字节重算指纹与
      // URL 声称的指纹比对,不符直接按缺失处理(渲染端占位)——损坏/恶意包
      // 连字节仓和账本都不进,不给"塞垃圾账"留门(review P1)。
      // mime 从**已验证的 URL** 扩展名反查(parseBlobUrl 白名单外返回 null)。
      const parsed = parseBlobUrl(entry.url);
      if (!parsed) return null;
      const mimeType = mimeForExt(parsed.ext);
      if (!mimeType) return null;
      const actualHash = createHash('sha256').update(buffer).digest('hex');
      if (actualHash !== parsed.hash) {
        log.warn('imported blob hash mismatch, treating as missing', {
          url: entry.url,
          actualHash,
        });
        return null;
      }
      // 挂 import 引用(归属导入会话,删会话时随 removeSessionRefs 走)。
      await ingestMedia(
        {
          buffer,
          mimeType,
          refs: [{ refKind: 'import', refId: params.newSessionId, originKind: 'user' }],
          assertStillValid: params.assertStillValid,
          refCompensationScope: params.refCompensationScope,
        },
        params.db,
      );
      return { kind: 'blob' };
    }
    if (entry.kind === 'model') {
      const { absPath } = resolveModelUrl(entry.url);
      await writeIfMissing(absPath, buffer, journal, params.assertStillValid);
      return { kind: 'reserved' };
    }
    // loose:按 zipPath 里带序号的文件名落盘(天然去重),二次单段校验防穿越
    const filename = path.posix.basename(entry.zipPath ?? '');
    if (!isSafePathSegment(filename)) return null;
    const scheme = entry.scheme === 'xdt-audio' ? 'xdt-audio' : 'xdt-file';
    // 媒体 mime 的散件入总仓:?path= 重写为仓内绝对路径,直读协议
    // 照常;非媒体(docx/zip)维持 shared-media 老路径(规则 25 边界)。
    const ingested = await ingestLegacyMedia(path.extname(filename));
    if (ingested) {
      return { kind: 'loose', newUrl: buildLooseUrl(scheme, ingested.absPath), viaBlob: true };
    }
    const targetDir = path.join(sharedMediaRoot, newSessionId);
    await fsp.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, filename);
    await writeIfMissing(target, buffer, journal, params.assertStillValid);
    return { kind: 'loose', newUrl: buildLooseUrl(scheme, target) };
  } catch (err) {
    params.assertStillValid();
    log.warn('restore media entry failed', {
      url: entry.url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** flag:'wx' 写入(已存在跳过复用);真正写入了才登记 journal 删除。 */
async function writeIfMissing(
  target: string,
  buffer: Buffer,
  journal: Array<() => Promise<void>>,
  assertStillValid: () => void,
): Promise<void> {
  assertStillValid();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  assertStillValid();
  try {
    await fsp.writeFile(target, buffer, { flag: 'wx' });
    journal.push(async () => {
      await fsp.rm(target, { force: true });
    });
    assertStillValid();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    assertStillValid();
  }
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PERMISSION_MODES = new Set([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

/** draftPrefs 缺省(旧调用方 / 测试)时按 agentKind 兜底的模型。 */
const FALLBACK_MODEL_BY_AGENT: Record<'cc' | 'codex' | 'pi', string> = {
  cc: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  pi: 'gpt-5.4',
};

/**
 * 组装 tx session.importShare 的 session 行(lead 与协同 Worker 共用)。
 *
 * 字段来源分两类(导入语义 = 用本地草稿默认值新建会话,只有 agent 跟随分享包):
 * - 会话配置(model/effort/permissionMode/planMode/fastMode/providerId)→ 导入端
 *   draftPrefs(白名单校验,非法/缺省落内置兜底),**不读** snapshot——导出方的
 *   模型/供应商在导入端不一定存在,照搬会产出本机不可用的脏 model(选择器显示
 *   不出、发消息才暴露)。draftPrefs 按包顶层 vendor 采集,跨 vendor 的 Worker
 *   经 applyDraftPrefs=false 落内置兜底;Worker 的 permissionMode 固定 auto
 *   (与 OrcaWorkerCreationService 同口径)。
 * - 历史事实(token 统计 / contextTokens / clearedAt / 时间戳等)→ snapshot 照搬。
 *   contextWindow 也照搬:仅是展示缓存,renderer 按 session.model 重新计算。
 */
function buildSessionRow(params: {
  newId: string;
  agentKind: 'cc' | 'codex' | 'pi';
  title: string;
  workspaceKind: string;
  orcaRole: 'lead' | 'worker' | null;
  snapshot: Record<string, unknown>;
  draftPrefs: ShareImportDraftPrefs | null;
  applyDraftPrefs: boolean;
  permissionModeOverride?: string;
  workingDir: string;
  worktreePath: string | null;
  activeSdkSessionId: string | null;
  now: number;
}): SessionImportShareSessionRow {
  const {
    newId,
    agentKind,
    title,
    workspaceKind,
    orcaRole,
    snapshot,
    workingDir,
    worktreePath,
    activeSdkSessionId,
    now,
  } = params;
  const draftPrefs = params.applyDraftPrefs ? params.draftPrefs : null;
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback);
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const effort = str(draftPrefs?.effort, 'high');
  const permissionMode = params.permissionModeOverride ?? str(draftPrefs?.permissionMode, 'auto');
  return {
    id: newId,
    title,
    workingDir,
    workspaceKind,
    worktreePath,
    model: str(draftPrefs?.model, FALLBACK_MODEL_BY_AGENT[agentKind]),
    effort: EFFORTS.has(effort) ? effort : 'high',
    permissionMode: PERMISSION_MODES.has(permissionMode) ? permissionMode : 'auto',
    providerId:
      typeof draftPrefs?.providerId === 'string' && draftPrefs.providerId.length > 0
        ? draftPrefs.providerId
        : null,
    status: 'active',
    sdkSessionId: activeSdkSessionId,
    totalTokenUsage: num(snapshot.totalTokenUsage, 0),
    totalCostUsd: num(snapshot.totalCostUsd, 0),
    contextTokens: num(snapshot.contextTokens, 0),
    contextWindow: num(snapshot.contextWindow, 0),
    fastMode: draftPrefs?.fastMode === true,
    planModeEnabled: draftPrefs?.planMode === true,
    agentKind,
    orcaRole,
    source: 'shared',
    extraDirs: '[]',
    // Shared bundles can come from a build whose product prompt still named
    // lizi_memory (or any future prompt generation). Force the existing one-shot
    // non-proxy restore path instead of trusting a versionless exported boolean.
    codexHistoryHasProductPrompt: agentKind === 'codex' ? false : null,
    // /clear 边界照搬:不带会让 pre-clear 历史在导入端重新显示(review bot 指出)
    clearedAt:
      typeof snapshot.clearedAt === 'number' && Number.isFinite(snapshot.clearedAt)
        ? snapshot.clearedAt
        : null,
    userSendAt: num(snapshot.userSendAt, now),
    createdAt: num(snapshot.createdAt, now),
    updatedAt: now,
  };
}

/**
 * 最终保真度:lead + 全部 Worker 聚合口径。bundledCount 按
 * (agentKind + sdkSessionId) 去重,与 Pi 内容寻址转录的全局去重写盘保持一致。
 * Codex rollout 也计入；transcriptsWritten 是本次真实落位(含复用)数。导出端
 * 已把"导出时就缺"折进 exportFidelity,导入端只对"包里有但没落成"再降档。
 */
function resolveFinalFidelity(params: {
  exportFidelity: XdtshareFidelity;
  bundledCount: number;
  transcriptsWritten: number;
}): XdtshareFidelity {
  const { exportFidelity, bundledCount, transcriptsWritten } = params;
  if (bundledCount === 0 || transcriptsWritten === 0) return 'db-only';
  if (transcriptsWritten < bundledCount) return 'partial';
  return exportFidelity;
}
