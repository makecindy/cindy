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
 *   - forgeGuide / forgeScaffold / forgePack:意识锻造(agent 帮用户做意识)——
 *     手册、骨架与打包真身在 cindy-brain/forge.ts,打包成功后经双击转交
 *     通道弹装入确认框(与拖入/双击完全同一个弹窗,装不装永远由用户点头)。
 *
 * cindy-tools 是意识系统工具集,包内零 Electron
 * 依赖,全部能力经本文件注入(设计规范规则 2)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { buildGhostRosterPrompt } from 'cindy-tools';
import type {
  CindyForgePackResult,
  CindyForgeScaffoldResult,
  CindyGhostInfo,
  CindyGhostsMcpDeps,
} from 'cindy-tools';
import type { PermissionMode } from '@cindy/maker-core';
import { getLiziMcpSessionContext, type LiziMcpSessionContext } from '@cindy/mcps';

import { activeOwnerScopeKey } from '../appSessionState.js';
import {
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
  isGhostAvailableForActiveSession,
} from '../cindy-brain/index.js';
import { writeForgeScaffoldWithStableParent } from '../cindy-brain/forgeScaffoldCapability.js';
import { getGhostSetupCoordinator } from '../cindy-brain/ghostSetupCoordinator.js';
import { classifyGhostVisibility } from '../cindy-brain/ghostVisibility.js';
import { readInstalledGhostManual } from '../cindy-brain/ghostManual.js';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import {
  ghostToolBlockVerdict,
  resolveToolApprovalMode,
} from '../cindy-brain/ghostToolPermissionsStore.js';
import { FORGE_GUIDE, packGhostDir, scaffoldGhostDir } from '../cindy-brain/forge.js';
import { workdirWriteVerdict } from '../cindy-brain/fsSlot.js';
import { handleIncomingCindyFile } from '../cindy-brain/openFileInstall.js';
import * as blobStore from '../cindy-media/blobStore.js';
import { commitMessageMediaRefs } from '../cindy-media/chatAttachments.js';
import { callCindyMedia } from '../cindy-media/invocationService.js';
import * as ledger from '../cindy-media/ledger.js';
import { chatAttachmentOrigin } from '../cindy-media/attachmentGrantGate.js';
import {
  captureMediaRefCompensationScope,
  withMediaRefCompensation,
} from '../cindy-media/refCompensationJournal.js';
import { getDbClient } from '../localDb/client/current.js';
import { resolveGhostAttachmentUrl } from './ghostAttachmentResolve.js';
import { ghostSetupInteractionSessionId } from './ghostSetupInteractionSurface.js';
import { createForgeIconConverter } from './forgeIconConversion.js';
import { forkForgeIconConversionHost } from './forgeIconConversionHost.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp/cindy');
const MAX_FORGE_ICON_SOURCE_BYTES = 25 * 1024 * 1024;
const GHOST_NO_TOOLS_MESSAGE =
  '该插件未声明任何可供调用的工具;不要重试,改用其它方式完成。';

const convertForgeIconToPng = createForgeIconConverter({
  fork: forkForgeIconConversionHost,
});

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
  /**
   * 现读活跃 Maker Session 的运行时状态。不得回退 DB:权限热切换先作用于
   * runtime、后持久化,DB 在合法窗口内会滞后;缺失/异常必须 fail closed。
   */
  getLiveSessionGrantState?: (
    sessionId: string,
    sessionInstanceId: string,
  ) => GhostGrantLiveSessionState | null;
  /**
   * 测试可注入当前工具档位；生产仍然每次经 owner-scoped 存储现读。
   * 目录/附件确认存在异步等待，不能把一次开始时的判定缓存到出票时。
   */
  resolveToolApprovalMode?: typeof resolveToolApprovalMode;
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

