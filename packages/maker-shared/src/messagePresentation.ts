import {
  formatDuration,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
  type MessageRenderTodoCardItem,
  type MessageRenderTodoItem,
  type MessageRenderToolGroupItem,
  type MessageRenderWorkChildItem,
  type MessageRenderWorkGroupItem,
} from './messageRender';
import {
  describeToolUse,
  truncateToolText,
  type ToolUseDescriptor,
} from './toolUseDescriptor';
import type { CommandIntent, CommandIntentAction } from './commandIntent';

export type MessageFoldHeaderChevronPosition = 'leading' | 'trailing';

export type MessageFoldHeaderVariant = 'card' | 'plain';

export interface MessageFoldHeaderPresentation {
  chevronPosition: MessageFoldHeaderChevronPosition;
  chevronSize: number;
  defaultExpanded: boolean;
  iconSize: number;
  summaryCount: number;
  subtitle: string | null;
  title: string;
  variant: MessageFoldHeaderVariant;
}

export interface ToolGroupPresentation {
  header: MessageFoldHeaderPresentation;
  title: string;
  /** 组内是否有仍在执行的工具行（块头图标同槽位换成进行中形态，对齐桌面 #454）。 */
  hasRunning: boolean;
}

export interface WorkGroupPresentation {
  header: MessageFoldHeaderPresentation;
  subtitle: string;
  title: string;
}

export type ToolRowStatus = 'running' | 'done';

export interface ToolRowPresentation {
  hasError: boolean;
  /** 人话主文案（issue #450 手机版）：description 成句 / 意图动词 + 参数 / MCP `调用 server · tool`。 */
  label: string;
  /** 次要细节（命令原文 / 完整路径 / MCP detail），桌面 hover title 的等价物；无则不渲染。 */
  detail?: string;
  /** running = tool_result 未到且会话流式中；其余（含无 settled 信号的历史消息）恒 done，防永久转圈。 */
  status: ToolRowStatus;
}

/** Compact human-readable tool text shared by mobile and remote IM surfaces. */
export interface ToolUseTextPresentation {
  label: string;
  detail?: string;
}

export interface ToolRowPresentationOptions {
  isSessionStreaming?: boolean;
  /** Structured sub-action when one Codex command execution expands into several rows. */
  intentOverride?: CommandIntent;
  /** Shared work projection owns status when rendering a split command row. */
  statusOverride?: ToolRowStatus;
}

export interface TodoStatusPresentation {
  status: MessageRenderTodoItem['status'];
}

export interface TodoCardPresentation {
  activeContent?: string;
  completed: number;
  defaultExpanded: boolean;
  header: MessageFoldHeaderPresentation;
  title: string;
  total: number;
}

export type MessageActionBarAlignment = 'left' | 'right';

export type MessageActionBarItemId = 'copy' | 'cost' | 'fork' | 'more' | 'streaming' | 'time';

export interface MessageActionBarPresentationInput {
  align: 'agent' | 'user';
  canCopy: boolean;
  canFork: boolean;
  hasMoreActions?: boolean;
  hasTime: boolean;
  hasTurnCost: boolean;
  isStreaming: boolean;
}

export interface MessageActionBarPresentation {
  align: MessageActionBarAlignment;
  buttonSize: number;
  iconSize: number;
  items: MessageActionBarItemId[];
}

export type MessageBubbleDensity = 'compact' | 'standard' | 'rich';

export interface MessageBubblePresentationInput {
  align?: 'user' | 'agent';
  attachmentCount?: number;
  body?: string;
  hasSystemCard?: boolean;
  isStreaming?: boolean;
  kind: string;
  mediaCount?: number;
  secondaryBody?: string;
}

export interface MessageBubblePresentation {
  density: MessageBubbleDensity;
  hasAuxiliaryContent: boolean;
  isUserAligned: boolean;
}

type MessagePresentationToolLike = MessageRenderNormalizedMessage & {
  diff?: unknown;
  media?: readonly unknown[];
  /** tool_result 是否已到达（normalize 层经 hasResultFor 写入）；undefined = 无信号（老数据），按已完成处理。 */
  toolSettled?: boolean;
};

