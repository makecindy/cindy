/**
 * 会话分享导出编排:把一个本机会话(cc / codex)打成 .xdtshare 文件。
 *
 * 数据三层的收集策略:
 *   1. 本地 DB:session 行(白名单字段)+ messages(含 rewind 链,忠实快照;
 *      但遵守 clearedAt 边界——/clear 之前的消息全应用都不可见,分享包同样
 *      不得携带,否则用户清掉敏感内容后分享会静默泄漏);
 *   2. vendor 转录:cc 按三源并集 sdkSessionId 逐个定位 jsonl(fork 链全带),
 *      codex dump state 三表行 + rollout 文件;找不到的记 manifest(保真度降档);
 *   3. 媒体:5 种协议 URL 全收集,托管缓存类(image/video/model)与绝对路径
 *      引用类(file/audio)分别解析落包,单文件失败记缺失不阻断。
 *
 * 快照语义:导出不关闭活跃 handle、不加锁;流式输出中的会话可能差最后一轮。
 * 写盘用「同目录 .tmp + rename」保证目标文件原子出现。
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import JSZip from 'jszip';
import { findClaudeSessionJsonl } from '@cindy/maker-core';

import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { collectClaudeSdkSessionIds } from '../maker-host/claude-transcript-relocation.js';
import {
  dumpCodexThreadStateRows,
  type CodexThreadStateDump,
} from '../maker-host/codex-local-sessions.js';
import { defaultClaudeConfigDirCandidates } from '../maker-orchestration/claudeTranscriptAnchors.js';
import { resolveSafe as resolveImageUrl } from '../imageCacheStore.js';
import { resolveSafe as resolveVideoUrl } from '../videoCacheStore.js';
import { resolveSafe as resolveModelUrl } from '../modelCacheStore.js';
import { resolveSafe as resolveCindyMediaUrl, getBlobsRoot as cindyMediaBlobsRoot } from '../cindy-media/blobStore.js';
import { app } from 'electron';

import {
  XDTSHARE_FORMAT_VERSION,
  XDTSHARE_MIN_READER_VERSION,
  type XdtshareFidelity,
  type XdtshareManifest,
  type XdtshareManifestEntry,
  type XdtshareTranscriptRef,
} from './xdtshareFormat.pure.js';
import { buildPlainFile, sealPayload } from './xdtshareCrypto.js';
import {
  collectMediaUrls,
  extractLoosePath,
  parseImageUrl,
  type MediaScheme,
} from './mediaUrlRewrite.pure.js';

const log = createLogger('session-share-export');

/**
 * 未压缩总量上限(消息文本 + 转录 + 媒体)。jszip 全内存打包发生在 main 进程,
 * 峰值 ≈ 输入总量 + zip 输出 + (加密时)一份密文——OOM 崩的是整个 app 而不是
 * 单次导出,故上限取 256MB(低配 Windows 机也安全;review bot 指出 1GB 时峰值
 * 可到 2GB+)。更大的会话走「排除媒体重试」;流式落盘作为后续优化。
 */
export const SHARE_EXPORT_SIZE_LIMIT_BYTES = 256 * 1024 * 1024;

export interface SessionShareExportOptions {
  sessionId: string;
  targetPath: string;
  password?: string | null;
  /** 超限重试时由 renderer 显式传入:跳过全部媒体,只保消息文本与转录。 */
  excludeMedia?: boolean;
  /** 仅测试用:覆盖体积上限(默认 SHARE_EXPORT_SIZE_LIMIT_BYTES)。 */
  sizeLimitBytes?: number;
}

export type SessionShareExportOutcome =
  | {
      status: 'ok';
      filePath: string;
      fidelity: XdtshareFidelity;
      /** 导出端没找到转录的 sdkSessionId 列表(cc fork 链部分缺失时非空)。 */
      missingTranscripts: string[];
      /** 引用了但文件已不存在的媒体数。 */
      mediaMissing: number;
    }
  | { status: 'oversize'; totalBytes: number; mediaBytes: number; limitBytes: number };

