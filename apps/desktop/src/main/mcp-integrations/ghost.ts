import { createPluginMarketAgentTools } from '../plugin-market/agentTools.js';
import type { PluginMarketService } from '../plugin-market/service.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getBotAuthorizationService } from '../maker-ipc/botAuthorizationService.js';
import { isBotAuthorizationSession } from '../maker-ipc/botAuthorizationHost.js';
/**
 * ghost.ts — cindy-tools ghost 总机的 host 侧接线(docs/dev-rules/plugin-security-and-authoring.md)。
 * ---------------------------------------------------------------------------
 * 网关模式:agent 工具箱里的插件发现/调用入口固定为
 * ghost_list / ghost_info / ghost_manual / ghost_call。工具面(名称/schema/基线描述)版本内
 * 恒定;完整描述(含花名册快照)会话内恒定,内容现查现报——本文件就是
 * "现查"的真身:
 *
 *   - listAwakeGhosts / getAwakeGhost:每次调用都重新扫 GhostManager(不缓存),
 *     装/卸/唤醒/沉睡对新老会话"下一次查询即生效";
 *   - callGhostTool:透传给管子派发器(pipeDispatcher),资格审/按需拉起/
 *     配对超时/崩溃收卷全在那边,错误码两侧同构直接原样交回;
 *   - forgeGuide / forgeScaffold / forgePack / forgeInstall:意识锻造(agent 帮用户做意识)——
 *     手册、骨架与打包真身在 cindy-brain/forge.ts；pack 始终只产出文件，只有显式
 *     forgeInstall 才复用本地包事务安装/更新，publish intent 改签一次性发布票据。
 *
 * cindy-tools 是意识系统工具集,包内零 Electron
 * 依赖,全部能力经本文件注入(设计规范规则 2)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { buildGhostRosterPrompt } from 'cindy-tools';
import { writeDocsOutput } from '../doc-tools/docsOutputWriter.js';
import type {
  CindyForgeInstallResult,
  CindyForgePackResult,
  CindyForgePublishResult,
  CindyForgePublishStatusResult,
  CindyForgeScaffoldResult,
  CindyGhostInfo,
  CindyGhostsMcpDeps,
} from 'cindy-tools';
import { toolAutoReviewAction, type PermissionMode, type ReviewableAction, type AutoReviewDecision } from '@cindy/maker-core';
import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import {
  GRANT_AUTHORIZATION_CHANGED_MESSAGE,
  GrantPolicyError,
  grantAttachmentsToGhost,
  MAX_GRANT_ATTACHMENTS,
  MAX_GRANT_ONLY_ATTACHMENTS,
  type ResolvedGrantSource,
} from '../cindy-brain/attachmentGrant.js';
import {
  collectDirFiles,
  getDirDepositVault,
  getSaveDepositVault,
  isPathInsideDir,
} from '../cindy-brain/dirDeposit.js';
import {
  getGhostGrantConfirmBridge,
  type GhostGrantFileItem,
  type GhostGrantLane,
} from '../cindy-brain/ghostGrantConfirmBridge.js';
import { classifyLocalAttachmentPath } from '../cindy-brain/ghostLocalPathGrant.js';
import { toolNotFoundMessage } from '../cindy-brain/pipeDispatcher.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getRemoteFileBrowser } from '../file-browser/remote-deps.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  deriveGhostSessionContext,
  type GhostSessionContextInjected,
  type GhostSetupAssessment,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { withCardToken } from '../cindy-brain/cardService.js';
import { drainGhostCallMedia } from '../cindy-brain/ghostMediaLedger.js';
import {
  getGhostCardService,
  getGhostManager,
  getGhostPipeDispatcher,
  getGhostSetupAssessment,
  ghostForgeForbiddenRootDirs,
  captureGhostMutationOwnerForMcp,
  acquireGhostMutationLeaseForMcp,
  installOrUpdateLocalGhostPackageFromForge,
  isGhostAvailableForActiveSession,
} from '../cindy-brain/index.js';
import { writeForgeScaffoldWithStableParent } from '../cindy-brain/forgeScaffoldCapability.js';
import { getGhostSetupCoordinator } from '../cindy-brain/ghostSetupCoordinator.js';
import { classifyGhostVisibility } from '../cindy-brain/ghostVisibility.js';
import { readInstalledGhostManual } from '../cindy-brain/ghostManual.js';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import { FORGE_GUIDE, packGhostDir, scaffoldGhostDir } from '../cindy-brain/forge.js';
import {
  completeForgePackStaging,
  getForgePackStagingController,
  releaseForgePackStaging,
} from '../cindy-brain/forgePackStaging.js';
import { consumeForgePackForPublish } from '../cindy-brain/forgePackPublishConsume.js';
import {
  currentPublisherIdentity,
  getPluginPublisherOrchestrator,
  startPluginPublish,
} from '../plugin-publisher/host.js';
import { workdirWriteVerdict } from '../cindy-brain/fsSlot.js';
import * as blobStore from '../cindy-media/blobStore.js';
import { collectCindyMediaUrls as collectChatMediaUrls, commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import { callCindyMedia } from '../cindy-media/invocationService.js';
import type { MediaDownloadContext } from '../cindy-media/mediaDownload.js';
import * as ledger from '../cindy-media/ledger.js';
import { chatAttachmentOrigin } from '../cindy-media/attachmentGrantGate.js';
import { resolveGhostAttachmentUrl } from './ghostAttachmentResolve.js';
import { ghostSetupInteractionSessionId } from './ghostSetupInteractionSurface.js';
import { createForgeIconConverter } from './forgeIconConversion.js';
import { forkForgeIconConversionHost } from './forgeIconConversionHost.js';
import {
  readAllowedBuiltinPluginIds,
} from './codexBuiltinToolPolicy.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { isIpcError } from '../../shared/ipc-errors.js';

const log = createLogger('mcp/cindy');
const MAX_FORGE_ICON_SOURCE_BYTES = 25 * 1024 * 1024;
const GHOST_NO_TOOLS_MESSAGE =
  '该插件未声明任何可供调用的工具;不要重试,改用其它方式完成。';

const convertForgeIconToPng = createForgeIconConverter({
  fork: forkForgeIconConversionHost,
});

/** pack 与显式 install 共用同一套可选 AI 图标叠加，避免二次打包丢失图标。 */
async function packForgeSource(
  dir: string,
  sessionWorkdir: string,
  iconSource?: string,
) {
  let iconPng: Buffer | undefined;
  let iconNote = '';
  if (iconSource !== undefined) {
    try {
      const resolved = blobStore.resolveSafe(iconSource);
      if (!resolved.mimeType.startsWith('image/')) {
        throw new Error('icon_source 不是图片');
      }
      const stat = await fs.promises.stat(resolved.absPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FORGE_ICON_SOURCE_BYTES) {
        throw new Error(`icon_source 体积必须在 1–${MAX_FORGE_ICON_SOURCE_BYTES} 字节之间`);
      }
      iconPng = await convertForgeIconToPng(resolved.absPath);
      iconNote = 'AI 图标已嵌入安装包。';
    } catch (err) {
      iconNote = 'AI 图标处理失败，已保留默认图标。';
      log.warn('ghost forge icon fallback', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const packOptions = {
    sessionWorkdir,
    forbiddenRootDirs: ghostForgeForbiddenRootDirs(),
  };
  let packed = await packGhostDir(dir, iconPng ? { ...packOptions, iconPng } : packOptions);
  // icon overlay 的任何失败都不是打包门槛：用原源码再打一次。若原源码
  // 本身也不合法，则返回原本就会出现的结构化错误。
  if (!packed.ok && iconPng) {
    const fallbackPacked = await packGhostDir(dir, packOptions);
    if (fallbackPacked.ok) {
      packed = fallbackPacked;
      iconNote = 'AI 图标处理失败，已保留默认图标。';
    } else {
      return { ok: false as const, result: fallbackPacked };
    }
  }
  if (!packed.ok) return { ok: false as const, result: packed };
  return { ok: true as const, packed, iconNote };
}

/* ────────────────────────────────────────────────────────────────────────
 * workdir 外过户确认:
 *   - 过户对象在会话 workdir 内 → 自动放行(与目录过户同信任等级);
 *   - 本地活跃会话当前为 Full Access(bypassPermissions) → Host 自动放行;
 *   - 其余 workdir 外场景(含无会话/远程会话)→ 弹确认卡,用户点允许才继续。
 * Full Access 只替代本处文件/目录交接确认,不扩大插件 manifest slot、网络、
 * 凭证、Setup、安装/更新等其它授权边界。
 * ──────────────────────────────────────────────────────────────────────── */

export interface GhostGrantLiveSessionState {
  permissionMode: PermissionMode | null;
  remoteHostId: string | null;
  /** Includes the captured permission/Plan generations and forbids active or unknown Plan. */
  isCurrent?: () => boolean;
  reviewAction?: (action: ReviewableAction) => Promise<AutoReviewDecision>;
}

/**
 * 工具结果图片描述结果。skipped 区分「有意跳过」与「真正尝试但失败」——
 * 前者不得计 attemptedCount、不得告警「视觉桥不可用」（功能没开不是故障）。
 */
export interface ToolResultImageDescription {
  skipped: boolean;
  description: string | null;
}

export interface CindyGhostsHostDeps {
  pluginMarket?: Pick<PluginMarketService, 'snapshot' | 'detail' | 'install'>;
  createMediaDownloadContext?: (sessionId: string, sessionInstanceId: string) => MediaDownloadContext | undefined;
  /** 当前 Desktop 版本；Forge scaffold 用它生成具体插件包的默认最低版本。 */
  getAppVersion?: () => string;
  /**
   * 现读活跃 Maker Session 的运行时状态。不得回退 DB:权限热切换先作用于
   * runtime、后持久化,DB 在合法窗口内会滞后;缺失/异常必须 fail closed。
   */
  getLiveSessionGrantState?: (
    sessionId: string,
    sessionInstanceId: string,
  ) => GhostGrantLiveSessionState | null;
  /**
   * 把工具结果里的图片（cindy-media:// 地址）转成文字描述（视觉桥，最佳努力）。
   * host 侧注入；内部判定视觉桥是否启用、当前 session 模型是否命中、blob 是否可读。
   * 返回对象区分两种「无描述」：
   *  - skipped:true = 有意跳过（视觉桥未启用 / 模型不命中 / session 缺失 / blob 解析
   *    失败），调用方不得计入 attemptedCount，也不得告警「不可用」——功能本就没开，
   *    不是故障；
   *  - skipped:false + description:null = 真正尝试了视觉后端但失败（错误 / 后端不可用），
   *    调用方据此计数并告警。
   * sessionId / sessionInstanceId 用于定位并校验当前 session，缺失或不匹配必须 fail closed。
   */
  describeToolResultImage?: (input: {
    imageUrl: string;
    sessionId: string | null;
    sessionInstanceId: string | null;
    /** 总预算超时中止信号：deadline 到点后中止未完成描述请求，不再硬等单张 30s。 */
    signal?: AbortSignal;
  }) => Promise<ToolResultImageDescription>;
  /**
   * 工具结果图片全部描述失败时回调（host 据此发「视觉桥不可用」UI 警告）。
   * 可选；未注入 = 不告警（静默，与未启用视觉桥一致）。fire-and-forget，不阻塞工具结果。
   */
  onToolResultImagesFailed?: (sessionId: string, attemptedCount: number) => void;
}

type GhostGrantApprovalSource = 'user' | 'full-access' | 'auto-review';

/** 确认卡内嵌图片预览的文件体积上限(只是预览阈值,不是过户限制——超阈值
 *  照样可过户,卡片上退化为文件名 + 路径 + 大小)。 */
const GRANT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/** 一张确认卡最多内嵌几张图片预览(批量预授权张数多,预览只给前几张)。 */
const GRANT_PREVIEW_MAX_ITEMS = 8;

/** workdir 外附件单批总字节上限:过户流程会把整批字节读进内存并跨确认卡
 *  持有(最长 10 分钟),不设闸的话 32 张大视频能把 main 进程打到 OOM。 */
const GRANT_BATCH_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

function grantBatchTooLargeMessage(): string {
  return `本批附件总体积过大(超过 ${Math.floor(GRANT_BATCH_MAX_TOTAL_BYTES / (1024 * 1024))}MB),请拆成多批过户`;
}

/** 已读入的文件字节 → dataURL 缩略预览(确认卡展示真实字节;非图/超阈值缺省)。 */
function buildGrantPreviewDataUrl(buffer: Uint8Array, mimeType: string): string | undefined {
  if (!mimeType.startsWith('image/') || buffer.byteLength > GRANT_PREVIEW_MAX_BYTES)
    return undefined;
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

/**
 * 目录/落盘过户的**会话内授权记忆**:同一会话里,同一意识对同一真身路径
 * 的同一通道允许过一次后不再重复弹卡(目录内容会变,不做跨会话永久记忆——
 * 与 attachments 的「按内容指纹永久」区分开)。内存态,体量 = 本进程生命周期
 * 内允许过的条目数,极小,无需清理钩子。
 *
 * lane 取值:'dir' / 'save_dir'(票据通道按路径本身记),以及
 * 'attachments-dir'(确认卡「允许该目录」勾选——按文件的精确父目录记,
 * 不递归子目录;后续该目录下的媒体文件对该意识本会话免弹)。
 */
const dirGrantMemory = new Set<string>();

function dirGrantMemoryKey(
  sessionId: string,
  ghostId: string,
  lane: string,
  realPath: string,
): string {
  const folded = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  return [sessionId, ghostId, lane, folded].join('\u0000');
}

/**
 * session-context 槽注入体铸造(能力「盖章工作单」):只有主机能证明会话
 * 不是远程工作区(sessions.remoteHostId 为空)时 workdir_is_local 才为 true;
 * workdir_is_read_only 复用 fs 槽的 permission / plan 裁决,避免插件靠 prompt
 * 猜测。证明不了会话时两项都 fail closed。
 */
async function buildGhostSessionContext(
  sessionId: string | null,
  alsWorkdir: string | null,
): Promise<GhostSessionContextInjected> {
  const snapshot = sessionId ? await getSessionFsSnapshot(sessionId) : null;
  return deriveGhostSessionContext(
    sessionId,
    alsWorkdir,
    snapshot
      ? {
          workingDir: snapshot.workingDir,
          remoteHostId: snapshot.remoteHostId,
          workdirIsReadOnly:
            workdirWriteVerdict(snapshot.permissionMode, snapshot.planModeEnabled) === 'deny',
        }
      : null,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Forge C-4 门:Forge 做的是**本机文件写**,裸 MCP workingDir 只是标签,不能
 * 直接交给 fs。权威 session 行决定它是否本机、是否当前可写(远程/只读/plan 一律
 * fail closed)。owner lease 在首个 await 前捕获、持到 scaffold/pack + 装入确认
 * 转交结束,账号 teardown 会等它释放。
 * ──────────────────────────────────────────────────────────────────────── */

type ForgeSessionFsGate =
  | { ok: true; workingDir: string }
  | {
      ok: false;
      errorCode: 'WORKDIR_NOT_LOCAL' | 'WORKDIR_READ_ONLY';
      message: string;
    };

async function withForgeOwnerLease<T>(operation: () => Promise<T>): Promise<T> {
  const owner = captureGhostMutationOwnerForMcp();
  const release = acquireGhostMutationLeaseForMcp(owner);
  try {
    return await operation();
  } finally {
    release();
  }
}

async function getForgeSessionFsGate(
  sessionContext: LiziMcpSessionContext | undefined,
  requireAutomaticWrite = false,
): Promise<ForgeSessionFsGate> {
  const sessionId = sessionContext?.sessionId ?? null;
  if (!sessionId) {
    return {
      ok: false,
      errorCode: 'WORKDIR_NOT_LOCAL',
      message: 'Forge requires an authoritative local session workdir',
    };
  }
  const snapshot = await getSessionFsSnapshot(sessionId);
  if (!snapshot?.workingDir || snapshot.remoteHostId) {
    return {
      ok: false,
      errorCode: 'WORKDIR_NOT_LOCAL',
      message: 'Forge cannot use a remote or unverified session workdir on the local host',
    };
  }
  const verdict = workdirWriteVerdict(snapshot.permissionMode, snapshot.planModeEnabled);
  if (verdict === 'deny' || (requireAutomaticWrite && verdict !== 'allow')) {
    return {
      ok: false,
      errorCode: 'WORKDIR_READ_ONLY',
      message: 'Forge is disabled while the current session workdir is read-only or in plan mode',
    };
  }
  return { ok: true, workingDir: snapshot.workingDir };
}

/* ────────────────────────────────────────────────────────────────────────
 * 超大工具结果外置(#4245):写入前只认当前活跃实例的运行时真相。权限热切换
 * runtime-first、DB-second,持久化行在合法窗口内会滞后;实例重建后 business
 * sessionId 复用,旧 MCP 请求不得借新实例的目录与权限。任何缺失/不一致 fail
 * closed。远程会话的 workingDir 在被控端:经 remote-file-service 写到远端任务
 * 目录并返回远端可读的相对路径,不落本机。
 * ──────────────────────────────────────────────────────────────────────── */

interface LargeResultSpillTarget {
  sessionId: string;
  workingDir: string;
  remoteHostId: string | null;
  /**
   * 再次现读活跃实例:每个 await 之后(写文件前、挂媒体引用前)都要重验,实例
   * 已换 / 会话已结束 / 权限已收紧 / 远端归属变化时抛错。传入 reviewTarget
   * (写入前)时,Auto 会话把该目标交给会话统一审阅器,只有 allow 才继续。
   */
  revalidate(reviewTarget?: string): Promise<void>;
}

const LARGE_RESULT_DIR = 'tool-results';

async function resolveLargeResultSpillTarget(
  sessionContext: LiziMcpSessionContext | undefined,
  getLiveSessionGrantState: CindyGhostsHostDeps['getLiveSessionGrantState'],
): Promise<LargeResultSpillTarget> {
  const sessionId = sessionContext?.sessionId ?? null;
  const sessionInstanceId = sessionContext?.sessionInstanceId ?? null;
  if (!sessionId || !sessionInstanceId || !getLiveSessionGrantState) {
    throw new Error('Tool result storage requires the live session');
  }
  // 实例不匹配 / 会话不再 active / 运行时异常 → null,一律 fail closed。
  const first = getLiveSessionGrantState(sessionId, sessionInstanceId);
  if (!first) throw new Error('Tool result storage requires the live session');
  const snapshot = await getSessionFsSnapshot(sessionId);
  if (!snapshot?.workingDir) throw new Error('Tool result storage requires an authoritative session workdir');
  const workingDir = snapshot.workingDir;
  const remoteHostId = first.remoteHostId;
  const readOnlyError = () =>
    new Error('Tool result storage is disabled while the session is read-only or in plan mode');
  // Auto: the reviewer's allow is bound to the permission/Plan generation of the snapshot
  // that produced it. A later revalidate() gets a fresh snapshot whose own isCurrent() only
  // proves the *new* generation is Auto — it must also prove the approving one is still it.
  let approvedIsCurrent: (() => boolean) | null | undefined;
  // The exact target this write was cleared for. Remembered so that a later boundary
  // (beforeCommit / beforeSend) can obtain a *fresh* Auto review if the session was
  // downgraded from Full Access to Auto meanwhile — a Full Access allow never carries
  // over into Auto, and Auto has to see the target itself.
  let clearedTarget: string | undefined;
  const reviewNow = async (live: NonNullable<ReturnType<NonNullable<typeof getLiveSessionGrantState>>>, target: string): Promise<void> => {
    let decision: AutoReviewDecision;
    try {
      decision = await live.reviewAction!({
        kind: 'file-write',
        path: target,
        resolvedPath: target,
        resolvedWritableRoots: [workingDir],
      });
    } catch {
      throw readOnlyError();
    }
    if (live.isCurrent?.() === false) throw readOnlyError();
    if (decision.verdict !== 'allow') {
      throw new Error(
        decision.verdict === 'block'
          ? (decision.reason ?? 'Automatic review denied the tool result storage write.')
          : 'Tool result storage requires a write the session reviewer did not approve automatically',
      );
    }
    // Bind the allow to the snapshot that produced it; a legacy provider without
    // isCurrent has no generation to bind (null keeps later checks fail-closed-neutral).
    approvedIsCurrent = live.isCurrent ?? null;
  };
  const revalidate = async (reviewTarget?: string): Promise<void> => {
    const live = getLiveSessionGrantState(sessionId, sessionInstanceId);
    if (!live) throw new Error('Tool result storage requires the live session');
    if ((snapshot.remoteHostId ?? null) !== live.remoteHostId || live.remoteHostId !== remoteHostId) {
      throw new Error('Tool result storage requires an authoritative session workdir');
    }
    // 计划模式同样 runtime-first:isCurrent 已含运行时 Plan 状态与权限/Plan 代次校验,
    // 有它就必须为 true;旧装配方没有 isCurrent 时回退持久化行的 planModeEnabled。
    if (live.isCurrent && live.isCurrent() !== true) throw readOnlyError();
    const planModeEnabled = live.isCurrent ? false : snapshot.planModeEnabled;
    const verdict = workdirWriteVerdict(live.permissionMode ?? '', planModeEnabled);
    if (reviewTarget !== undefined) clearedTarget = reviewTarget;
    if (verdict === 'allow') {
      // Full Access: no reviewer involved. Any earlier Auto approval is irrelevant here,
      // and (see below) a Full Access clearance never stands in for an Auto review later.
      approvedIsCurrent = undefined;
      return;
    }
    // Auto:workdir 写入交给当前会话的统一审阅器(与 fsSlot 的 workdir 写同口径),
    // 没有审阅器、审阅异常、要求确认或拒绝都 fail closed —— 工具结果外置是宿主
    // 内部动作,不弹确认卡。写入前审阅一次(reviewTarget),写后复验只查活性/归属。
    if (verdict !== 'review' || !live.reviewAction) throw readOnlyError();
    if (reviewTarget === undefined) {
      // Post-clearance boundaries under Auto. The write may proceed only on an Auto
      // approval whose generation is still live. No such approval (never reviewed under
      // Auto — e.g. cleared under Full Access and downgraded meanwhile — or the approving
      // generation is gone) means the *current* Auto generation must review the target
      // now; before any target is known there is nothing to clear and nothing to review.
      if (approvedIsCurrent === null || (approvedIsCurrent && approvedIsCurrent() === true)) return;
      if (clearedTarget === undefined) return;
      await reviewNow(live, clearedTarget);
      return;
    }
    await reviewNow(live, reviewTarget);
  };
  // The snapshot read above is an async boundary; check the live state once more before returning.
  await revalidate();
  return { sessionId, workingDir, remoteHostId, revalidate };
}

/**
 * 远端写:createFolder(已存在则复用)后用 daemon 的 writeNewFile 一步排他新建并
 * 写入(O_EXCL,目标已存在 / 为 symlink 即失败、不跟随最终链接),不留 createFile →
 * writeFile 之间可被换成 symlink 的窗口。路径一律 POSIX(远端 daemon 只支持 POSIX)。
 * 变更类 RPC 断链时结果未知:daemon 可能已写完、只是响应没回来,不能盲删唯一副本,
 * 用幂等 stat 核验字节数:一致 = 成功;缺失 = 失败不删;不一致才删。
 */
async function writeLargeResultToRemote(
  remoteHostId: string,
  workdir: string,
  relPath: string,
  text: string,
  revalidate: () => Promise<void>,
): Promise<SpillAnchor | null> {
  const remote = getRemoteFileBrowser();
  const dir = path.posix.dirname(relPath);
  // Same frame-boundary revalidation as the write below: connecting / installing /
  // handshaking the host can take long, and a stale approval must not execute even this
  // directory mutation in the workdir. An authorization failure here is final — it is not
  // an ambiguous filesystem outcome and must not enter the "did the mkdir land?" poll.
  let authorizationRevoked = false;
  const beforeSend = async (): Promise<void> => {
    try {
      await revalidate();
    } catch (err) {
      authorizationRevoked = true;
      throw err;
    }
  };
  try {
    await remote.request(remoteHostId, 'createFolder', { workdir, relPath: dir }, { beforeSend });
  } catch (err) {
    if (authorizationRevoked) throw err;
    // 超时/断链时 daemon 可能仍在 mkdir:按结果未知轮询等目录出现;明确失败(EEXIST 等)
    // 只 stat 一次确认目录已在。目录仍不可见就放弃,不能把唯一文件写进不存在的目录。
    const ready = await pollRemoteStat(remote, remoteHostId, workdir, dir, {
      attempts: isRemoteResultUnknown(err) ? REMOTE_WRITE_RECONCILE.maxAttempts : 1,
      done: (stat) => stat?.type === 'directory',
    });
    if (!ready) throw err;
  }
  // The directory RPC (and its reconcile window) is an async boundary: the exact
  // instance and its write grant must still hold right before the private bytes go out.
  await revalidate();
  const bytes = Buffer.from(text, 'utf8');
  try {
    // `beforeSend` runs after the manager has connected / probed / installed / handshaken
    // the host — i.e. at the real frame boundary — so an instance that ended or lost its
    // grant while the client was being built never has its private bytes sent.
    const written = await remote.request(
      remoteHostId,
      'writeNewFile',
      { workdir, relPath, content: text },
      { beforeSend: revalidate },
    );
    const anchor: SpillAnchor = { dev: written.dev, ino: written.ino, ...(typeof written.holdId === 'string' ? { holdId: written.holdId } : {}) };
    if (written.durable === false) {
      // The staging removal did not reach disk (round 30): a crash could bring the hidden
      // hard link back with the full private content outside the ledger lifecycle. This
      // client is the only party that accepted the publish and still holds the descriptor:
      // withdraw through it and report the write as failed.
      await remote.request(remoteHostId, 'eraseIfSame', { workdir, relPath, dev: anchor.dev, ino: anchor.ino, ...(anchor.holdId !== undefined ? { holdId: anchor.holdId } : {}) }).catch(() => undefined);
      throw new Error('remote spill not durable: staging removal did not reach disk');
    }
    return anchor;
  } catch (err) {
    if (isRemoteResultUnknown(err)) {
      return reconcileUnknownRemoteWrite(remote, remoteHostId, workdir, relPath, bytes, err);
    }
    // A definite failure (EEXIST, size limit, path rejection) wrote nothing.
    throw err;
  }
}

/** Race a probe against the remaining reconcile budget; the loser's outcome is ignored. */
function withinBudget<T>(probe: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('verifyNewFile exceeded the reconcile budget'), { code: 'RECONCILE_BUDGET' })), budgetMs);
  });
  probe.catch(() => undefined); // a late rejection after the race must not be unhandled
  return Promise.race([probe, bound]).finally(() => clearTimeout(timer));
}

/** 结果未知时的 stat 轮询节奏:总时长约 10s,覆盖慢文件系统上 2 MiB 上限的写入;测试可缩短。 */
export const REMOTE_WRITE_RECONCILE = { intervalMs: 250, maxAttempts: 40, windowMs: 10_000 };

type RemoteStatResult = { type: string; size?: number | null; mtimeMs?: number | null } | null;

/**
 * 轮询 stat 直到 done 为真(返回 true),或次数/总时长耗尽(false);stat 失败按 null 交给 done。
 * 总时长按墙钟计:每次 stat 本身可能等到客户端 15s 超时,不能让 40 次探测把 ghost_call 与
 * owner lease 拖到十分钟;窗口一到就停,不再发下一次探测。
 */
async function pollRemoteStat(
  remote: ReturnType<typeof getRemoteFileBrowser>,
  remoteHostId: string,
  workdir: string,
  relPath: string,
  options: { attempts: number; done: (stat: RemoteStatResult) => boolean; giveUp?: (stat: RemoteStatResult) => boolean },
): Promise<boolean> {
  const deadline = Date.now() + REMOTE_WRITE_RECONCILE.windowMs;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const stat = (await remote.request(remoteHostId, 'stat', { workdir, relPath }).catch(() => null)) as RemoteStatResult;
    if (options.done(stat)) return true;
    if (options.giveUp?.(stat)) return false;
    if (attempt + 1 >= options.attempts) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REMOTE_WRITE_RECONCILE.intervalMs, remaining)));
    if (Date.now() >= deadline) break;
  }
  return false;
}