type ToolSummaryVerb =
  | 'edited'
  | 'created'
  | 'ran'
  | 'read'
  | 'updated'
  | 'searched'
  | 'fetched'
  | 'used';

interface ToolSummaryVerbEntry {
  verb: ToolSummaryVerb;
  count: number;
}

const TOOL_SUMMARY_VERB_BY_LABEL: Record<string, ToolSummaryVerb> = {
  Edit: 'edited',
  MultiEdit: 'edited',
  file_change: 'edited',
  Write: 'created',
  Bash: 'ran',
  exec: 'ran',
  Read: 'read',
  TodoWrite: 'updated',
  Glob: 'searched',
  Grep: 'searched',
  WebFetch: 'fetched',
  WebSearch: 'fetched',
  web_search: 'fetched',
};

const TOOL_SUMMARY_VERB_ORDER: ToolSummaryVerb[] = [
  'edited',
  'ran',
  'read',
  'updated',
  'created',
  'searched',
  'fetched',
  'used',
];

// 聚合摘要短语（中文硬编码，文案对齐桌面 zh-CN `chat.agentActions.part.*`）。
const TOOL_SUMMARY_PART_ZH: Record<ToolSummaryVerb, (count: number) => string> = {
  edited: (count) => `编辑 ${count} 个文件`,
  created: (count) => `创建 ${count} 个文件`,
  ran: (count) => `运行 ${count} 条命令`,
  read: (count) => `读取 ${count} 个文件`,
  updated: () => '更新待办',
  searched: () => '执行搜索',
  fetched: () => '访问网络',
  used: (count) => `调用 ${count} 个工具`,
};

// 行级动词（中文硬编码，对齐桌面 zh-CN `chat.agentActionRow.verb.*`）。
const TOOL_ROW_VERB_ZH = {
  read: '读取',
  edit: '编辑',
  create: '创建',
  delete: '删除',
  rename: '重命名',
  update: '更新',
  run: '运行',
  runCommand: '运行命令',
  search: '搜索',
  fetch: '访问',
  use: '调用',
  updateTodos: '更新待办',
} as const;

// 命令意图动词（issue #450 codex 支持，对齐桌面 `verbLabelKeyForIntent` 的 zh-CN 文案）。
const INTENT_VERB_ZH: Record<CommandIntentAction, string> = {
  read: '读取',
  list: '列出',
  search: '搜索',
  inspect: '查阅内容',
  inspectRepository: '检查仓库',
  inspectEnvironment: '检查开发环境',
  modifyRepository: '修改仓库',
  verify: '运行验证',
  fetch: '访问',
  install: '安装依赖',
  test: '运行测试',
  build: '构建',
  lint: '代码检查',
  typecheck: '类型检查',
  runScript: '运行脚本',
  runNodeScript: '运行 Node.js 脚本',
  runPythonScript: '运行 Python 脚本',
  runPerlScript: '运行 Perl 脚本',
  runSwiftScript: '运行 Swift 脚本',
  checkSyntax: '检查语法',
  showVersion: '查看版本',
  checkFormatting: '检查格式',
  parseJson: '解析 JSON',
  count: '统计',
  showCurrentDirectory: '查看当前目录',
  showDateTime: '查看日期时间',
  locateCommand: '查找命令',
  inspectProcesses: '查看进程',
  inspectPorts: '查看端口',
  queryDatabase: '查询数据库',
  gitStatus: '查看工作区状态',
  gitDiff: '查看代码变更',
  gitLog: '查看提交记录',
  gitShow: '查看提交内容',
  gitAdd: '暂存代码变更',
  gitCommit: '提交代码变更',
  gitFetch: '获取远端更新',
  gitPull: '拉取远端更新',
  gitPush: '推送代码变更',
  gitRebase: '变基分支',
  gitMerge: '合并分支',
  gitCherryPick: '拣选提交',
  gitStash: '管理暂存工作',
  gitRestore: '恢复文件',
  gitSubmodule: '管理子模块',
  gitRemote: '查看远端仓库',
  gitRevParse: '解析 Git 引用',
  gitBranch: '查看分支',
  gitGrep: '搜索仓库内容',
  gitMergeBase: '查找共同祖先',
  gitLsFiles: '查看已跟踪文件',
  gitRevList: '查看提交范围',
  gitLsRemote: '查看远端引用',
  gitWorktreeList: '查看工作树',
  gitWorktreeAdd: '创建工作树',
  gitWorktreeRemove: '删除工作树',
  gitWorktreeMove: '移动工作树',
  gitWorktreePrune: '清理工作树',
  ghPrList: '查看 PR 列表',
  ghPrView: '查看 PR',
  ghPrChecks: '查看 PR 检查',
  ghPrStatus: '查看 PR 状态',
  ghPrDiff: '查看 PR 变更',
  ghPrCreate: '创建 PR',
  ghPrEdit: '编辑 PR',
  ghPrComment: '评论 PR',
  ghPrReview: '评审 PR',
  ghPrMerge: '合并 PR',
  ghPrClose: '关闭 PR',
  ghPrReopen: '重新打开 PR',
  ghPrCheckout: '检出 PR',
  ghIssueList: '查看 Issue 列表',
  ghIssueView: '查看 Issue',
  ghIssueStatus: '查看 Issue 状态',
  ghIssueCreate: '创建 Issue',
  ghIssueEdit: '编辑 Issue',
  ghIssueComment: '评论 Issue',
  ghIssueClose: '关闭 Issue',
  ghIssueReopen: '重新打开 Issue',
  ghAuthStatus: '查看 GitHub 登录状态',
  ghAuthLogin: '登录 GitHub',
  ghAuthLogout: '退出 GitHub',
  ghAuthRefresh: '刷新 GitHub 授权',
  ghAuthSwitch: '切换 GitHub 账号',
  ghRunList: '查看工作流运行',
  ghRunView: '查看工作流运行',
  ghRunWatch: '监视工作流运行',
  ghSearch: '搜索 GitHub',
  ghRepoList: '查看仓库列表',
  ghRepoView: '查看仓库',
  ghApiQuery: '查询 GitHub API',
  ghApiMutation: '修改 GitHub 数据',
  ghApiCall: '调用 GitHub API',
};

