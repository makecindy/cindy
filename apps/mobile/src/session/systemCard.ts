import type { MobileSlashCommand } from '@/device-link/mobileMakerTransport';
import type { InputProjection, RemoteSession } from '@/session/types';
import {
  DEFAULT_LOCAL_SYSTEM_COMMANDS,
  buildSystemCardData,
  formatSystemCard,
  mergeLocalSlashCommands,
  parseLocalSystemCommand,
  type SystemCardPresentation,
  type SystemCardType,
} from '@cindy/maker-shared/system-card';
import { i18n } from '@/i18n';

/**
 * 手机端系统卡类型 = 共享 slash 命令卡 + goal 持久记录卡 + silent-stop 自动续跑卡。
 * goal 两种不来自 slash 命令(桌面 goal-host 落库 agentMeta.goalCompletion /
 * goalNotice,读侧派生),shared 的 formatSystemCard 不认识它们,由本模块特判
 * 格式化。历史上手机端不认这两种卡,/goal 达成与用量恢复记录被渲染成空白
 * assistant 气泡(2026-07 排查发现)。auto-resume 同为读侧派生(user 行
 * agentMeta.autoResume,桌面 silent-stop 守卫落库),历史上被手机渲染成一条
 * 用户没发过的「继续」气泡(2026-07 排查发现)。
 */
export type MobileSystemCardType =
  | SystemCardType
  | 'goal-complete'
  | 'goal-resumed'
  | 'auto-resume'
  | 'learn'
  // session-agent-switch 边界卡(desktop 落库 role='agent_switch',读侧派生)。
  | 'agent-switch';
export type MobileSystemCardPresentation = SystemCardPresentation;

/** goal 达成记录文案(对齐桌面 GoalCompleteCard 的 goal.complete.record)。 */
function formatGoalCompleteCard(data: Record<string, unknown> | undefined): SystemCardPresentation {
  const turns = typeof data?.turnsUsed === 'number' ? data.turnsUsed : 0;
  const elapsedMs = typeof data?.elapsedMs === 'number' ? data.elapsedMs : 0;
  const reason = typeof data?.reason === 'string' ? data.reason : '';
  return {
    title: i18n.t('message.systemCard.goalComplete', { turns, duration: formatGoalDuration(elapsedMs) }),
    ...(reason ? { body: reason } : {}),
    rows: [],
  };
}

function formatGoalDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export const MOBILE_LOCAL_SYSTEM_COMMANDS = DEFAULT_LOCAL_SYSTEM_COMMANDS as MobileSlashCommand[];

export function parseMobileLocalSystemCommand(text: string): MobileSystemCardType | null {
  return parseLocalSystemCommand(text, MOBILE_LOCAL_SYSTEM_COMMANDS);
}

/**
 * 出卡前需要「会话在被控端已存在」的本地命令。
 *
 * /context 要向被控端取上下文用量(maker.getContextUsage);/help /cost /pwd /status
 * 都只是本地 projection 与会话行的视图,合成行上照样出得来,不该挡——挡了反而破坏
 * 新建会话「一切正常」的观感。
 */
export const MOBILE_REMOTE_BACKED_LOCAL_COMMANDS: ReadonlySet<MobileSystemCardType> = new Set(['context']);

/**
 * 这次发送要执行的命令是否需要远端会话已经存在。
 *
 * desktop 命令一律算:手机端白名单(MOBILE_SUPPORTED_DESKTOP_COMMANDS)只有 /learn,
 * 而它就是打被控端蒸馏管线的。会话还没建成时这类命令必须挡住而不是执行 —— 也不能
 * 排队,outbox 的派发动作是「enqueue 一条消息」,命令原样入队 agent 只会当普通文本
 * 忽略(review P1)。
 */
export function commandNeedsRemoteSession(
  localCommand: MobileSystemCardType | null,
  desktopCommand: { name: string } | null,
): boolean {
  if (desktopCommand) return true;
  return localCommand !== null && MOBILE_REMOTE_BACKED_LOCAL_COMMANDS.has(localCommand);
}

export function mergeMobileLocalSlashCommands(
  remoteCommands: readonly MobileSlashCommand[],
): MobileSlashCommand[] {
  return mergeLocalSlashCommands(remoteCommands, MOBILE_LOCAL_SYSTEM_COMMANDS) as MobileSlashCommand[];
}

