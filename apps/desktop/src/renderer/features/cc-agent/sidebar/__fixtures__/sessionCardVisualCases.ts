import type { Session } from '@/lib/ccAgent.types';

export interface SessionCardVisualCase {
  id: string;
  label: string;
  session: Session;
  isActive?: boolean;
  isRunning?: boolean;
  isAttached?: boolean;
  hasAttentionNotification?: boolean;
  isSelected?: boolean;
  boundSchedule?: 'active' | 'paused';
}

const now = '2026-06-29T06:00:00.000Z';

function makeSession(overrides: Partial<Session> & Pick<Session, 'id' | 'title'>): Session {
  const { id, title, ...rest } = overrides;
  return {
    id,
    userId: 'visual-user',
    title,
    workingDir: '/Users/dave/Documents/xdt-maker',
    workspaceKind: 'project',
    model: 'claude-opus-4-8',
    effort: 'medium',
    permissionMode: 'default',
    providerId: null,
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 200000,
    fastMode: false,
    clearedAt: null,
    pinnedAt: now,
    userSendAt: now,
    status: 'active',
    agentKind: 'cc',
    source: 'desktop',
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    worktreePath: null,
    usedProjectContext: false,
    extraDirs: [],
    remoteHostId: null,
    createdAt: now,
    updatedAt: now,
    _count: { messages: 12 },
    preview: null,
    summary: null,
    ...rest,
  };
}

export const sessionCardVisualCases: SessionCardVisualCase[] = [
  {
    id: 'short-idle-cc',
    label: '短标题 / Claude / 普通预览',
    session: makeSession({
      id: 'short-idle-cc',
      title: '部门QBR制作',
      preview: '李雷, on it',
      agentKind: 'cc',
      updatedAt: '2026-06-29T05:59:00.000Z',
    }),
  },
  {
    id: 'two-line-title-codex',
    label: '短标题 / Codex / 短正文',
    session: makeSession({
      id: 'two-line-title-codex',
      title: '部门Token用量分析',
      preview: '长尾用量分析。',
      agentKind: 'codex',
      updatedAt: '2026-06-23T06:00:00.000Z',
    }),
  },
  {
    id: 'very-long-title',
    label: '超长标题 / 普通正文 / 单行截断',
    session: makeSession({
      id: 'very-long-title',
      title: '这是一个很长很长的标题用于验证置顶卡片两行截断和第二行左侧对齐关系',
      preview: '正文保持普通预览长度,用于观察标题区域和正文区域之间的节奏。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T05:40:00.000Z',
    }),
  },
  {
    id: 'summary-long-body',
    label: '中等标题 / summary 两行预算',
    session: makeSession({
      id: 'summary-long-body',
      title: '玩家反馈精华回复整理',
      summary: '汇总玩家对本周活动、付费礼包、社交体验和长线留存的核心反馈,提炼老板汇报可用的重点结论和行动项。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T04:30:00.000Z',
    }),
  },
  {
    id: 'running-loading',
    label: '运行中 / loading 条 / 呼吸 icon',
    isRunning: true,
    session: makeSession({
      id: 'running-loading',
      title: '实时运营周报生成',
      preview: '正在分析本周项目数据与异常波动。',
      agentKind: 'codex',
      updatedAt: '2026-06-29T05:58:00.000Z',
    }),
  },
  {
    id: 'attention-dot',
    label: '需关注 / 红点 / 等待处理',
    hasAttentionNotification: true,
    session: makeSession({
      id: 'attention-dot',
      title: '审批信息补充',
      preview: '需要你确认下一步操作。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T05:10:00.000Z',
    }),
  },
  {
    id: 'automation-timer',
    label: '自动化生成 / Timer / 单行正文',
    session: makeSession({
      id: 'automation-timer',
      title: '自动化日报巡检',
      source: 'scheduler',
      preview: '自动运行结果摘要,正文只保留一行。',
      agentKind: 'codex',
      updatedAt: '2026-06-29T03:00:00.000Z',
    }),
  },
  {
    id: 'schedule-bound-active',
    label: '绑定 schedule / Timer + 绑定态',
    boundSchedule: 'active',
    session: makeSession({
      id: 'schedule-bound-active',
      title: '每小时核心指标监控',
      source: 'scheduler',
      preview: '绑定任务沿用同一个 Timer，并额外承载绑定状态。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T02:30:00.000Z',
    }),
  },
  {
    id: 'schedule-bound-paused',
    label: '暂停 schedule / Pause mini badge',
    boundSchedule: 'paused',
    session: makeSession({
      id: 'schedule-bound-paused',
      title: '暂停中的自动巡检任务',
      source: 'scheduler',
      preview: '暂停状态需要保持弱化的绑定徽章。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T01:30:00.000Z',
    }),
  },
  {
    id: 'remote-device-link',
    label: 'Device Link / 远程图标',
    session: makeSession({
      id: 'remote-device-link',
      title: '远程设备日志排查与复盘',
      preview: '验证标题右侧 device-link 图标不挤压标题行高。',
      agentKind: 'codex',
      deviceLinkDeviceId: 'device-1',
      deviceLinkDeviceName: 'Mac Studio',
      updatedAt: '2026-06-28T06:00:00.000Z',
    }),
  },
  {
    id: 'remote-ssh',
    label: 'SSH remote / Globe 图标',
    session: makeSession({
      id: 'remote-ssh',
      title: 'SSH 远端构建问题分析',
      preview: '验证 ssh 图标和标题尾部之间的贴合程度。',
      agentKind: 'codex',
      remoteHostId: 'ssh-prod-a',
      updatedAt: '2026-06-27T06:00:00.000Z',
    }),
  },
  {
    id: 'attached-control',
    label: '接管中 / RadioTower',
    isAttached: true,
    isRunning: true,
    session: makeSession({
      id: 'attached-control',
      title: '远程接管中的任务观察',
      preview: 'attached 优先显示 RadioTower,运行时同样呼吸。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T05:20:00.000Z',
    }),
  },
  {
    id: 'archived',
    label: '归档 / Archive icon',
    session: makeSession({
      id: 'archived',
      title: '已归档的历史分析任务',
      preview: '归档状态使用 Archive 图标,验证弱化视觉。',
      status: 'archived',
      agentKind: 'cc',
      updatedAt: '2026-06-20T06:00:00.000Z',
    }),
  },
  {
    id: 'selected-active',
    label: '当前选中 / active 背景',
    isActive: true,
    session: makeSession({
      id: 'selected-active',
      title: '当前正在查看的置顶会话',
      preview: '验证 active 背景下标题、图标、时间的对比度。',
      agentKind: 'cc',
      updatedAt: '2026-06-29T05:55:00.000Z',
    }),
  },
];
