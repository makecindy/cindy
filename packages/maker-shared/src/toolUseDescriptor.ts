import { basenameRemotePath } from './filePreview.js';
import { normalizeDisplayCommand } from './commandDisplay.js';
import {
  commandIntentFromActions,
  commandIntentFromCommand,
  type CommandIntent,
} from './commandIntent.js';

/**
 * 工具调用「人话摘要」共享层（issue #450）。
 *
 * 把 tool_use 的 (toolName, input) 解析成结构化描述符，供桌面端 / 手机端
 * 各自格式化最终文案 —— 桌面端有 4 语言 i18n、手机端是中文硬编码，所以本层
 * 只输出结构化数据，绝不拼接面向用户的句子。
 *
 * 数据来源约定（由 maker-core translator 决定，本层只读）：
 * - Claude Code：toolName 为 SDK 原名（Bash/Read/...，MCP 为 `mcp__server__tool`），
 *   input 全量透传；Bash 的 `description` 是模型每次调用填写的一句话描述。
 * - Codex：shell 工具 toolName='exec'（input 无 description，`displayCommand`
 *   是解包 POSIX / PowerShell wrapper 后的展示命令）；MCP 为 `mcp:server:tool`，另有
 *   `dynamic:ns:tool` / `collab:tool` / `web_search`。
 * - pi：内置工具名全小写（bash/read/edit/write/grep/find/ls），文件参数字段为
 *   `path`（fileDescriptor 已双认 file_path/path）；bash 无 description 字段，
 *   桥接 MCP 复用 Claude Code 的 `mcp__server__tool` 形态。
 */

// ── 工具名拆解 ───────────────────────────────────────────────────────────────

export type ParsedToolName =
  | { kind: 'plain'; name: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'dynamic'; namespace?: string; tool: string }
  | { kind: 'collab'; tool: string };

/**
 * 拆解 MCP / dynamic / collab 工具名。
 *
 * - `mcp__server__tool`（Claude Code）：去前缀后按双下划线切，首段是 server，
 *   其余段用 `__` 重接为 tool —— server 自身含单下划线（如 orca_worker_bridge）
 *   不受影响。
 * - `mcp:server:tool`（Codex）：按冒号切，tool 段可再含冒号。
 * - 段数不足（拆不出 server + tool）时降级 plain，按原名展示。
 */
export function parseToolName(toolName: string): ParsedToolName {
  if (toolName.startsWith('mcp__')) {
    const segments = toolName.slice('mcp__'.length).split('__');
    if (segments.length >= 2 && segments[0]) {
      const tool = segments.slice(1).join('__');
      if (tool) return { kind: 'mcp', server: segments[0], tool };
    }
    return { kind: 'plain', name: toolName };
  }
  if (toolName.startsWith('mcp:')) {
    const segments = toolName.split(':');
    if (segments.length >= 3 && segments[1]) {
      const tool = segments.slice(2).join(':');
      if (tool) return { kind: 'mcp', server: segments[1], tool };
    }
    return { kind: 'plain', name: toolName };
  }
  if (toolName.startsWith('dynamic:')) {
    const segments = toolName.split(':');
    if (segments.length >= 3 && segments[1] && segments.slice(2).join(':')) {
      return { kind: 'dynamic', namespace: segments[1], tool: segments.slice(2).join(':') };
    }
    if (segments.length === 2 && segments[1]) {
      return { kind: 'dynamic', tool: segments[1] };
    }
    return { kind: 'plain', name: toolName };
  }
  if (toolName.startsWith('collab:')) {
    const tool = toolName.slice('collab:'.length);
    if (tool) return { kind: 'collab', tool };
    return { kind: 'plain', name: toolName };
  }
  return { kind: 'plain', name: toolName };
}

// ── 工具调用描述符 ───────────────────────────────────────────────────────────