/** media-map.json 的条目(导入端按它落位与重写 URL)。 */
export interface MediaMapEntry {
  url: string;
  scheme: MediaScheme;
  kind: 'image' | 'video' | 'model' | 'loose' | 'blob';
  /** zip 内路径;null = 导出时文件已缺失。 */
  zipPath: string | null;
  /** image 专用:URL host 段(sessionId 或 reserved host),导入端判断是否重写。 */
  imageHost?: string;
  filename: string;
}

interface SessionRow {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: string;
  model: string;
  effort: string;
  permissionMode: string;
  status: string;
  sdkSessionId: string | null;
  totalTokenUsage: number;
  totalCostUsd: number;
  contextTokens: number;
  contextWindow: number;
  fastMode: number;
  planModeEnabled: number;
  agentKind: string;
  orcaRole: string | null;
  remoteHostId: string | null;
  codexHistoryHasProductPrompt: number | null;
  clearedAt: number | null;
  userSendAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface MessageRow {
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

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function exportSessionShare(
  opts: SessionShareExportOptions,
): Promise<SessionShareExportOutcome> {
  const session = await readSessionRow(opts.sessionId);
  if (!session) throw codedError('NOT_FOUND', `session not found: ${opts.sessionId}`);
  if (session.status === 'deleted') {
    throw codedError('NOT_FOUND', 'session is deleted');
  }
  // remote / orca 会话的转录在远端机器或协同关系图里,本地打包必然缺,直接拒绝
  // (renderer 侧菜单已隐藏,这里是双保险)。
  if (session.remoteHostId) {
    throw codedError('PRECONDITION_FAILED', 'remote sessions cannot be exported');
  }
  if (session.orcaRole) {
    throw codedError('PRECONDITION_FAILED', 'orca team sessions cannot be exported');
  }
  if (session.agentKind !== 'cc' && session.agentKind !== 'codex') {
    throw codedError('PRECONDITION_FAILED', `unsupported agentKind: ${session.agentKind}`);
  }

  const messages = await readMessageRows(opts.sessionId, session.clearedAt);
  if (messages.length === 0) {
    throw codedError('SHARE_EXPORT_FAILED', 'session has no messages to share');
  }

  // ── 阶段 A:候选收集,只 stat 不读——体积门禁必须在任何大文件进内存之前判
  //    (review bot 指出:先读后判会让超限媒体先把内存吃满,门禁形同虚设)。──
  let sdkSessionIds: string[] = [];
  let activeSdkSessionId: string | null = null;
  const transcriptCandidates: Array<{ sdkSessionId: string; zipPath: string; absPath: string; bytes: number }> = [];
  const transcriptRefs: XdtshareTranscriptRef[] = [];
  let codexState: CodexThreadStateDump | null = null;

  const statSize = async (absPath: string): Promise<number | null> => {
    const stat = await fsp.stat(absPath).catch(() => null);
    return stat?.isFile() && stat.size > 0 ? stat.size : null;
  };

  if (session.agentKind === 'cc') {
    const collected = await collectClaudeSdkSessionIds(opts.sessionId);
    sdkSessionIds = collected.ids;
    activeSdkSessionId = collected.activeId;
    // clearedAt 边界(review bot P1):collect 的三源并集含 pre-clear 消息
    // agent_meta 里的旧 fork id,直接用会把 /clear 已隐藏的旧转录打进包。
    // 只保留「post-clear 消息仍引用的 + 活跃 + DB 行」id(/clear 会把 DB 行
    // sdkSessionId 置 null,后两者天然是 post-clear 的)。
    if (session.clearedAt != null) {
      const allowed = new Set<string>();
      if (collected.activeId) allowed.add(collected.activeId);
      if (session.sdkSessionId) allowed.add(session.sdkSessionId);
      for (const m of messages) {
        if (!m.agentMeta) continue;
        try {
          const sid = (JSON.parse(m.agentMeta) as { sdkSessionId?: unknown }).sdkSessionId;
          if (typeof sid === 'string' && sid.trim()) allowed.add(sid.trim());
        } catch {
          // 历史消息可能带坏 JSON 的 agent_meta,与其它读路径同口径容忍
        }
      }
      sdkSessionIds = sdkSessionIds.filter((id) => allowed.has(id));
    }
    // 与 loadClaudeTranscriptAnchorIndex 同口径:遍历全部候选目录
    // (CLAUDE_CONFIG_DIR → XDT_USER_DATA_DIR/claude-home → ~/.claude),
    // 只查第一个会把落在后续候选的 jsonl 误记缺失(review bot P1)。
    const projectsRoots = defaultClaudeConfigDirCandidates().map((dir) =>
      path.join(dir, 'projects'),
    );
    for (const sid of sdkSessionIds) {
      let jsonl: string | null = null;
      for (const projectsRoot of projectsRoots) {
        jsonl = await findClaudeSessionJsonl(sid, session.workingDir ?? undefined, projectsRoot);
        if (jsonl) break;
      }
      const bytes = jsonl ? await statSize(jsonl) : null;
      if (jsonl && bytes) {
        const zipPath = `transcripts/claude/${sid}.jsonl`;
        transcriptCandidates.push({ sdkSessionId: sid, zipPath, absPath: jsonl, bytes });
        transcriptRefs.push({ sdkSessionId: sid, path: zipPath });
      } else {
        transcriptRefs.push({ sdkSessionId: sid, path: null });
      }
    }
  } else {
    activeSdkSessionId = session.sdkSessionId;
    sdkSessionIds = session.sdkSessionId ? [session.sdkSessionId] : [];
    if (session.sdkSessionId) {
      codexState = await dumpCodexThreadStateRows(session.sdkSessionId);
      const bytes = codexState.rolloutPath ? await statSize(codexState.rolloutPath) : null;
      if (codexState.rolloutPath && bytes) {
        const zipPath = `transcripts/codex/${path.basename(codexState.rolloutPath)}`;
        transcriptCandidates.push({
          sdkSessionId: session.sdkSessionId,
          zipPath,
          absPath: codexState.rolloutPath,
          bytes,
        });
        transcriptRefs.push({ sdkSessionId: session.sdkSessionId, path: zipPath });
      } else {
        transcriptRefs.push({ sdkSessionId: session.sdkSessionId, path: null });
      }
    }
  }

  const mediaMap: MediaMapEntry[] = [];
  const mediaCandidates: Array<{
    entry: MediaMapEntry;
    absPath: string;
    folder: string;
    bytes: number;
  }> = [];
  if (!opts.excludeMedia) {
    // loose(xdt-file/xdt-audio)的 ?path= 指向本机任意绝对路径。为防被塞进消息
    // 文本的 URL 把无关本地文件(如凭证)静默打进分享包,只放行 userData/cc-agent
    // 受管媒体区内的路径(mivo 音频等产品自己落的文件)。user 消息也不豁免:
    // 真实附件持久化在 content 的 files[](不走 URL 文本),文本里出现的 loose
    // URL 只可能是粘贴/导入的内容,不能作为导出任意本地文件的依据(review bot
    // 指出的来源审计口径;files[] 附件落包属 format 演进,记 follow-up)。
    // realpath 双侧归一后再比前缀:纯字符串前缀判定会被受管区内的
    // symlink / Windows junction 指到区外绕过(review bot 指出);顺带解决
    // Windows 盘符大小写与 macOS /var → /private/var 的别名差异。
    // 受管区两个根:历史 cc-agent + 媒体总仓 blobs(导入会把 loose 媒体
    // 入仓后,?path= 指向 blobs 内路径,再导出必须放行,否则附件在二次分享时
    // 静默丢失——review P1 的闭环回归)。
    const managedMediaRoots: string[] = [];
    for (const root of [
      path.resolve(path.join(app.getPath('userData'), 'cc-agent')),
      path.resolve(cindyMediaBlobsRoot()),
    ]) {
      managedMediaRoots.push(await fsp.realpath(root).catch(() => root));
    }
    const isManagedMediaPath = async (p: string): Promise<boolean> => {
      const real = await fsp.realpath(p).catch(() => null);
      if (!real) return false; // 路径不存在/不可达:按缺失处理
      return managedMediaRoots.some((r) => real === r || real.startsWith(r + path.sep));
    };
    const seenUrls = new Set<string>();
    for (const message of messages) {
      for (const { scheme, url } of collectMediaUrls(message.content)) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const resolved = resolveMediaFile(scheme, url);
        if (!resolved) continue; // 非法 URL:不进 map,导入端原样保留
        const looseBlocked =
          resolved.entry.kind === 'loose' &&
          (!resolved.absPath || !(await isManagedMediaPath(resolved.absPath)));
        const bytes = !looseBlocked && resolved.absPath ? await statSize(resolved.absPath) : null;
        if (!bytes) {
          mediaMap.push({ ...resolved.entry, zipPath: null });
          continue;
        }
        mediaCandidates.push({
          entry: resolved.entry,
          absPath: resolved.absPath!,
          folder: resolved.folder,
          bytes,
        });
      }
    }
  }

  // ── 体积门禁(未压缩总量,基于 stat 尺寸,此时尚未读任何大文件) ──
  const messagesBytes = messages.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0);
  const transcriptBytes = transcriptCandidates.reduce((sum, f) => sum + f.bytes, 0);
  const mediaBytes = mediaCandidates.reduce((sum, f) => sum + f.bytes, 0);
  const totalBytes = messagesBytes + transcriptBytes + mediaBytes;
  const limitBytes = opts.sizeLimitBytes ?? SHARE_EXPORT_SIZE_LIMIT_BYTES;
  if (totalBytes > limitBytes) {
    return { status: 'oversize', totalBytes, mediaBytes, limitBytes };
  }