/**
 * 断链/超时后 daemon 可能仍在写:客户端超时只是把请求移出 pending 表,服务端写入继续,
 * 而协议没有完成令牌,长度/mtime 也证明不了「是本机写的」——workdir 内的进程可以放一个
 * 同长度文件或 symlink 冒充。因此按**内容身份**消歧:轮询 daemon 的 verifyNewFile
 * (非 symlink、父目录仍在 workdir 内、大小与 SHA-256 与本次内容完全一致),通过即拿到
 * inode 身份视为本次写入已发布;文件暂时缺失/未写完都继续等(远端 open 本身可能阻塞过
 * 客户端超时);窗口耗尽仍未核实则保留现场、按失败上报,不做任何删除。
 */
async function reconcileUnknownRemoteWrite(
  remote: ReturnType<typeof getRemoteFileBrowser>,
  remoteHostId: string,
  workdir: string,
  relPath: string,
  bytes: Buffer,
  cause: unknown,
): Promise<SpillAnchor> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = bytes.length;
  const deadline = Date.now() + REMOTE_WRITE_RECONCILE.windowMs;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < REMOTE_WRITE_RECONCILE.maxAttempts; attempt += 1) {
    // Each probe is bounded by the time left in the window: the client's default 15s
    // request timeout (and any endpoint rebuild) must not push ghost_call and the owner
    // lease past the configured 10s. A probe that outlives its bound is abandoned; its
    // late outcome is ignored and the write stays "unverified".
    const budget = deadline - Date.now();
    if (budget <= 0) break;
    try {
      const verified = await withinBudget(
        remote.request(remoteHostId, 'verifyNewFile', { workdir, relPath, sha256, size }),
        budget,
      );
      return { dev: verified.dev, ino: verified.ino, ...(typeof verified.holdId === 'string' ? { holdId: verified.holdId } : {}) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt + 1 >= REMOTE_WRITE_RECONCILE.maxAttempts) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REMOTE_WRITE_RECONCILE.intervalMs, remaining)));
    if (Date.now() >= deadline) break;
  }
  log.warn('ghost large result: remote write unverified after reconcile window; leaving the path untouched', {
    remoteHostId, relPath, size, lastError,
  });
  throw cause;
}