type GhostGrantApprovalSource = 'user' | 'full-access';
type GhostGrantPolicyBlock = {
  ok: false;
  errorCode: 'PERMISSION_DENIED';
  message: string;
};
type GhostGrantPolicyRecheck = () => GhostGrantPolicyBlock | null;

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
  if (workdirWriteVerdict(snapshot.permissionMode, snapshot.planModeEnabled) === 'deny') {
    return {
      ok: false,
      errorCode: 'WORKDIR_READ_ONLY',
      message: 'Forge is disabled while the current session workdir is read-only or in plan mode',
    };
  }
  return { ok: true, workingDir: snapshot.workingDir };
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
  recheckPolicy?: GhostGrantPolicyRecheck;
}): Promise<
  | { ok: true; approvalSource: GhostGrantApprovalSource; allowDirs?: boolean }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' }
> {
  if (params.sessionId && params.sessionInstanceId && params.getLiveSessionGrantState) {
    try {
      const live = params.getLiveSessionGrantState(params.sessionId, params.sessionInstanceId);
      // 远程会话的 workingDir 是另一台机器上的路径。即使档位为 Full Access,
      // 也不能据此静默读取本机同名/任意路径;保留原确认边界。
      if (live?.permissionMode === 'bypassPermissions' && !live.remoteHostId) {
        const policyBlock = params.recheckPolicy?.();
        if (policyBlock) return policyBlock;
        log.info('ghost grant: Full Access auto-approved outside-workdir handoff', {
          ghostId: params.ghostId,
          lane: params.lane,
          count: params.items.length,
          grantSource: 'full-access',
        });
        return { ok: true, approvalSource: 'full-access' };
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
  if (decision.confirmed) {
    // 确认卡等待期间用户可能把工具切换为 blocked。在返回给
    // 调用方写 blob / ledger / ref 或记目录授权之前现读重判。
    const policyBlock = params.recheckPolicy?.();
    if (policyBlock) return policyBlock;
    return { ok: true, approvalSource: 'user', allowDirs: decision.allowDirs };
  }
  return {
    ok: false,
    message:
      decision.reason === 'timeout'
        ? '过户确认超时:用户未在时限内响应,本次调用已取消;如仍需要,请提醒用户后重试'
        : '用户拒绝了本次过户请求,不要重试;如确有需要请先与用户沟通',
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
  recheckPolicy?: GhostGrantPolicyRecheck;
  /** 项数上限(普通调用 MAX_GRANT_ATTACHMENTS;grant_only 批量预授权放宽)。 */
  maxCount: number;
}): Promise<
  | { ok: true; resolved: Map<string, ResolvedGrantSource> }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' }
> {
  const resolved = new Map<string, ResolvedGrantSource>();
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
        recheckPolicy: params.recheckPolicy,
      });
      if (!confirm.ok) return confirm;
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
  return { ok: true, resolved };
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
  recheckPolicy?: GhostGrantPolicyRecheck;
}): Promise<
  | { ok: true; userGranted: false }
  | { ok: true; userGranted: true; approvedRealPath: string }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' }
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
    recheckPolicy: params.recheckPolicy,
  });
  if (!confirm.ok) return confirm;
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
  return { ok: true, userGranted: true, approvedRealPath: real };
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
  recheckPolicy?: GhostGrantPolicyRecheck;
}): Promise<
  | { ok: true; resolved: Map<string, ResolvedGrantSource> }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' }
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
    recheckPolicy: params.recheckPolicy,
  });
  if (!confirm.ok) return confirm;

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
  return { ok: true, resolved };
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
  recheckPolicy?: GhostGrantPolicyRecheck;
  maxCount: number;
}): Promise<
  | { ok: true; hashes: string[]; revoke: () => Promise<void> }
  | { ok: false; message: string; errorCode?: 'PERMISSION_DENIED' }