  // ── 阶段 B:真正读入。读失败(stat 后被删/权限/盘不可用)与缺失同等降档,
  //    不让单文件问题炸掉整次导出;转录读失败同步把 ref 回落 null,保真度按
  //    实际落包结果判。──
  const transcriptFiles: Array<{ zipPath: string; buffer: Buffer }> = [];
  for (const candidate of transcriptCandidates) {
    const buffer = await fsp.readFile(candidate.absPath).catch(() => null);
    if (buffer && buffer.length > 0) {
      transcriptFiles.push({ zipPath: candidate.zipPath, buffer });
    } else {
      const ref = transcriptRefs.find((r) => r.path === candidate.zipPath);
      if (ref) ref.path = null;
    }
  }
  const mediaFiles: Array<{ zipPath: string; buffer: Buffer }> = [];
  let mediaIndex = 0;
  for (const candidate of mediaCandidates) {
    const buffer = await fsp.readFile(candidate.absPath).catch(() => null);
    if (!buffer || buffer.length === 0) {
      mediaMap.push({ ...candidate.entry, zipPath: null });
      continue;
    }
    mediaIndex += 1;
    const zipPath = `media/${candidate.folder}/${mediaIndex}-${candidate.entry.filename}`;
    mediaMap.push({ ...candidate.entry, zipPath });
    mediaFiles.push({ zipPath, buffer });
  }

