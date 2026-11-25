/**
 * 一个任务的只读交付收据。只投影既有读结果，不落库、不把「这一轮结束」写成已完成。
 * 命令成败与 apps/desktop agentHandoff 的 extractCommandOutcome 共用 judgeCommandOutcome。
 */
import { isBotDeliverableFile, type BotDeliverableFile } from './botDeliverable.js';
import { describeToolUse } from './toolUseDescriptor.js';
import { extractToolResultDiagnostics, parseToolResultCompactionMarker } from './toolResultCompaction.js';

export const DELIVERY_RECEIPT_FILE_CAP = 20;
export const DELIVERY_RECEIPT_OUTPUT_CAP = 10;
export const DELIVERY_RECEIPT_COMMAND_CAP = 3;
const COMMAND_LINE_CAP = 120;

/** 与 agentHandoff 的命令工具名同一份，不另放宽。 */
export const DELIVERY_COMMAND_TOOL_NAMES = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

const NEW_FILE_STATUSES = new Set(['added', 'untracked', 'copied']);

export interface DeliveryReceiptCommandMessage {
  role: string;
  content: unknown;
  toolUseId?: string | null;
}

export interface DeliveryReceiptFileInput {
  path: string;
  status?: string;
  name?: string;
  artifact?: unknown;
  /** 改名前的路径。只有 status 为 renamed 时使用。 */
  oldPath?: string | null;
  /** 这条记录所属变更集的工作目录。相对路径只按它解析一次。 */
  cwd?: string | null;
  /**
   * false 表示这条记录所属的变更已经撤销，不再描述当前工作区。
   * 省略表示仍然生效。
   */
  applied?: boolean;
}

export interface DeliveryReceiptChecks {
  total: number;
  failed: number;
  passed: number;
  pending: number;
  skipped: number;
}

export interface DeliveryReceiptPullRequest {
  url: string | null;
  /** ok = 状态读到了；unknown = 没读到。读不到不能当成通过。 */
  status: 'ok' | 'unknown';
  checks?: DeliveryReceiptChecks | null;
}

export type DeliveryReceiptNextStep =
  | 'waiting-answer'
  | 'waiting-approval'
  | 'waiting-merge'
  | 'none';

export type DeliveryReceiptCi = 'unknown' | 'none' | 'passed' | 'failed' | 'pending';

export interface DeliveryReceiptSection<T> {
  items: T[];
  omitted: number;
  /** false 时界面不渲染这一段，避免空表格。 */
  shown: boolean;
}

export interface DeliveryReceiptChangeItem {
  path: string;
  /** false 时这个路径已经删除或被改名走，只作为改动记下来，不再提供打开。 */
  openable: boolean;
}

export interface DeliveryReceipt {
  title: string;
  /** get_task_digest 的 phase。finished 只表示这一轮结束。 */
  phase: string;
  workingDir: string | null;
  branch: string | null;
  changes: DeliveryReceiptSection<DeliveryReceiptChangeItem>;
  verification: DeliveryReceiptSection<{ command: string; outcome: string; failed: boolean }>;
  outputs: DeliveryReceiptSection<{ path: string; name: string }>;
  prUrl: string | null;
  ci: DeliveryReceiptCi;
  nextStep: DeliveryReceiptNextStep;
  conversationOnly: boolean;
}

export interface DeliveryReceiptInput {
  title: string;
  /** 活动快照的 phase；null 时收据写 idle，不猜成完成。 */
  phase?: string | null;
  interactionKind?: string | null;
  workflowWaitingOn?: string | null;
  workingDir?: string | null;
  branch?: string | null;
  changedFiles?: DeliveryReceiptFileInput[];
  /** 清单被上限截掉、调用方知道还有多少项时传入。 */
  unlistedChangeCount?: number;
  /** 按时间从旧到新。命令结果走 judgeCommandOutcome。 */
  messages?: DeliveryReceiptCommandMessage[];
  pullRequests?: DeliveryReceiptPullRequest[];
  /** 关联列表没读到。不能当成没有 PR，也不能把 CI 写成通过或未跑。 */
  pullRequestsUnavailable?: boolean;
  /**
   * 变更集标明采集不完整（例如敏感文件没有内容）。
   * 不能因此写成「这次没有改动文件」。
   */
  captureIncomplete?: boolean;
  /**
   * 文件清单被截断。看不全删除记录时，不能断言成品还在。
   */
  fileHistoryTruncated?: boolean;
}

