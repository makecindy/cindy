/**
 * Claude Code 的 Auto-review adapter —— 把 CC 内置工具调用翻译成归一化 `ReviewableAction`,
 * 交给 harness 无关的 Cindy Auto-Review Core(`../shared/auto-review.ts`)裁决。
 *
 * 背景与判定档见 core 的文件头。Claude 侧特有的只是"工具名→动作"的映射:CC 的
 * `--permission-mode auto` 会绕过 Cindy 的 canUseTool(实机探针证实),故 auto 映射到 SDK
 * `default` 让 canUseTool 生效后,非 MCP 内置工具在此分类(见 claude-code/index.ts 的 dispatcher)。
 */

import {
  reviewAction,
  isSensitiveCredentialPath,
  type ReviewableAction,
  type ReviewVerdict,
} from '../shared/auto-review.js';

export type BuiltinAutoReviewVerdict = ReviewVerdict;

export interface BuiltinAutoReviewContext {
  /** Claude 内置工具名(非 MCP;MCP 工具走 host 的 getMcpToolApprovalPolicy)。 */
  toolName: string;
  /** 工具入参(SDK 透传的原始对象)。 */
  input: unknown;
  /** 会话的工作区根:cwd + additionalDirectories,绝对路径。远端会话是远端路径(纯字符串判定)。 */
  workspaceRoots: string[];
  /** 会话所在平台(决定是否抹平 macOS firmlink /private)。缺省用本进程 process.platform;远端会话应传远端 OS。 */
  platform?: NodeJS.Platform;
}

/** 只读内省工具:纯读、无本地写、无命令执行、无外发。 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead',
]);

/**
 * 无副作用的会话内状态/控制工具:TodoWrite 只改会话内 todo;BashOutput/KillShell 只读取/终止
 * 已存在(已被审过)的后台 shell;Task 派生 subagent,其内部工具调用会再次经 canUseTool 复检。
 */
const SAFE_STATEFUL_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite', 'BashOutput', 'KillShell', 'KillBash', 'Task',
]);

/** 会改文件、带结构化 path 参数、可精确判定工作区边界的工具。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

function extractFilePath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractCommand(input: unknown): string {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c : '';
}

/**
 * 读工具的路径字段(Read=file_path、NotebookRead=notebook_path、Grep/Glob/LS=path),交 core 判凭证。
 * 命中凭证位置(如 ~/.ssh、/Users/x/.aws)才升级——读内容(Read/Grep)与列目录(LS/Glob)都算侦察面;
 * 路径缺失(如 `Glob {pattern}` 无 path)返回 undefined,按普通只读放行。
 */
function extractReadPath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const primaryKey = toolName === 'Read' ? 'file_path' : toolName === 'NotebookRead' ? 'notebook_path' : 'path';
  const candidates: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) candidates.push(v);
  };
  push(obj[primaryKey]);
  // 文件选择器也可能直指凭证文件:Grep 的 glob(`{path:'/Users/me', glob:'**/.aws/credentials'}` 会读出内容)、
  // Glob 的 pattern(其本身就是路径选择器)。任一命中凭证就用它升级;Grep 的 pattern 是搜索正则、非路径,不纳入。
  if (toolName === 'Grep') push(obj.glob);
  if (toolName === 'Glob') push(obj.pattern);
  return candidates.find((c) => isSensitiveCredentialPath(c)) ?? candidates[0];
}

function extractNetworkTarget(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const key = toolName === 'WebFetch' ? 'url' : 'query';
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Auto-review 下对一个**内置工具调用**给出审查档位。仅在权限档为 `auto` 时调用
 * (见 claude-code/index.ts 的 canUseTool dispatcher)。纯映射,判定逻辑全在 core。
 */
export function classifyBuiltinToolForAutoReview(
  ctx: BuiltinAutoReviewContext,
): BuiltinAutoReviewVerdict {
  const action = normalizeBuiltinToolForAutoReview(ctx.toolName, ctx.input);
  const opts = ctx.platform ? { platform: ctx.platform } : undefined;
  return reviewAction(action, ctx.workspaceRoots, opts);
}

/** 把 Claude 内置工具翻译成共享动作；判定与 AI fallback 都复用这一份归一化结果。 */
export function normalizeBuiltinToolForAutoReview(
  toolName: string,
  input: unknown,
): ReviewableAction {
  if (READ_ONLY_TOOLS.has(toolName)) {
    // Read/NotebookRead 读单个具名文件(scope='file');Grep/Glob/LS 是目录级递归读(scope='tree'),
    // 根在工作区外时能遍历进区外凭证子路径 → 由 core 按边界升级(见 reviewAction 的 read 分支)。
    const scope: 'file' | 'tree' = toolName === 'Read' || toolName === 'NotebookRead' ? 'file' : 'tree';
    return { kind: 'read', path: extractReadPath(toolName, input), scope };
  }
  if (SAFE_STATEFUL_TOOLS.has(toolName)) return { kind: 'session-state' };
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'file-write', path: extractFilePath(toolName, input) };
  }
  if (toolName === 'Bash') {
    return { kind: 'exec', command: extractCommand(input) };
  }
  // WebFetch/WebSearch:把 URL/搜索词送往外部(exfil 面)→ 升级。
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return {
      kind: 'network',
      operation: toolName,
      target: extractNetworkTarget(toolName, input),
    };
  }
  // 未知 / 其它一切工具 → fail-closed 升级。
  return { kind: 'other' };
}
