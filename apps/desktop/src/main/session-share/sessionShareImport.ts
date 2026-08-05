/**
 * 会话分享导入编排:inspect / unlock / commit / cancel 三段式 + draft registry。
 *
 * 解密后的 zip 驻留 main 内存 draft(TTL 10 分钟),避免向导每步重复解密/重复要
 * 密码;commit 前置校验全过才开始写,写入顺序「先文件后 DB」:
 *   媒体还原 → CC 转录落位(按 B 机 workdir 重新转码目录) / Codex rollout+state
 *   → 最后单事务落 DB(tx session.importShare,原子)。
 * 任何一步失败 → RollbackJournal 逆序清理已写文件(best-effort),DB 因 tx 原子
 * 天然无残留 —— 保证导入中断不留半截会话。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { isClaudeProjectKeyExact, sanitizeClaudeProjectKey } from '@cindy/maker-core';
import { app } from 'electron';

import { getDbClient } from '../localDb/client/current.js';
import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace.js';
import { patchSessionMetaInDb } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import {
  importSharedCodexThread,
  removeSharedCodexThread,
  type ImportSharedCodexThreadResult,
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
import { parseBlobUrl, mimeForExt, resolveHashRef as resolveBlobHashRef } from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { removeSessionRefs as removeSessionMediaRefs } from '../cindy-media/ledger.js';

import { openPayload } from './xdtshareCrypto.js';
import {
  XdtshareError,
  validateManifest,
  type XdtshareFidelity,
  type XdtshareManifest,
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
  agentKind: 'cc' | 'codex';
  workspaceKind: 'project' | 'dialogue';
  originalWorkingDir: string | null;
  exportedAt: string;
  appVersion: string;
  fidelity: XdtshareFidelity;
  messageCount: number;
  mediaCount: number;
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
  };
}

async function loadZipAndManifest(zipBytes: Buffer): Promise<{ zip: JSZip; manifest: XdtshareManifest }> {
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
  /** 冲突覆盖:同 resume id 的存活会话已存在时,软删旧会话后继续导入(替换而非叠加)。 */
  overwrite?: boolean;
}

export interface CommitShareImportResult {
  sessionId: string;
  fidelity: XdtshareFidelity;
  /** 需要用户知晓的降档/提示信息 key(renderer 翻译)。 */
  notes: string[];
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

/** 第三段:落三层数据。前置校验全过才写;文件步登记 journal,失败逆序回滚。 */
export async function commitShareImport(
  opts: CommitShareImportOptions,
): Promise<CommitShareImportResult> {
  sweepExpiredDrafts();
  const draft = drafts.get(opts.draftId);
  if (!draft) throw codedError('NOT_FOUND', 'draft expired or not found');
  if (!draft.zip || !draft.manifest) {
    throw codedError('SHARE_PASSWORD_REQUIRED', 'draft is still locked');
  }
  const { zip, manifest } = draft;

  // ── 解析包内数据(仍属只读阶段) ──
  const sessionSnapshot = await readJsonEntry(zip, 'session.json');
  const messages = await readMessagesJsonl(zip);
  if (messages.length === 0) throw codedError('SHARE_FILE_INVALID', 'bundle has no messages');
  const mediaMap = await readMediaMap(zip);

  // ── 前置校验 ──
  const now = Date.now();
  const newId = randomUUID();
  let workingDir: string;
  if (manifest.workspaceKind === 'project') {
    const dir = typeof opts.workingDir === 'string' ? opts.workingDir.trim() : '';
    if (!dir) throw codedError('INVALID_PARAMS', 'workingDir is required for project sessions');
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw codedError('PRECONDITION_FAILED', 'workingDir does not exist or is not a directory');
    }
    workingDir = dir;
  } else {
    workingDir = ensureDialogueWorkspaceDir(newId, now);
  }