function isWindowsShaped(filePath: string): boolean {
  return filePath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filePath);
}

/**
 * 绝对路径保持原样，重复调用不改变结果。相对路径按记录自己的工作目录拼接。
 * 不使用 node:path：这份投影会进 Renderer。
 */
export function resolveDeliveryReceiptPath(filePath: string, base: string | null | undefined): string {
  if (!filePath) return filePath;
  const root = base?.trim() ? base : null;
  const windows = isWindowsShaped(filePath) || (root != null && isWindowsShaped(root));
  if (windows) {
    if (isWindowsShaped(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) return filePath;
    if (!root) return filePath;
    const relative = filePath.replace(/^[\\/]+/, '').replace(/\//g, '\\');
    return `${root.replace(/[\\/]+$/, '')}\\${relative}`;
  }
  if (filePath.startsWith('/')) return filePath;
  if (!root) return filePath;
  return `${root.replace(/\/+$/, '')}/${filePath.replace(/^\/+/, '')}`;
}

export function judgeCommandOutcome(input: {
  isError?: unknown;
  exitCode?: unknown;
  text?: string;
}): string | undefined {
  if (input.isError === true) return 'failed';
  if (typeof input.exitCode === 'number' && Number.isFinite(input.exitCode)) {
    return `exit ${input.exitCode}`;
  }
  const text = input.text ?? '';
  const exitMatch = text.match(/exit(?:ed)?(?:\s+code)?[:\s]+(-?\d+)/i);
  if (exitMatch) return `exit ${exitMatch[1]}`;
  // 落库把 isError 编成整段文本的这层包裹，对象上的字段会丢掉。只认整段，避免命令输出里偶然出现这个词。
  if (text.startsWith('<tool_use_error>') && text.endsWith('</tool_use_error>')) return 'failed';
  if (/\b(tests? failed|failing tests|assertionerror)\b/i.test(text)) return 'tests failed';
  if (input.isError === false) return 'ok';
  return undefined;
}

export function isFailedCommandOutcome(outcome: string | undefined): boolean {
  if (!outcome) return false;
  if (outcome === 'ok' || outcome === 'exit 0') return false;
  return true;
}

/**
 * 与 get_task_digest 的 fallbackDigestPhase 同一方向：completed 只变成 finished，
 * 不表示目标已经完成。
 */
export function deliveryReceiptPhase(activity: {
  phase?: string | null;
  interactionKind?: string | null;
} | null): string {
  switch (activity?.phase) {
    case 'running':
      return 'running';
    case 'needs-interaction':
      return /permission|approval/i.test(activity.interactionKind ?? '')
        ? 'waiting-permission'
        : 'waiting-answer';
    case 'error':
      return 'errored';
    case 'completed':
      return 'finished';
    case 'waiting-permission':
    case 'waiting-answer':
    case 'errored':
    case 'usage-limit':
    case 'finished':
    case 'idle':
      return activity.phase;
    default:
      return 'idle';
  }
}

export function deliveryNextStep(input: {
  phase: string | null;
  interactionKind?: string | null;
  workflowWaitingOn?: string | null;
}): DeliveryReceiptNextStep {
  if (input.workflowWaitingOn === 'merge') return 'waiting-merge';
  if (
    input.phase === 'waiting-permission' ||
    /permission|approval/i.test(input.interactionKind ?? '')
  ) {
    return 'waiting-approval';
  }
  if (input.phase === 'waiting-answer' || input.phase === 'needs-interaction') return 'waiting-answer';
  return 'none';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentRecord(content: unknown): Record<string, unknown> | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return contentRecord(JSON.parse(content));
      } catch {
        return { fullText: content };
      }
    }
    return { fullText: content };
  }
  return asRecord(content);
}

