/**
 * pi 的 Auto-review adapter —— 把 cindy-bridge 冒泡上来的 pi 工具调用翻译成归一化
 * `ReviewableAction`,交 harness 无关的 Cindy Auto-Review Core(`../shared/auto-review.ts`)
 * 裁决。判定档语义见 core 文件头。
 *
 * pi 侧的到达面与 CC 不同:bridge 在 pi 进程内直通「只读内置四件套且入参不碰凭证
 * 路径」(见 cindy-bridge-source.ts READONLY_BUILTINS + touchesCredentialPath),
 * `bypassPermissions` 全放行 —— 能到这里的是 bash / edit / write / 桥接 MCP 工具 /
 * 凭证路径的只读调用 / 未来新增内置工具。只读分支扫全部字符串入参判凭证,与 bridge
 * 同判定:bridge 升级上来的凭证读在 auto 档必须落弹窗,不能被 path 字段缺失反向放行。
 *
 * MCP 工具(`mcp__*`)一律走 `other`,由当前会话模型结合完整工具名/入参轻量诊断；
 * 本 adapter 不猜测各 server 的安全性。reviewer 缺失/失败仍由共享决策层 fail-closed。
 */

import {
  isSensitiveCredentialPath,
  reviewAction,
  type ReviewableAction,
  type ReviewVerdict,
} from '../shared/auto-review.js';

export type PiAutoReviewVerdict = ReviewVerdict;

export interface PiAutoReviewContext {
  /** pi 工具名(内置小写:bash/edit/write/read/…;桥接 MCP 为 mcp__<server>__<tool>)。 */
  toolName: string;
  /** 工具入参(bridge 透传的原始对象)。 */
  input: Record<string, unknown>;
  /**
   * Bridge-followed real paths that matched the credential policy. `null` means
   * the bridge evidence was present but malformed and must fail closed.
   */
  resolvedCredentialPaths?: readonly string[] | null;
  /** 会话工作区根:cwd,绝对路径(pi 无 extraDirs)。 */
  workspaceRoots: string[];
  /** 可读根:工作区 + Pi 附加只读引用目录。写操作仍只看 workspaceRoots。 */
  readRoots?: string[];
}

/** 给当前模型 reviewer 的完整 MCP/未知工具证据；输入来自 JSON RPC，可安全序列化。 */
function describeOtherTool(toolName: string, input: Record<string, unknown>): string {
  try {
    return JSON.stringify({ toolName, input });
  } catch {
    return JSON.stringify({ toolName });
  }
}

/**
 * pi 只读内置工具(与 cindy-bridge READONLY_BUILTINS 同集)。入参路径字段统一为 `path`。
 *
 * 注意可达面:bridge 对这四个工具在**非凭证路径**时直接放行、根本不冒泡
 * (`cindy-bridge-source.ts` 的 `READONLY_BUILTINS.has(toolName) && !credentialRead` → return),
 * 所以能走到本 adapter 的只读调用只有「命中凭证路径」那一类,下面的凭证分支已经把它收成
 * `prompt-each-time`。因此这里不做 CC 那套 `scope:'file' | 'tree'` 的区分 —— 加了也不会执行。
 * Pi 的区外目录级递归读(`grep`/`find`/`ls` 根在工作区外)当前确实不经 host 审阅,与 Claude
 * 存在行为差异;真正修它要动 bridge 的只读快路径,属独立改动(见 PR 描述里的后续项)。
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['read', 'grep', 'find', 'ls']);

/** 会改文件、带结构化 `path` 入参的 pi 内置工具。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 递归找第一个触碰凭证路径的字符串叶子(含数组 / 嵌套对象),深度上限防环。与 bridge 的
 * touchesCredentialPath 同口径:凭证路径若藏在 { paths:[...] } / { opts:{path} } 里也命中。
 */
function findCredentialLeaf(input: unknown, depth = 0): string | undefined {
  if (depth > 6 || input == null) return undefined;
  if (typeof input === 'string') return isSensitiveCredentialPath(input) ? input : undefined;
  if (Array.isArray(input)) {
    for (const v of input) {
      const hit = findCredentialLeaf(v, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof input === 'object') {
    for (const v of Object.values(input as Record<string, unknown>)) {
      const hit = findCredentialLeaf(v, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

function canonicalCredentialEvidenceAction(
  resolvedCredentialPaths: readonly string[] | null | undefined,
): ReviewableAction | undefined {
  if (resolvedCredentialPaths === null) {
    return {
      kind: 'other',
      description: 'Pi credential-read evidence was malformed.',
      requireConsent: true,
    };
  }
  const resolvedCredentialHit = findCredentialLeaf(resolvedCredentialPaths);
  if ((resolvedCredentialPaths?.length ?? 0) > 0 && !resolvedCredentialHit) {
    return {
      kind: 'other',
      description: 'Pi credential-read evidence did not match the Host policy.',
      requireConsent: true,
    };
  }
  return resolvedCredentialHit ? { kind: 'read', path: resolvedCredentialHit } : undefined;
}

/**
 * Auto-review 下对一个 pi 工具调用给出审查档位。仅在权限档为 `auto` 时调用
 * (见 pi/index.ts handleExtensionUiRequest 的 dispatcher)。纯映射,判定逻辑全在 core。
 */
export function normalizePiToolForAutoReview(ctx: PiAutoReviewContext): ReviewableAction {
  const { toolName, input } = ctx;

  if (READ_ONLY_TOOLS.has(toolName)) {
    // Bridge follows symlinks in its process, so Host must include those canonical
    // targets in the same credential decision. A malformed or policy-inconsistent
    // evidence payload cannot fall back to the innocent-looking link path.
    const evidenceAction = canonicalCredentialEvidenceAction(ctx.resolvedCredentialPaths);
    if (evidenceAction) return evidenceAction;
    // 凭证特征可能落在任意字符串入参(grep 的 pattern、find 的表达式等),与 bridge
    // 的 touchesCredentialPath 同口径递归扫全字段。
    const credentialHit = findCredentialLeaf(input);
    return { kind: 'read', path: credentialHit ?? stringField(input, 'path') };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'file-write', path: stringField(input, 'path') };
  }
  if (toolName === 'bash') {
    const evidenceAction = canonicalCredentialEvidenceAction(ctx.resolvedCredentialPaths);
    if (evidenceAction) return evidenceAction;
    return { kind: 'exec', command: stringField(input, 'command') ?? '' };
  }
  // MCP / 自定义 / 未知工具进入灰区，同时把完整工具名与入参交给轻量 reviewer。
  return { kind: 'other', description: describeOtherTool(toolName, input) };
}

export function classifyPiToolForAutoReview(ctx: PiAutoReviewContext): PiAutoReviewVerdict {
  return reviewAction(normalizePiToolForAutoReview(ctx), ctx.readRoots ?? ctx.workspaceRoots);
}
