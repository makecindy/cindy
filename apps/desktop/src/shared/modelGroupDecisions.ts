/**
 * 模型组「最近的选择」：新任务把路线解析成具体模型后留下的一条记录，设置页总览按时间倒序列出。
 * 只记组、选中的模型与来源、原因和当时的额度；不记消息、任务标题、账号或凭证。
 */
import type {
  ModelGroupAgentKind,
  ModelGroupTraceQuota,
  ModelGroupTraceWhy,
} from './modelGroups.js';

export const MODEL_GROUP_DECISIONS_IPC = 'model-groups:decisions' as const;

/** 本机每个账号最多保留这么多条，超出丢最早的。 */
export const MODEL_GROUP_DECISIONS_MAX = 50;

export interface ModelGroupDecision {
  at: number;
  /** 只有路线；旧版的模式条目读取时丢弃。 */
  groupType: 'route';
  groupId: string;
  groupName: string;
  /** unavailable = 里面没有能用的模型，沿用了原来的模型。 */
  outcome: 'routed' | 'unavailable';
  agentKind?: ModelGroupAgentKind;
  providerId?: string;
  model?: string;
  /** 选中的来源在另一台电脑或是分享来的：它的运行位置。本机省略。 */
  agentDeviceId?: string;
  modelName?: string;
  sourceName?: string;
  effort?: string;
  why?: ModelGroupTraceWhy;
  quota?: ModelGroupTraceQuota | null;
  /** 全都用完时选了最早恢复的那个：它的恢复时刻。 */
  limitedUntilMs?: number | null;
}