  // activeSdkSessionId 同样是不可信输入,且会流入落盘路径:codex 侧
  // importSharedCodexThread 的 rollout 文件名兜底会把 threadId 拼进 filename,
  // CC 侧 resume 也按 `<id>.jsonl` 定位转录——非单路径段一律拒整包(审查 P0)。
  const activeSdkSessionId = manifest.activeSdkSessionId;
  if (activeSdkSessionId && !isSafePathSegment(activeSdkSessionId)) {
    throw new XdtshareError('SHARE_FILE_INVALID', `unsafe activeSdkSessionId: ${activeSdkSessionId}`);
  }
  // 互斥判定的唯一权威:DB 里是否已有同 agent + 同 resume id 的**存活**会话行。
  // 刻意排除 status='deleted'——删除会话不清理盘上的转录/rollout/state,重导同一
  // 分享包时下方文件层一律「存在即复用、绝不覆盖」,不把盘上残留当成冲突。
  // overwrite = 用户在冲突弹窗确认"覆盖导入":记下旧会话,写入阶段先软删它,
  // 再走既有的"已删除会话重导"路径(盘上转录复用)——净效果是替换而非叠加。
  let conflictExisting: { id: string; status: string } | null = null;
  if (activeSdkSessionId) {
    const existing = await getDbClient().queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM sessions
       WHERE agent_kind = ? AND sdk_session_id = ? AND status != 'deleted' LIMIT 1`,
      [manifest.agentKind, activeSdkSessionId],
    );
    if (existing) {
      if (!opts.overwrite) {
        throw codedError('SHARE_CONFLICT', `session with same resume id already imported: ${existing.id}`);
      }
      conflictExisting = existing;
    }
  }

  const projectsRoot =
    opts.projectsRootOverride ?? path.join(defaultClaudeConfigDirCandidates()[0], 'projects');
  const bundledTranscripts = manifest.transcripts.filter(
    (t): t is { sdkSessionId: string; path: string } => t.path !== null,
  );
  // .xdtshare 是他人给的不可信输入:sdkSessionId 会拼进落盘路径(`<id>.jsonl`),
  // 恶意包塞 `../../evil` 可逃出转码目录写任意文件(review bot P1)。写盘/预检前
  // 先整体校验为单路径段,非法直接拒绝整包。
  for (const t of bundledTranscripts) {
    if (!isSafePathSegment(t.sdkSessionId)) {
      throw new XdtshareError('SHARE_FILE_INVALID', `unsafe sdkSessionId in transcripts: ${t.sdkSessionId}`);
    }
  }
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

  try {
    // 0. 覆盖导入:软删旧会话(复用手动删除的完整语义——DB 更新 + 图片缓存清理 +
    //    sessions:patched 广播,sidebar 即时移除),并登记 journal 恢复原 status:
    //    后续任一步失败逆序回滚时旧会话回到列表,不丢用户数据。
    if (conflictExisting) {
      const { id: existingId, status: prevStatus } = conflictExisting;
      await patchSessionMetaInDb(existingId, { status: 'deleted' });
      journal.push(async () => {
        await patchSessionMetaInDb(existingId, {
          status: prevStatus === 'archived' ? 'archived' : 'active',
        });
      });
      log.info('share import overwrite: soft-deleted existing session', {
        existingId,
        prevStatus,
      });
    }

    // 0b. worktree(仅 project 会话 + 用户勾选):以所选目录的 git 仓库根为
    //     baseRepo 建会话级 worktree,后续所有 workingDir 相关落位(CC 转录转码
    //     目录 / codex cwd / session 行)一律指向 worktree 路径——与 New Maker
    //     草稿开 worktree 创建同语义。失败即中止导入;成功登记 journal,后续
    //     任一步失败逆序回滚时移除 worktree,不留孤儿。
    if (opts.useWorktree && manifest.workspaceKind === 'project') {
      const detect = await detectCwd(workingDir).catch(() => null);
      if (!detect?.isGitRepo || !detect.repoRoot) {
        throw codedError(
          'SHARE_WORKTREE_NOT_GIT',
          'selected workingDir is not inside a git repository',
        );
      }
      const baseRepo = detect.repoRoot;
      let wtName = (await suggestWorktreeName(baseRepo).catch(() => '')).trim();
      if (!wtName) wtName = `auto-${Date.now().toString(36).slice(-6)}`;
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
      log.info('share import created worktree', { newId, baseRepo, worktreePath });
    }

    // CC 转录转码目录依赖**最终** workingDir(可能已切到 worktree),必须在
    // worktree 步之后计算。盘上已有同名转录不算冲突(典型是删除 Maker 会话后
    // 重导——软删不清理转录):写入步用 wx 独占写,已存在则复用盘上副本,绝不
    // 覆盖(sdk id 是 UUID,同名即同一会话,且盘上副本可能含删除前 resume 产生
    // 的更新内容)。
    let claudeTargetDir: string | null = null;
    let transcriptsPlaceable = true;
    if (manifest.agentKind === 'cc' && bundledTranscripts.length > 0) {
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
      const buffer = Buffer.from(await file.async('nodebuffer'));
      const restored = await restoreMediaEntry({
        entry,
        buffer,
        newSessionId: newId,
        sharedMediaRoot,
        journal,
      });
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
        await removeSessionMediaRefs(newId).catch(() => undefined);
      });
    }

    // 2a. CC 转录落位(B 机 workdir 重新转码目录)。wx 独占写:已存在(删除后
    //     重导 / 同源 CLI 转录)则复用盘上副本不覆盖,也不进 journal——回滚
    //     只删本次真实写入的文件。复用同样计入 transcriptsWritten(resume 可用,
    //     保真度不降档)。
    let transcriptsWritten = 0;
    if (manifest.agentKind === 'cc' && claudeTargetDir && transcriptsPlaceable) {
      await fsp.mkdir(claudeTargetDir, { recursive: true });
      for (const t of bundledTranscripts) {
        const file = zip.file(t.path);
        if (!file) continue;
        const target = path.join(claudeTargetDir, `${t.sdkSessionId}.jsonl`);
        try {
          await fsp.writeFile(target, Buffer.from(await file.async('nodebuffer')), { flag: 'wx' });
          journal.push(async () => {
            await fsp.rm(target, { force: true });
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          log.info('transcript already on disk, reusing', { sdkSessionId: t.sdkSessionId });
        }
        transcriptsWritten += 1;
      }
    }

    // 2b. Codex rollout + state 落位
    let codexWritten: ImportSharedCodexThreadResult | null = null;
    if (manifest.agentKind === 'codex' && activeSdkSessionId) {
      const stateEntry = zip.file('codex-state/thread.json');
      const stateRows = stateEntry
        ? ((JSON.parse(await stateEntry.async('string'))) as {
            threads: Array<Record<string, unknown>>;
            threadDynamicTools: Array<Record<string, unknown>>;
            threadSpawnEdges: Array<Record<string, unknown>>;
          })
        : { threads: [], threadDynamicTools: [], threadSpawnEdges: [] };
      const rolloutRef = bundledTranscripts[0] ?? null;
      const rolloutFile = rolloutRef ? zip.file(rolloutRef.path) : null;
      codexWritten = await importSharedCodexThread({
        threadId: activeSdkSessionId,
        stateRows,
        rolloutBuffer: rolloutFile ? Buffer.from(await rolloutFile.async('nodebuffer')) : null,
        rolloutFilename: rolloutRef ? path.posix.basename(rolloutRef.path) : null,
        newCwd: workingDir,
        title: manifest.title,
        updatedAt: now,
      });
      const written = codexWritten;
      journal.push(async () => {
        await removeSharedCodexThread(activeSdkSessionId, written);
      });
      // 降档提示看 statePresent(state 行最终在不在),不能看 stateWritten——
      // 删除后重导时行已存在、本次零插入,state 依然完好,不该提示。
      if (!written.statePresent && stateRows.threads.length > 0) {
        notes.push('codexStateSkipped');
      }
    }

    // 3. DB 最后一步(tx 原子):message id 重新生成防撞库,content 过媒体重写
    const rewriteRules = urlMap.size > 0 ? { urlMap } : {};
    const dbMessages = messages.map((m) => ({
      id: randomUUID(),
      clientId: m.clientId,
      role: m.role,
      content: rewriteMediaUrls(m.content, rewriteRules),
      toolUseId: m.toolUseId,
      agentMeta: m.agentMeta,
      agentKind: m.agentKind,
      createdAt: m.createdAt,
      rewindAt: m.rewindAt,
    }));
    await getDbClient().tx('session.importShare', {
      session: buildSessionRow({
        newId,
        manifest,
        snapshot: sessionSnapshot,
        draftPrefs: opts.draftPrefs ?? null,
        workingDir,
        worktreePath,
        activeSdkSessionId,
        now,
      }),
      messages: dbMessages,
    });

    // ── 最终保真度 ──
    const fidelity = resolveFinalFidelity({
      manifest,
      transcriptsWritten,
      bundledCount: bundledTranscripts.length,
      codexWritten,
    });
    if (manifest.agentKind === 'cc' && !transcriptsPlaceable) notes.push('workdirKeyInexact');
    log.info('session share imported', {
      newId,
      agentKind: manifest.agentKind,
      fidelity,
      messages: dbMessages.length,
      transcriptsWritten,
      notes,
    });
    drafts.delete(opts.draftId);
    return { sessionId: newId, fidelity, notes };
  } catch (err) {
    await rollback();
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code !== 'ALREADY_EXISTS') throw err;
    throw codedError(
      'SHARE_IMPORT_FAILED',
      err instanceof Error ? err.message : String(err),
    );
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw codedError('SHARE_FILE_INVALID', `${entryPath} is not valid JSON`);
  }
}

async function readMessagesJsonl(zip: JSZip): Promise<BundleMessageRow[]> {
  const file = zip.file('messages.jsonl');
  if (!file) throw codedError('SHARE_FILE_INVALID', 'messages.jsonl missing');
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
}): Promise<RestoredMedia | null> {
  const { entry, buffer, newSessionId, sharedMediaRoot, journal } = params;
  // 老包媒体入总仓的统一小工具:字节 → blob + import 引用,mime 按已验证来源
  // 的扩展名反查;白名单外/账本不可用返回 null 由调用方走各自回落路径。
  // 白名单即 blobStore 全集(含 .glb 模型)——比"图/音/视频"口径略宽是有意的:
  // xdt-file 直读协议本就放行 .glb,入仓只是换了字节的住处。
  const ingestLegacyMedia = async (ext: string): Promise<{ url: string; absPath: string } | null> => {
    const mimeType = mimeForExt(ext.toLowerCase());
    if (!mimeType) return null;
    try {
      const written = await ingestMedia({
        buffer,
        mimeType,
        refs: [{ refKind: 'import', refId: newSessionId, originKind: 'user' }],
      });
      return { url: written.url, absPath: resolveBlobHashRef(written.hash, written.ext).absPath };
    } catch (err) {
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
        await writeIfMissing(target, buffer, journal);
        return {
          kind: 'session-image',
          newUrl: `xdt-image://${newSessionId}/${encodeURIComponent(parsed.filename)}`,
        };
      }
      await writeIfMissing(absPath, buffer, journal);
      return { kind: 'reserved' };
    }
    if (entry.kind === 'video') {
      const { absPath } = resolveVideoUrl(entry.url);
      await writeIfMissing(absPath, buffer, journal);
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
      await ingestMedia({
        buffer,
        mimeType,
        refs: [{ refKind: 'import', refId: params.newSessionId, originKind: 'user' }],
      });
      return { kind: 'blob' };
    }
    if (entry.kind === 'model') {
      const { absPath } = resolveModelUrl(entry.url);
      await writeIfMissing(absPath, buffer, journal);
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
    await writeIfMissing(target, buffer, journal);
    return { kind: 'loose', newUrl: buildLooseUrl(scheme, target) };
  } catch (err) {
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
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.writeFile(target, buffer, { flag: 'wx' });
    journal.push(async () => {
      await fsp.rm(target, { force: true });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PERMISSION_MODES = new Set(['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

/** draftPrefs 缺省(旧调用方 / 测试)时按 agentKind 兜底的模型。 */
const FALLBACK_MODEL_BY_AGENT: Record<'cc' | 'codex', string> = {
  cc: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
};

/**
 * 组装 tx session.importShare 的 session 行。
 *
 * 字段来源分两类(导入语义 = 用本地草稿默认值新建会话,只有 agent 跟随分享包):
 * - 会话配置(model/effort/permissionMode/planMode/fastMode/providerId)→ 导入端
 *   draftPrefs(白名单校验,非法/缺省落内置兜底),**不读** snapshot——导出方的
 *   模型/供应商在导入端不一定存在,照搬会产出本机不可用的脏 model(选择器显示
 *   不出、发消息才暴露)。
 * - 历史事实(token 统计 / contextTokens / clearedAt / 时间戳等)→ snapshot 照搬。
 *   contextWindow 也照搬:仅是展示缓存,renderer 按 session.model 重新计算。
 */
function buildSessionRow(params: {
  newId: string;
  manifest: XdtshareManifest;
  snapshot: Record<string, unknown>;
  draftPrefs: ShareImportDraftPrefs | null;
  workingDir: string;
  worktreePath: string | null;
  activeSdkSessionId: string | null;
  now: number;
}): {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: string;
  worktreePath: string | null;
  model: string;
  effort: string;
  permissionMode: string;
  providerId: string | null;
  status: string;
  sdkSessionId: string | null;
  totalTokenUsage: number;
  totalCostUsd: number;
  contextTokens: number;
  contextWindow: number;
  fastMode: boolean;
  planModeEnabled: boolean;
  agentKind: string;
  source: string;
  extraDirs: string;
  codexHistoryHasProductPrompt: boolean | null;
  clearedAt: number | null;
  userSendAt: number | null;
  createdAt: number;
  updatedAt: number;
} {
  const { newId, manifest, snapshot, draftPrefs, workingDir, worktreePath, activeSdkSessionId, now } =
    params;
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const effort = str(draftPrefs?.effort, 'high');
  const permissionMode = str(draftPrefs?.permissionMode, 'auto');
  return {
    id: newId,
    title: manifest.title || 'Shared session',
    workingDir,
    workspaceKind: manifest.workspaceKind,
    worktreePath,
    model: str(draftPrefs?.model, FALLBACK_MODEL_BY_AGENT[manifest.agentKind]),
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
    agentKind: manifest.agentKind,
    source: 'shared',
    extraDirs: '[]',
    // Shared bundles can come from a build whose product prompt still named
    // lizi_memory (or any future prompt generation). Force the existing one-shot
    // non-proxy restore path instead of trusting a versionless exported boolean.
    codexHistoryHasProductPrompt: manifest.agentKind === 'codex' ? false : null,
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

function resolveFinalFidelity(params: {
  manifest: XdtshareManifest;
  transcriptsWritten: number;
  bundledCount: number;
  codexWritten: ImportSharedCodexThreadResult | null;
}): XdtshareFidelity {
  const { manifest, transcriptsWritten, bundledCount, codexWritten } = params;
  if (manifest.agentKind === 'codex') {
    if (!codexWritten?.rolloutPath) return 'db-only';
    return manifest.exportFidelity === 'full' ? 'full' : manifest.exportFidelity;
  }
  if (bundledCount === 0 || transcriptsWritten === 0) return 'db-only';
  if (transcriptsWritten < manifest.transcripts.length) return 'partial';
  return manifest.exportFidelity;
}