function outcomeText(content: unknown, record: Record<string, unknown>): string {
  const nested = record.fullText ?? record.output ?? record.content;
  if (typeof nested === 'string') return nested;
  if (typeof content === 'string') return content;
  return '';
}

function commandOutcomeOf(content: unknown): string | undefined {
  const compacted = parseToolResultCompactionMarker(content);
  if (compacted) return judgeCommandOutcome({ isError: compacted.diagnostics?.isError });
  // 字符串是命令输出本身。失败事实只认落库诊断，不把输出 JSON 里的字段当成退出码。
  if (typeof content === 'string') {
    return judgeCommandOutcome({
      isError: extractToolResultDiagnostics(content)?.isError,
      text: content,
    });
  }
  const record = asRecord(content);
  if (!record) return undefined;
  return judgeCommandOutcome({
    isError: record.isError,
    exitCode: record.exitCode,
    text: outcomeText(content, record),
  });
}

function commandTextOf(input: Record<string, unknown>): string {
  const raw = input.command;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((item) => typeof item === 'string').join(' ');
  return '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clipCommand(command: string): string {
  const line = oneLine(command);
  if (line.length <= COMMAND_LINE_CAP) return line;
  return `${line.slice(0, COMMAND_LINE_CAP)}…`;
}

function toolUseIdOf(message: DeliveryReceiptCommandMessage, content?: Record<string, unknown>): string {
  if (typeof message.toolUseId === 'string' && message.toolUseId) return message.toolUseId;
  if (!content) return '';
  return typeof content.toolUseId === 'string'
    ? content.toolUseId
    : typeof content.id === 'string'
      ? content.id
      : '';
}

export function recordedCommandsFromMessages(
  messages: DeliveryReceiptCommandMessage[],
): Array<{ command: string; outcome?: string }> {
  const commands: Array<{ command: string; outcome?: string }> = [];
  const commandByToolUseId = new Map<string, number>();
  for (const message of messages) {
    const content = contentRecord(message.content);
    if (message.role === 'tool_use') {
      if (!content) continue;
      const name = typeof content.toolName === 'string' ? content.toolName : '';
      const input = asRecord(content.input) ?? {};
      const described = name ? describeToolUse(name, input) : null;
      const command = described?.kind === 'command'
        ? described.command
        : DELIVERY_COMMAND_TOOL_NAMES.has(name)
          ? commandTextOf(input)
          : '';
      if (!command) continue;
      const index = commands.push({ command: clipCommand(command) }) - 1;
      const toolUseId = toolUseIdOf(message, content);
      if (toolUseId) commandByToolUseId.set(toolUseId, index);
      continue;
    }
    if (message.role !== 'tool_result') continue;
    const toolUseId = toolUseIdOf(message, content);
    const index = toolUseId ? commandByToolUseId.get(toolUseId) : undefined;
    if (index === undefined) continue;
    const outcome = commandOutcomeOf(message.content);
    if (!outcome) continue;
    commands[index] = { ...commands[index]!, outcome };
  }
  return commands;
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || path;
}

function section<T>(items: T[], cap: number, extraOmitted = 0): DeliveryReceiptSection<T> {
  const shownItems = items.slice(0, cap);
  const omitted = Math.max(0, items.length - shownItems.length) + Math.max(0, extraOmitted);
  return { items: shownItems, omitted, shown: shownItems.length > 0 || omitted > 0 };
}

function receiptCi(
  pullRequests: DeliveryReceiptPullRequest[],
  unavailable: boolean,
): DeliveryReceiptCi {
  if (unavailable) return 'unknown';
  if (pullRequests.length === 0) return 'none';
  let unknown = false;
  let pending = false;
  let passed = 0;
  let known = 0;
  for (const pr of pullRequests) {
    if (pr.status !== 'ok' || pr.checks == null) {
      unknown = true;
      continue;
    }
    known += 1;
    if (pr.checks.failed > 0) return 'failed';
    if (pr.checks.pending > 0) {
      pending = true;
      continue;
    }
    if (pr.checks.total > 0 && pr.checks.passed > 0) passed += 1;
    else unknown = true;
  }
  if (unknown) return 'unknown';
  if (pending) return 'pending';
  if (known > 0 && passed === known) return 'passed';
  return 'unknown';
}

