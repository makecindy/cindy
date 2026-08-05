/**
 * sessionDirResolver — 推断「一个对话当前实际在哪个 git 工作目录干活」。
 *
 * 为什么:session.working_dir 是建会话时的静态快照,常常是被多个对话共用的主
 * checkout;而真正的代码工作往往在各自独立的 worktree 里。用 working_dir 的实时
 * HEAD 当「这个对话的分支」会全错(主 checkout 停在哪个分支,所有共用它的对话就
 * 都显示哪个分支)。这里改从 agent 的 tool-call 遥测推断真实工作目录,再读那个
 * 目录的确定性 HEAD。
 *
 * 信号(按 agent):
 *   - Codex exec:每条命令 content.input.cwd = agent 当前 shell 目录,直接可信
 *     (实测:agent `cd` 进 worktree 后,后续每条命令的 cwd 都跟着变)。
 *   - Claude Code:Bash 不带 cwd;改用 Edit/Write/MultiEdit/NotebookEdit 的
 *     input.file_path 绝对路径,取其所在目录(Read 不算——读文件 ≠ 在此工作)。
 *
 * 取「最近一条产出候选目录的 tool-use」(= 对话此刻在哪),用 readGitHead 校验:
 *   - 是 git 目录 → 采用,source='telemetry'(可信);
 *   - 该目录已不存在(worktree 删了)→ **不往回翻**(避免翻出更早的主 checkout
 *     冒充),直接落到 fallback,让 PR 分支兜底。
 * 拿不到遥测候选时回退 app 托管 worktree(live 路径)→ session.working_dir(低信任)。
 *
 * 纯函数 extractDirCandidate 不碰 IO,便于单测;IO 编排走注入依赖 / live 包装。
 */

import path from 'node:path';

import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { messages, sessions } from '../localDb/schema';
import { createLogger } from '../logger.js';
import { readGitHead, type GitHeadInfo } from './headReader.js';

const log = createLogger('git-context/session-dir');

/** 算「在此工作」的编辑类工具(Read / 普通 Bash 等不算)。 */
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * 把 Claude Code SDK 在 Windows 上常用的 POSIX 盘符路径(如 `/e/AIWork/...`)
 * 转成原生 Win32 路径(`E:\AIWork\...`)。非 win32 是 no-op。
 *
 * 为什么需要:`path.isAbsolute('/e/AIWork/...')` 在 win32 上为 true,但
 * `readGitHead`/`path.resolve` 会把它当"当前盘符的根路径"解析成 `<盘>:\e\AIWork`,
 * 于是 cc 的 Edit/Write 遥测目录探测落空、徽标退回 workingDir/PR 兜底(Codex
 * review P2)。这里在喂给 readGitHead 前先归一。逻辑镜像 bootstrap-electron.ts 的
 * `posixToWin32`(那个是 main 入口文件里的非导出私有函数,不便直接 import);
 * platform 参数显式可注入,便于在非 win32 机器上单测 win32 分支。
 */
export function posixDriveToWin32(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || !p) return p;
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

/** 倒序扫描的 tool-use 上限——只为找到最近一条带候选目录的;200 足够穿过连续的 Read。 */
const SCAN_LIMIT = 200;

/** 解析结果:目录 + 其 HEAD + 来源(决定徽标对分支的信任度)。 */
export interface SessionGitDirResult {
  workdir: string | null;
  head: GitHeadInfo | null;
  source: 'telemetry' | 'worktree' | 'workingDir' | null;
}

/**
 * 从一条 tool-use 消息 content(已是 JSON 文本)解析候选工作目录:
 *   - input.cwd 是绝对路径(Codex exec)→ 直接用;
 *   - toolName ∈ 编辑类 且 input.file_path 是绝对路径 → 取 path.dirname;
 *   - 其它(Read / 普通 Bash / 脏 JSON / 相对路径)→ null。
 * 纯函数,不碰 IO。
 */