export type ToolUseDescriptor =
  | {
      kind: 'command';
      toolName: string;
      /** 模型填写的一句话人话描述（仅 Claude Code Bash 有；trim 后非空才认）。 */
      description?: string;
      /** 原始命令；缺失时为空串，消费端回退 toolName 展示。 */
      command: string;
      cwd?: string;
      /**
       * 代码解析出的结构化意图（issue #450 codex 支持）：codex `commandActions`
       * 优先，其次本地规则表解析命令原文。仅在无模型 description 时计算 ——
       * description 存在时渲染端也不会用到 intent。
       */
      intent?: CommandIntent;
    }
  | {
      kind: 'file';
      toolName: string;
      action: 'read' | 'edit' | 'create';
      filePath: string;
      fileName: string;
    }
  | {
      kind: 'fileChange';
      toolName: string;
      changes: Array<{
        action: 'add' | 'delete' | 'update' | 'move' | 'unknown';
        path: string;
        fileName: string;
        movePath?: string;
        moveFileName?: string;
        diff: string;
      }>;
    }
  | {
      kind: 'search';
      toolName: string;
      mode: 'grep' | 'glob';
      pattern: string;
      path?: string;
      glob?: string;
    }
  | {
      kind: 'web';
      toolName: string;
      mode: 'fetch' | 'search';
      /** fetch = url，search = query。 */
      target: string;
    }
  | { kind: 'todo'; toolName: string }
  | {
      kind: 'task';
      toolName: string;
      description?: string;
      subagentType?: string;
    }
  | {
      kind: 'mcp';
      toolName: string;
      server: string;
      tool: string;
      /** server 原名（不做转换，server 名本身就是标识）。 */
      serverLabel: string;
      /** tool 下划线转空格后的可读形态（read_by_url → read by url）。 */
      toolLabel: string;
      /** 从 input 常见字段里抽出的一段人话细节（截断到 80 字）。 */
      detail?: string;
    }
  | {
      kind: 'dynamic';
      toolName: string;
      namespace?: string;
      tool: string;
      toolLabel: string;
      detail?: string;
    }
  | {
      kind: 'collab';
      toolName: string;
      tool: string;
      toolLabel: string;
      detail?: string;
    }
  | { kind: 'generic'; toolName: string; detail?: string };

/** pi `edit` 的一段定向替换。 */
export interface PiEditReplacement {
  oldText: string;
  newText: string;
}

/**
 * 归一化 pi `edit` 工具的替换段。
 *
 * pi v0.83.0 的 `edit` 有**两种**入参形态，展示层必须都认（`edit.ts` 的
 * `editSchema` 与 `LegacyEditToolInput` / `normalizeEditInput`）：
 *  - 声明 schema（模型被要求产出的形态）：`{ path, edits: [{ oldText, newText }] }`；
 *  - legacy 顶层单段：`{ path, oldText, newText }` —— pi 自己仍接受并归一化。
 *
 * 顺序与 pi 的 `normalizeEditInput` 对齐：先取 `edits[]`，再把顶层
 * `oldText`/`newText`（两者都是字符串才认）作为**最后一段**追加。只认其中之一
 * 会让另一种形态退化成空 diff 与 `+0 -0`。
 */
export function piEditReplacements(input: unknown): PiEditReplacement[] {
  const inp = readRecord(input);
  if (!inp) return [];
  const out: PiEditReplacement[] = [];
  if (Array.isArray(inp.edits)) {
    for (const raw of inp.edits) {
      const rec = readRecord(raw);
      // 单段内只要有一侧是字符串就成段(另一侧按空串)，纯增/纯删才不会被丢掉。
      const oldText = typeof rec?.oldText === 'string' ? rec.oldText : undefined;
      const newText = typeof rec?.newText === 'string' ? rec.newText : undefined;
      if (oldText === undefined && newText === undefined) continue;
      out.push({ oldText: oldText ?? '', newText: newText ?? '' });
    }
  }
  if (typeof inp.oldText === 'string' && typeof inp.newText === 'string') {
    out.push({ oldText: inp.oldText, newText: inp.newText });
  }
  return out;
}

