import { sessionCollaborationLabel, sessionWorkspaceTitle, sessionWorktreeLabel } from './sessionIdentity.js';

export type SessionActionStripActionId = 'settings' | 'usage' | 'files' | 'queue' | 'search';

export interface SessionActionStripSessionLike {
  agentKind: 'cc' | 'codex' | string;
  contextTokens?: number;
  contextWindow?: number;
  fastMode: boolean;
  model: string;
  orcaRole?: 'lead' | 'worker' | string | null;
  permissionMode: string;
  status: 'active' | 'archived' | 'deleted' | string;
  totalCostUsd?: number;
  totalTokenUsage?: number;
  workingDir: string | null;
  worktreePath?: string | null;
}

export interface SessionOverviewChip {
  id: string;
  label: string;
  strong: boolean;
}

export interface SessionActionStripAction {
  accessibilityLabel: string;
  active: boolean;
  attention: boolean;
  disabled: boolean;
  disabledReason: string | null;
  id: SessionActionStripActionId;
  label: string;
  testID: string;
}

export interface SessionOverviewModel {
  actionCopy: string | null;
  actions: SessionActionStripAction[];
  attentionLabel: string | null;
  filesEnabled: boolean;
  runtimeSubtitle: string;
  stateChips: SessionOverviewChip[];
  title: string;
}

export interface SessionActionStripInput {
  diffCount?: number;
  messageCount: number;
  pendingCount: number;
  queueAvailable?: boolean;
  queueCount: number;
  queueOpen?: boolean;
  queuePaused: boolean;
  readOnlyReason?: string | null;
  remoteUnavailableReason?: string | null;
  searchOpen?: boolean;
  session: SessionActionStripSessionLike;
}

export function buildSessionActionStrip(input: SessionActionStripInput): SessionOverviewModel {
  return summarizeSessionOverview(input);
}

export function summarizeSessionOverview(input: SessionActionStripInput): SessionOverviewModel {
  const collaboration = sessionCollaborationLabel(input.session);
  const worktree = sessionWorktreeLabel(input.session);
  const runtimeSubtitle = [
    collaboration,
    worktree,
    agentLabel(input.session.agentKind),
    input.session.model,
    input.session.permissionMode,
    input.session.fastMode ? 'Fast' : null,
  ].filter(Boolean).join(' · ');
  const stateChips: SessionOverviewChip[] = [];

  if (input.remoteUnavailableReason) {
    stateChips.push({ id: 'remote-unavailable', label: '不可用', strong: true });
  }
  if (input.pendingCount > 0) {
    stateChips.push({ id: 'pending', label: `待处理 ${input.pendingCount}`, strong: true });
  }
  if (input.readOnlyReason) {
    stateChips.push({ id: 'read-only', label: '只读', strong: true });
  }
  if (input.session.status !== 'active') {
    stateChips.push({
      id: 'status',
      label: sessionStatusLabel(input.session.status),
      strong: true,
    });
  }
  if (input.queuePaused) {
    stateChips.push({ id: 'queue-paused', label: '队列暂停', strong: true });
  }

  const filesEnabled = !!input.session.workingDir;
  return {
    actionCopy: overviewActionCopy({
      pendingCount: input.pendingCount,
      queuePaused: input.queuePaused,
      readOnlyReason: input.readOnlyReason,
      remoteUnavailableReason: input.remoteUnavailableReason,
      sessionStatus: input.session.status,
    }),
    actions: buildActionStripActions(input, filesEnabled),
    attentionLabel: input.pendingCount > 0
      ? `待处理 ${input.pendingCount}`
      : input.readOnlyReason
        ? '只读'
        : input.session.status === 'archived'
          ? '已归档'
          : input.queuePaused
            ? '队列暂停'
            : null,
    filesEnabled,
    runtimeSubtitle,
    stateChips,
    title: sessionWorkspaceTitle(input.session),
  };
}

