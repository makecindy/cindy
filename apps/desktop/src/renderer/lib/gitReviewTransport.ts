/**
 * gitReviewTransport —— git 审查的 device-link 透明传输层(fileBrowserTransport 同款模式)。
 *
 * 让 useReviewGitState 等 hooks 的只读查询**按会话来源**自动切换:
 *   - 本地 / SSH remote 会话 → 原样走 window.electronAPI.gitReview(SSH 由 scope
 *     层返回 remote-session 禁用态,renderer 无感)
 *   - device-link 远程会话(被控设备)→ 走 deviceLink.invoke(deviceId,
 *     'git-review:remote-op', [{op, payload}]) 隧道,被控端 git-review/device-op
 *     以它自己的 session 记录解析 workdir 并执行
 *
 * 只覆盖只读子集(get / summary / commits / commitDiff / branchDiff / fileDiff /
 * imagePreview / markdownPreview);写操作与 openFile 在 device-link 场景由 UI 层
 * 直接禁用,不进传输层。
 *
 * 响应编码:被控端超帧预算时以 resultGz(gzip+base64)返回,这里解回原形,
 * hooks 零感知;gzip 后仍超帧回结构化 OVERSIZE → 这里抛带稳定标记的错误,
 * UI 据 isReviewRemoteOversizeError 渲染"改动过大"占位。
 *
 * 版本偏差:老被控端没有 remote-op channel,invoke reject
 * DEVICE_LINK_CHANNEL_NOT_ALLOWED —— 复用 fileBrowserTransport 的
 * isDeviceTooOldError 给上层渲染"对方设备版本过旧"占位。
 */

import { gunzipBase64ToText } from './gzipBase64';

type LocalGitReview = typeof window.electronAPI.gitReview;

/** 只读子集:device-link 场景可用的查询面。 */
export type GitReviewReadApi = Pick<
  LocalGitReview,
  | 'get'
  | 'summary'
  | 'commits'
  | 'commitDiff'
  | 'branchDiff'
  | 'fileDiff'
  | 'imagePreview'
  | 'markdownPreview'
>;

const REMOTE_OP_CHANNEL = 'git-review:remote-op';

/** OVERSIZE 的稳定错误标记(进 Error.message,供 UI 分支判定,不面向用户展示)。 */
const OVERSIZE_MARKER = 'GIT_REVIEW_REMOTE_OVERSIZE';

export function isReviewRemoteOversizeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(OVERSIZE_MARKER);
}

/** 被控端 remote-op 的响应信封(与 main/git-review/device-op.ts 对齐)。 */
type RemoteOpResult =
  | { ok: true; result: unknown }
  | { ok: true; resultGz: string }
  | { ok: false; code: 'OVERSIZE' }
  | { ok: false; message: string };

async function invokeOp<T>(deviceId: string, op: string, payload: object): Promise<T> {
  const res = (await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_OP_CHANNEL, [
    { op, payload },
  ])) as RemoteOpResult | null | undefined;
  if (res && res.ok === true) {
    if ('resultGz' in res && typeof res.resultGz === 'string') {
      return JSON.parse(await gunzipBase64ToText(res.resultGz)) as T;
    }
    return (res as { ok: true; result: unknown }).result as T;
  }
  if (res && res.ok === false && 'code' in res && res.code === 'OVERSIZE') {
    throw new Error(`${OVERSIZE_MARKER}: review payload exceeds device-link frame budget`);
  }
  const message = res && res.ok === false && 'message' in res ? res.message : 'git-review remote-op failed';
  throw new Error(message);
}

/**
 * 与 window.electronAPI.gitReview 只读子集同形,按 deviceId 路由。
 * device 分支的返回形状由被控端复用本机 readReview* 实现逐字段保证一致。
 */
export function gitReviewApiFor(deviceId: string | null | undefined): GitReviewReadApi {
  if (!deviceId) return window.electronAPI.gitReview;
  return {
    get: (p) => invokeOp(deviceId, 'get', p),
    summary: (p) => invokeOp(deviceId, 'summary', p),
    commits: (p) => invokeOp(deviceId, 'commits', p),
    commitDiff: (p) => invokeOp(deviceId, 'commit-diff', p),
    branchDiff: (p) => invokeOp(deviceId, 'branch-diff', p),
    fileDiff: (p) => invokeOp(deviceId, 'file-diff', p),
    imagePreview: (p) => invokeOp(deviceId, 'image-preview', p),
    markdownPreview: (p) => invokeOp(deviceId, 'markdown-preview', p),
  };
}