/**
 * 变更类 RPC 的结果未知:断链(CHANNEL_CLOSED / CHANNEL_ERROR)与客户端超时(TIMEOUT,
 * daemon 可能已写完只是响应晚到)都不能当作「没写」,必须回读核对。
 * ENDPOINT_STALE 是 RemoteFileBrowserManager 在端点代次变化时于 catch/成功后生成的包装错误,
 * 会盖掉底层结果:请求可能已发出甚至已成功发布,同样只能按未知处理、经当前端点 verifyNewFile
 * 消歧(不是同一台机器时核验自然失败,保持"失败但不删"的现场)。
 */
function isRemoteResultUnknown(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'CHANNEL_CLOSED' || code === 'CHANNEL_ERROR' || code === 'TIMEOUT' || code === 'ENDPOINT_STALE';
}

/** 外置文件写入后记录的 inode 身份(本地 lstat / 远端 writeNewFile 或 verifyNewFile 返回),供清理时锚定。 */
/** dev/ino 以十进制字符串承载:Windows 文件 ID 为 64 位,JS number 会丢低位。 */
interface SpillIdentity { dev: string; ino: string }
/**
 * 清理锚:inode 身份,远端还带 daemon 保留的描述符 hold(holdId):目录被移出 workdir 后
 * 仍可经该描述符清零同一 inode,登记完成后 releaseNewFile 关闭。
 */
interface SpillAnchor extends SpillIdentity { holdId?: string }
type LocalSpillAnchor = SpillAnchor;

/**
 * 本地外置文件写成后立刻按 inode 身份把它打开并**持有**(O_NOFOLLOW,fstat 必须等于写入器经
 * 自己句柄读到的身份):随后的权限复验与媒体账本登记都是异步边界,期间 workdir 进程可能把
 * 输出目录整个移出 workdir,按路径的清理就再也找不到那份内容;经这个句柄清零与路径无关。
 * 打开失败或身份不符(写入器关句柄到这里之间已被移走)时不持有,退回按身份的路径清理。
 */
