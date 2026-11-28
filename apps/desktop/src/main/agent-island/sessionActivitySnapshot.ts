import { projectSessionActivity } from '@cindy/maker-shared/session-activity';
import type { AgentIslandSessionActivity, AgentIslandSessionSnapshot } from '../../shared/agentIsland.js';
import { completedReplySummary } from './state.js';

function safeSessionActionSummary(snapshot: AgentIslandSessionSnapshot): string {
  if (snapshot.phase === 'needs-interaction') {
    if (snapshot.interactionKind === 'permission') return '等待权限确认';
    if (snapshot.interactionKind === 'ask_user_question') return '等待用户回答';
    if (snapshot.interactionKind === 'plan_review') return '等待计划确认';
    if (snapshot.interactionKind === 'plugin_setup') return '等待插件配置';
    if (snapshot.interactionKind === 'input_handoff') return '等待代输入';
    return '等待用户确认';
  }
  if (snapshot.phase === 'completed') return '运行已正常结束';
  if (snapshot.phase === 'error') return '运行出错';
  const latestKind = snapshot.activityLines.at(-1)?.kind;
  if (latestKind === 'tool') return '正在运行工具';
  if (latestKind === 'assistant') return '正在生成回复';
  if (latestKind === 'user') return '正在处理新消息';
  return '正在运行';
}

export function toSessionActivity(s: AgentIslandSessionSnapshot): AgentIslandSessionActivity {
  return {
    ...(s.completionToken ? { completionToken: s.completionToken } : {}),
    ...(s.completionNotification ? { completionNotification: s.completionNotification } : {}),
    ...projectSessionActivity({
      sessionId: s.sessionId,
      recordStatus: 'active',
      title: s.title,
      source: 'live',
      livePhase: s.phase,
      startedAtMs: s.startedAt,
      lastActivityAtMs: s.lastActivityAt,
      currentActionSummary: safeSessionActionSummary(s),
      interactionKind: s.interactionKind,
      attention: s.attention,
    }),
    phase: s.phase,
    interactionKind: s.interactionKind,
    // 完成后这份摘要只给其它设备的完成卡片用(本机岛面直接读展示快照)。
    compactDetail: s.phase === 'completed' ? completedReplySummary(s) : s.compactDetail,
    summaryFormat: 'plain-text',
    workingPhase: s.workingPhase,
  };
}