> {
  const { ghostId } = params;
  // 捕获在两次可能弹确认卡的 prepare 之前：owner scope key 编码
  // mode:dataOwnerId:generation，账号切换会改变它。等到落任何持久副作用前
  // 才现取，会让"等待期间切了账号"的窗口把旧会话解析出的附件写进新账号的
  // 媒体账本——同一份判据必须钉在同一个起点。
  const ownerScopeKeyAtStart = activeOwnerScopeKey();
  const localGrant = await prepareLocalPathAttachments({
    urls: params.urls,
    ghostId,
    workdirAbs: params.workdirAbs,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    getLiveSessionGrantState: params.getLiveSessionGrantState,
    recheckPolicy: params.recheckPolicy,
    maxCount: params.maxCount,
  });
  if (!localGrant.ok) return localGrant;
  const managedToolGrant = await prepareManagedToolGrantSources({
    urls: params.urls,
    ghostId,
    localResolved: localGrant.resolved,
    maxCount: params.maxCount,
    sessionId: params.sessionId,
    sessionInstanceId: params.sessionInstanceId,
    getLiveSessionGrantState: params.getLiveSessionGrantState,
    recheckPolicy: params.recheckPolicy,
  });
  if (!managedToolGrant.ok) return managedToolGrant;
  // 已有授权记忆可能让上面两个 prepare 都不弹卡，但其间仍有异步
  // 读盘/查账。落任何持久副作用前再做一次无 await 的最终重判。
  const policyBlock = params.recheckPolicy?.();
  if (policyBlock) return policyBlock;
  // 从此到整批 ref 事务收口始终固定同一 owner scope 与 DB 句柄。现读一次
  // 只用来核对没有漂移——真正生效的 key 是函数开头捕获的那份，不是这里
  // 重新现取的，否则"重新现取"本身就是在重犯这条不变量要堵的漏洞。
  const grantRuntime = (() => {
    try {
      const ownerScopeKeyNow = activeOwnerScopeKey();
      if (ownerScopeKeyNow !== ownerScopeKeyAtStart) {
        log.warn('ghost attachment grant: owner scope changed during grant wait; denying call', {
          ghostId,
        });
        return null;
      }
      return {
        compensationScope: captureMediaRefCompensationScope(ownerScopeKeyAtStart),
        db: getDbClient().drizzle,
      };
    } catch (error) {
      log.warn('ghost attachment grant: cannot capture stable owner transaction', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  })();
  if (!grantRuntime) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: '附件授权环境未就绪，为了安全未执行工具，请重试。',
    };
  }
  const { compensationScope, db } = grantRuntime;
  const assertStillAllowed = (): void => {
    compensationScope.assertStillValid();
    const block = params.recheckPolicy?.();
    if (block) throw new GrantPolicyError(block.message);
  };
  const guardedCompensationScope = {
    ...compensationScope,
    assertStillValid: assertStillAllowed,
  };
  return grantAttachmentsToGhost(
    {
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
        const origin = await chatAttachmentOrigin(r.blobHash, db);
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
          }, db);
          if (userGranted) {
            return { absPath: r.absPath, mimeType: r.mimeType, originKind: 'user' };
          }
          const toolGranted = await ledger.hasGhostToolGrant({
            hash: r.blobHash,
            ghostId,
          }, db);
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
      recordBlob: (p) => ledger.recordBlob(p, db),
      assertStillAllowed,
      removeRefById: (id) => ledger.removeRefById(id, db),
      withRefCompensation: ({ refIds, perform, compensate }) =>
        withMediaRefCompensation({
          scope: guardedCompensationScope,
          refIds,
          perform,
          compensate,
        }),
      // 撤销的持久标记不能绑任何会拒绝的 assertStillValid——工具被切成
      // blocked、owner 漂移都正是触发撤销的常见原因(见上面派发前的复判与
      // grant_only 的收口复判),沿用会拒绝这些状态的判据只会让补偿写盘前
      // 置断言直接抛错,连 pending 标记都落不了盘,持久补偿这层保护整个
      // 失效。journalDir/ownerStorageKey 是抓取时就定死的静态路径值,与
      // "现在活跃的 owner 是不是它"无关,复用完全安全;真正"继续用同一个
      // db 句柄是否安全"这件事交给 perform/compensate 里的 removeRefById
      // 自己去试——db 已经失效时它自然会抛错,withMediaRefCompensation 的
      // catch→compensate 兜底会接住,兜底也失败则 pending 标记已经落盘,
      // 留给下次同 owner DB 就绪时的 reconcile 重放。
      withRevokeCompensation: ({ refIds, perform, compensate }) =>
        withMediaRefCompensation({
          scope: {
            journalDir: compensationScope.journalDir,
            ownerStorageKey: compensationScope.ownerStorageKey,
            assertStillValid: () => {},
          },
          refIds,
          perform,
          compensate,
        }),
      // 顺序调用幂等化:同 (指纹,意识,引用类型,来源) 已有交接行就不再插入。
      // 并发 check-then-insert 仍可能产生重复账行,但不会改变归属或扩权语义。
      addRef: async (p) => {
        const exists = await ledger.hasRef({
          hash: p.hash,
          refKind: p.refKind,
          refId: p.refId,
          originKind: p.originKind,
        }, db);
        // hasRef 本身是 async；返回后再读一次当前工具策略，不能把这段 I/O
        // 变成 blocked 后仍插入持久 grant ref 的窗口。
        assertStillAllowed();
        if (!exists) await ledger.addRef(p, db);
      },
      log,
    },
    { ghostId, urls: params.urls, maxCount: params.maxCount },
  );
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

