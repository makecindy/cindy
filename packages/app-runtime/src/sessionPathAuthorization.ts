import fs from 'node:fs';
import path from 'node:path';
import {toolAutoReviewAction,type Logger,type PermissionMode,type ReviewableAction,type AutoReviewDecision} from '@cindy/maker-core';
import type {SessionPathAuthorization,SessionPathAuthorizationRequest} from '@cindy/mcps';
import type {GhostGrantFileItem,GhostGrantLane,GhostGrantConfirmPayload,GhostGrantConfirmDecision} from '@cindy/plugin-runtime/grantTypes';
import {GRANT_AUTHORIZATION_CHANGED_MESSAGE} from '@cindy/plugin-runtime/attachmentGrant';
export interface GhostGrantLiveSessionState {
  permissionMode: PermissionMode | null;
  remoteHostId: string | null;
  /** Includes the captured permission/Plan generations and forbids active or unknown Plan. */
  isCurrent?: () => boolean;
  reviewAction?: (action: ReviewableAction) => Promise<AutoReviewDecision>;
  /** Supplied by the live harness; absent means Cindy owns review. */
  autoReviewOwner?: 'native' | 'cindy';
}

export type GetLiveSessionGrantState=(id:string,instance:string)=>GhostGrantLiveSessionState|null;
export function requireLiveSessionInstance(
  sessionId: string | undefined,
  sessionInstanceId: string | undefined,
  getLiveSessionGrantState?: GetLiveSessionGrantState,
): { ok: true; sessionId: string; sessionInstanceId: string } | { ok: false; message: string } {
  if (!sessionId || !sessionInstanceId || !getLiveSessionGrantState) {
    return {
      ok: false,
      message: '当前调用无法确认任务实例，不能读写工作目录外的路径。请在本机已打开的任务里重试。',
    };
  }
  try {
    if (!getLiveSessionGrantState(sessionId, sessionInstanceId)) {
      return {
        ok: false,
        message: '当前任务实例已失效，不能读写工作目录外的路径。请用当前任务重试。',
      };
    }
  } catch {
    return {
      ok: false,
      message: '当前任务权限状态读不到，不能读写工作目录外的路径。请用当前任务重试。',
    };
  }
  return { ok: true, sessionId, sessionInstanceId };
}

type GhostGrantApprovalSource='user'|'full-access'|'auto-review';
type GhostGrantTarget={isCurrent:()=>boolean};
const CINDY_SESSION_FS_GRANT_ID='cindy-session-fs';
export function createSessionPathAuthorization(host:{logger:Pick<Logger,'info'|'debug'|'warn'>;ghostDisplayName(id:string):string;getGrantBridge():{request(id:string,payload:GhostGrantConfirmPayload):Promise<GhostGrantConfirmDecision>}|null|undefined}){
const log=host.logger,ghostDisplayName=host.ghostDisplayName,getGhostGrantConfirmBridge=host.getGrantBridge;
async function requestGrantConfirm(params: {
  ghostId: string;
  target?: GhostGrantTarget;
  sessionId: string | null;
  sessionInstanceId: string | null;
  lane: GhostGrantLane;
  items: GhostGrantFileItem[];
  /** Native approval of an alias does not authorize a newly resolved target. */
  requiresResolvedPathReview?: boolean;
  toolName?: string;
  operation?: 'read' | 'write';
  getLiveSessionGrantState?: GetLiveSessionGrantState;
}): Promise<
  | { ok: true; approvalSource: GhostGrantApprovalSource; allowDirs?: boolean; isCurrent?: () => boolean }
  | { ok: false; message: string }
> {
  const targetIsCurrent = params.target?.isCurrent;
  let isCurrent = targetIsCurrent;
  const expired = () => isCurrent?.() === false;
  const denied = { ok: false as const, message: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  if (expired()) return denied;
  if (params.sessionId && params.sessionInstanceId && params.getLiveSessionGrantState) {
    try {
      const live = params.getLiveSessionGrantState(params.sessionId, params.sessionInstanceId);
      const sessionIsCurrent = live?.isCurrent;
      isCurrent = targetIsCurrent
        ? () => targetIsCurrent() && sessionIsCurrent?.() !== false
        : sessionIsCurrent;
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
        // The harness already owns this MCP invocation. Keep live authority and
        // path/slot checks, but do not ask a second model to reinterpret its intent.
        // A remote task cannot extend approval to controller-local files.
        if (!params.requiresResolvedPathReview && live.autoReviewOwner === 'native' && !live.remoteHostId && live.isCurrent?.() === true && isCurrent?.() === true) {
          log.debug('ghost grant: native reviewer owns handoff', { lane: params.lane });
          return { ok: true, approvalSource: 'auto-review', isCurrent };
        }
        const decision = await live.reviewAction(toolAutoReviewAction('plugin_file_handoff', {
          ghostId: params.ghostId,
          lane: params.lane,
          ...(params.toolName ? { sourceTool: params.toolName } : {}),
          ...(params.operation ? { operation: params.operation } : {}),
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
    ...(params.toolName ? { sourceTool: params.toolName } : {}),
    ...(params.operation ? { operation: params.operation } : {}),
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

function denyOutsideSessionPath(reason: string): SessionPathAuthorization {
  return { allowed: false, reason };
}

async function authorizeSessionPath(
  request: SessionPathAuthorizationRequest,
  getLiveSessionGrantState?: GetLiveSessionGrantState,
): Promise<SessionPathAuthorization> {
  if (request.remoteHostId) {
    return {
      allowed: false,
      reason: '远程会话不能授权控制端本机路径。请改用当前任务工作目录内的路径，或在本机会话中重试。',
    };
  }
  const live = requireLiveSessionInstance(request.sessionId, request.sessionInstanceId, getLiveSessionGrantState);
  if (!live.ok) return denyOutsideSessionPath(live.message);
  let size = 0;
  let isDirectory = false;
  try {
    const stat = fs.statSync(request.path);
    isDirectory = stat.isDirectory();
    size = stat.size;
  } catch {
    /* write targets may not exist yet */
  }
  const granted = await requestGrantConfirm({
    ghostId: CINDY_SESSION_FS_GRANT_ID,
    sessionId: live.sessionId,
    sessionInstanceId: live.sessionInstanceId,
    lane: 'outside_workdir',
    // This Host callback receives only a canonical path, without the original
    // harness arguments. Native ownership cannot prove it reviewed this target.
    requiresResolvedPathReview: true,
    items: [{
      name: path.basename(request.path) || request.path,
      absPath: request.path,
      size,
      isDirectory,
    }],
    toolName: request.toolName,
    operation: request.operation,
    getLiveSessionGrantState,
  });
  if (!granted.ok) return denyOutsideSessionPath(granted.message);
  if (!granted.isCurrent) {
    return denyOutsideSessionPath('当前任务实例已失效，不能读写工作目录外的路径。请用当前任务重试。');
  }
  if (granted.isCurrent() === false) {
    return { allowed: false, reason: GRANT_AUTHORIZATION_CHANGED_MESSAGE };
  }
  return { allowed: true, isCurrent: granted.isCurrent };
}

return {requestGrantConfirm,authorizeSessionPath};
}