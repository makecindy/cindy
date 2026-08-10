/**
 * device-op — device-link 远程 git 审查(只读)的被控端执行层。
 *
 * 控制端经隧道 `deviceLink.invoke(deviceId, 'git-review:remote-op', [args])`
 * 到达这里(invoke-registry 捕获本文件注册的 ipcMain.handle;本机 renderer
 * 不调用该 channel)。单聚合 channel 的取舍与 file-browser/device-op 一致:
 * 老被控端 CHANNEL_NOT_ALLOWED = 能力全无,控制端渲染"设备版本过旧"占位。
 *
 * 安全:
 *  - **只读**:仅暴露 status / diff / commit 列表 / 文件 diff / 图片与 Markdown
 *    预览。写 op(stage / discard / commit / push)与 openFile(本机 shell 副作用)
 *    一律不实现,未知 op 确定性回 `{ok:false}`。
 *  - 入参只有 sessionId + 结构化查询字段(复用本机 IPC 的 parse* 校验),不接受
 *    任何客户端路径:workdir 由被控端 resolveReviewScope 从自己的 session 记录
 *    解析;SSH 远程会话由 scope 层返回 remote-session 禁用态(不二跳,对齐
 *    本机审查面板现状)。
 *
 * oversize:响应序列化超 relay 帧限(MAX_FRAME_BYTES=2MiB)前主动预判——先
 * gzip(diff 文本压缩率高),仍超回结构化 `{ ok:false, code:'OVERSIZE' }`,
 * 绝不裸炸 FRAME_TOO_LARGE。新 channel 两端同代次,控制端恒可解 gzip,
 * 不需要 file-browser 那样的 caps 探测。
 */

import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { GIT_REVIEW_REMOTE_OP_CHANNEL } from '@cindy/device-link';

import { createLogger } from '../logger.js';
import {
  parseBranchDiffPayload,
  parseCommitDiffPayload,
  parseCommitsPayload,
  parseFileDiffPayload,
  parseImagePreviewPayload,
  parseMarkdownPreviewPayload,
  parseReviewDataPayload,
  parseSessionId,
  readReviewBranchDiff,
  readReviewCommitDiff,
  readReviewCommits,
  readReviewData,
  readReviewFileDiff,
  readReviewImagePreview,
  readReviewMarkdownPreview,
  readReviewSummary,
} from './ipc.js';

const log = createLogger('git-review/device-op');

const gzipAsync = promisify(gzipCb);

/**
 * 响应的 device-link 上帧预算。量纲对齐 file-browser/device-op 的
 * DEVICE_READ_MAX_JSON_BYTES:relay 单帧 MAX_FRAME_BYTES=2MiB 按 UTF-8 字节判,
 * 用 JSON.stringify 后的字节数覆盖转义膨胀,再给 envelope 留余量。
 */
const GIT_REVIEW_MAX_JSON_BYTES = 1_800_000;

export interface GitReviewRemoteOpArgs {
  op: string;
  /** 与本机 git-review IPC 同形的 payload(sessionId + 结构化查询字段)。 */
  payload: unknown;
}

/** 成功响应:明文 result 或(超预算时)gzip+base64 的 resultGz,二者互斥。 */
export type GitReviewRemoteOpResult =
  | { ok: true; result: unknown }
  | { ok: true; resultGz: string }
  | { ok: false; code: 'OVERSIZE' }
  | { ok: false; message: string };

function bad(message: string): GitReviewRemoteOpResult {
  return { ok: false, message };
}

/** 结果编码:明文不超预算 → 原样;超预算 → gzip;gzip 后仍超 → OVERSIZE。 */
async function encodeResult(result: unknown): Promise<GitReviewRemoteOpResult> {
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') <= GIT_REVIEW_MAX_JSON_BYTES) {
    return { ok: true, result };
  }
  // base64 纯 ASCII,字符数 = UTF-8 字节数,JSON 转义零膨胀。
  const gzB64 = (await gzipAsync(Buffer.from(json, 'utf8'))).toString('base64');
  if (gzB64.length <= GIT_REVIEW_MAX_JSON_BYTES) {
    return { ok: true, resultGz: gzB64 };
  }
  return { ok: false, code: 'OVERSIZE' };
}

async function dispatchRemoteOp(op: string, payload: unknown): Promise<unknown> {
  switch (op) {
    case 'get': {
      const { sessionId, options } = parseReviewDataPayload(payload);
      return readReviewData(sessionId, options);
    }
    case 'summary':
      return readReviewSummary(parseSessionId(payload));
    case 'commits': {
      const { sessionId, baseRef } = parseCommitsPayload(payload);
      return readReviewCommits(sessionId, baseRef);
    }
    case 'commit-diff': {
      const { sessionId, oid, options } = parseCommitDiffPayload(payload);
      return readReviewCommitDiff(sessionId, oid, options);
    }
    case 'branch-diff': {
      const { sessionId, baseRef, options } = parseBranchDiffPayload(payload);
      return readReviewBranchDiff(sessionId, baseRef, options);
    }
    case 'file-diff': {
      const { sessionId, request } = parseFileDiffPayload(payload);
      return readReviewFileDiff(sessionId, request);
    }
    case 'image-preview': {
      const { sessionId, request } = parseImagePreviewPayload(payload);
      return readReviewImagePreview(sessionId, request);
    }
    case 'markdown-preview': {
      const { sessionId, request } = parseMarkdownPreviewPayload(payload);
      return readReviewMarkdownPreview(sessionId, request);
    }
    default:
      return null;
  }
}

const READ_OPS = new Set([
  'get',
  'summary',
  'commits',
  'commit-diff',
  'branch-diff',
  'file-diff',
  'image-preview',
  'markdown-preview',
]);

async function handleRemoteOp(args: GitReviewRemoteOpArgs): Promise<GitReviewRemoteOpResult> {
  if (!args || typeof args.op !== 'string') {
    return bad('invalid remote-op args');
  }
  if (!READ_OPS.has(args.op)) {
    // 未知 / 写 op:确定性拒绝(而非 throw),供控制端做能力探测语义。
    return bad(`unknown op: ${args.op}`);
  }
  try {
    const result = await dispatchRemoteOp(args.op, args.payload);
    return await encodeResult(result);
  } catch (err) {
    // 与本机 handler 同口径:带 [CODE] 标记的错误原样抛(经 invoke error 信封
    // 到控制端 reject,extractIpcError 可解);其余摘要为结构化 message,
    // 避免把内部堆栈带回控制端。
    if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED)\]/.test(err.message)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn('git-review remote-op failed', { op: args.op, message });
    return bad(message);
  }
}

/** 注册 remote-op handler。bootstrap 期调用一次(installInvokeCapture 之后)。 */
export function registerGitReviewDeviceOp(): void {
  ipcMain.handle(GIT_REVIEW_REMOTE_OP_CHANNEL, async (_event, args: GitReviewRemoteOpArgs) => {
    return handleRemoteOp(args);
  });
  log.info('git-review device-op registered');
}

/** 单测入口:绕开 ipcMain 直接驱动分发。 */
export const __gitReviewDeviceOpTesting = {
  handleRemoteOp,
  encodeResult,
  GIT_REVIEW_MAX_JSON_BYTES,
};