function visibleChipGhosts(workdir: string | null): InstalledGhost[] {
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
  return {
    callMedia: async (request) => {
      const result = await callCindyMedia(request);
      const sessionId = resolveSessionContext()?.sessionId;
      if (result.ok !== false && sessionId) {
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
    getRosterItems() {
      const workdir = resolveSessionContext()?.workingDir;
      if (!workdir) return [];
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
      const workdir = resolveSessionContext()?.workingDir ?? null;
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
      const blockedToolVerdict = (
        declaredTools: typeof target.manifest.tools,
        isGrantOnly: boolean,
      ): GhostGrantPolicyBlock | null => {
        try {
          return ghostToolBlockVerdict(
            ghostId,
            tool,
            declaredTools,
            isGrantOnly,
            hostDeps.resolveToolApprovalMode ?? resolveToolApprovalMode,
          );
        } catch (error) {
          // 这是授权执法点,不是可选 UI 偏好。读取失败时无法证明
          // 当前工具未被 blocked,setup/过户/出票副作用都必须 fail closed。
          log.warn('ghost tool approval lookup failed at grant gate; denying call', {
            ghostId,
            tool,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: `无法读取 ${ghostId} 的工具 ${tool} 授权策略;为了安全未执行该工具,请重试或检查插件设置。`,
          };
        }
      };
      // Attachment confirmation and directory handoff may wait for user input.
      // Every side-effect recheck must therefore resolve the current installed
      // plugin again: the original object can be removed or replaced under the
      // same id while the card is open. The narrow recheck result uses
      // PERMISSION_DENIED for every lost eligibility state so downstream grant
      // code can trigger its exact-id compensation path uniformly.
      const recheckCurrentGrantPolicy = (isGrantOnly: boolean): GhostGrantPolicyBlock | null => {
        const currentVisibility = classifyGhostVisibility(
          ghostId,
          sessionWorkdir,
          ghostVisibilityDeps,
        );
        if (!currentVisibility.ok) {
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: currentVisibility.message,
          };
        }
        const currentTools = currentVisibility.ghost.manifest.tools;
        if (
          !isGrantOnly &&
          !(currentTools ?? []).some((candidate) => candidate.name === tool)
        ) {
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: toolNotFoundMessage(ghostId, tool, currentTools),
          };
        }
        try {
          if (getGhostSetupAssessment(ghostId).state !== 'ready') {
            return {
              ok: false,
              errorCode: 'PERMISSION_DENIED',
              message: t('newChat.pluginSetup.setupChangedDuringResume'),
            };
          }
        } catch {
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: t('newChat.pluginSetup.assessmentReadFailed'),
          };
        }
        return blockedToolVerdict(currentTools, isGrantOnly);
      };
      // 媒体过户:显式 attachments 逐张落媒体总仓 + 记可读引用
      // (人工确认 = ghost-grant；Host 工具代办 = ghost-tool-grant),指纹注入
      // args.attachments 交给意识。任何一张失败整批拒(ATTACHMENT_INVALID),
      // 不做半成品授权。全链路见 grantAttachmentUrls。
      let mergedArgs = args;
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
      // 用户禁用判定。普通调用的真正收口在派发器的资格审(pipeDispatcher.callGhostTool,
      // 所有调用方共用),这里只是提前到 setupCoordinator.ensureReady 之前,免得一个注定
      // 被拒的调用先把配置卡/OAuth 卡弹到用户脸上。
      //
      // grant_only 是例外:它只过户不派发,永远走不到派发器,**这里就是它唯一的收口**。
      // 它按协议忽略 tool 字段,所以判据落在插件层——目标插件的工具被用户全禁时,不存在
      // 任何合法的后续调用,预授权只剩"绕过禁用把文件交出去"这一个用途;显式点名了某个
      // 已声明且被禁的工具时同样拒。
      const blockedVerdict = blockedToolVerdict(target.manifest.tools, grantOnly === true);
      if (blockedVerdict) return blockedVerdict;
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
        // 附件引用提交后到 grantOnlySucceeded 落地之间有一次真实的异步锁
        // 释放窗口(grantAttachmentUrls 内部的确认卡等待)。如果账号在这段
        // 窗口切换,且新账号下恰好也装了同 id、ready 且未 blocked 的插件,
        // 下面的 postGrant 复判只会现查"当前活跃账号",照常通过并把
        // grantOnlySucceeded 置真——但 hashes 只在旧账号账本里获得了授权,
        // 新账号的插件用不了它们,旧账号那笔授权也没被撤销。派发前(这里是
        // grantOnlySucceeded 落地前)统一核对,漂移就当拒绝处理,交给下面
        // finally 的撤销收拾。
        const grantOnlyOwnerScopeKeyAtStart = activeOwnerScopeKey();
        const grant = await grantAttachmentUrls({
          ghostId,
          urls: attachments!,
          workdirAbs: sessionWorkdir,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          recheckPolicy: () => recheckCurrentGrantPolicy(true),
          maxCount: MAX_GRANT_ONLY_ATTACHMENTS,
        });
        if (!grant.ok) {
          return {
            ok: false,
            errorCode: grant.errorCode ?? 'ATTACHMENT_INVALID',
            message: grant.message,
          };
        }
        // Post-grant revalidation: the grant process includes an async user
        // confirmation step; re-check everything before returning success.
        // grant_only 走不到派发器,这里就是它唯一的收口——下面任何一个提前
        // return 都必须先撤销刚授出的 ghost-tool-grant,否则会留下和上面
        // callGhostTool 主路径同样的"写完才拒绝"授权残留。
        let grantOnlySucceeded = false;
        try {
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
          // 补偿事务的最后一次策略断言:visibility/setup 刷新之后、
          // grantOnlySucceeded 落地之前,工具仍可能被用户切到 blocked——
          // 只查 visibility+setup 会漏掉这个窗口,必须复用同一份
          // postGrantVisibility 再判一次 blockedToolVerdict。
          const postGrantBlocked = blockedToolVerdict(postGrantVisibility.ghost.manifest.tools, true);
          if (postGrantBlocked) return postGrantBlocked;
          // 同一收口点核对 owner 是否漂移(见 grantOnlyOwnerScopeKeyAtStart
          // 旁边的注释)——visibility/setup/blocked 都只现查"当前活跃账号",
          // 单靠它们查不出"这还是不是授权发生时那个账号"。
          if (activeOwnerScopeKey() !== grantOnlyOwnerScopeKeyAtStart) {
            log.warn('ghost grant-only: denied, owner scope changed during grant wait', {
              ghostId,
            });
            return {
              ok: false,
              errorCode: 'PERMISSION_DENIED',
              message: '账号状态已变化，为了安全未执行预授权，请重试。',
            };
          }
          log.info('ghost grant-only: batch pre-granted', { ghostId, count: grant.hashes.length });
          grantOnlySucceeded = true;
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
        } finally {
          if (!grantOnlySucceeded) {
            await grant.revoke().catch((err: unknown) => {
              log.warn('ghost attachment grant: revoke after grant_only post-check rejection did not complete', {
                ghostId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      }
      // owner 快照:下面这段从这里到实际派发之间会经过 dir/save_dir 确认、
      // 附件授权、session-context 构建等好几个 await 窗口。就算这次调用没有
      // 附件,dir/save_dir 出的一次性票据与 buildGhostSessionContext 铸的
      // 上下文同样是"交接"——账号在这些窗口切换后,若新账号下恰好也装了
      // 同 id 插件,后续 classifyGhostVisibility 只现查"当前活跃账号",会
      // 照常放行并把旧账号铸好的票据/上下文连同派发一起送进新账号的进程。
      // 在整段交接开始前统一捕获一次,派发前统一复核,不局限于"有附件才
      // 检查"。
      const ownerScopeKeyAtHandoffStart = activeOwnerScopeKey();
      // 附件授权(ghost-grant/ghost-tool-grant)是持久 ledger 记录,不是这次
      // 调用专属的一次性凭证——插件此后任何时候引用同一 hash 都会被判定为
      // 已授权。下面直到实际派发之间还有多处会拒绝这次调用(目录/save_dir
      // 确认、两次 blocked 复判、pre-dispatch 与 session-context 复判、
      // 派发本身失败);任何一处拒绝都不能把这次刚授出的读取权限留在账上
      // ——"写完才拒绝会留下已生效的授权副作用，不算拦住"
      // (docs/dev-rules/plugin-security-and-authoring.md §3.1 第 4 条)。
      let pendingAttachmentRevoke: (() => Promise<void>) | null = null;
      const attachmentUrls = [...new Set(attachments ?? [])];
      if (attachmentUrls.length > 0) {
        const grant = await grantAttachmentUrls({
          ghostId,
          urls: attachmentUrls,
          workdirAbs: sessionWorkdir,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          recheckPolicy: () => recheckCurrentGrantPolicy(false),
          maxCount: MAX_GRANT_ATTACHMENTS,
        });
        if (!grant.ok) {
          return {
            ok: false,
            errorCode: grant.errorCode ?? 'ATTACHMENT_INVALID',
            message: grant.message,
          };
        }
        mergedArgs = { ...args, attachments: grant.hashes };
        pendingAttachmentRevoke = grant.revoke;
      }
      // dispatchSucceeded 置真的两种情况:调用整体成功,或者 pipeDispatcher
      // 明确报告 TIMEOUT(语义是"可能仍在后台继续",附件已经真正交给了
      // sandbox)。下面任何一个提前 return(派发前的复判/确认,以及
      // pipeDispatcher 自己资格审失败的 PERMISSION_DENIED 等)都会让它保持
      // false,finally 据此撤销刚才可能已经授出的附件读取权限——见下方调用点
      // 旁边的注释。
      let dispatchSucceeded = false;
      try {
        // 目录过户(xd-service 意识化二期):dir 收集文件发一次性票据,元数据
        // 注入 args.dir_deposit——意识拿到的只有票据与相对路径清单;上传时
        // networkSlot 凭票读盘代组 multipart。钳制两层策略:workdir 内直通,
        // workdir 外(含无 workdir 语境)经确认卡放行。
        if (dir !== undefined) {
          const dirConfirm = await confirmDepositOutsideWorkdir({
            ghostId,
            sessionId: sessionIdForConfirm,
            sessionInstanceId: sessionInstanceIdForGrant,
            lane: 'dir',
            dirAbs: dir,
            workdirAbs: sessionWorkdir,
            getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
            recheckPolicy: () => recheckCurrentGrantPolicy(false),
          });
          if (!dirConfirm.ok) {
            return {
              ok: false,
              errorCode: dirConfirm.errorCode ?? 'DIR_INVALID',
              message: dirConfirm.message,
            };
          }
          // 确认卡的返回与出票之间绝不能沿用旧裁决：票据一旦创建可由 sandbox
          // 在稍后消费，派发器的 blocked 闸已无法撤销它。这里是最后一个无 await
          // 的拦截点，命中时保证零票据副作用。
          const dirBlocked = recheckCurrentGrantPolicy(false);
          if (dirBlocked) return dirBlocked;
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
          const saveConfirm = await confirmDepositOutsideWorkdir({
            ghostId,
            sessionId: sessionIdForConfirm,
            sessionInstanceId: sessionInstanceIdForGrant,
            lane: 'save_dir',
            dirAbs: saveDir,
            workdirAbs: sessionWorkdir,
            getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
            recheckPolicy: () => recheckCurrentGrantPolicy(false),
          });
          if (!saveConfirm.ok) {
            return {
              ok: false,
              errorCode: saveConfirm.errorCode ?? 'DIR_INVALID',
              message: saveConfirm.message,
            };
          }
          // 与 dir 相同：出票前重新读取当前策略，不能让确认期间后的 blocked
          // 切换留下仍可消费的本地写入票据。
          const saveBlocked = recheckCurrentGrantPolicy(false);
          if (saveBlocked) return saveBlocked;
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
        // Session-context slot: use the revalidated manifest to decide injection.
        // Re-read manifest after the async buildGhostSessionContext to guard against
        // a same-ID plugin replacement removing the slot during the await.
        if (preDispatch.manifest.slots?.includes('session-context')) {
          const ctx = await buildGhostSessionContext(sessionIdForConfirm, sessionWorkdir);
          const postCtxManifest = getGhostManager()
            .list()
            .find((g) => g.manifest.id === ghostId)?.manifest;
          if (postCtxManifest?.slots?.includes('session-context')) {
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
        // 派发前最后一个无 await 的拦截点:核对整段交接开始以来 owner 是否
        // 漂移(见 ownerScopeKeyAtHandoffStart 旁边的注释)——不局限于有
        // 附件的调用,dir/save_dir 票据与 session-context 同样是交接。命中
        // 就直接拒,让 dispatchSucceeded 保持 false,交给下面 finally 去撤销
        // 可能已经写进旧账号账本的 ghost-grant/ghost-tool-grant——不能在这里
        // 改派发目标或者忽略漂移继续派发,那样等于把旧账号的票据/上下文/
        // 附件送进了新账号的插件进程。
        if (activeOwnerScopeKey() !== ownerScopeKeyAtHandoffStart) {
          log.warn('ghost tool call denied: owner scope changed during handoff', { ghostId });
          return {
            ok: false,
            errorCode: 'PERMISSION_DENIED',
            message: '账号状态已变化，为了安全未执行该工具，请重试。',
          };
        }
        // ── 卡槽③:callId 在这里预铸并登记给卡片服务 ────────────────────
        // 时序契约:register(供片窗开)→ dispatch(意识拿到同一 callId,执行
        // 中可 card-update)→ finalize(问"这单供过卡吗",开晚到宽限窗)→
        // 真供过卡才把 xdt_card_id 注入 result(mcpServer 提升到顶层,renderer
        // 据此配对取卡;没供过 = 结果零变化,模型永远看不到内部 UUID)。
        const callId = randomUUID();
        const cardService = getGhostCardService();
        cardService.registerCall(callId, {
          ghostId,
          toolUseId: agentToolUseId ?? null,
          // ALS 优先(codex 每单恢复)、闭包兜底(claude 建线期按 session 绑定)
          // ——此前 claude 路径这里恒为 null,卡片只能靠 toolUseId 启发式锚定。
          sessionId: resolveSessionContext()?.sessionId ?? null,
        });
        // GhostToolCallResult 与 CindyGhostCallResult 同构(错误码枚举一致),
        // 原样透传;类型层若有漂移 tsc 会拦。
        const result = await getGhostPipeDispatcher().callGhostTool({
          ghostId,
          tool,
          args: mergedArgs,
          callId,
        });
        // pipeDispatcher 自己的资格审失败(GHOST_NOT_FOUND / GHOST_ASLEEP /
        // TOOL_NOT_FOUND / PERMISSION_DENIED / GHOST_CRASHED)从未真正把
        // mergedArgs 送进 sandbox——那条 ghost-tool-grant 必须照旧撤销,见下方
        // finally。真正把附件交出去之后才可能出现的结果只有两种:调用本身
        // 成功,或者 TIMEOUT(armTimer 的 message 明确写了"任务可能仍在后台
        // 继续")——这两种都不再是"调用被拒绝",不该撤销已生效的授权,否则
        // 重试还得让用户再走一遍确认。除 TIMEOUT 外的其它 ok:false 暂时仍归
        // 入"撤销"这一支:插件工具自己上报的 errorCode 是开放集合,没有结构化
        // 信号能安全区分"确实送达但工具自己失败"与"根本没送达",宁可多撤销
        // 一次逼用户重新确认,也不留下无法证伪的已生效授权(fail closed)。
        if (result.ok || result.errorCode === 'TIMEOUT') {
          dispatchSucceeded = true;
        }
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
        // 这段发生在 dispatchSucceeded 已置真之后,与上面的附件撤销互不影响——
        // 派发已经成功,视觉桥本身的失败不构成"调用被拒",不该触发撤销。
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
      } finally {
        if (!dispatchSucceeded && pendingAttachmentRevoke) {
          await pendingAttachmentRevoke().catch((err: unknown) => {
            log.warn('ghost attachment grant: revoke after later call rejection did not complete', {
              ghostId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
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
        const result = await scaffoldGhostDir(request, {
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
    async forgePack({ dir, iconSource }): Promise<CindyForgePackResult> {
      return withForgeOwnerLease(async () => {
        const gate = await getForgeSessionFsGate(resolveSessionContext());
        if (!gate.ok) return gate;
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
            iconNote = 'AI 图标处理失败，已保留默认图标并继续打包。';
            log.warn('ghost forge icon fallback', {
              dir,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const packOptions = {
          sessionWorkdir: gate.workingDir,
          forbiddenRootDirs: ghostForgeForbiddenRootDirs(),
        };
        let packed = await packGhostDir(dir, iconPng ? { ...packOptions, iconPng } : packOptions);
        // icon overlay 的任何失败都不是打包门槛：用原源码再打一次。若原源码
        // 本身也不合法，则返回原本就会出现的结构化错误。
        if (!packed.ok && iconPng) {
          const fallbackPacked = await packGhostDir(dir, packOptions);
          if (fallbackPacked.ok) {
            packed = fallbackPacked;
            iconNote = 'AI 图标处理失败，已保留默认图标并继续打包。';
          } else {
            return fallbackPacked;
          }
        }
        if (!packed.ok) return packed;
        // 与双击 .cindy 同一条转交通道:renderer 弹标准确认框(同 id 已装则
        // 自动转"更新 vX → vY"),用户点头才真装。lease 持到转交完成。
        await handleIncomingCindyFile(packed.cindyPath, 'ghost-forge');
        log.info('ghost forge packed', { dir, cindyPath: packed.cindyPath, id: packed.manifest.id });
        return {
          ok: true,
          cindyPath: packed.cindyPath,
          id: packed.manifest.id,
          name: packed.manifest.name,
          version: packed.manifest.version,
          note: `${iconNote}已打包并弹出装入/更新确认框,请告知用户在应用内确认(装入默认沉睡)。`,
        };
      });
    },
    logger: log,
  };
}