export function extractDirCandidate(content: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const input = (obj as { input?: unknown }).input;
  if (!input || typeof input !== 'object') return null;

  const toolName = (obj as { toolName?: unknown }).toolName;
  if (typeof toolName !== 'string') return null;

  // Codex exec:input.cwd = agent 当前 shell 目录。**只认 toolName==='exec'**——
  // 避免未来某个 input 里恰好带 cwd 字段的工具(语义未必是"工作目录")被误当成
  // 会话工作目录、绕过 cc 编辑路径分支(Greptile review P2)。translator 确认所有
  // 命令执行事件都发 toolName 'exec',其它工具(mcp/file_change/...)不带 cwd。
  if (toolName === 'exec') {
    const cwd = (input as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && cwd.trim() !== '' && path.isAbsolute(cwd)) {
      return posixDriveToWin32(cwd);
    }
  }

  // cc 编辑类:先归一 POSIX 盘符路径(Windows 上 cc 常发 `/e/...`)再取 dirname。
  if (EDIT_TOOL_NAMES.has(toolName)) {
    const fp = (input as { file_path?: unknown }).file_path;
    if (typeof fp === 'string' && path.isAbsolute(fp)) return path.dirname(posixDriveToWin32(fp));
  }
  return null;
}

/** 注入依赖(单测不碰真实 DB / fs)。 */
export interface ResolveSessionGitDirDeps {
  /** 该 session 可见的 tool-use 消息 content,createdAt 降序(已过滤 rewind/clear)。 */
  recentToolUseContents: (sessionId: string) => Promise<string[]>;
  /** 读目录 HEAD(= readGitHead);非 git 目录 / 不存在返回 null。 */
  probeGitDir: (dir: string) => Promise<GitHeadInfo | null>;
}

/**
 * 编排解析逻辑(纯依赖注入,可单测)。优先级:遥测 → app worktree → working_dir。
 */
export async function resolveSessionGitDir(
  input: {
    sessionId: string;
    fallbackWorktreePath: string | null;
    fallbackWorkingDir: string | null;
  },
  deps: ResolveSessionGitDirDeps,
): Promise<SessionGitDirResult> {
  // 1) 遥测:最近一条能产出候选目录的 tool-use(跳过 Read/Bash/脏 JSON 等无候选的)。
  const contents = await deps.recentToolUseContents(input.sessionId);
  let candidate: string | null = null;
  for (const content of contents) {
    const cand = extractDirCandidate(content);
    if (cand) {
      candidate = cand;
      break;
    }
  }
  if (candidate) {
    const head = await deps.probeGitDir(candidate);
    if (head !== null) {
      return { workdir: path.resolve(candidate), head, source: 'telemetry' };
    }
    // 最近的工作目录已不存在(worktree 删了)→ 不往回翻更早候选,落 fallback。
  }

  // 2) app 托管 worktree 的 live 路径。
  if (input.fallbackWorktreePath) {
    const head = await deps.probeGitDir(input.fallbackWorktreePath);
    if (head !== null) {
      return { workdir: path.resolve(input.fallbackWorktreePath), head, source: 'worktree' };
    }
  }

  // 3) 兜底 session.working_dir(低信任,徽标优先让位 PR 分支)。
  if (input.fallbackWorkingDir) {
    const head = await deps.probeGitDir(input.fallbackWorkingDir);
    if (head !== null) {
      return { workdir: path.resolve(input.fallbackWorkingDir), head, source: 'workingDir' };
    }
  }

  return { workdir: null, head: null, source: null };
}

/** 查该 session 可见的 tool-use 消息 content,createdAt 降序、bounded(可见性同 prRefsStore)。 */
async function queryRecentToolUseContents(sessionId: string): Promise<string[]> {
  const db = getDbClient().drizzle;
  const [sessionRow] = await db
    .select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const clearedAt = sessionRow?.clearedAt ?? null;

  const conds = [
    eq(messages.sessionId, sessionId),
    eq(messages.role, 'tool_use'),
    isNull(messages.rewindAt),
  ];
  if (clearedAt !== null) conds.push(gt(messages.createdAt, clearedAt));

  const rows = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(SCAN_LIMIT);
  return rows.map((r) => r.content);
}

/**
 * live 包装:用真实 DB + readGitHead 解析。DB 未就绪 / 查询失败时视为「无遥测」,
 * 静默落到 worktree / working_dir 兜底(永不抛错)。
 */
export async function resolveSessionGitDirLive(input: {
  sessionId: string;
  fallbackWorktreePath: string | null;
  fallbackWorkingDir: string | null;
}): Promise<SessionGitDirResult> {
  return resolveSessionGitDir(input, {
    recentToolUseContents: async (sid) => {
      try {
        return await queryRecentToolUseContents(sid);
      } catch (err) {
        log.warn('query recent tool-use failed (no telemetry)', {
          sessionId: sid,
          err: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },
    probeGitDir: (dir) => readGitHead(dir),
  });
}