export function buildDeliveryReceipt(input: DeliveryReceiptInput): DeliveryReceipt {
  const phase = deliveryReceiptPhase({
    phase: input.phase,
    interactionKind: input.interactionKind,
  });
  const changed = input.changedFiles ?? [];
  const order: string[] = [];
  const byPath = new Map<string, DeliveryReceiptFileInput & { created: boolean; removed: boolean }>();
  const remember = (path: string) => {
    if (!byPath.has(path)) order.push(path);
  };
  for (let file of changed) {
    if (!file.path || file.applied === false) continue;
    const base = file.cwd ?? input.workingDir;
    const resolved = {
      ...file,
      path: resolveDeliveryReceiptPath(file.path, base),
      oldPath: file.oldPath ? resolveDeliveryReceiptPath(file.oldPath, base) : file.oldPath,
    };
    file = resolved;
    if (file.status === 'renamed' && file.oldPath && file.oldPath !== file.path) {
      const previous = byPath.get(file.oldPath);
      if (previous) previous.removed = true;
      const current = byPath.get(file.path);
      remember(file.path);
      const stillThere = current != null && !current.removed && current.created;
      byPath.set(file.path, {
        ...file,
        created: previous?.created === true || stillThere,
        removed: false,
      });
      continue;
    }
    const previous = byPath.get(file.path);
    remember(file.path);
    const created = file.status && NEW_FILE_STATUSES.has(file.status)
      ? true
      : file.status === 'deleted'
        ? false
        : previous?.created ?? false;
    byPath.set(file.path, {
      ...file,
      created,
      removed: file.status === 'deleted',
    });
  }
  const changeItems = order.map((path) => {
    const file = byPath.get(path)!;
    return { path, openable: !file.removed };
  });
  const outputFiles: Array<BotDeliverableFile & { cwd?: string | null }> = [];
  for (const path of order) {
    const file = byPath.get(path)!;
    if (file.created && !file.removed) {
      outputFiles.push({
        path: file.path,
        name: file.name,
        artifact: file.artifact,
        cwd: file.cwd,
      });
    }
  }
  const outputs = input.fileHistoryTruncated
    ? []
    : outputFiles
      .filter((file) => isBotDeliverableFile(file, file.cwd ?? input.workingDir ?? undefined))
      .map((file) => ({ path: file.path, name: file.name || fileName(file.path) }));
  const commands = recordedCommandsFromMessages(input.messages ?? []);
  const recent = commands.slice(-DELIVERY_RECEIPT_COMMAND_CAP);
  const verification = section(
    recent.map((command) => ({
      command: command.command,
      outcome: command.outcome ?? '',
      failed: isFailedCommandOutcome(command.outcome),
    })).filter((command) => command.command),
    DELIVERY_RECEIPT_COMMAND_CAP,
    Math.max(0, commands.length - recent.length),
  );
  const changes = section(changeItems, DELIVERY_RECEIPT_FILE_CAP, input.unlistedChangeCount ?? 0);
  const outputSection = section(outputs, DELIVERY_RECEIPT_OUTPUT_CAP);
  const pullRequests = input.pullRequests ?? [];
  return {
    title: input.title.trim() || '',
    phase,
    workingDir: input.workingDir?.trim() ? input.workingDir : null,
    branch: input.branch?.trim() ? input.branch : null,
    changes,
    verification,
    outputs: outputSection,
    prUrl: pullRequests.find((pr) => pr.url)?.url ?? null,
    ci: receiptCi(pullRequests, input.pullRequestsUnavailable === true),
    nextStep: deliveryNextStep({
      phase,
      interactionKind: input.interactionKind,
      workflowWaitingOn: input.workflowWaitingOn,
    }),
    conversationOnly:
      !input.captureIncomplete && !changes.shown && !verification.shown && !outputSection.shown,
  };
}