/** 行级动词槽位(TOOL_ROW_VERB_ZH 的 key 空间,供措辞注入方实现)。 */
export type ToolRowVerbKey = keyof typeof TOOL_ROW_VERB_ZH;

/**
 * 工具行措辞注入点——默认是本文件的中文硬编码表(mobile / IM 卡片继续走默认,
 * 字节级不变);desktop main(灵动岛)注入经 i18n 解析的本地化实现。做成函数式
 * 接口而非数据表:locale 可运行时切换,惰性求值免缓存失效。
 */
export interface ToolRowWording {
  /** 行级工具动词("读取"/"编辑"…)。 */
  verb(key: ToolRowVerbKey): string;
  /** 命令意图动词(CommandIntentAction 全覆盖)。 */
  intentVerb(action: CommandIntentAction): string;
  /** fileChange 多文件复合短语("更新 3 个文件");量词与语序语言相关,整短语粒度,count 恒 >= 2。 */
  updateFilesLabel(count: number): string;
}

export const DEFAULT_TOOL_ROW_WORDING: ToolRowWording = {
  verb: (key) => TOOL_ROW_VERB_ZH[key],
  intentVerb: (action) => INTENT_VERB_ZH[action],
  updateFilesLabel: (count) => `${TOOL_ROW_VERB_ZH.update} ${count} 个文件`,
};

const TOOL_ROW_TEXT_MAX_CHARS = 60;

/** 次行命令原文的截断上限(与桌面 hover 展示完整命令的意图对齐,手机放宽到 200 字)。 */
const COMMAND_DETAIL_MAX_CHARS = 200;

export function summarizeMessageBubblePresentation(
  input: MessageBubblePresentationInput,
): MessageBubblePresentation {
  const attachmentCount = Math.max(0, input.attachmentCount ?? 0);
  const mediaCount = Math.max(0, input.mediaCount ?? 0);
  const body = input.body?.trim() ?? '';
  const secondary = input.secondaryBody?.trim() ?? '';
  const hasAuxiliaryContent = attachmentCount > 0 || mediaCount > 0 || secondary.length > 0 || !!input.hasSystemCard;
  const isUserAligned = input.align === 'user' || input.kind === 'user';
  const density = messageBubbleDensity({
    body,
    hasAuxiliaryContent,
    isStreaming: input.isStreaming === true,
    kind: input.kind,
  });

  return {
    density,
    hasAuxiliaryContent,
    isUserAligned,
  };
}