function buildActionStripActions(
  input: SessionActionStripInput,
  filesEnabled: boolean,
): SessionActionStripAction[] {
  const queueDisabledReason = queueActionDisabledReason(input);
  const searchDisabledReason = input.messageCount > 0 ? null : '当前没有可搜索的消息。';
  // 判据只是 `!!session.workingDir`(见 filesEnabled) —— 不绑项目的任务是最常见的
  // 命中场景, 但旧数据/异常行同样会缺 workingDir, 所以文案只陈述状态、不断言原因。
  const filesDisabledReason = filesEnabled ? null : '这个任务没有远程工作目录，不能浏览文件。';
  return [
    {
      accessibilityLabel: '打开任务设置',
      active: false,
      attention: !!input.readOnlyReason,
      disabled: false,
      disabledReason: null,
      id: 'settings',
      label: '设置',
      testID: 'session.controlsToggle',
    },
    {
      accessibilityLabel: '查看任务用量',
      active: false,
      attention: false,
      disabled: false,
      disabledReason: null,
      id: 'usage',
      label: '用量',
      testID: 'session.usageButton',
    },
    {
      accessibilityLabel: '浏览远程文件',
      active: false,
      attention: false,
      disabled: !!filesDisabledReason,
      disabledReason: filesDisabledReason,
      id: 'files',
      label: '文件',
      testID: 'session.filesButton',
    },
    {
      accessibilityLabel: '打开队列面板',
      active: input.queueOpen === true,
      attention: input.queueCount > 0 || input.queuePaused,
      disabled: !!queueDisabledReason,
      disabledReason: queueDisabledReason,
      id: 'queue',
      label: queueActionLabel(input),
      testID: 'session.queueButton',
    },
    {
      accessibilityLabel: input.searchOpen ? '关闭消息搜索' : '搜索消息',
      active: input.searchOpen === true,
      attention: false,
      disabled: !!searchDisabledReason,
      disabledReason: searchDisabledReason,
      id: 'search',
      label: '搜索',
      testID: 'session.searchToggleButton',
    },
  ];
}

function queueActionLabel(input: Pick<SessionActionStripInput, 'queueCount' | 'queuePaused'>): string {
  if (input.queuePaused) return '队列暂停';
  return '队列';
}

function queueActionDisabledReason(input: SessionActionStripInput): string | null {
  const queueAvailable = input.queueAvailable ?? input.queueCount > 0;
  if (queueAvailable) return null;
  if (input.remoteUnavailableReason) return '被控电脑暂不可用，重新同步后再查看队列。';
  if (input.pendingCount > 0) return '先处理待处理请求，处理后队列面板会恢复。';
  if (input.queuePaused) return '队列已暂停，但当前没有可继续的队列消息。';
  if (input.queueCount <= 0) return '当前没有队列消息。';
  return '当前状态暂不能打开队列面板。';
}

function overviewActionCopy(input: {
  pendingCount: number;
  queuePaused: boolean;
  readOnlyReason?: string | null;
  remoteUnavailableReason?: string | null;
  sessionStatus: SessionActionStripSessionLike['status'];
}): string | null {
  if (input.remoteUnavailableReason) return input.remoteUnavailableReason;
  if (input.pendingCount > 0) return '先处理待处理请求，处理后输入区会恢复。';
  if (input.readOnlyReason) return input.readOnlyReason;
  if (input.sessionStatus === 'archived') return '任务已归档，恢复后才能继续发送。';
  if (input.sessionStatus === 'deleted') return '任务已删除，不能继续操作。';
  if (input.queuePaused) return '队列已暂停，可在队列面板继续执行。';
  return null;
}

function agentLabel(agentKind: SessionActionStripSessionLike['agentKind']): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : 'Claude Code';
}

function sessionStatusLabel(status: SessionActionStripSessionLike['status']): string {
  if (status === 'archived') return '已归档';
  if (status === 'deleted') return '已删除';
  return '活跃';
}