  // ── 保真度判定(按实际读入结果) ──
  const foundCount = transcriptRefs.filter((t) => t.path !== null).length;
  let fidelity: XdtshareFidelity;
  if (transcriptRefs.length === 0 || foundCount === 0) fidelity = 'db-only';
  else if (foundCount === transcriptRefs.length) fidelity = 'full';
  else fidelity = 'partial';

  // ── 打 zip ──
  const zip = new JSZip();
  const entries: XdtshareManifestEntry[] = [];
  // sha256 大 buffer 分块 + 块间让出:与 sealPayload 的 AES 分块同一套节奏,
  // 否则单文件百 MB 级转录/媒体的同步哈希会把刚做的异步化收益抵消掉
  // (review bot 指出);小 entry 一把算完不付调度开销。
  const HASH_CHUNK_BYTES = 8 * 1024 * 1024;
  const addEntry = async (zipPath: string, content: Buffer | string): Promise<void> => {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    zip.file(zipPath, buf);
    const hash = createHash('sha256');
    if (buf.length <= HASH_CHUNK_BYTES) {
      hash.update(buf);
    } else {
      for (let offset = 0; offset < buf.length; offset += HASH_CHUNK_BYTES) {
        hash.update(buf.subarray(offset, offset + HASH_CHUNK_BYTES));
        await yieldToEventLoop();
      }
    }
    entries.push({ path: zipPath, bytes: buf.length, sha256: hash.digest('hex') });
  };