export function buildMessageActionBarPresentation(
  input: MessageActionBarPresentationInput,
): MessageActionBarPresentation {
  if (input.isStreaming) {
    return {
      align: 'left',
      buttonSize: 24,
      iconSize: 14,
      items: ['streaming'],
    };
  }

  const agentItems: Array<MessageActionBarItemId | null> = [
    input.canCopy ? 'copy' : null,
    input.canFork ? 'fork' : null,
    input.hasMoreActions ? 'more' : null,
    input.hasTime ? 'time' : null,
    input.hasTurnCost ? 'cost' : null,
  ];
  const userItems: Array<MessageActionBarItemId | null> = [
    input.hasTime ? 'time' : null,
    input.canCopy ? 'copy' : null,
    input.canFork ? 'fork' : null,
    input.hasMoreActions ? 'more' : null,
  ];
  const items = (input.align === 'agent' ? agentItems : userItems).filter(isMessageActionBarItemId);

  return {
    align: input.align === 'user' ? 'right' : 'left',
    buttonSize: 24,
    iconSize: 14,
    items,
  };
}

export function summarizeToolGroupPresentation<
  TMessage extends MessagePresentationToolLike,
>(
  item: MessageRenderToolGroupItem<TMessage>,
  options: ToolRowPresentationOptions = {},
): ToolGroupPresentation {
  const primary = item.tools[0];
  const title = formatToolGroupSummary(item.tools)
    || (primary?.label ? `调用 ${primary.label}` : '调用了工具');
  const hasRunning = item.tools.some((tool) => toolRowStatus(tool, options) === 'running');

  // 折叠工具组只显示聚合标题(desktopPlainFoldHeader.subtitle 恒 null,对齐桌面):
  // 单个工具的人话文案在展开后的 tool row 里已呈现,折叠头不再挂一行冗余副标题。
  return {
    header: desktopPlainFoldHeader({ title }),
    title,
    hasRunning,
  };
}

export function summarizeToolRowPresentation<
  TMessage extends MessagePresentationToolLike,
>(tool: TMessage, options: ToolRowPresentationOptions = {}): ToolRowPresentation {
  const sourceDescriptor = toolRowDescriptor(tool);
  const descriptor = sourceDescriptor.kind === 'command' && options.intentOverride
    ? { ...sourceDescriptor, intent: options.intentOverride }
    : sourceDescriptor;
  // 读文件 / 搜索 / 网页类工具的结果正文是「内容」而非执行状态,全文错误关键词匹配
  // 必然误报(文件里出现 error / 失败 字样 ≠ 工具失败);但真实失败也常以纯文本落盘
  // (持久化链路无 is_error 标志),所以对这类工具改用锚定判定而非整段关闭检测。
  const hasError = isContentOutputDescriptor(descriptor)
    ? isContentToolFailureLike(tool)
    : isToolErrorLike(tool);
  const text = formatToolRowText(descriptor);

  return {
    hasError,
    label: text.label || tool.label || 'tool',
    ...(text.detail ? { detail: text.detail } : {}),
    status: options.statusOverride ?? toolRowStatus(tool, options),
  };
}

/**
 * Present a raw tool_use event with the same Chinese wording as expanded
 * desktop/mobile tool rows. Remote channels use only `label` in their live
 * latest-N preview; `detail` remains available for surfaces that can expand.
 */
export function summarizeToolUseText(
  toolName: string,
  input: unknown,
  options: Pick<ToolRowPresentationOptions, 'intentOverride'> & { wording?: ToolRowWording } = {},
): ToolUseTextPresentation {
  const sourceDescriptor = describeToolUse(toolName, input);
  const descriptor = sourceDescriptor.kind === 'command' && options.intentOverride
    ? { ...sourceDescriptor, intent: options.intentOverride }
    : sourceDescriptor;
  return formatToolRowText(descriptor, options.wording);
}