export function buildMobileSystemCardData(
  type: MobileSystemCardType,
  options: {
    contextUsage?: unknown;
    contextError?: string;
    projection?: InputProjection;
    remoteCommands?: readonly MobileSlashCommand[];
    session: RemoteSession | null;
  },
): Record<string, unknown> {
  // goal / auto-resume / agent-switch 卡的数据由桌面落库行派生,learn 卡的数据由
  // 发送侧 buildLearnCardData 直接组装,都不走本地 slash 命令的数据组装。
  if (type === 'goal-complete' || type === 'goal-resumed' || type === 'auto-resume' || type === 'learn' || type === 'agent-switch') return {};
  return buildSystemCardData(type, {
    ...options,
    localCommands: MOBILE_LOCAL_SYSTEM_COMMANDS,
    remoteCommands: options.remoteCommands,
  });
}

export function formatMobileSystemCard(
  type: MobileSystemCardType,
  data: Record<string, unknown> | undefined,
): MobileSystemCardPresentation {
  if (type === 'goal-complete') return formatGoalCompleteCard(data);
  if (type === 'goal-resumed') {
    // 两种续跑原因共用这张卡, 但说法必须分开(与桌面 GoalResumedCard 同口径):
    // 上游过载那条只是干等了 60s、**没有**任何容量探测, 说「用量已恢复」是假信息;
    // 账号限流那条的重置时刻来自账号额度信息, 有依据(review #844 codex P1)。
    const isCapacity = data?.kind === 'capacity-resumed';
    return {
      title: i18n.t(
        isCapacity ? 'message.systemCard.goalCapacityRetry' : 'message.systemCard.goalResumed',
      ),
      rows: [],
    };
  }
  if (type === 'auto-resume') return { title: i18n.t('message.systemCard.autoResume'), rows: [] };
  if (type === 'agent-switch') return formatAgentSwitchCard(data);
  if (type === 'learn') return formatLearnCard(data);
  return formatSystemCard(type, data);
}

/**
 * session-agent-switch 边界卡的纯数据兜底(标题 + 目标模型行)。
 * 注意:实际渲染已改由 MessageRenderer 的 MobileAgentSwitchCard 直接读 data
 * 走「分隔线 + 药丸 + 可展开交接」1:1 对齐桌面 AgentSwitchCard,不再经过本函数;
 * 这里仅保留为 formatMobileSystemCard 在该 union 分支上的类型完备兜底。
 */
function formatAgentSwitchCard(data: Record<string, unknown> | undefined): SystemCardPresentation {
  const engineLabel = (kind: unknown): string => (kind === 'codex' ? 'Codex' : 'Claude Code');
  const from = engineLabel(data?.fromAgentKind);
  const to = engineLabel(data?.toAgentKind);
  const toModel = typeof data?.toModel === 'string' ? data.toModel : '';
  const rows = toModel ? [{ label: i18n.t('message.systemCard.modelLabel'), value: toModel }] : [];
  // Phase 2:resumed = 目标引擎续接了自己的停泊原生会话(增量交接)。
  if (data?.resumed === true) rows.push({ label: i18n.t('message.systemCard.sessionLabel'), value: i18n.t('message.systemCard.sessionResumed') });
  return {
    title: i18n.t('message.systemCard.agentSwitch', { from, to }),
    rows,
  };
}

/**
 * /learn 启动反馈卡(移动端本地卡,数据来自 desktopSlashCommands.buildLearnCardData)。
 * 蒸馏与评审全在被控端 learn-host:移动端暂无评审 UI,成功态明确引导回桌面端。
 */
function formatLearnCard(data: Record<string, unknown> | undefined): SystemCardPresentation {
  const runId = typeof data?.runId === 'string' ? data.runId : '';
  if (runId) {
    return {
      title: i18n.t('message.systemCard.learnStarted'),
      rows: [{ label: 'run', value: runId.slice(0, 8) }],
      body: i18n.t('message.systemCard.learnStartedBody'),
    };
  }
  const error = typeof data?.error === 'string' ? data.error : 'learn-failed';
  return {
    title: i18n.t('message.systemCard.learnFailed'),
    rows: [],
    body: error === 'learn-busy'
      ? i18n.t('message.systemCard.learnBusyBody')
      : i18n.t('message.systemCard.learnFailedBody', { detail: typeof data?.detail === 'string' && data.detail ? data.detail : i18n.t('message.systemCard.unknownError') }),
  };
}