  await addEntry(
    'session.json',
    JSON.stringify(buildSessionSnapshot(session, activeSdkSessionId), null, 2),
  );
  await addEntry('messages.jsonl', messages.map((m) => JSON.stringify(m)).join('\n'));
  for (const f of transcriptFiles) await addEntry(f.zipPath, f.buffer);
  if (codexState) {
    await addEntry(
      'codex-state/thread.json',
      JSON.stringify(
        {
          threads: codexState.threads,
          threadDynamicTools: codexState.threadDynamicTools,
          threadSpawnEdges: codexState.threadSpawnEdges,
        },
        null,
        2,
      ),
    );
  }
  for (const f of mediaFiles) await addEntry(f.zipPath, f.buffer);
  await addEntry('media-map.json', JSON.stringify({ entries: mediaMap }, null, 2));

  const manifest: XdtshareManifest = {
    formatVersion: XDTSHARE_FORMAT_VERSION,
    minReaderVersion: XDTSHARE_MIN_READER_VERSION,
    appVersion: safeAppVersion(),
    platform: process.platform,
    exportedAt: new Date().toISOString(),
    agentKind: session.agentKind as 'cc' | 'codex',
    title: session.title,
    workspaceKind: session.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    originalWorkingDir: session.workingDir,
    sdkSessionIds,
    activeSdkSessionId,
    exportFidelity: fidelity,
    counts: { messages: messages.length, media: mediaFiles.length },
    entries,
    transcripts: transcriptRefs,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const zipBytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const fileBytes = opts.password
    ? await sealPayload(zipBytes, opts.password)
    : buildPlainFile(zipBytes);

  // 同目录 tmp + rename:保证同卷原子;失败时清掉 tmp 不留残渣。
  // tmp 名带随机段 + 'wx' 独占创建:固定 `${target}.tmp` 可被共享目录里预先
  // 种下的同名 symlink 劫持(writeFile 跟随链接覆盖任意目标,review bot 指出),
  // 随机名不可预测,wx 在路径已存在(含 symlink)时直接 EEXIST 拒写。
  const tmpPath = `${opts.targetPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmpPath, fileBytes, { flag: 'wx' });
    await fsp.rename(tmpPath, opts.targetPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const missingTranscripts = transcriptRefs.filter((t) => t.path === null).map((t) => t.sdkSessionId);
  const mediaMissing = mediaMap.filter((m) => m.zipPath === null).length;
  log.info('session share exported', {
    sessionId: opts.sessionId,
    agentKind: session.agentKind,
    fidelity,
    messages: messages.length,
    transcripts: transcriptFiles.length,
    missingTranscripts: missingTranscripts.length,
    media: mediaFiles.length,
    mediaMissing,
    encrypted: !!opts.password,
    fileBytes: fileBytes.length,
  });
  return { status: 'ok', filePath: opts.targetPath, fidelity, missingTranscripts, mediaMissing };
}

/**
 * session.json 白名单快照(不带 providerId/extraDirs/worktree 等本机绑定字段)。
 * sdkSessionId 取三源并集算出的活跃 id(内存态可能新于 DB 行,review bot 指出
 * 用 DB 陈旧值会让导入端 resume 到旧 fork),兜底才用 DB 行。
 */
function buildSessionSnapshot(
  session: SessionRow,
  activeSdkSessionId: string | null,
): Record<string, unknown> {
  return {
    title: session.title,
    workspaceKind: session.workspaceKind,
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    sdkSessionId: activeSdkSessionId ?? session.sdkSessionId,
    totalTokenUsage: session.totalTokenUsage,
    totalCostUsd: session.totalCostUsd,
    contextTokens: session.contextTokens,
    contextWindow: session.contextWindow,
    fastMode: !!session.fastMode,
    planModeEnabled: !!session.planModeEnabled,
    agentKind: session.agentKind,
    codexHistoryHasProductPrompt:
      session.codexHistoryHasProductPrompt == null ? null : !!session.codexHistoryHasProductPrompt,
    clearedAt: session.clearedAt,
    userSendAt: session.userSendAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function resolveMediaFile(
  scheme: MediaScheme,
  url: string,
): { entry: MediaMapEntry; absPath: string | null; folder: string } | null {
  try {
    switch (scheme) {
      case 'xdt-image': {
        const parsed = parseImageUrl(url);
        if (!parsed) return null;
        const { absPath } = resolveImageUrl(url);
        return {
          entry: {
            url,
            scheme,
            kind: 'image',
            zipPath: null,
            imageHost: parsed.host,
            filename: parsed.filename,
          },
          absPath,
          folder: 'images',
        };
      }
      case 'xdt-video': {
        const { absPath } = resolveVideoUrl(url);
        return {
          entry: { url, scheme, kind: 'video', zipPath: null, filename: path.basename(absPath) },
          absPath,
          folder: 'videos',
        };
      }
      case 'xdt-model': {
        const { absPath } = resolveModelUrl(url);
        return {
          entry: { url, scheme, kind: 'model', zipPath: null, filename: path.basename(absPath) },
          absPath,
          folder: 'models',
        };
      }
      case 'xdt-file':
      case 'xdt-audio': {
        const absPath = extractLoosePath(url);
        if (!absPath) return null;
        return {
          entry: { url, scheme, kind: 'loose', zipPath: null, filename: path.basename(absPath) },
          absPath,
          folder: 'loose',
        };
      }
      case 'cindy-media': {
        // 内容寻址 blob:resolveSafe 已做指纹正则 + 扩展名白名单校验,
        // filename 即 `<sha256>.<ext>`(导入端不信它,按字节重算指纹落仓)。
        const { absPath } = resolveCindyMediaUrl(url);
        return {
          entry: { url, scheme, kind: 'blob', zipPath: null, filename: path.basename(absPath) },
          absPath,
          folder: 'blobs',
        };
      }
      default:
        return null;
    }
  } catch {
    // resolveSafe 对未知 host / 越界路径抛错:该 URL 不可解析,当缺失处理。
    return null;
  }
}

async function readSessionRow(sessionId: string): Promise<SessionRow | null> {
  return (
    (await getDbClient().queryOne<SessionRow>(
      `SELECT
        id, title,
        working_dir AS workingDir,
        workspace_kind AS workspaceKind,
        model, effort,
        permission_mode AS permissionMode,
        status,
        sdk_session_id AS sdkSessionId,
        total_token_usage AS totalTokenUsage,
        total_cost_usd AS totalCostUsd,
        context_tokens AS contextTokens,
        context_window AS contextWindow,
        fast_mode AS fastMode,
        plan_mode_enabled AS planModeEnabled,
        agent_kind AS agentKind,
        orca_role AS orcaRole,
        remote_host_id AS remoteHostId,
        codex_history_has_product_prompt AS codexHistoryHasProductPrompt,
        cleared_at AS clearedAt,
        user_send_at AS userSendAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM sessions WHERE id = ? LIMIT 1`,
      [sessionId],
    )) ?? null
  );
}

/** 与 messages:list 同口径:clear 过的会话只导出 clearedAt 之后的消息。 */
async function readMessageRows(sessionId: string, clearedAt: number | null): Promise<MessageRow[]> {
  const clearCond = clearedAt != null ? 'AND created_at > ?' : '';
  const params = clearedAt != null ? [sessionId, clearedAt] : [sessionId];
  return getDbClient().query<MessageRow>(
    `SELECT
      id,
      client_id AS clientId,
      role, content,
      tool_use_id AS toolUseId,
      agent_meta AS agentMeta,
      agent_kind AS agentKind,
      created_at AS createdAt,
      rewind_at AS rewindAt
    FROM messages WHERE session_id = ? ${clearCond}
    ORDER BY created_at ASC, id ASC`,
    params,
  );
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}