/**
 * 从 normalize 消息解出工具描述符：source 上 toolName / input 走 content 透传
 * （mobile 的 RemoteMessage 形态），残缺时退化 generic（describeToolUse 自身防御）。
 */
function toolRowDescriptor(tool: MessagePresentationToolLike): ToolUseDescriptor {
  const source = tool.source;
  const content = readRecordValue(source.content);
  const toolName = readNonEmptyStringValue(source.toolName)
    ?? readNonEmptyStringValue(content?.toolName)
    ?? readNonEmptyStringValue(content?.name)
    ?? tool.label
    ?? '';
  const input = source.toolInput !== undefined ? source.toolInput : content?.input;
  return describeToolUse(toolName, input);
}

/**
 * 描述符 → 行级人话文案（对齐桌面 AgentActionRow 的展示决策，issue #450）：
 * - Bash 有模型 description → 独立成句，命令原文降为次要细节；
 * - command intent（codex commandActions / 本地规则）命中 → 意图动词 + 目标；
 * - MCP / dynamic / collab → `调用 server · tool`；
 * - 无法分类的命令显示「运行命令」，真实命令保留在 detail；其它工具按类型回退。
 *
 * 措辞经 wording 注入(默认中文表);export 供灵动岛在拿到 descriptor 后按
 * kind 决定单行拼接策略。
 */