/** 下划线（含双下划线）转空格并收敛连续空白，得到可读的 token。 */
export function humanizeToolToken(token: string): string {
  return token.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 展示用截断：超出 max 时截到 max-3 并补 `...`（与 payloadSummary 风格一致）。 */
export function truncateToolText(text: string, max: number): string {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** MCP / dynamic / collab / generic 的 detail 抽取字段优先级。 */
const DETAIL_KEYS = ['description', 'url', 'query', 'path', 'file_path', 'title', 'name', 'prompt'] as const;

const DETAIL_MAX_CHARS = 80;

/**
 * 解析一次工具调用为结构化描述符。
 *
 * 防御约定：input 可能是 null / string / array / 任意残缺对象（老消息、
 * 第三方 MCP、模型漏填），任何分支都不许抛异常 —— 拿不到关键参数时降级
 * generic（文件/搜索/Web 类）或空串回退（command 类）。
 */
export function describeToolUse(toolName: string, input: unknown): ToolUseDescriptor {
  const inp = readRecord(input);

  const parsed = parseToolName(toolName);
  if (parsed.kind === 'mcp') {
    return {
      kind: 'mcp',
      toolName,
      server: parsed.server,
      tool: parsed.tool,
      serverLabel: parsed.server,
      toolLabel: humanizeToolToken(parsed.tool),
      ...withDetail(inp),
    };
  }
  if (parsed.kind === 'dynamic') {
    return {
      kind: 'dynamic',
      toolName,
      ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
      tool: parsed.tool,
      toolLabel: humanizeToolToken(parsed.tool),
      ...withDetail(inp),
    };
  }
  if (parsed.kind === 'collab') {
    return {
      kind: 'collab',
      toolName,
      tool: parsed.tool,
      toolLabel: humanizeToolToken(parsed.tool),
      ...withDetail(inp),
    };
  }

  switch (toolName) {
    // pi 内置 bash 与 Claude Code Bash 同构:input.command 必有,description
    // 仅 CC 会填(pi schema 无此字段,自然走 intent 兜底),共用一条路径。
    case 'Bash':
    case 'bash': {
      const description = readNonEmptyString(inp?.description);
      const command = readNonEmptyString(inp?.command) ?? '';
      // description 缺失（模型漏填 / pi bash 无此字段）才兜底算 intent。
      const intent = description ? undefined : commandIntentFromCommand(command);
      return {
        kind: 'command',
        toolName,
        ...(description ? { description } : {}),
        command,
        ...withCwd(inp),
        ...(intent ? { intent } : {}),
      };
    }
    case 'exec': {
      // codex shell：displayCommand 是解包 wrapper 后的展示命令，优先。
      const rawCommand = readNonEmptyString(inp?.command) ?? '';
      const command = readNonEmptyString(inp?.displayCommand)
        ?? normalizeDisplayCommand(rawCommand)
        ?? rawCommand;
      // codex 官方 commandActions（translator 透传）优先,本地规则解析兜底。
      // 完整命令一并传入:commandActions 采纳前先过同一道形态安全闸
      // (防止 `cat a | tee b` 这类后段副作用绕过,见 commandIntent 注释)。
      const intent =
        commandIntentFromActions(inp?.commandActions, command) ?? commandIntentFromCommand(command);
      return { kind: 'command', toolName, command, ...withCwd(inp), ...(intent ? { intent } : {}) };
    }
    case 'file_change':
      return fileChangeDescriptor(toolName, inp);
    case 'Read':
    case 'read':
    // pi ls 目标是目录,读取语义与 read 同档;path 可缺省(默认当前目录),
    // 缺省时 fileDescriptor 自然降级 generic。
    case 'ls':
      return fileDescriptor(toolName, 'read', inp);
    case 'Edit':
    case 'MultiEdit':
    case 'edit':
      return fileDescriptor(toolName, 'edit', inp);
    case 'Write':
    case 'write':
      return fileDescriptor(toolName, 'create', inp);
    // pi grep/find 与 CC Grep/Glob 同构:pattern 必有,path/glob 可选;
    // find 的 pattern 是 glob 表达式,归 glob 模式。
    case 'Grep':
    case 'Glob':
    case 'grep':
    case 'find': {
      const pattern = readNonEmptyString(inp?.pattern);
      if (!pattern) return genericDescriptor(toolName, inp);
      const path = readNonEmptyString(inp?.path);
      const glob = readNonEmptyString(inp?.glob);
      return {
        kind: 'search',
        toolName,
        mode: toolName === 'Grep' || toolName === 'grep' ? 'grep' : 'glob',
        pattern,
        ...(path ? { path } : {}),
        ...(glob ? { glob } : {}),
      };
    }
    case 'WebFetch': {
      const url = readNonEmptyString(inp?.url);
      if (!url) return genericDescriptor(toolName, inp);
      return { kind: 'web', toolName, mode: 'fetch', target: url };
    }
    case 'WebSearch':
    case 'web_search': {
      const query = readNonEmptyString(inp?.query);
      if (!query) return genericDescriptor(toolName, inp);
      return { kind: 'web', toolName, mode: 'search', target: query };
    }
    case 'TodoWrite':
    case 'update_plan':
      return { kind: 'todo', toolName };
    case 'Task':
    case 'Agent': {
      const description = readNonEmptyString(inp?.description);
      const subagentType = readNonEmptyString(inp?.subagent_type);
      return {
        kind: 'task',
        toolName,
        ...(description ? { description } : {}),
        ...(subagentType ? { subagentType } : {}),
      };
    }
    default:
      return genericDescriptor(toolName, inp);
  }
}

// ── 内部辅助 ────────────────────────────────────────────────────────────────

function fileDescriptor(
  toolName: string,
  action: 'read' | 'edit' | 'create',
  inp: Record<string, unknown> | null,
): ToolUseDescriptor {
  const filePath = readNonEmptyString(inp?.file_path) ?? readNonEmptyString(inp?.path);
  if (!filePath) return genericDescriptor(toolName, inp);
  return {
    kind: 'file',
    toolName,
    action,
    filePath,
    fileName: basenameRemotePath(filePath) || filePath,
  };
}

/**
 * Codex file_change 一次可以携带多个文件；这里只把协议形态收敛成稳定的
 * 展示模型。任一 change 缺关键字段时整次降级 generic，避免 UI 只展示半套
 * 变更而让用户误以为剩余文件没有被修改。
 */
function fileChangeDescriptor(
  toolName: string,
  inp: Record<string, unknown> | null,
): ToolUseDescriptor {
  if (!Array.isArray(inp?.changes) || inp.changes.length === 0) {
    return genericDescriptor(toolName, inp);
  }

  const changes: Extract<ToolUseDescriptor, { kind: 'fileChange' }>['changes'] = [];
  for (const rawChange of inp.changes) {
    const change = readRecord(rawChange);
    const kind = readRecord(change?.kind);
    const path = readNonEmptyString(change?.path);
    const kindType = readNonEmptyString(kind?.type);
    if (!change || !kind || !path || !kindType || typeof change.diff !== 'string') {
      return genericDescriptor(toolName, inp);
    }

    const movePath = readNonEmptyString(kind.move_path)
      ?? readNonEmptyString(kind.movePath)
      ?? readNonEmptyString(change.move_path)
      ?? readNonEmptyString(change.movePath);
    const action = movePath
      ? 'move'
      : kindType === 'add' || kindType === 'delete' || kindType === 'update'
        ? kindType
        : 'unknown';

    changes.push({
      action,
      path,
      fileName: basenameRemotePath(path) || path,
      ...(movePath
        ? {
            movePath,
            moveFileName: basenameRemotePath(movePath) || movePath,
          }
        : {}),
      diff: change.diff,
    });
  }

  return { kind: 'fileChange', toolName, changes };
}

function genericDescriptor(toolName: string, inp: Record<string, unknown> | null): ToolUseDescriptor {
  return { kind: 'generic', toolName, ...withDetail(inp) };
}

function withDetail(inp: Record<string, unknown> | null): { detail?: string } {
  const detail = extractDetail(inp);
  return detail ? { detail } : {};
}

function withCwd(inp: Record<string, unknown> | null): { cwd?: string } {
  const cwd = readNonEmptyString(inp?.cwd);
  return cwd ? { cwd } : {};
}

function extractDetail(inp: Record<string, unknown> | null): string | undefined {
  if (!inp) return undefined;
  for (const key of DETAIL_KEYS) {
    const value = readNonEmptyString(inp[key]);
    if (value) return truncateToolText(value, DETAIL_MAX_CHARS);
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