async function bindLocalSpill(abs: string, identity: SpillIdentity): Promise<fs.promises.FileHandle | null> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(abs, fs.constants.O_RDWR | ((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (st.isFile() && st.dev.toString() === identity.dev && st.ino.toString() === identity.ino) return handle;
  } catch {
    /* fall through: not bindable */
  }
  await handle.close().catch(() => undefined);
  return null;
}

/**
 * 本地按 inode 身份擦除:以 O_NOFOLLOW 打开并 fstat 核对,通过后经该 fd 把私密内容清零
 * (擦除与 inode 绑定,与路径无关)。不再 unlink 路径名:POSIX 没有"按 inode 删除路径名"
 * 的原语,检查后删除总有可能删掉期间被放到同名处的无关文件;敏感内容既已经 fd 清零,
 * 保守地留下一个空文件名是可接受的结果。
 */
async function truncateIfSame(candidate: string, anchor: SpillIdentity): Promise<void> {
  const handle = await fs.promises.open(candidate, fs.constants.O_RDWR | ((fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || st.dev.toString() !== anchor.dev || st.ino.toString() !== anchor.ino) return;
    await handle.truncate(0);
  } finally {
    await handle.close();
  }
}

/**
 * 清理刚写的外置文件。本地与远端都只按 inode 身份擦除内容、不删路径名:父目录可能已被换成指向别处的 symlink,并在
 * 那里放一个同名文件诱导删除。只有父目录 realpath 仍在 workdir 内、且同名条目的 dev/ino
 * 与写入时记录的一致,才删那一个条目;否则放弃(宁可留下自己的文件,不删别人的)。
 */
async function discardLargeResultFile(
  target: LargeResultSpillTarget,
  relPath: string,
  anchor: LocalSpillAnchor | null,
  hold: fs.promises.FileHandle | null = null,
): Promise<void> {
  try {
    if (!anchor) return;
    if (target.remoteHostId) {
      // Identity-checked deletion on the daemon: never follows a swapped symlink, never
      // removes anything but the inode this call created/verified. With the daemon-held
      // descriptor (hold) no pathname is needed at all: the directory may have been moved.
      await getRemoteFileBrowser().request(target.remoteHostId, 'eraseIfSame', {
        workdir: target.workingDir, relPath, dev: anchor.dev, ino: anchor.ino,
        ...(anchor.holdId !== undefined ? { holdId: anchor.holdId } : {}),
      });
      return;
    }
    if (hold) {
      // Inode-bound: the retained handle follows the file wherever its directory went.
      const st = await hold.stat({ bigint: true });
      if (st.isFile() && st.dev.toString() === anchor.dev && st.ino.toString() === anchor.ino) {
        await hold.truncate(0);
        return;
      }
    }
    const abs = path.join(target.workingDir, relPath);
    const [wdReal, parentReal] = await Promise.all([fs.promises.realpath(target.workingDir), fs.promises.realpath(path.dirname(abs))]);
    if (parentReal !== wdReal && !parentReal.startsWith(wdReal + path.sep)) return;
    await truncateIfSame(path.join(parentReal, path.basename(abs)), anchor);
  } catch {
    /* best-effort: the write already failed to be accounted for; keep the original error */
  }
}

/**
 * 只在字节落盘成功后才给完整结果里的媒体挂引用。引用身份是**外置结果文件本身**
 * (refKind ghost-tool-result / refId = 文件相对路径 / originSessionId = 会话),不与消息
 * 生命周期的 session-attachment 行共用:消息回退清理只看 live messages,共享行会被删掉
 * 而回收器随即回收 saved_to 仍引用的字节。会话删除时按 originSessionId 连坐清理。
 * 逐 URL 隔离(pin → 本文件已有引用则跳过 → addRef),并记住**本次调用实际插入的引用
 * id**;任一 URL 挂账失败时只按这些 id 回滚(并发的另一次外置不受影响),再删掉刚写的
 * 文件,不留没有结果文件的孤立引用。成功时把插入的 id 交给调用方,供后续复验失败回滚。
 */
async function commitLargeResultMediaRefs(target: LargeResultSpillTarget, relPath: string, text: string, anchor: LocalSpillAnchor | null, hold: fs.promises.FileHandle | null): Promise<string[]> {
  // Reserve every ref id *before* the insert RPC: a DB worker that commits the row but
  // loses its response would otherwise leave an id we never learned and cannot roll back.
  // Rollback removes all attempted ids (removeRefById is idempotent for rows never written).
  const inserted: string[] = [];
  let failed = 0;
  for (const url of collectChatMediaUrls(text)) {
    const parsed = blobStore.parseBlobUrl(url);
    if (!parsed) continue;
    try {
      await ledger.pinBlob(parsed.hash);
      if (await ledger.hasRef({ hash: parsed.hash, refKind: 'ghost-tool-result', refId: relPath })) continue;
      const id = randomUUID();
      inserted.push(id);
      await ledger.addRef({
        id,
        hash: parsed.hash,
        refKind: 'ghost-tool-result',
        refId: relPath,
        originSessionId: target.sessionId,
        originKind: 'tool',
      });
    } catch (err) {
      failed += 1;
      log.warn('ghost large result: media ref commit failed for url', {
        sessionId: target.sessionId,
        hash: parsed.hash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (failed === 0) return inserted;
  for (const id of inserted) await ledger.removeRefById(id).catch(() => 0);
  await discardLargeResultFile(target, relPath, anchor, hold);
  throw new Error('Tool result media references unavailable');
}

/** 意识显示名(确认卡标题用;查不到回落 id)。 */
function ghostDisplayName(ghostId: string): string {
  const g = getGhostManager()
    .list()
    .find((x) => x.manifest.id === ghostId);
  return g?.manifest.name ?? ghostId;
}

/** 目标路径是否位于会话 workdir 内(realpath 归一化,口径同 dirDeposit)。 */
function isInsideSessionWorkdir(targetAbs: string, workdirAbs: string | null): boolean {
  if (!workdirAbs) return false;
  try {
    return isPathInsideDir(fs.realpathSync.native(workdirAbs), fs.realpathSync.native(targetAbs));
  } catch {
    return false;
  }
}

/**
 * 弹过户确认卡并等待用户决定。message 是可直达模型的人话(拒绝/超时要能让
 * 模型停手转告用户,而不是自纠重试)。
 */
async function requestGrantConfirm(params: {
  ghostId: string;
  sessionId: string | null;
  sessionInstanceId: string | null;
  lane: GhostGrantLane;
  items: GhostGrantFileItem[];
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
}): Promise<
  | { ok: true; approvalSource: GhostGrantApprovalSource; allowDirs?: boolean; isCurrent?: () => boolean }
  | { ok: false; message: string }
> {
  let isCurrent: (() => boolean) | undefined;
  const expired = () => isCurrent?.() === false;
  const denied = { ok: false as const, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  if (params.sessionId && params.sessionInstanceId && params.getLiveSessionGrantState) {
    try {
      const live = params.getLiveSessionGrantState(params.sessionId, params.sessionInstanceId);
      isCurrent = live?.isCurrent;
      if (expired()) return denied;
      // 远程会话的 workingDir 是另一台机器上的路径。即使档位为 Full Access,
      // 也不能据此静默读取本机同名/任意路径;保留原确认边界。
      if (live?.permissionMode === 'bypassPermissions' && !live.remoteHostId) {
        log.info('ghost grant: Full Access auto-approved outside-workdir handoff', {
          ghostId: params.ghostId,
          lane: params.lane,
          count: params.items.length,
          grantSource: 'full-access',
        });
        return { ok: true, approvalSource: 'full-access', isCurrent };
      }
      if (live?.permissionMode === 'auto' && live.reviewAction) {
        const decision = await live.reviewAction(toolAutoReviewAction('plugin_file_handoff', {
          ghostId: params.ghostId,
          lane: params.lane,
          files: params.items.map(({ absPath, size, mimeType, isDirectory }) => ({ absPath, size, mimeType, isDirectory })),
        }, live.remoteHostId ? 'These are files on the controller, NOT the remote task filesystem.' : undefined));
        if (expired()) return denied;
        if (decision.verdict === 'allow') {
          log.info('ghost grant: AI approved outside-workdir handoff', { ghostId: params.ghostId, lane: params.lane, grantSource: 'auto-review' });
          return { ok: true, approvalSource: 'auto-review', isCurrent };
        }
        if (decision.verdict === 'block') return { ok: false, message: decision.reason ?? 'Automatic review denied this file handoff.' };
      }
    } catch (error) {
      // 自动扩权查询必须 fail closed:运行时状态读不到就继续走原确认路径,
      // 绝不回退可能滞后的 DB permission_mode。
      log.warn('ghost grant: live permission lookup failed; falling back to confirmation', {
        ghostId: params.ghostId,
        lane: params.lane,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  if (expired()) return denied;
  const bridge = getGhostGrantConfirmBridge();
  if (!bridge) {
    return {
      ok: false,
      message:
        '该路径在当前会话工作目录之外,需要用户确认才能过户,但确认通道未就绪;请让用户把文件移入工作目录或作为附件发进聊天',
    };
  }
  if (!params.sessionId) {
    return {
      ok: false,
      message:
        '该路径在当前会话工作目录之外,需要用户确认才能过户,但当前调用没有会话语境无法弹出确认框;请让用户把文件作为附件发进聊天',
    };
  }
  const decision = await bridge.request(params.sessionId, {
    ghostId: params.ghostId,
    ghostName: ghostDisplayName(params.ghostId),
    lane: params.lane,
    items: params.items,
  });
  if (expired()) return denied;
  if (decision.confirmed) {
    return { ok: true, approvalSource: 'user', allowDirs: decision.allowDirs, isCurrent };
  }
  return {
    ok: false,
    message:
      decision.reason === 'timeout'
        ? '过户确认超时:用户未在时限内响应,本次调用已取消;如仍需要,请提醒用户后重试'
        : decision.reason === 'session_closed' || decision.reason === 'session_aborted'
          ? `Cindy 已取消本次过户请求（${decision.reason}），并非用户手动拒绝。`
          : '用户拒绝了本次过户请求,不要重试;如确有需要请先与用户沟通',
  };
}

/**
 * 媒体仓路径揭示沿用当前会话权限；远端权限不能授权控制端的本机路径。
 */
async function requestMediaPathRevealConfirm(params: {
  sessionId: string | null;
  sessionInstanceId: string | null;
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
  absPath: string;
  mimeType: string;
}): Promise<{ ok: true; isCurrent?: () => boolean } | { ok: false; errorCode: string; message: string }> {
  let isCurrent: (() => boolean) | undefined;
  const expired = () => isCurrent?.() === false;
  const denied = { ok: false as const, errorCode: 'LOCAL_PATH_REVEAL_DENIED',
    message: 'Task or Plan permissions changed; retry with the current scope.' };
  if (!params.sessionId) {
    return {
      ok: false,
      errorCode: 'LOCAL_PATH_REVEAL_CONFIRM_UNAVAILABLE',
      message: '当前调用没有会话语境，无法让用户确认是否把本机路径返回给 Agent',
    };
  }
  if (params.sessionInstanceId && params.getLiveSessionGrantState) {
    try {
      const live = params.getLiveSessionGrantState(params.sessionId, params.sessionInstanceId);
      isCurrent = live?.isCurrent;
      if (expired()) return denied;
      if (live?.permissionMode === 'bypassPermissions' && !live.remoteHostId) {
        return { ok: true, isCurrent };
      }
      if (live?.permissionMode === 'auto' && live.reviewAction) {
        const decision = await live.reviewAction(toolAutoReviewAction('cindy_media.resolve_local_path', {
          path: params.absPath, mimeType: params.mimeType,
        }, 'Return the controller local path of this managed media to the agent.'));
        if (expired()) return denied;
        if (decision.verdict === 'allow') return { ok: true, isCurrent };
        if (decision.verdict === 'block') return {
          ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED', message: decision.reason ?? 'Automatic review denied revealing this path.',
        };
      }
    } catch {
      // Same failure boundary as file handoffs: a live-state/reviewer exception
      // must reach the existing confirmation path, never disclose the path.
    }
  }
  if (expired()) return denied;
  const bridge = getGhostGrantConfirmBridge();
  if (!bridge) {
    return {
      ok: false,
      errorCode: 'LOCAL_PATH_REVEAL_CONFIRM_UNAVAILABLE',
      message: '本机路径确认通道未就绪，请稍后重试',
    };
  }
  let size: number;
  try {
    const stat = fs.statSync(params.absPath);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    return {
      ok: false,
      errorCode: 'MEDIA_FILE_NOT_FOUND',
      message: '该受管媒体文件在确认前已不存在',
    };
  }
  const decision = await bridge.request(params.sessionId, {
    ghostId: 'cindy-media',
    ghostName: 'Cindy Media',
    lane: 'reveal_path',
    items: [
      {
        name: path.basename(params.absPath),
        absPath: params.absPath,
        size,
        mimeType: params.mimeType,
      },
    ],
  });
  if (expired()) return denied;
  if (decision.confirmed) return { ok: true, isCurrent };
  return {
    ok: false,
    errorCode: 'LOCAL_PATH_REVEAL_DENIED',
    message:
      decision.reason === 'timeout'
        ? '本机路径确认超时，本次调用已取消；如仍需要，请提醒用户后重试'
        : decision.reason === 'session_closed' || decision.reason === 'session_aborted'
          ? `Cindy 已取消本机路径确认（${decision.reason}），并非用户手动拒绝。`
          : '用户未允许把本机路径返回给 Agent，不要重试',
  };
}

/**
 * attachments 的「任意本地路径」预处理:原有三层解析不命中、但输入是真实
 * 存在的本地媒体文件路径时,按两层策略放行(workdir 内直通记 tool、外部
 * 确认后记 user),产出 url → ResolvedGrantSource 的旁路表;workdir 外的
 * 多个文件合并进**一次**确认卡,不连环弹。
 */
async function prepareLocalPathAttachments(params: {
  urls: string[];
  ghostId: string;
  workdirAbs: string | null;
  sessionId: string | null;
  sessionInstanceId: string | null;
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
  /** 项数上限(普通调用 MAX_GRANT_ATTACHMENTS;grant_only 批量预授权放宽)。 */
  maxCount: number;
}): Promise<
  { ok: true; resolved: Map<string, ResolvedGrantSource>; isCurrent?: () => boolean } | { ok: false; message: string }
> {
  const resolved = new Map<string, ResolvedGrantSource>();
  let isCurrent: (() => boolean) | undefined;
  // 超项数上限时不弹确认,直接交给 grant 流程报标准错(别让用户白点一次)。
  if (params.urls.length > params.maxCount) return { ok: true, resolved };
  const outside: Array<{
    url: string;
    absPath: string;
    mimeType: string;
    size: number;
    name: string;
  }> = [];
  for (const url of params.urls) {
    // 原有三层(会话图缓存/总仓 blob/缩图缓存)能解析的地址不归本分支管。
    let handledByChain = true;
    try {
      resolveGhostAttachmentUrl(url);
    } catch {
      handledByChain = false;
    }
    if (handledByChain) continue;
    const c = classifyLocalAttachmentPath(url, params.workdirAbs, {
      mimeForExt: blobStore.mimeForExt,
    });
    if (c.kind === 'not-local') continue; // 非本地文件 → 交回 grant 流程的教学错误
    if (c.kind === 'unsupported-type') {
      // attachments 的字节归宿是媒体总仓(规则 25:非媒体不入仓),类型死角由
      // dir 通道补齐——同样吃两层策略,能力面上无类型限制。
      return {
        ok: false,
        message: `该文件类型不能走 attachments 过户(${c.name}):attachments 仅收媒体文件(图片/视频/音频);其它类型请改用 ghost_call 顶层 dir 参数按单文件过户`,
      };
    }
    if (c.kind === 'inside-workdir') {
      resolved.set(url, { absPath: c.absPath, mimeType: c.mimeType, originKind: 'tool' });
    } else {
      outside.push({ url, absPath: c.absPath, mimeType: c.mimeType, size: c.size, name: c.name });
    }
  }
  if (outside.length > 0) {
    // 总量闸(读盘之前,用 classify 层的 stat size):整批字节会驻留内存
    // 直到落仓完成,超限直接拒并教模型分批。
    const totalBytes = outside.reduce((sum, o) => sum + o.size, 0);
    if (totalBytes > GRANT_BATCH_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        message: grantBatchTooLargeMessage(),
      };
    }
    // 人工授权记忆(按张、永久):先算内容指纹查账本,该意识名下已有 user
    // provenance 的 ghost-grant 授权行才直接放行。Full Access 自动交接写入
    // 独立 ghost-tool-grant + tool provenance,热切回 ask/auto 后必须恢复确认。
    // 指纹算法与
    // blobStore.writeBlob 同(sha256 hex),读到的字节顺便喂预览。
    const needConfirm: Array<{
      url: string;
      absPath: string;
      mimeType: string;
      size: number;
      name: string;
      buffer: Uint8Array;
    }> = [];
    for (const o of outside) {
      let buffer: Uint8Array;
      try {
        buffer = await fs.promises.readFile(o.absPath);
      } catch {
        return { ok: false, message: `附件读取失败:${o.name}(文件不可读或已被移动)` };
      }
      const hash = createHash('sha256').update(buffer).digest('hex');
      // 两级记忆:内容指纹永久授权(账本)→ 目录级会话授权(确认卡勾选)。
      const granted =
        (await ledger.hasRef({
          hash,
          refKind: 'ghost-grant',
          refId: params.ghostId,
          originKind: 'user',
        })) ||
        (params.sessionId !== null &&
          dirGrantMemory.has(
            dirGrantMemoryKey(
              params.sessionId,
              params.ghostId,
              'attachments-dir',
              path.dirname(o.absPath),
            ),
          ));
      if (granted) {
        // 短路命中也带 T1 字节:授权判定用的字节 = 实际过户的字节(防换文件)。
        resolved.set(o.url, {
          absPath: o.absPath,
          mimeType: o.mimeType,
          originKind: 'user',
          buffer,
        });
      } else {
        needConfirm.push({ ...o, buffer });
      }
    }
    if (needConfirm.length > 0) {
      // 批量预授权可到 32 张,内嵌预览只给前几张**图片**(每张 dataURL 最大
      // ~5.3MB,全带会撑爆一次 IPC broadcast;视频/音频本就无预览,不占名额;
      // 其余条目显示图标 + 名称 + 路径)。
      let previewCount = 0;
      const items: GhostGrantFileItem[] = needConfirm.map((o) => {
        const canPreview =
          o.mimeType.startsWith('image/') && previewCount < GRANT_PREVIEW_MAX_ITEMS;
        const previewDataUrl = canPreview
          ? buildGrantPreviewDataUrl(o.buffer, o.mimeType)
          : undefined;
        if (previewDataUrl) previewCount += 1;
        return {
          name: o.name,
          absPath: o.absPath,
          size: o.size,
          mimeType: o.mimeType,
          ...(previewDataUrl ? { previewDataUrl } : {}),
        };
      });
      const confirm = await requestGrantConfirm({
        ghostId: params.ghostId,
        sessionId: params.sessionId,
        sessionInstanceId: params.sessionInstanceId,
        lane: 'attachments',
        items,
        getLiveSessionGrantState: params.getLiveSessionGrantState,
      });
      if (!confirm.ok) return confirm;
      isCurrent = confirm.isCurrent;
      if (isCurrent?.() === false) return { ok: false, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
      for (const o of needConfirm) {
        // 人工确认记 user;Full Access 自动交接记 tool,不能伪装成用户点击。
        // 两者都带 T1 字节落仓——确认/授权判定时读到的字节就是实际过户
        // 的字节,中途换文件无效。
        resolved.set(o.url, {
          absPath: o.absPath,
          mimeType: o.mimeType,
          originKind: confirm.approvalSource === 'user' ? 'user' : 'tool',
          buffer: o.buffer,
        });
      }
      // 「允许该目录」勾选:把每张图的精确父目录记入会话级记忆,后续同目录
      // 媒体文件对该意识本会话免弹(跨调用批量任务只需点一次)。
      if (confirm.approvalSource === 'user' && confirm.allowDirs && params.sessionId) {
        for (const o of needConfirm) {
          dirGrantMemory.add(
            dirGrantMemoryKey(
              params.sessionId,
              params.ghostId,
              'attachments-dir',
              path.dirname(o.absPath),
            ),
          );
        }
      }
      if (confirm.approvalSource === 'user') {
        log.info('ghost grant confirm: user approved outside-workdir attachments', {
          ghostId: params.ghostId,
          count: needConfirm.length,
          grantSource: 'user-confirmation',
        });
      }
    }
  }
  return { ok: true, resolved, isCurrent };
}

/**
 * dir / save_dir 的 workdir 外授权:目标真实存在且在 workdir 外时，人工确认
 * 或本地活跃 Full Access 可令历史字段 userGranted=true，交给票据库旁路钳制；
 * 目标不存在/类型不对时不弹卡(直接交给 deposit 报标准错，别让用户为一个
 * 必失败的请求点允许)。
 */
async function confirmDepositOutsideWorkdir(params: {
  ghostId: string;
  sessionId: string | null;
  sessionInstanceId: string | null;
  lane: 'dir' | 'save_dir';
  dirAbs: string;
  workdirAbs: string | null;
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
}): Promise<
  | { ok: true; userGranted: false; isCurrent?: () => boolean }
  | { ok: true; userGranted: true; approvedRealPath: string; isCurrent?: () => boolean }
  | { ok: false; message: string }
> {
  if (!path.isAbsolute(params.dirAbs)) return { ok: true, userGranted: false };
  let real: string;
  let stat: fs.Stats;
  try {
    real = fs.realpathSync.native(params.dirAbs);
    stat = fs.statSync(real);
  } catch {
    return { ok: true, userGranted: false }; // 不存在 → deposit 报「目录不存在」
  }
  if (isInsideSessionWorkdir(real, params.workdirAbs)) return { ok: true, userGranted: false };

  // 会话内授权记忆:同一意识对同一真身路径同一通道,本会话允许过一次即放行。
  if (
    params.sessionId &&
    dirGrantMemory.has(dirGrantMemoryKey(params.sessionId, params.ghostId, params.lane, real))
  ) {
    return { ok: true, userGranted: true, approvedRealPath: real };
  }

  let item: GhostGrantFileItem;
  if (stat.isDirectory()) {
    if (params.lane === 'dir') {
      // 上行读票据:预收集给用户看清体量(文件数/总字节);超限在这里直接拒,
      // 不浪费一次用户点击(deposit 会再收集一次,量级小可接受)。
      const collected = collectDirFiles(real);
      if (!collected.ok) return { ok: false, message: collected.message };
      item = {
        name: path.basename(real),
        absPath: real,
        size: collected.totalBytes,
        isDirectory: true,
        fileCount: collected.files.length,
      };
    } else {
      item = { name: path.basename(real), absPath: real, size: 0, isDirectory: true };
    }
  } else if (stat.isFile() && params.lane === 'dir') {
    item = { name: path.basename(real), absPath: real, size: stat.size };
  } else {
    return { ok: true, userGranted: false }; // 类型不对 → deposit 报标准错
  }

  const confirm = await requestGrantConfirm({
    ghostId: params.ghostId,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    lane: params.lane,
    items: [item],
    getLiveSessionGrantState: params.getLiveSessionGrantState,
  });
  if (!confirm.ok) return confirm;
  if (confirm.isCurrent?.() === false) return { ok: false, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  // Full Access 是每次在实时档位上自动裁决,不伪造「用户确认过」的目录
  // 记忆。这样热切回 ask/auto 后,同一路径的新过户会立刻恢复询问。
  if (confirm.approvalSource === 'user' && params.sessionId) {
    dirGrantMemory.add(dirGrantMemoryKey(params.sessionId, params.ghostId, params.lane, real));
  }
  if (confirm.approvalSource === 'user') {
    log.info('ghost grant confirm: user approved outside-workdir deposit', {
      ghostId: params.ghostId,
      lane: params.lane,
      grantSource: 'user-confirmation',
    });
  }
  return { ok: true, userGranted: true, approvedRealPath: real, isCurrent: confirm.isCurrent };
}

type ManagedToolGrantCandidate = {
  hash: string;
  absPath: string;
  mimeType: string;
  buffer: Uint8Array;
  urls: string[];
};

/**
 * 总仓 blob 的工具交接必须先整批完成权限裁决，再交给 attachmentGrant
 * 的两阶段解析/落仓。这样 grant_only 仍只弹一张确认卡，同时把确认前
 * 读到的同一批字节限制在统一的内存上限内。
 */
async function prepareManagedToolGrantSources(params: {
  urls: string[];
  ghostId: string;
  localResolved: Map<string, ResolvedGrantSource>;
  maxCount: number;
  sessionId: string | null;
  sessionInstanceId: string | null;
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
}): Promise<
  { ok: true; resolved: Map<string, ResolvedGrantSource>; isCurrent?: () => boolean } | { ok: false; message: string }
> {
  // Preserve attachmentGrant's standard count error and, importantly, do not
  // read or confirm an over-limit batch before that error is produced.
  if (params.urls.length > params.maxCount) return { ok: true, resolved: new Map() };

  const candidates = new Map<string, ManagedToolGrantCandidate>();
  let totalBytes = 0;
  for (const source of params.localResolved.values()) {
    if (source.buffer) totalBytes += source.buffer.byteLength;
  }

  for (const url of params.urls) {
    if (params.localResolved.has(url)) continue;
    let resolved: { absPath: string; mimeType: string; blobHash?: string };
    try {
      resolved = resolveGhostAttachmentUrl(url);
    } catch {
      continue;
    }
    if (!resolved.blobHash) continue;

    let origin: 'user' | 'tool' | null;
    let userGranted: boolean;
    let toolGranted: boolean;
    try {
      origin = await chatAttachmentOrigin(resolved.blobHash);
      if (origin) continue;
      userGranted = await ledger.hasRef({
        hash: resolved.blobHash,
        refKind: 'ghost-grant',
        refId: params.ghostId,
        originKind: 'user',
      });
      if (userGranted) continue;
      toolGranted = await ledger.hasGhostToolGrant({
        hash: resolved.blobHash,
        ghostId: params.ghostId,
      });
    } catch {
      return { ok: false, message: '附件授权状态读取失败，请重试' };
    }
    if (!toolGranted) continue;

    let candidate = candidates.get(resolved.blobHash);
    if (!candidate) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(resolved.absPath);
      } catch {
        return {
          ok: false,
          message: `附件读取失败:${path.basename(resolved.absPath)}(文件不可读或已被移动)`,
        };
      }
      if (!stat.isFile()) {
        return {
          ok: false,
          message: `附件读取失败:${path.basename(resolved.absPath)}(文件不可读或已被移动)`,
        };
      }
      if (totalBytes + stat.size > GRANT_BATCH_MAX_TOTAL_BYTES) {
        return { ok: false, message: grantBatchTooLargeMessage() };
      }
      let buffer: Uint8Array;
      try {
        buffer = await fs.promises.readFile(resolved.absPath);
      } catch {
        return {
          ok: false,
          message: `附件读取失败:${path.basename(resolved.absPath)}(文件不可读或已被移动)`,
        };
      }
      if (totalBytes + buffer.byteLength > GRANT_BATCH_MAX_TOTAL_BYTES) {
        return { ok: false, message: grantBatchTooLargeMessage() };
      }
      totalBytes += buffer.byteLength;
      candidate = {
        hash: resolved.blobHash,
        absPath: resolved.absPath,
        mimeType: resolved.mimeType,
        buffer,
        urls: [],
      };
      candidates.set(resolved.blobHash, candidate);
    }
    candidate.urls.push(url);
  }

  if (candidates.size === 0) return { ok: true, resolved: new Map() };

  let previewCount = 0;
  const items: GhostGrantFileItem[] = [];
  for (const candidate of candidates.values()) {
    const canPreview =
      candidate.mimeType.startsWith('image/') && previewCount < GRANT_PREVIEW_MAX_ITEMS;
    const previewDataUrl = canPreview
      ? buildGrantPreviewDataUrl(candidate.buffer, candidate.mimeType)
      : undefined;
    if (previewDataUrl) previewCount += 1;
    items.push({
      name: path.basename(candidate.absPath),
      absPath: candidate.absPath,
      size: candidate.buffer.byteLength,
      mimeType: candidate.mimeType,
      ...(previewDataUrl ? { previewDataUrl } : {}),
    });
  }

  const confirm = await requestGrantConfirm({
    ghostId: params.ghostId,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    lane: 'attachments',
    items,
    getLiveSessionGrantState: params.getLiveSessionGrantState,
  });
  if (!confirm.ok) return confirm;
  if (confirm.isCurrent?.() === false) return { ok: false, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };

  const originKind = confirm.approvalSource === 'user' ? 'user' : 'tool';
  const resolved = new Map<string, ResolvedGrantSource>();
  for (const candidate of candidates.values()) {
    const source: ResolvedGrantSource = {
      absPath: candidate.absPath,
      mimeType: candidate.mimeType,
      originKind,
      buffer: candidate.buffer,
    };
    for (const url of candidate.urls) resolved.set(url, source);
  }
  return { ok: true, resolved, isCurrent: confirm.isCurrent };
}

/**
 * attachments 过户全链路(普通调用与 grant_only 批量预授权共用同一条链):
 * 本地路径两层策略预处理(workdir 内直通 / 外部确认卡)→ 逐张解析(会话图
 * 缓存 / 总仓 blob + 出生闸 + 授权记忆 / 缩图缓存 / 本地旁路)→ 落仓记账,
 * 返回指纹数组。任何一张失败整批拒。
 */
async function grantAttachmentUrls(params: {
  ghostId: string;
  urls: string[];
  workdirAbs: string | null;
  sessionId: string | null;
  sessionInstanceId: string | null;
  getLiveSessionGrantState?: CindyGhostsHostDeps['getLiveSessionGrantState'];
  maxCount: number;
}): Promise<{ ok: true; hashes: string[]; isCurrent: () => boolean } | { ok: false; message: string }> {
  const { ghostId } = params;
  const localGrant = await prepareLocalPathAttachments({
    urls: params.urls,
    ghostId,
    workdirAbs: params.workdirAbs,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    getLiveSessionGrantState: params.getLiveSessionGrantState,
    maxCount: params.maxCount,
  });
  if (!localGrant.ok) return localGrant;
  if (localGrant.isCurrent?.() === false) return { ok: false, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  const managedToolGrant = await prepareManagedToolGrantSources({
    urls: params.urls,
    ghostId,
    localResolved: localGrant.resolved,
    maxCount: params.maxCount,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    getLiveSessionGrantState: params.getLiveSessionGrantState,
  });
  if (!managedToolGrant.ok) return managedToolGrant;
  // 保留两次预处理捕获的授权，不能用后取的快照替换先前代次。
  const isCurrent = () => localGrant.isCurrent?.() !== false && managedToolGrant.isCurrent?.() !== false;
  const result = await grantAttachmentsToGhost(
    {
      isCurrent,
      // 宽容解析:模型可能只有本地路径、缩图副本路径、或把 xdt-image
      // 地址的会话段拼丢(多个会话实测都踩过)——统一归一化。
      // 总仓 blob 形态(聊天附件或当前 Agent 工具结果的受管地址)额外过
      // 账本出生闸:必须进过聊天流(session-attachment)才可过户,
      // 纯画廊产物/孤儿文件拒;过户行按真实出生记账(user/tool)。
      resolveImageUrl: async (url) => {
        const local = localGrant.resolved.get(url);
        if (local) return local;
        const managed = managedToolGrant.resolved.get(url);
        if (managed) return managed;
        const r = resolveGhostAttachmentUrl(url);
        if (!r.blobHash) return r;
        const origin = await chatAttachmentOrigin(r.blobHash);
        if (!origin) {
          // 交接记忆:该内容此前已过户给本意识时,模型拿总仓地址再引用
          // 直接放行——workdir 外确认流落仓后,模型手里的地址就是总仓
          // 形态,不放行会逼它绕回原路径。人工确认与 Host 工具代办必须
          // 保留各自 provenance:后者仍是 ghost-tool-grant,绝不升级成人工
          // 永久授权；这里只复用它本来就已经赋予插件的取件能力。
          const userGranted = await ledger.hasRef({
            hash: r.blobHash,
            refKind: 'ghost-grant',
            refId: ghostId,
            originKind: 'user',
          });
          if (userGranted) {
            return { absPath: r.absPath, mimeType: r.mimeType, originKind: 'user' };
          }
          const toolGranted = await ledger.hasGhostToolGrant({
            hash: r.blobHash,
            ghostId,
          });
          if (toolGranted) {
            // The batch preflight above must have covered every tool grant.
            // If the ledger changes during the async resolve phase, fail
            // closed instead of silently opening a one-item confirmation path.
            throw new GrantPolicyError('附件授权状态已变化，请重试');
          }
          // 策略拒绝标记:message 原样透给模型(落格式教学文案会误导自纠)。
          throw new GrantPolicyError('该媒体不是聊天里出现过的附件或工具结果,不可过户');
        }
        return { absPath: r.absPath, mimeType: r.mimeType, originKind: origin };
      },
      readFile: (absPath) => fs.promises.readFile(absPath),
      writeBlob: (p) => blobStore.writeBlob(p),
      recordBlob: (p) => ledger.recordBlob(p),
      // 顺序调用幂等化:同 (指纹,意识,引用类型,来源) 已有交接行就不再插入。
      // 并发 check-then-insert 仍可能产生重复账行,但不会改变归属或扩权语义。
      addRef: async (p) => {
        const exists = await ledger.hasRef({
          hash: p.hash,
          refKind: p.refKind,
          refId: p.refId,
          originKind: p.originKind,
        });
        if (!isCurrent()) throw new GrantPolicyError(GRANT_AUTHORIZATION_CHANGED_MESSAGE);
        return exists ? '' : ledger.addRef(p);
      },
      log,
    },
    { ghostId, urls: params.urls, maxCount: params.maxCount },
  );
  if (!isCurrent()) return { ok: false, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  return result.ok ? { ...result, isCurrent } : result;
}

function ghostHasTools(ghost: InstalledGhost): boolean {
  return (ghost.manifest.tools?.length ?? 0) > 0;
}

/** 工具结果图片描述:视觉桥描述并发上限(worker 审核强制项,不串行等待 N×30s)。 */
const TOOL_RESULT_DESCRIBE_CONCURRENCY = 2;
/** 工具结果图片描述:整批总预算(超时丢弃未完成描述,工具结果照常返回)。 */
const TOOL_RESULT_DESCRIBE_BUDGET_MS = 60 * 1000;
/** result.result 递归扫描最大深度(防爆栈)。 */
const TOOL_RESULT_SCAN_MAX_DEPTH = 8;
/** 递归扫描最大节点数(防插件返回超宽数组/对象时同步 DFS 卡死主进程/P1)。 */
const TOOL_RESULT_SCAN_MAX_NODES = 10_000;
/** 递归扫描时跳过的元数据键(避免处理自引用/无关字段)。 */
const TOOL_RESULT_SKIP_KEYS = new Set(['xdt_media_descriptions', 'hint', 'setup']);

/**
 * 收集 cindy-media:// 图片 URL 并转成文字描述(视觉桥,最佳努力)。
 *
 * 纯文本模型(deepseek 等)拿不到工具结果里的 image block,只能看到
 * cindy-media:// URL 文本,读不到图容易幻觉编造内容。这里从 producedMedia(主机
 * 媒体账本)+ result.result(插件返回体,递归扫描)收集图片 URL,读 blob 调视觉桥
 * 转描述,附加为顶层 xdt_media_descriptions。任何失败/未启用都静默跳过,工具
 * 调用照常返回。
 * @internal 导出仅供单测;调用方通过 getCindyGhostsMcpDeps 的 hostDeps 注入。
 */
export async function buildToolResultImageDescriptions(params: {
  producedMedia: string[];
  resultPayload: unknown;
  sessionId: string | null;
  sessionInstanceId: string | null;
  describeImage?: CindyGhostsHostDeps['describeToolResultImage'];
}): Promise<{
  /** 成功转成描述的工具结果图片。缺省 = 有图但全部失败（attemptedCount > 0）。 */
  xdt_media_descriptions?: Array<{ url: string; description: string }>;
  /** 真正尝试描述的图片数（非 skipped）。0 = 无图或全部有意跳过，不触发告警。 */
  attemptedCount: number;
  /** 预算超时/中止导致部分图未完成（budgetAbort 触发）。true 时不应告警「不可用」——
   *  超时不是后端不可用，避免把慢后端/长图误报成故障。 */
  aborted: boolean;
} | null> {
  const { describeImage } = params;
  if (!describeImage) return null;

  // 收集 URL:producedMedia(主机账本,本次调用期间主机实际入库的媒体,可信)。
  // result.result 里的 cindy-media:// URL **必须也在 producedMedia 中**才收——
  // 插件返回体不可信,可回显它没生产/没授权接收的任意 URL,若直接 resolve 读 blob
  // 会触发 host 读任意媒体字节外发给视觉后端(安全 P1)。只有经主机 media 账本确权
  // (recordGhostCallMedia 在媒体入库时记录)的 URL 才允许描述。
  // 扫描仍带节点预算:防超宽结果同步 DFS 卡死主进程(P1)。
  const producedMediaSet = new Set(params.producedMedia);
  const urls = new Set(params.producedMedia);
  const resultUrls = new Set<string>();
  collectCindyMediaUrls(params.resultPayload, resultUrls, TOOL_RESULT_SCAN_MAX_DEPTH, {
    remaining: TOOL_RESULT_SCAN_MAX_NODES,
  });
  for (const url of resultUrls) {
    if (producedMediaSet.has(url)) urls.add(url);
  }
  if (urls.size === 0) return null;

  // 过滤为图片:parseBlobUrl 校验 cindy-media://blobs/<hash>.<ext> 形状,
  // mimeForExt 按扩展名白名单判 image/*——跳过 mp4/webm/mp3/glb 等非图媒体。
  const imageUrls: string[] = [];
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    const parsed = blobStore.parseBlobUrl(url);
    if (!parsed) continue;
    const mime = blobStore.mimeForExt(parsed.ext);
    if (mime && mime.startsWith('image/')) imageUrls.push(url);
  }
  if (imageUrls.length === 0) return null;

  // 限量并发描述(不串行等待 N×30s)+ 整批总预算(超时丢弃未完成)。
  // 单张失败静默跳过,不阻塞其余;全失败/全超时 → 不附加字段。
  // 惰性启动:worker 拿到 index 才调 describeImage,不预建 promise——预建会在
  // map 阶段同步启动全部请求,并发限制失效。
  // 预算是「完成门」双保险:
  //  1) 共享 AbortController,deadline 到点 abort 所有在飞请求(最佳努力,
  //     describeImage 透传 signal 到视觉通道 fetch,能中止大部分请求);
  //  2) Promise.race 兜底:即使某 describeImage 不响应 signal(如缓存命中
  //     路径不走 fetch),预算到期也立即返回已完成描述,绝不把 callGhostTool
  //     收口无限挂住。
  const described: Array<{ url: string; description: string }> = [];
  const deadline = Date.now() + TOOL_RESULT_DESCRIBE_BUDGET_MS;
  const budgetAbort = new AbortController();
  // 单个预算 timer 同时承担「abort 在飞请求」+「race 兜底 resolve」:
  // 到点 abort signal(硬切断 fetch),并让 race 立即返回;finally 只清这一个
  // timer,快速完成时不留悬挂 timeout(高频 ghost_call 不累积无用 timer)。
  let settleRace: (() => void) | null = null;
  const racePromise = new Promise<void>((resolve) => {
    settleRace = resolve;
  });
  const budgetTimer = setTimeout(() => {
    budgetAbort.abort();
    settleRace?.();
  }, TOOL_RESULT_DESCRIBE_BUDGET_MS);
  let next = 0;
  let attempted = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadline || budgetAbort.signal.aborted) return;
      const idx = next++;
      if (idx >= imageUrls.length) return;
      const url = imageUrls[idx];
      // 请求启动即计 attempted(区分「有意跳过」:skip 判定在 descriptor 内同步完成、
      // 不挂起,结果回来再回退;挂起到预算 abort 的都是真实后端尝试,计数不丢——
      // 外层 Promise.race 在 budget 到期时立即返回,不等 worker 恢复,若等到结果才
      // 计数,abort 场景 attempted 会漏计)。
      attempted += 1;
      let result: ToolResultImageDescription | null = null;
      try {
        // per-call 与预算 race:即使 describeImage 不响应 signal 且永不 settle
        // (极端注入实现/后端异常),budget 到期后本调用立即返回 null,worker 下一轮
        // 因 aborted 退出——不永久 await、不悬挂 worker 持有 imageUrls/described
        // 等闭包(高频 ghost_call 不按「每次最多 2 个悬挂 worker」累积)。
        // 原始 promise 挂 catch 吞掉潜在 rejection,防 unhandled rejection。
        const raw = describeImage({
          imageUrl: url,
          sessionId: params.sessionId,
          sessionInstanceId: params.sessionInstanceId,
          signal: budgetAbort.signal,
        }).catch(() => ({ skipped: false, description: null }));
        result = await Promise.race([
          raw,
          racePromise.then(() => null),
        ]);
      } catch {
        // 单张失败/预算 abort 静默跳过(视觉桥不可用/后端错误/超时),不阻塞其余图。
      }
      // 有意跳过回退计数:skipped(视觉桥未启用/模型不命中/session 缺失)不是真实
      // 尝试——功能本就没开,不得告警「不可用」。请求立即返回,预算 abort 前必达。
      if (result?.skipped) attempted -= 1;
      // deadline 到点后不再启动新图;已 await 的请求由 abort 中止后走 catch 收口。
      // race 兜底已 resolve 后(aborted)不再接受 worker 迟到的结果,避免预算
      // 到期返回后 described 仍被后台 worker 追加(结果与返回快照不一致)。
      if (result && !result.skipped && result.description !== null && !budgetAbort.signal.aborted) {
        described.push({ url, description: result.description });
      }
    }
  };
  try {
    // Promise.race:预算到期(或全部 worker 收敛)即返回,不依赖底层响应 signal。
    await Promise.race([
      Promise.all(
        Array.from({ length: Math.min(TOOL_RESULT_DESCRIBE_CONCURRENCY, imageUrls.length) }, worker),
      ),
      racePromise,
    ]);
  } finally {
    clearTimeout(budgetTimer);
  }

  // 始终返回 attemptedCount + aborted（含全失败/中止，供 callGhostTool 判定是否告警）；
  // 有成功描述才附 xdt_media_descriptions。预算超时中止（aborted）不应告警「不可用」。
  // attemptedCount 只计「真正尝试」的图（非 skipped）：视觉桥未启用/模型不命中等
  // 有意跳过不计入，避免功能没开时误报「视觉桥不可用」。
  const aborted = budgetAbort.signal.aborted;
  return described.length > 0
    ? { xdt_media_descriptions: described, attemptedCount: attempted, aborted }
    : { attemptedCount: attempted, aborted };
}

/**
 * 递归扫描任意嵌套对象/数组,收集值形如 `cindy-media://blobs/...` 的字符串。
 * 跳过元数据键(TOOL_RESULT_SKIP_KEYS),限制深度防爆栈,**并限总节点数**——
 * 插件工具结果是不可信输入,可能返回宽度极大的数组/对象;同步 DFS 无节点上限会在
 * 60s 预算启动前遍历并保存全部结果,卡死 Electron 主进程甚至耗尽内存(P1)。
 * @internal 导出仅供单测。
 */
export function collectCindyMediaUrls(
  value: unknown,
  sink: Set<string>,
  depth: number,
  budget?: { remaining: number },
): void {
  if (depth <= 0 || (budget && budget.remaining <= 0)) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (budget) budget.remaining -= 1;
      if (budget && budget.remaining <= 0) return;
      collectCindyMediaUrls(item, sink, depth - 1, budget);
    }
    return;
  }
  if (value && typeof value === 'object') {
    // 用 for...in 惰性枚举而非 Object.entries:后者会先同步物化全部键值对数组,
    // 宽对象(海量键)在节点预算检查前就已分配大量内存并阻塞主进程(P1)。for...in
    // 按需产出键,预算耗尽立即 break,不物化未访问条目。
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (TOOL_RESULT_SKIP_KEYS.has(key)) continue;
      if (budget) budget.remaining -= 1;
      if (budget && budget.remaining <= 0) return;
      collectCindyMediaUrls((value as Record<string, unknown>)[key], sink, depth - 1, budget);
    }
    return;
  }
  if (typeof value === 'string' && value.startsWith('cindy-media://')) {
    sink.add(value);
  }
}

function visibleChipGhosts(
  workdir: string | null,
): InstalledGhost[] {
  return getGhostManager()
    .list()
    .filter(
      (ghost) =>
        ghost.enabled &&
        isGhostAvailableForActiveSession(ghost.manifest.id) &&
        ghost.manifest.kind === 'chip' &&
        ghostHasTools(ghost) &&
        !isGhostDisabledForWorkdir(ghost.manifest.id, workdir),
    );
}

const ghostVisibilityDeps = {
  listGhosts: () => getGhostManager().list(),
  isAvailableForActiveSession: isGhostAvailableForActiveSession,
  isDisabledForWorkdir: isGhostDisabledForWorkdir,
};

function ghostRecall(ghost: InstalledGhost): string | undefined {
  return ghost.manifest.whenToUse ?? ghost.manifest.description;
}

/** 供各 harness 会话装配 system/developer 段；每次调用按 workdir 取一次数据。 */
export function getGhostRosterPrompt({ workingDir }: { workingDir?: string }): string {
  if (!workingDir) return '';
  const items = visibleChipGhosts(workingDir).map((ghost) => {
    const recall = ghostRecall(ghost);
    return {
      id: ghost.manifest.id,
      name: ghost.manifest.name,
      ...(ghost.manifest.command ? { command: ghost.manifest.command } : {}),
      ...(recall ? { recall } : {}),
    };
  });
  return buildGhostRosterPrompt(items);
}

function toCindyGhostInfo(ghost: InstalledGhost): CindyGhostInfo {
  const recall = ghostRecall(ghost);
  let setup: CindyGhostInfo['setup'];
  try {
    setup = getGhostSetupAssessment(ghost.manifest.id);
  } catch (error) {
    // Discovery is best-effort per plugin. Keep this plugin discoverable
    // without claiming it is ready; ghost_call retains the strict setup gate.
    log.warn('ghost setup assessment omitted from discovery', {
      ghostId: ghost.manifest.id,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  }
  return {
    id: ghost.manifest.id,
    name: ghost.manifest.name,
    ...(ghost.manifest.command ? { command: ghost.manifest.command } : {}),
    ...(recall ? { recall } : {}),
    ...(ghost.manifest.manual
      ? {
          manual: ghost.manifest.manual.items.map(({ name, description }) => ({
            name,
            description,
          })),
        }
      : {}),
    ...(setup ? { setup } : {}),
    tools: (ghost.manifest.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    })),
  };
}

/**
 * 构造总机 deps(每次工具调用都现查,无任何缓存层)。
 *
 * sessionCtx:Claude in-process SDK 路径的会话语境(toClaudeSdkConfig(ctx)
 * 时按 session 闭包进来;每次 startSession 都重建 provider,语境不串号)。
 * Codex HTTP bridge 路径下建线期语境是全局空值,tool-call 期经
 * AsyncLocalStorage(getLiziMcpSessionContext)恢复——因此运行时取语境一律
 * "ALS 优先、闭包兜底"(见 resolveSessionContext)。
 */
export function getCindyGhostsMcpDeps(
  sessionCtx?: LiziMcpSessionContext,
  hostDeps: CindyGhostsHostDeps = {},
): CindyGhostsMcpDeps {
  const resolveSessionContext = (): LiziMcpSessionContext | undefined =>
    getLiziMcpSessionContext() ?? sessionCtx;
  const marketTools = hostDeps.pluginMarket && createPluginMarketAgentTools({
    market: hostDeps.pluginMarket,
    installedState: (ghostId) => {
      const visibility = classifyGhostVisibility(ghostId, resolveSessionContext()?.workingDir ?? null, ghostVisibilityDeps);
      return {
        exists: getGhostManager().list().some(ghost => ghost.manifest.id === ghostId),
        errorCode: visibility.ok ? null : visibility.errorCode,
      };
    },
    captureRead: () => {
      const owner = getActiveAppSession();
      const assertCurrent = () => {
        const current = getActiveAppSession();
        if (isAppSessionBoundaryPending() || owner.generation !== current.generation ||
            owner.mode !== current.mode || owner.dataOwnerId !== current.dataOwnerId) {
          throwIpcError('PRECONDITION_FAILED', 'The active account changed during plugin discovery');
        }
      };
      assertCurrent();
      return assertCurrent;
    },
    captureInstall: (signal) => {
      const context = resolveSessionContext();
      const live = context?.sessionId && context.sessionInstanceId
        ? hostDeps.getLiveSessionGrantState?.(context.sessionId, context.sessionInstanceId)
        : null;
      const assertCurrent = () => {
        if (signal?.aborted || !live?.permissionMode || live.isCurrent?.() !== true ||
            workdirWriteVerdict(live.permissionMode, false) === 'deny') {
          throwIpcError('PERMISSION_DENIED', 'Plugin install requires a current writable task outside Plan mode');
        }
      };
      assertCurrent();
      const owner = captureGhostMutationOwnerForMcp();
      const release = acquireGhostMutationLeaseForMcp(owner);
      return { assertCurrent, release };
    },
  });
  return {
    saveLargeGhostResult: async (text) => withForgeOwnerLease(async () => {
      // Live instance + runtime permission are re-read immediately before any
      // side effect; the persisted row only supplies the workdir path.
      const target = await resolveLargeResultSpillTarget(resolveSessionContext(), hostDeps.getLiveSessionGrantState);
      const fileName = `ghost-${randomUUID()}.json`;
      const relativePath = target.remoteHostId
        ? path.posix.join(LARGE_RESULT_DIR, fileName)
        : path.join(LARGE_RESULT_DIR, fileName);
      await target.revalidate(
        target.remoteHostId
          ? path.posix.join(target.workingDir, relativePath)
          : path.join(target.workingDir, relativePath),
      );
      let anchor: LocalSpillAnchor | null = null;
      let hold: fs.promises.FileHandle | null = null;
      if (target.remoteHostId) {
        anchor = await writeLargeResultToRemote(target.remoteHostId, target.workingDir, relativePath, text, () => target.revalidate());
      } else {
        // Reuse the root-anchored, no-overwrite writer, including its symlink/race
        // checks. No plugin-controlled filename or raw fs write enters this path.
        // `beforeCommit` runs right before the isolated writer receives the bytes: the
        // realpath/lstat checks and utility-process start-up are async, and an instance that
        // ended, switched, entered Plan or lost its grant meanwhile must not get a file written.
        const outcome = await writeDocsOutput({
          root: target.workingDir,
          path: path.join(target.workingDir, relativePath),
          data: Buffer.from(text, 'utf8'),
          overwrite: false,
          beforeCommit: () => target.revalidate(),
        });
        // The cleanup anchor is the identity the writer read through its own handle —
        // never a separate path query, which a workdir process could have re-pointed at an
        // unrelated file. Without an attested identity, cleanup is skipped.
        anchor = outcome?.identity ?? null;
        // Retain an inode-bound capability across the bookkeeping below (round 29): a
        // path-only cleanup cannot follow the output directory once a workdir process moves
        // it out of the workdir between the writer's success and the ledger commit. A
        // write whose attested inode can no longer be bound (moved or replaced in that gap)
        // is an unsettled write (round 30): nothing is booked in its name, the path is
        // cleaned by identity where still reachable, and the call fails.
        if (anchor) {
          hold = await bindLocalSpill(path.join(target.workingDir, relativePath), anchor);
          if (!hold) {
            await discardLargeResultFile(target, relativePath, anchor);
            throw new Error('Tool result file lost its anchor before registration');
          }
        }
      }
      try {
        // The write is another async boundary: an instance that ended or lost its
        // automatic-write grant meanwhile must not have refs booked in its name.
        try {
          await target.revalidate();
        } catch (err) {
          await discardLargeResultFile(target, relativePath, anchor, hold);
          throw err;
        }
        // Keep media referenced by the full response alive even when the SDK only
        // receives its bounded projection; refs are committed after the bytes are durable.
        const insertedRefs = await commitLargeResultMediaRefs(target, relativePath, text, anchor, hold);
        // The ledger mutations above are further async boundaries: an instance that
        // ended or lost its grant meanwhile must not keep refs or a private file in its name.
        try {
          await target.revalidate();
        } catch (err) {
          for (const id of insertedRefs) await ledger.removeRefById(id).catch(() => 0);
          await discardLargeResultFile(target, relativePath, anchor, hold);
          throw err;
        }
        // Remote: drop the daemon-held descriptor only now. The authorization is re-checked
        // at the real frame boundary (round 30): reconnecting / handshaking the host may take
        // long, and an instance that ended or lost its grant meanwhile withdraws the whole
        // spill through the still-held descriptor instead of keeping the file in its name.
        if (target.remoteHostId && anchor?.holdId !== undefined) {
          let authorizationRevoked = false;
          try {
            await getRemoteFileBrowser().request(
              target.remoteHostId,
              'releaseNewFile',
              { holdId: anchor.holdId },
              { beforeSend: async () => { try { await target.revalidate(); } catch (err) { authorizationRevoked = true; throw err; } } },
            );
          } catch (err) {
            if (authorizationRevoked) {
              for (const id of insertedRefs) await ledger.removeRefById(id).catch(() => 0);
              await discardLargeResultFile(target, relativePath, anchor, hold);
              throw err;
            }
            // The bytes are durable, referenced and re-validated; a lost release response only
            // leaves a daemon-side descriptor that its TTL closes.
            log.warn('ghost large result: remote hold release failed; the daemon closes it after its TTL', {
              remoteHostId: target.remoteHostId, relPath: relativePath, error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return relativePath;
      } finally {
        await hold?.close().catch(() => undefined);
      }
    }),
    ...(marketTools ? {
      searchMarket: (query: string) => marketTools.search(query),
      installMarket: (request: { pluginId: string; releaseId: string }, signal?: AbortSignal) => marketTools.install(request, signal),
    } : {}),
    connectAccount: async (target) => {
      const context = resolveSessionContext();
      const sessionId = ghostSetupInteractionSessionId(context);
      if (!sessionId) return { ok: false, errorCode: 'NO_SESSION_CONTEXT' };
      const service = getBotAuthorizationService();
      if (!service) return { ok: false, errorCode: 'HOST_NOT_READY' };
      return service.request(sessionId, target);
    },
    callMedia: async (request) => {
      const sessionContext = resolveSessionContext();
      const sessionId = sessionContext?.sessionId;
      const downloadContext = (request.action === 'request' || request.action === 'poll') && sessionId && sessionContext?.sessionInstanceId
        ? hostDeps.createMediaDownloadContext?.(sessionId, sessionContext.sessionInstanceId)
        : undefined;
      let result: Record<string, unknown>;
      try {
        result = await callCindyMedia(request, downloadContext);
      } finally {
        downloadContext?.dispose?.();
      }
      if (request.action === 'resolve_local_path' && result.ok !== false) {
        const localPath = typeof result.local_path === 'string' ? result.local_path : '';
        const mimeType = typeof result.mime_type === 'string' ? result.mime_type : '';
        if (!localPath || !mimeType) {
          return {
            ok: false,
            errorCode: 'INTERNAL',
            message: '媒体路径解析结果缺少必要字段',
          };
        }
        const confirmed = await requestMediaPathRevealConfirm({
          sessionId: sessionId ?? null,
          sessionInstanceId: resolveSessionContext()?.sessionInstanceId ?? null,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          absPath: localPath,
          mimeType,
        });
        if (!confirmed.ok) return confirmed;
        if (confirmed.isCurrent?.() === false) return {
          ok: false, errorCode: 'LOCAL_PATH_REVEAL_DENIED',
          message: 'Task or Plan permissions changed; retry with the current scope.',
        };
      }
      if (request.action !== 'resolve_local_path' && result.ok !== false && sessionId) {
        // Core 结果返回给当前 Agent 前先同步挂到本会话。后续消息落库钩子仍会
        // 幂等补账，但不能依赖那个异步时序：Agent 可能紧接着通过
        // ghost_call.attachments 把结果交给插件。
        const committed = await commitMessageMediaRefs({
          sessionId,
          role: 'tool',
          content: result,
        });
        if (committed && committed.failed > 0) {
          log.warn('Core media result session ref commit incomplete', {
            sessionId,
            failed: committed.failed,
          });
        }
      }
      return result;
    },
    // 花名册快照(server 装配时取一次):唤醒的芯片意识 + 召回线索,进
    // ghost_list 工具描述做语义召回。system 段由 getGhostRosterPrompt 在每个
    // session 装配时按 workdir 单独取数,更准确;实时真相以 ghost_list 调用返回为准。
    // 线索优先 whenToUse(给模型
    // 的场景枚举,可独立调优),缺省回落 description(给人的自我介绍);
    // 两者皆无的意识只列名字与指令(作者该去补——手册已教)。
    //
    // 目录级禁用(ghostWorkdirPrefs):被用户在本会话 workdir 停用的意识
    // 不进花名册,ghost_list 也不返回;ghost_info / ghost_call 会明说当前
    // 目录停用。装配时刻 ALS 未必生效,workdir 取 ALS 优先、建线闭包
    // 兜底;若没有解析到 workingDir(包括 Codex/Pi bridge 建线期空值),花名册
    // 宁缺勿全,不注入工具描述;Codex 正常 startSession 的 developerInstructions
    // 会在拿到真实 workdir 后单独装配 system 段。
    //
    // 伙伴冻结 Toolset 只清空本花名册快照（不把全量插件写进工具描述）；
    // ghost_list / ghost_info / ghost_call 仍按实时可见性发现已装插件，
    // 内置工具冻结名单不套到插件 ID；授权卡同样由 Host 按实时插件可见性守门。
    getRosterItems() {
      const context = resolveSessionContext();
      const workdir = context?.workingDir;
      if (!workdir || readAllowedBuiltinPluginIds(context?.vendorOptions)) return [];
      return visibleChipGhosts(workdir)
        .map((g) => {
          const recall = ghostRecall(g);
          return {
            id: g.manifest.id,
            name: g.manifest.name,
            ...(g.manifest.command ? { command: g.manifest.command } : {}),
            ...(recall ? { recall } : {}),
          };
        });
    },
    async listAwakeGhosts(): Promise<CindyGhostInfo[]> {
      // 现查同样按会话 workdir 滤掉目录级禁用的意识(ALS 恢复的真实语境
      // 优先)——模型主动 ghost_list 也看不到被禁用的条目,清单层面干净。
      const context = resolveSessionContext();
      const workdir = context?.workingDir ?? null;
      return visibleChipGhosts(workdir)
        .map(toCindyGhostInfo);
    },
    async getAwakeGhost(ghostId) {
      const workdir = resolveSessionContext()?.workingDir ?? null;
      const visibility = classifyGhostVisibility(ghostId, workdir, ghostVisibilityDeps);
      if (!visibility.ok) return visibility;
      const visible = visibleChipGhosts(workdir).find(
        (ghost) => ghost.manifest.id === ghostId,
      );
      if (visible) {
        return { ok: true, ghost: toCindyGhostInfo(visible) };
      }
      return {
        ok: false,
        errorCode: 'GHOST_NOT_FOUND',
        message: GHOST_NO_TOOLS_MESSAGE,
      };
    },
    async readGhostManual({ ghostId, path: manualPath }) {
      const workdir = resolveSessionContext()?.workingDir ?? null;
      const visibility = classifyGhostVisibility(ghostId, workdir, ghostVisibilityDeps);
      if (!visibility.ok) {
        return {
          ok: false,
          manual: [],
          content: '',
          errorCode: visibility.errorCode,
          message: visibility.message,
        };
      }
      if (!ghostHasTools(visibility.ghost)) {
        return {
          ok: false,
          manual: [],
          content: '',
          errorCode: 'GHOST_NOT_FOUND',
          message: GHOST_NO_TOOLS_MESSAGE,
        };
      }
      return readInstalledGhostManual(visibility.ghost, manualPath);
    },
    async callGhostTool({
      ghostId,
      tool,
      args,
      attachments,
      dir,
      saveDir,
      agentToolUseId,
      grantOnly,
      setupPlan,
    }) {
      const sessionContext = resolveSessionContext();
      const sessionIdForConfirm = sessionContext?.sessionId ?? null;
      const sessionInstanceIdForGrant = sessionContext?.sessionInstanceId ?? null;
      const sessionWorkdir = sessionContext?.workingDir ?? null;
      const initialVisibility = classifyGhostVisibility(
        ghostId,
        sessionWorkdir,
        ghostVisibilityDeps,
      );
      if (!initialVisibility.ok) return initialVisibility;
      const target = initialVisibility.ghost;
      // 媒体过户:显式 attachments 逐张落媒体总仓 + 记可读引用
      // (人工确认 = ghost-grant；Host 工具代办 = ghost-tool-grant),指纹注入
      // args.attachments 交给意识。任何一张失败整批拒(ATTACHMENT_INVALID),
      // 不做半成品授权。全链路见 grantAttachmentUrls。
      let mergedArgs = args;
      // 文件交接的原授权要贯穿后续目录审批、上下文查询和最终派发。
      const handoffChecks: Array<() => boolean> = [];
      const handoffExpired = () => handoffChecks.some((isCurrent) => !isCurrent());
      const handoffDenied = { ok: false as const, errorCode: 'PERMISSION_DENIED' as const,
        message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
      // Runtime setup gate: the shared visibility check above runs before any
      // durable attachment grant, directory ticket, sandbox, card call, or dispatch.
      // grant_only never dispatches and intentionally ignores its tool field.
      if (
        !grantOnly &&
        !(target.manifest.tools ?? []).some((candidate) => candidate.name === tool)
      ) {
        return {
          ok: false,
          errorCode: 'TOOL_NOT_FOUND',
          message: toolNotFoundMessage(ghostId, tool, target.manifest.tools),
        };
      }
      if (grantOnly && (!attachments || attachments.length === 0)) {
        return {
          ok: false,
          errorCode: 'ATTACHMENT_INVALID',
          message: 'grant_only 调用必须携带 attachments(要预授权的文件地址列表)',
        };
      }
      const setupCoordinator = getGhostSetupCoordinator();
      if (!setupCoordinator) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: '插件设置通道尚未就绪，本次调用未执行。',
        };
      }
      const authorizationSessionId = ghostSetupInteractionSessionId(sessionContext);
      const authorizationService = getBotAuthorizationService();
      if (authorizationService && authorizationSessionId && await isBotAuthorizationSession(authorizationSessionId)) {
        const service = authorizationService;
        const card = await service.request(authorizationSessionId, { kind: 'plugin', id: ghostId, ...(setupPlan && getGhostSetupAssessment(ghostId).reauthSuggest ? { reauthorize: true } : {}) }, setupPlan);
        if (!card.ok) return card;
      }
      const setup = await setupCoordinator.ensureReady({
        sessionId: ghostSetupInteractionSessionId(sessionContext),
        ghostId,
        ...(!grantOnly ? { tool } : {}),
        workingDir: sessionWorkdir,
        ...(setupPlan ? { plan: setupPlan } : {}),
      });
      if (!setup.ok) return setup;

      // OAuth/settings may take minutes. Re-resolve mutable target facts after
      // the waiter completes and before beginning the existing side effects.
      const refreshedVisibility = classifyGhostVisibility(
        ghostId,
        sessionWorkdir,
        ghostVisibilityDeps,
      );
      if (!refreshedVisibility.ok) return refreshedVisibility;
      const refreshed = refreshedVisibility.ghost;
      if (
        !grantOnly &&
        !(refreshed.manifest.tools ?? []).some((candidate) => candidate.name === tool)
      ) {
        return {
          ok: false,
          errorCode: 'TOOL_NOT_FOUND',
          message: toolNotFoundMessage(ghostId, tool, refreshed.manifest.tools),
        };
      }
      let finalAssessment;
      try {
        finalAssessment = getGhostSetupAssessment(ghostId);
      } catch {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: t('newChat.pluginSetup.assessmentReadFailed'),
        };
      }
      if (finalAssessment.state !== 'ready') {
        return {
          ok: false,
          errorCode: 'SETUP_REQUIRED',
          message: t('newChat.pluginSetup.setupChangedDuringResume'),
          setup: finalAssessment,
        };
      }
      // 批量预授权(grant_only):只过户不派发。它与普通调用共用上面的
      // Host-authoritative setup gate，确保任何授权副作用之前插件已经 ready。
      if (grantOnly) {
        // Full pre-grant gate: confirm target, workdir, and setup readiness
        // BEFORE grantAttachmentUrls creates durable ledger entries.
        const grantVisibility = classifyGhostVisibility(
          ghostId,
          sessionWorkdir,
          ghostVisibilityDeps,
        );
        if (!grantVisibility.ok) return grantVisibility;
        try {
          const grantOnlyAssessment = getGhostSetupAssessment(ghostId);
          if (grantOnlyAssessment.state !== 'ready') {
            return {
              ok: false,
              errorCode: 'SETUP_REQUIRED',
              message: t('newChat.pluginSetup.setupIncomplete'),
              setup: grantOnlyAssessment,
            };
          }
        } catch {
          return {
            ok: false,
            errorCode: 'INTERNAL',
            message: t('newChat.pluginSetup.assessmentReadFailed'),
          };
        }
        const grant = await grantAttachmentUrls({
          ghostId,
          urls: attachments!,
          workdirAbs: sessionWorkdir,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          maxCount: MAX_GRANT_ONLY_ATTACHMENTS,
        });
        if (!grant.ok) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: grant.message };
        }
        // Post-grant revalidation: the grant process includes an async user
        // confirmation step; re-check everything before returning success.
        const postGrantVisibility = classifyGhostVisibility(
          ghostId,
          sessionWorkdir,
          ghostVisibilityDeps,
        );
        if (!postGrantVisibility.ok) return postGrantVisibility;
        let postGrantAssessment: GhostSetupAssessment;
        try {
          postGrantAssessment = getGhostSetupAssessment(ghostId);
          if (postGrantAssessment.state !== 'ready') {
            return {
              ok: false,
              errorCode: 'SETUP_REQUIRED',
              message: t('newChat.pluginSetup.setupChangedDuringResume'),
              setup: postGrantAssessment,
            };
          }
        } catch {
          return {
            ok: false,
            errorCode: 'INTERNAL',
            message: t('newChat.pluginSetup.assessmentReadFailed'),
          };
        }
        if (!grant.isCurrent()) return handoffDenied;
        log.info('ghost grant-only: batch pre-granted', { ghostId, count: grant.hashes.length });
        return {
          ok: true,
          ...(postGrantAssessment.reauthSuggest ? { setup: postGrantAssessment } : {}),
          result: {
            ok: true,
            granted_count: grant.hashes.length,
            attachments: grant.hashes,
            guidance:
              '整批文件已过户并获授权;在当前权限档位下继续逐次调用目标工具,可引用原路径或这些指纹。若热切回需要确认的权限档位,后续重新交接可能再次弹出确认卡。不要向用户复述指纹列表。',
          },
        };
      }
      const attachmentUrls = [...new Set(attachments ?? [])];
      if (attachmentUrls.length > 0) {
        const grant = await grantAttachmentUrls({
          ghostId,
          urls: attachmentUrls,
          workdirAbs: sessionWorkdir,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          maxCount: MAX_GRANT_ATTACHMENTS,
        });
        if (!grant.ok) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: grant.message };
        }
        handoffChecks.push(grant.isCurrent);
        if (handoffExpired()) return handoffDenied;
        mergedArgs = { ...args, attachments: grant.hashes };
      }
      // 目录过户(xd-service 意识化二期):dir 收集文件发一次性票据,元数据
      // 注入 args.dir_deposit——意识拿到的只有票据与相对路径清单;上传时
      // networkSlot 凭票读盘代组 multipart。钳制两层策略:workdir 内直通,
      // workdir 外(含无 workdir 语境)经确认卡放行。
      if (dir !== undefined) {
        if (handoffExpired()) return handoffDenied;
        const dirConfirm = await confirmDepositOutsideWorkdir({
          ghostId,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          lane: 'dir',
          dirAbs: dir,
          workdirAbs: sessionWorkdir,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
        });
        if (!dirConfirm.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: dirConfirm.message };
        }
        if (dirConfirm.isCurrent) handoffChecks.push(dirConfirm.isCurrent);
        if (handoffExpired()) return handoffDenied;
        const deposited = getDirDepositVault().deposit({
          ghostId,
          dirAbs: dirConfirm.userGranted ? dirConfirm.approvedRealPath : dir,
          workdirAbs: sessionWorkdir,
          userGranted: dirConfirm.userGranted,
          ...(dirConfirm.userGranted ? { expectedRealPath: dirConfirm.approvedRealPath } : {}),
        });
        if (!deposited.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: deposited.message };
        }
        mergedArgs = { ...mergedArgs, dir_deposit: deposited.receipt };
      }
      // 下行落盘过户(附件下载不降级):save_dir 发限时票据注入
      // args.save_deposit——意识 fetch as:'file' 报票据,主机把响应字节直接
      // 写进该目录,绝对路径与字节不进沙箱。钳制两层策略同 dir。
      if (saveDir !== undefined) {
        if (handoffExpired()) return handoffDenied;
        const saveConfirm = await confirmDepositOutsideWorkdir({
          ghostId,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          lane: 'save_dir',
          dirAbs: saveDir,
          workdirAbs: sessionWorkdir,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
        });
        if (!saveConfirm.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: saveConfirm.message };
        }
        if (saveConfirm.isCurrent) handoffChecks.push(saveConfirm.isCurrent);
        if (handoffExpired()) return handoffDenied;
        const saveDeposited = getSaveDepositVault().deposit({
          ghostId,
          dirAbs: saveConfirm.userGranted ? saveConfirm.approvedRealPath : saveDir,
          workdirAbs: sessionWorkdir,
          userGranted: saveConfirm.userGranted,
          ...(saveConfirm.userGranted ? { expectedRealPath: saveConfirm.approvedRealPath } : {}),
        });
        if (!saveDeposited.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: saveDeposited.message };
        }
        mergedArgs = { ...mergedArgs, save_deposit: saveDeposited.receipt };
      }
      // ── session-context 槽:注入宿主铸造的会话上下文(盖章工作单)────
      // agent / 上游自报的同名字段一律剥除——这个字段的全部价值在于
      // "主机铸造、不可伪造";未声明槽的插件连剥除后的空位都不给。
      if ('session_context' in mergedArgs) {
        const { session_context: _dropped, ...rest } = mergedArgs;
        void _dropped;
        mergedArgs = rest;
      }
      // Pre-dispatch revalidation: attachment grants and dir tickets may have
      // taken time; confirm the target is still available before committing the
      // callId and dispatching to the sandbox.
      const preDispatchVisibility = classifyGhostVisibility(
        ghostId,
        sessionWorkdir,
        ghostVisibilityDeps,
      );
      if (!preDispatchVisibility.ok) return preDispatchVisibility;
      const preDispatch = preDispatchVisibility.ghost;
      if (!(preDispatch.manifest.tools ?? []).some((c) => c.name === tool)) {
        return {
          ok: false,
          errorCode: 'TOOL_NOT_FOUND',
          message: toolNotFoundMessage(ghostId, tool, preDispatch.manifest.tools),
        };
      }
      try {
        const preDispatchAssessment = getGhostSetupAssessment(ghostId);
        if (preDispatchAssessment.state !== 'ready') {
          return {
            ok: false,
            errorCode: 'SETUP_REQUIRED',
            message: t('newChat.pluginSetup.setupChangedDuringResume'),
            setup: preDispatchAssessment,
          };
        }
      } catch {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: t('newChat.pluginSetup.assessmentReadFailed'),
        };
      }
      // Session-context capability: use the revalidated manifest to decide injection.
      // Re-read manifest after the async buildGhostSessionContext to guard against
      // a same-ID plugin replacement removing the declaration during the await.
      if (preDispatch.manifest.sessionContext === true) {
        const ctx = await buildGhostSessionContext(sessionIdForConfirm, sessionWorkdir);
        const postCtxManifest = getGhostManager()
          .list()
          .find((g) => g.manifest.id === ghostId)?.manifest;
        if (postCtxManifest?.sessionContext === true) {
          mergedArgs = { ...mergedArgs, session_context: ctx };
        }
      }
      // Full revalidation after session-context await (DB query may take time)
      const postCtxVisibility = classifyGhostVisibility(
        ghostId,
        sessionWorkdir,
        ghostVisibilityDeps,
      );
      if (!postCtxVisibility.ok) return postCtxVisibility;
      const postCtx = postCtxVisibility.ghost;
      if (!(postCtx.manifest.tools ?? []).some((c) => c.name === tool)) {
        return {
          ok: false,
          errorCode: 'TOOL_NOT_FOUND',
          message: toolNotFoundMessage(ghostId, tool, postCtx.manifest.tools),
        };
      }
      let postCtxAssessment: GhostSetupAssessment;
      try {
        postCtxAssessment = getGhostSetupAssessment(ghostId);
        if (postCtxAssessment.state !== 'ready') {
          return {
            ok: false,
            errorCode: 'SETUP_REQUIRED',
            message: t('newChat.pluginSetup.setupChangedDuringResume'),
            setup: postCtxAssessment,
          };
        }
      } catch {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: t('newChat.pluginSetup.assessmentReadFailed'),
        };
      }
      if (handoffExpired()) return handoffDenied;
      // ── 卡槽③:callId 在这里预铸并登记给卡片服务 ────────────────────
      // 时序契约:register(供片窗开)→ dispatch(意识拿到同一 callId,执行
      // 中可 card-update)→ finalize(问"这单供过卡吗",开晚到宽限窗)→
      // 真供过卡才把 xdt_card_id 注入 result(mcpServer 提升到顶层,renderer
      // 据此配对取卡;没供过 = 结果零变化,模型永远看不到内部 UUID)。
      const callId = randomUUID();
      const cardService = getGhostCardService();
      const callSessionContext = resolveSessionContext();
      cardService.registerCall(callId, {
        ghostId,
        toolUseId: agentToolUseId ?? null,
        // ALS 优先(codex 每单恢复)、闭包兜底(claude 建线期按 session 绑定)
        // ——此前 claude 路径这里恒为 null,卡片只能靠 toolUseId 启发式锚定。
        sessionId: callSessionContext?.sessionId ?? null,
        sessionInstanceId: callSessionContext?.sessionInstanceId,
        // 未声明 network 的 Agent 调用只能借本机 Agent 授权走 Desktop 出网；
        // SSH remote 会话保留 host id，由 networkSlot 明确拒绝本地出口。
        remoteHostId: callSessionContext?.remoteHostId ?? null,
      });
      // GhostToolCallResult 与 CindyGhostCallResult 同构(错误码枚举一致),
      // 原样透传;类型层若有漂移 tsc 会拦。
      const result = await getGhostPipeDispatcher().callGhostTool({
        ghostId,
        tool,
        args: mergedArgs,
        callId,
      });
      // 收口取账(ghostMediaLedger):本次调用期间主机实际入库的媒体地址。
      // 失败也 drain(清账防泄漏),但只在成功结果上附带——cindy-tools 层
      // 在意识未声明媒体字段时以 xdt_media_produced 注入,兜底 IM/hook 送达。
      const producedMedia = drainGhostCallMedia(ghostId, callId);
      const finalized = withCardToken(result, cardService.finalizeCall(callId), callId);
      if (!finalized.ok) return finalized;
      // 附最后一道 gate(postCtx)的快照:它是派发前最新的 ready 判定。
      const advisory = postCtxAssessment.reauthSuggest ? { setup: postCtxAssessment } : {};
      const base = producedMedia.length > 0
        ? { ...finalized, ...advisory, producedMedia }
        : { ...finalized, ...advisory };
      // 视觉桥工具结果图片描述(最佳努力,不阻塞):把工具返回的 cindy-media://
      // 图片 URL 转成文字描述,附加为 xdt_media_descriptions——纯文本模型
      // (deepseek 等)拿不到 image block,只能看到 URL 文本,易幻觉编造图片
      // 内容;描述让它真正「看到」图。任何失败/未启用都静默跳过,工具结果照常。
      // 仅在成功分支执行:ok:false 无 result 可扫,视觉桥也无需对失败结果描述。
      if (result.ok) {
        const sessionContext = resolveSessionContext();
        const mediaDescriptions = await buildToolResultImageDescriptions({
          producedMedia,
          resultPayload: result.result,
          sessionId: sessionContext?.sessionId ?? null,
          sessionInstanceId: sessionContext?.sessionInstanceId ?? null,
          describeImage: hostDeps.describeToolResultImage,
        });
        if (mediaDescriptions) {
          // 有成功描述 → 附加 xdt_media_descriptions（attemptedCount 是内部告警计数，
          // 不泄漏给模型）；有图但全部失败 → 发「视觉桥不可用」UI 警告（fire-and-forget，
          // 不阻塞工具结果，也不改返回结构）。
          if (mediaDescriptions.xdt_media_descriptions?.length) {
            return { ...base, xdt_media_descriptions: mediaDescriptions.xdt_media_descriptions };
          }
          // 预算超时中止（aborted）不是后端不可用：不告警，避免把慢后端/长图误报成故障。
          if (!mediaDescriptions.aborted && mediaDescriptions.attemptedCount > 0 && sessionContext?.sessionId) {
            hostDeps.onToolResultImagesFailed?.(sessionContext.sessionId, mediaDescriptions.attemptedCount);
          }
        }
      }
      return base;
    },
    async forgeGuide(): Promise<string> {
      return FORGE_GUIDE;
    },
    async forgeScaffold(request): Promise<CindyForgeScaffoldResult> {
      // C-4:owner lease 在首个 await 前捕获并持到副作用结束;workingDir 取权威
      // session snapshot(远程/只读/plan fail closed),不用裸 MCP workingDir。
      return withForgeOwnerLease(async () => {
        const gate = await getForgeSessionFsGate(resolveSessionContext());
        if (!gate.ok) return gate;
        const declaredMinCindyVersion = request.minCindyVersion?.trim();
        const stableCindyVersionPattern =
          /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
        if (
          declaredMinCindyVersion &&
          (declaredMinCindyVersion === '0.0.0' ||
            !stableCindyVersionPattern.test(declaredMinCindyVersion))
        ) {
          return {
            ok: false,
            errorCode: 'INVALID_INPUT',
            message: 'minCindyVersion 必须是插件实际依赖的首个 Cindy 正式版本（major.minor.patch）',
          };
        }
        const currentCindyVersion = hostDeps.getAppVersion?.().trim();
        const stableCurrentCindyVersion =
          currentCindyVersion &&
          currentCindyVersion !== '0.0.0' &&
          stableCindyVersionPattern.test(currentCindyVersion)
            ? currentCindyVersion
            : null;
        const minCindyVersion = declaredMinCindyVersion || stableCurrentCindyVersion;
        if (!minCindyVersion) {
          return {
            ok: false,
            errorCode: 'INVALID_INPUT',
            message:
              '当前是未发布或预发布 Cindy 构建，请明确填写 minCindyVersion（插件实际依赖的首个 Cindy 正式版本）',
          };
        }
        const result = await scaffoldGhostDir({ ...request, minCindyVersion }, {
          sessionWorkdir: gate.workingDir,
          forbiddenRootDirs: ghostForgeForbiddenRootDirs(),
          writeScaffold: writeForgeScaffoldWithStableParent,
        });
        if (result.ok) {
          log.info('ghost forge scaffold created', {
            dir: result.dir,
            template: result.template,
            files: result.files,
          });
        }
        return result;
      });
    },
    async forgePack({ dir, iconSource, intent }): Promise<CindyForgePackResult> {
      return withForgeOwnerLease(async () => {
        const gate = await getForgeSessionFsGate(resolveSessionContext());
        if (!gate.ok) return gate;
        const attempt = await packForgeSource(dir, gate.workingDir, iconSource);
        if (!attempt.ok) return attempt.result;
        const { packed, iconNote } = attempt;
        if (intent === 'publish') {
          const alreadyInstalled = getGhostManager()
            .list()
            .some((ghost) => ghost.manifest.id === packed.manifest.id);
          let staged;
          try {
            staged = completeForgePackStaging({
              buf: packed.buf,
              manifestId: packed.manifest.id,
              owner: captureGhostMutationOwnerForMcp(),
              operationKind: alreadyInstalled ? 'update' : 'install',
              authorCindyPath: packed.cindyPath,
            });
          } catch (err) {
            return {
              ok: false,
              errorCode: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            };
          }
          log.info('ghost forge packed for publish', { dir, id: packed.manifest.id });
          return {
            ok: true,
            cindyPath: staged.agentCindyPath,
            id: packed.manifest.id,
            name: packed.manifest.name,
            version: packed.manifest.version,
            publishToken: staged.ticket,
            note: `${iconNote}已打包为待发布产物。仅企业组织成员可用 ghost_forge_publish 提交;个人账号不可用。`,
          };
        }
        log.info('ghost forge packed', { dir, cindyPath: packed.cindyPath, id: packed.manifest.id });
        return {
          ok: true,
          cindyPath: packed.cindyPath,
          id: packed.manifest.id,
          name: packed.manifest.name,
          version: packed.manifest.version,
          note: `${iconNote}已完成校验和打包；本工具不会安装或更新插件。`,
        };
      });
    },
    async forgeInstall({ dir, iconSource }): Promise<CindyForgeInstallResult> {
      return withForgeOwnerLease(async () => {
        const gate = await getForgeSessionFsGate(resolveSessionContext());
        if (!gate.ok) return gate;
        const attempt = await packForgeSource(dir, gate.workingDir, iconSource);
        if (!attempt.ok) return attempt.result;
        const { packed, iconNote } = attempt;
        try {
          const installed = await installOrUpdateLocalGhostPackageFromForge(
            packed.cindyPath,
            {
              ghostId: packed.manifest.id,
              packageSha256: createHash('sha256').update(packed.buf).digest('hex'),
            },
          );
          log.info('ghost forge install completed', {
            dir,
            id: installed.ghost.manifest.id,
            version: installed.ghost.manifest.version,
            action: installed.action,
          });
          return {
            ok: true,
            action: installed.action,
            id: installed.ghost.manifest.id,
            name: installed.ghost.manifest.name,
            version: installed.ghost.manifest.version,
            enabled: installed.ghost.enabled,
            note:
              installed.action === 'installed'
                ? `${iconNote}插件已完成校验、打包和安装，并已启用。`
                : `${iconNote}插件已完成校验、打包和原位更新；原有启用状态、配置与数据保持不变。`,
          };
        } catch (err) {
          return {
            ok: false,
            errorCode: isIpcError(err) ? err.code : 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          };
        }
      });
    },
    async forgePublish({ token }): Promise<CindyForgePublishResult> {
      const boundaryPending = isAppSessionBoundaryPending();
      const consumed = consumeForgePackForPublish(getForgePackStagingController(), {
        token,
        currentOwner: getActiveAppSession(),
        boundaryPending,
      });
      if (consumed.kind === 'rejected') {
        const errorCode =
          consumed.reason === 'session-boundary-pending'
            ? 'SESSION_BOUNDARY_PENDING'
            : consumed.reason === 'owner-mismatch'
              ? 'PUBLISH_TOKEN_OWNER_MISMATCH'
              : 'PUBLISH_TOKEN_INVALID';
        return {
          ok: false,
          errorCode,
          message:
            consumed.reason === 'session-boundary-pending'
              ? '账号切换中，请稍后重试'
              : consumed.reason === 'owner-mismatch'
                ? '发布票据无效、已过期或已被使用，请重新打包'
                : "发布票据无效、已过期或已被使用。发布票据只能由 ghost_forge_pack(intent='publish') 签发；若刚才使用的是缺省的纯打包模式，请用 intent='publish' 重新打一次。",
        };
      }
      const ticket = consumed.ticket;
      if (!currentPublisherIdentity()) {
        releaseForgePackStaging(ticket.stagingPath);
        return {
          ok: false,
          errorCode: 'NOT_ORG_MEMBER',
          message: '需要组织身份才能发布插件',
        };
      }
      try {
        const started = startPluginPublish(ticket.stagingPath, null, {
          manifestId: ticket.manifestId,
          packageSha256: ticket.packageSha256,
          onTerminal: () => releaseForgePackStaging(ticket.stagingPath),
        });
        return {
          ok: true,
          transferId: started.transferId,
          uploadId: started.uploadId,
          note: '已开始发布并弹出确认屏。用 ghost_forge_publish_status 查询进度;用户取消或确认后才会继续传输。',
        };
      } catch (err) {
        releaseForgePackStaging(ticket.stagingPath);
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async forgePublishStatus({ transferId }): Promise<CindyForgePublishStatusResult> {
      const orch = getPluginPublisherOrchestrator();
      const progress = await orch.refreshReviewStatus(transferId);
      if (!progress) {
        return { ok: false, errorCode: 'NOT_FOUND', message: '找不到这次发布传输' };
      }
      return {
        ok: true,
        transferId: progress.transferId,
        uploadId: progress.uploadId,
        stage: progress.stage,
        status: progress.status ?? null,
        reviewStatus: progress.reviewStatus ?? null,
        ghostId: progress.ghostId ?? null,
        version: progress.version ?? null,
        bytesHashed: progress.bytesHashed,
        bytesSent: progress.bytesSent,
        totalBytes: progress.totalBytes,
        errorCode: progress.errorCode ?? null,
        message: progress.message ?? null,
      };
    },
    logger: log,
  };
}