export function formatToolRowText(
  descriptor: ToolUseDescriptor,
  wording: ToolRowWording = DEFAULT_TOOL_ROW_WORDING,
): ToolUseTextPresentation {
  switch (descriptor.kind) {
    case 'command': {
      if (descriptor.description) {
        return {
          label: descriptor.description,
          ...commandDetail(descriptor.command),
        };
      }
      const intent = descriptor.intent;
      if (intent) {
        const label = intent.target
          ? joinVerb(wording.intentVerb(intent.action), truncateToolText(intent.target, TOOL_ROW_TEXT_MAX_CHARS))
          : wording.intentVerb(intent.action);
        return {
          label,
          // 友好标题负责扫读，真实命令固定留在次行负责准确性与审计。
          ...commandDetail(descriptor.command),
        };
      }
      if (!descriptor.command) return { label: descriptor.toolName };
      return {
        label: wording.verb('runCommand'),
        ...commandDetail(descriptor.command),
      };
    }
    case 'file': {
      const verb = descriptor.action === 'read'
        ? wording.verb('read')
        : descriptor.action === 'edit'
          ? wording.verb('edit')
          : wording.verb('create');
      return {
        label: joinVerb(verb, descriptor.fileName),
        ...(descriptor.filePath !== descriptor.fileName ? { detail: descriptor.filePath } : {}),
      };
    }
    case 'fileChange': {
      if (descriptor.changes.length > 1) {
        return { label: wording.updateFilesLabel(descriptor.changes.length) };
      }
      const change = descriptor.changes[0];
      const verb = change.action === 'add'
        ? wording.verb('create')
        : change.action === 'delete'
          ? wording.verb('delete')
          : change.action === 'move'
            ? wording.verb('rename')
            : change.action === 'update'
              ? wording.verb('edit')
              : wording.verb('update');
      const target = change.action === 'move' && change.moveFileName
        ? `${change.fileName} → ${change.moveFileName}`
        : change.fileName;
      const detail = change.action === 'move' && change.movePath
        ? `${change.path} → ${change.movePath}`
        : change.path;
      return {
        label: joinVerb(verb, target),
        ...(detail !== target ? { detail } : {}),
      };
    }
    case 'search':
      return {
        label: joinVerb(wording.verb('search'), truncateToolText(descriptor.pattern, TOOL_ROW_TEXT_MAX_CHARS)),
        ...(descriptor.path ? { detail: descriptor.path } : {}),
      };
    case 'web':
      return {
        label: joinVerb(
          descriptor.mode === 'fetch' ? wording.verb('fetch') : wording.verb('search'),
          truncateToolText(descriptor.target, TOOL_ROW_TEXT_MAX_CHARS),
        ),
      };
    case 'todo':
      return { label: wording.verb('updateTodos') };
    case 'task':
      return {
        label: descriptor.description ?? descriptor.toolName,
        ...(descriptor.subagentType ? { detail: descriptor.subagentType } : {}),
      };
    case 'mcp':
      return {
        label: joinVerb(wording.verb('use'), `${descriptor.serverLabel} · ${descriptor.toolLabel}`),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    case 'dynamic':
      return {
        label: joinVerb(
          wording.verb('use'),
          descriptor.namespace ? `${descriptor.namespace} · ${descriptor.toolLabel}` : descriptor.toolLabel,
        ),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    case 'collab':
      return {
        label: joinVerb(wording.verb('use'), descriptor.toolLabel),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    default:
      return {
        label: joinVerb(wording.verb('use'), descriptor.toolName),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
  }
}

function joinVerb(verb: string, target: string): string {
  return target ? `${verb} ${target}` : verb;
}

function commandDetail(command: string): { detail?: string } {
  return command ? { detail: truncateToolText(command, COMMAND_DETAIL_MAX_CHARS) } : {};
}

function toolRowStatus(
  tool: MessagePresentationToolLike,
  options: ToolRowPresentationOptions,
): ToolRowStatus {
  if (tool.toolSettled === false && options.isSessionStreaming === true) return 'running';
  return 'done';
}

export function summarizeTodoCardPresentation(item: MessageRenderTodoCardItem): TodoCardPresentation {
  const completed = item.todos.filter((todo) => todo.status === 'completed').length;
  const total = item.todos.length;
  const active = item.todos.find((todo) => todo.status === 'in_progress') ?? item.todos[item.todos.length - 1];
  const activeContent = active?.content;
  const title = `${completed}/${total}${activeContent ? ` · ${activeContent}` : ''}`;

  return {
    activeContent,
    completed,
    defaultExpanded: true,
    header: desktopTodoFoldHeader({
      summaryCount: total,
      title,
    }),
    title,
    total,
  };
}

export function todoStatusPresentation(status: MessageRenderTodoItem['status']): TodoStatusPresentation {
  return {
    status,
  };
}

export function summarizeWorkGroupPresentation<
  TMessage extends MessagePresentationToolLike,
>(item: MessageRenderWorkGroupItem<TMessage>): WorkGroupPresentation {
  const title = item.isStreaming
    ? '正在工作…'
    : item.durationMs !== undefined
      ? `已工作 ${formatDuration(item.durationMs)}`
      : '工作过程';

  return {
    header: desktopPlainFoldHeader({ title }),
    subtitle: '',
    title,
  };
}

export function countMessageRenderItemDiffs<
  TMessage extends MessagePresentationToolLike,
>(items: readonly MessageRenderItem<TMessage>[]): number {
  return items.reduce((sum, item) => sum + countItemDiffs(item), 0);
}

export function isToolErrorLike(
  tool: Pick<MessageRenderNormalizedMessage, 'body' | 'secondaryBody'>,
  keywordHeuristic = true,
): boolean {
  const secondary = tool.secondaryBody?.trim();
  if (secondary && isErrorRecord(secondary)) return true;
  if (!keywordHeuristic) return false;
  const text = [tool.body, secondary].filter(Boolean).join('\n');
  return /\b(error|failed|failure|exception|traceback|stderr|non-zero|denied|timed out|timeout)\b|exit code [1-9]|错误|失败|异常|拒绝|超时/i
    .test(text);
}

/** 结果正文是「内容」的工具(读文件 / 搜索 / 网页):对其输出跑全文错误关键词匹配没有意义。 */
function isContentOutputDescriptor(descriptor: ToolUseDescriptor): boolean {
  if (descriptor.kind === 'file') return descriptor.action === 'read';
  return descriptor.kind === 'search' || descriptor.kind === 'web';
}

/**
 * 内容类工具的失败判定:只认三类明确信号——结构化错误记录、`<tool_use_error>`
 * 标记、首行以失败句式开头。真实工具错误输出是短消息且失败措辞在开头
 * (`Error: ENOENT ...` / `request failed ...`),正文中段出现关键词的是内容命中,不算。
 */
export function isContentToolFailureLike(
  tool: Pick<MessageRenderNormalizedMessage, 'body' | 'secondaryBody'>,
): boolean {
  if (isToolErrorLike(tool, false)) return true;
  const secondary = tool.secondaryBody?.trim();
  if (!secondary) return false;
  if (secondary.includes('<tool_use_error>')) return true;
  const firstLine = secondary.split('\n', 1)[0].trim();
  // 字符类是全角冒号 U+FF1A + 半角冒号 U+003A 并列;别把全角的归一化成半角,
  // 会变成重复字符类(CodeQL 已拦过一次)。
  return /^(error\b|request failed\b|failed to \S|enoent\b|eacces\b|permission denied\b|错误[：:]|(读取|搜索|请求|抓取)失败|无法(读取|访问|打开|获取))/i
    .test(firstLine);
}

function isMessageActionBarItemId(value: MessageActionBarItemId | null): value is MessageActionBarItemId {
  return value !== null;
}

// 聚合摘要头（中文，对齐桌面 zh-CN：「编辑 3 个文件、运行 2 条命令 和 调用 1 个工具」口径的分隔符）。
function formatToolGroupSummary<TMessage extends MessagePresentationToolLike>(
  tools: readonly TMessage[],
): string {
  const entries = aggregateToolSummaryVerbs(tools);
  const truncatedExtra = entries.length > 5 ? entries.length - 5 : 0;
  const parts = entries.slice(0, 5).map((entry) => TOOL_SUMMARY_PART_ZH[entry.verb](entry.count));
  if (truncatedExtra > 0) parts.push(`另外 ${truncatedExtra} 项`);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join('、')} 和 ${parts[parts.length - 1]}`;
}

function aggregateToolSummaryVerbs<TMessage extends MessagePresentationToolLike>(
  tools: readonly TMessage[],
): ToolSummaryVerbEntry[] {
  const counter = new Map<ToolSummaryVerb, number>();
  for (const tool of tools) {
    const verb = TOOL_SUMMARY_VERB_BY_LABEL[tool.label] ?? 'used';
    counter.set(verb, (counter.get(verb) ?? 0) + 1);
  }
  return TOOL_SUMMARY_VERB_ORDER
    .filter((verb) => counter.has(verb))
    .map((verb) => ({
      verb,
      count: counter.get(verb)!,
    }));
}

function desktopPlainFoldHeader({ title }: { title: string }): MessageFoldHeaderPresentation {
  return {
    chevronPosition: 'trailing',
    chevronSize: 14,
    defaultExpanded: false,
    iconSize: 14,
    summaryCount: 0,
    subtitle: null,
    title,
    variant: 'plain',
  };
}

function desktopTodoFoldHeader({
  summaryCount,
  title,
}: {
  summaryCount: number;
  title: string;
}): MessageFoldHeaderPresentation {
  return {
    chevronPosition: 'leading',
    chevronSize: 14,
    defaultExpanded: true,
    iconSize: 16,
    summaryCount,
    subtitle: null,
    title,
    variant: 'card',
  };
}

function messageBubbleDensity({
  body,
  hasAuxiliaryContent,
  isStreaming,
  kind,
}: {
  body: string;
  hasAuxiliaryContent: boolean;
  isStreaming: boolean;
  kind: string;
}): MessageBubbleDensity {
  if (kind === 'system' || hasAuxiliaryContent || body.length > 520) return 'rich';
  if (isStreaming || body.length > 140 || body.includes('\n')) return 'standard';
  return 'compact';
}

function countItemDiffs<TMessage extends MessagePresentationToolLike>(
  item: MessageRenderItem<TMessage> | MessageRenderWorkChildItem<TMessage>,
): number {
  if (item.type === 'tool_group') {
    return item.tools.filter((tool) => !!tool.diff).length;
  }
  if (item.type === 'work_group') {
    return item.children.reduce((sum, child) => sum + countItemDiffs(child), 0);
  }
  return 0;
}

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isErrorRecord(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    if (record.ok === false || record.success === false) return true;
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    if (status === 'error' || status === 'failed' || status === 'failure') return true;
    return ['error', 'errors', 'exception', 'stderr'].some((key) => {
      const raw = record[key];
      return typeof raw === 'string' ? raw.trim().length > 0 : raw !== undefined && raw !== null;
    });
  } catch {
    return false;
  }
}
