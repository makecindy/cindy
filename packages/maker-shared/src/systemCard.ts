import { summarizeContextUsage, summarizeSessionSpend } from './sessionControls.js';

export type SystemCardType =
  | 'help'
  | 'context'
  | 'cost'
  | 'pwd'
  | 'status'
  | 'compact'
  | 'cmd';

export interface SystemCardSlashCommandLike {
  description?: string;
  kind: string;
  name: string;
  source?: string;
}

export interface SystemCardSessionLike {
  agentKind?: string | null;
  contextTokens?: number;
  contextWindow?: number;
  fastMode?: boolean | null;
  model?: string | null;
  permissionMode?: string | null;
  status?: string | null;
  title?: string | null;
  totalCostUsd?: number;
  totalTokenUsage?: number;
  workingDir?: string | null;
}

export interface SystemCardInputProjectionLike {
  pendingQueue?: readonly unknown[];
  queuePaused?: boolean;
}

export interface SystemCardPresentation {
  body?: string;
  rows: Array<{ label: string; value: string }>;
  subtitle?: string;
  title: string;
}

export const DEFAULT_LOCAL_SYSTEM_COMMANDS: SystemCardSlashCommandLike[] = [
  { kind: 'agent-builtin', name: 'help', description: '显示手机端和远程 agent 命令' },
  { kind: 'agent-builtin', name: 'context', description: '查看当前任务上下文用量' },
  { kind: 'agent-builtin', name: 'cost', description: '查看当前任务消耗' },
  { kind: 'agent-builtin', name: 'pwd', description: '显示当前远程工作目录' },
  { kind: 'agent-builtin', name: 'status', description: '显示当前任务状态' },
];

export function parseLocalSystemCommand(
  text: string,
  localCommands: readonly SystemCardSlashCommandLike[] = DEFAULT_LOCAL_SYSTEM_COMMANDS,
): SystemCardType | null {
  const match = /^\/([a-z][\w-]*)\s*$/.exec(text.trim());
  if (!match || !localCommandNameSet(localCommands).has(match[1])) return null;
  return match[1] as SystemCardType;
}

export function mergeLocalSlashCommands<TCommand extends SystemCardSlashCommandLike>(
  remoteCommands: readonly TCommand[],
  localCommands: readonly SystemCardSlashCommandLike[] = DEFAULT_LOCAL_SYSTEM_COMMANDS,
): Array<SystemCardSlashCommandLike | TCommand> {
  const out: Array<SystemCardSlashCommandLike | TCommand> = [];
  const seen = new Set<string>();
  for (const command of [...localCommands, ...remoteCommands]) {
    const key = command.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(command);
  }
  return out;
}

export function buildSystemCardData(
  type: SystemCardType,
  options: {
    contextError?: string;
    contextUsage?: unknown;
    localCommands?: readonly SystemCardSlashCommandLike[];
    projection?: SystemCardInputProjectionLike;
    remoteCommands?: readonly SystemCardSlashCommandLike[];
    session: SystemCardSessionLike | null;
  },
): Record<string, unknown> {
  const session = options.session;
  const localCommands = options.localCommands ?? DEFAULT_LOCAL_SYSTEM_COMMANDS;
  if (type === 'help') {
    const localNames = localCommandNameSet(localCommands);
    return {
      commands: mergeLocalSlashCommands(options.remoteCommands ?? [], localCommands).map((command) => ({
        name: command.name,
        description: command.description ?? '',
        source: localNames.has(command.name) ? 'mobile-local' : command.kind,
      })),
    };
  }
  if (type === 'context') {
    return options.contextError
      ? { error: options.contextError, usage: null }
      : { usage: options.contextUsage ?? null };
  }
  if (type === 'cost') {
    const summary = summarizeSessionSpend(session);
    return { detail: summary.detail, available: summary.available };
  }
  if (type === 'pwd') {
    return { workingDir: session?.workingDir ?? '' };
  }
  return {
    agent: session?.agentKind === 'codex' ? 'Codex' : session?.agentKind === 'pi' ? 'Pi' : 'Claude Code',
    fastMode: session?.fastMode === true,
    model: session?.model ?? '',
    permissionMode: session?.permissionMode ?? '',
    queuePaused: options.projection?.queuePaused === true,
    queueSize: options.projection?.pendingQueue?.length ?? 0,
    sessionStatus: session?.status ?? 'unknown',
    title: session?.title ?? '',
  };
}

export function formatSystemCard(
  type: SystemCardType,
  data: Record<string, unknown> | undefined,
): SystemCardPresentation {
  const record = data ?? {};
  if (type === 'help') {
    const commands = Array.isArray(record.commands) ? record.commands : [];
    return {
      title: 'Available Commands',
      rows: commands.flatMap((item) => {
        if (!isRecord(item)) return [];
        const name = readString(item.name);
        if (!name) return [];
        return [{
          label: `/${name}`,
          value: readString(item.description) ?? sourceLabel(readString(item.source)),
        }];
      }),
      body: commands.length === 0 ? '没有可用命令。' : undefined,
    };
  }
  if (type === 'context') {
    const error = readString(record.error);
    const summary = summarizeContextUsage(record.usage);
    return {
      title: summary.title,
      rows: summary.rows,
      body: error || summary.detail,
    };
  }
  if (type === 'cost') {
    return {
      title: 'Session spend',
      rows: [],
      body: readString(record.detail) ?? '暂无任务用量',
    };
  }
  if (type === 'pwd') {
    return {
      title: 'Working Directory',
      rows: [{ label: 'cwd', value: readString(record.workingDir) || '未设置' }],
    };
  }
  if (type === 'compact') {
    return {
      title: 'Compact',
      rows: [],
      body: readString(record.detail)
        ?? readString(record.summary)
        ?? readString(record.message)
        ?? '对话压缩已完成。',
    };
  }
  if (type === 'cmd') {
    return {
      title: 'Command Result',
      rows: readString(record.command)
        ? [{ label: 'command', value: readString(record.command) ?? '' }]
        : [],
      body: readString(record.detail)
        ?? readString(record.output)
        ?? readString(record.message)
        ?? '',
    };
  }
  return {
    title: 'Session Status',
    rows: [
      { label: 'title', value: readString(record.title) || '未命名任务' },
      { label: 'status', value: readString(record.sessionStatus) || 'unknown' },
      { label: 'agent', value: readString(record.agent) || 'unknown' },
      { label: 'model', value: readString(record.model) || 'unknown' },
      { label: 'permission', value: readString(record.permissionMode) || 'unknown' },
      { label: 'fast mode', value: record.fastMode === true ? 'on' : 'off' },
      { label: 'queue', value: formatQueueStatus(record.queueSize, record.queuePaused) },
    ],
  };
}

function localCommandNameSet(commands: readonly SystemCardSlashCommandLike[]): Set<string> {
  return new Set(commands.map((command) => command.name));
}

function formatQueueStatus(size: unknown, paused: unknown): string {
  const n = typeof size === 'number' && Number.isFinite(size) ? size : 0;
  return `${n} 条${paused === true ? ' · 已暂停' : ''}`;
}

function sourceLabel(source: string | null): string {
  if (source === 'mobile-local') return 'mobile local';
  if (source === 'agent-skill') return 'agent skill';
  if (source === 'agent-builtin') return 'agent command';
  if (source === 'desktop') return 'desktop command';
  return source ?? '';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
