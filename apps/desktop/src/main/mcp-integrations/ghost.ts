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
import { FORGE_GUIDE, packGhostDir, scaffoldGhostDir } from '../cindy-brain/forge.js';
import { workdirWriteVerdict } from '../cindy-brain/fsSlot.js';
import { handleIncomingCindyFile } from '../cindy-brain/openFileInstall.js';
import * as blobStore from '../cindy-media/blobStore.js';
import * as ledger from '../cindy-media/ledger.js';
import { chatAttachmentOrigin } from '../cindy-media/attachmentGrantGate.js';
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

export interface CindyGhostsHostDeps {
  /**
   * 现读活跃 Maker Session 的运行时状态。不得回退 DB:权限热切换先作用于
   * runtime、后持久化,DB 在合法窗口内会滞后;缺失/异常必须 fail closed。
   */
  getLiveSessionGrantState?: (
    sessionId: string,
    sessionInstanceId: string,
  ) => GhostGrantLiveSessionState | null;
}

type GhostGrantApprovalSource = 'user' | 'full-access';

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
}): Promise<
  | { ok: true; approvalSource: GhostGrantApprovalSource; allowDirs?: boolean }
  | { ok: false; message: string }
> {
  if (params.sessionId && params.sessionInstanceId && params.getLiveSessionGrantState) {
    try {
      const live = params.getLiveSessionGrantState(params.sessionId, params.sessionInstanceId);
      // 远程会话的 workingDir 是另一台机器上的路径。即使档位为 Full Access,
      // 也不能据此静默读取本机同名/任意路径;保留原确认边界。
      if (live?.permissionMode === 'bypassPermissions' && !live.remoteHostId) {
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
  /** 张数上限(普通调用 MAX_GRANT_ATTACHMENTS;grant_only 批量预授权放宽)。 */
  maxCount: number;
}): Promise<
  { ok: true; resolved: Map<string, ResolvedGrantSource> } | { ok: false; message: string }
> {
  const resolved = new Map<string, ResolvedGrantSource>();
  // 超张数上限时不弹确认,直接交给 grant 流程报标准错(别让用户白点一次)。
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
}): Promise<
  | { ok: true; userGranted: false }
  | { ok: true; userGranted: true; approvedRealPath: string }
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
}): Promise<
  { ok: true; resolved: Map<string, ResolvedGrantSource> } | { ok: false; message: string }
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
  maxCount: number;
}): Promise<{ ok: true; hashes: string[] } | { ok: false; message: string }> {
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
  return grantAttachmentsToGhost(
    {
      // 宽容解析:模型可能只有本地路径、缩图副本路径、或把 xdt-image
      // 地址的会话段拼丢(多个会话实测都踩过)——统一归一化。
      // 总仓 blob 形态(聊天附件迁总仓后模型手里的用户图地址)额外过
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
          throw new GrantPolicyError('该图片不是聊天里出现过的附件,不可过户');
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
        return exists ? '' : ledger.addRef(p);
      },
      log,
    },
    { ghostId, urls: params.urls, maxCount: params.maxCount },
  );
}

function ghostHasTools(ghost: InstalledGhost): boolean {
  return (ghost.manifest.tools?.length ?? 0) > 0;
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
      // 用户图片过户:attachments 里的地址逐张落媒体总仓 + 记可读引用
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
      if (attachments && attachments.length > 0) {
        const grant = await grantAttachmentUrls({
          ghostId,
          urls: attachments,
          workdirAbs: sessionWorkdir,
          sessionId: sessionIdForConfirm,
          sessionInstanceId: sessionInstanceIdForGrant,
          getLiveSessionGrantState: hostDeps.getLiveSessionGrantState,
          maxCount: MAX_GRANT_ATTACHMENTS,
        });
        if (!grant.ok) {
          return { ok: false, errorCode: 'ATTACHMENT_INVALID', message: grant.message };
        }
        mergedArgs = { ...args, attachments: grant.hashes };
      }
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
        });
        if (!dirConfirm.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: dirConfirm.message };
        }
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
        });
        if (!saveConfirm.ok) {
          return { ok: false, errorCode: 'DIR_INVALID', message: saveConfirm.message };
        }
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
      // 收口取账(ghostMediaLedger):本次调用期间主机实际入库的媒体地址。
      // 失败也 drain(清账防泄漏),但只在成功结果上附带——cindy-tools 层
      // 在意识未声明媒体字段时以 xdt_media_produced 注入,兜底 IM/hook 送达。
      const producedMedia = drainGhostCallMedia(ghostId, callId);
      const finalized = withCardToken(result, cardService.finalizeCall(callId), callId);
      if (!finalized.ok) return finalized;
      // 附最后一道 gate(postCtx)的快照:它是派发前最新的 ready 判定。
      const advisory = postCtxAssessment.reauthSuggest ? { setup: postCtxAssessment } : {};
      return producedMedia.length > 0
        ? { ...finalized, ...advisory, producedMedia }
        : { ...finalized, ...advisory };
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
