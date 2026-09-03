/**
 * Learn 功能的跨进程共享类型 —— main / preload / renderer 单一来源。
 *
 * Learn 是系统级能力:把任意来源(自由文本描述、hub skill、本地会话用法证据)
 * 蒸馏成一个本地 skill 提案,经 diff 审查确认后才落盘到 ~/.agents/skills/。
 * 引擎实现在 apps/desktop/src/main/learn-host/。
 */

import type { ToolLoopErrorDetails } from '@cindy/maker-shared/tool-loop-error';

/** 触发来源:聊天 /learn 自由文本 | skill hub 详情页按钮 | 会话内(预留)。 */
export type LearnSourceKind = 'freetext' | 'hub' | 'session';

/**
 * run 状态机(单向推进):
 *   collecting(证据打包) → distilling(蒸馏 session 运行中) → awaiting-review
 *   → applied | discarded;任一阶段可 → failed | cancelled;
 *   awaiting-review 超龄由 sweep 标 expired。
 */
export type LearnRunStatus =
  | 'collecting'
  | 'distilling'
  | 'awaiting-review'
  | 'applied'
  | 'discarded'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** 终态集合(不再变化、staging 已清理或待 sweep)。 */
export const LEARN_TERMINAL_STATUSES: readonly LearnRunStatus[] = [
  'applied',
  'discarded',
  'failed',
  'cancelled',
  'expired',
];

/**
 * 蒸馏产物的溯源记录 —— 落 skillhub registry manifest(StoredInstall.provenance)。
 * personal=true 的 skill 含本地会话衍生内容。当前**不拦截**发布 —— 该字段是
 * 将来「发布前泛化」流程(产品定的方向,另行独立 PR)的判定依据。
 */
export interface LearnProvenance {
  method: 'learn';
  sourceKind: LearnSourceKind;
  /** hub slug / url / 源 session id(按 sourceKind 语义)。 */
  sourceRef?: string;
  /** 证据检索是否实际命中并注入了本地会话内容。 */
  usedSessionEvidence: boolean;
  /** usedSessionEvidence=true ⇒ true,不可配置。当前不拦截发布;供将来
   *  发布前泛化流程判定用。 */
  personal: boolean;
  /** unix seconds,与 StoredInstall.installedAt 惯例一致。 */
  learnedAt: number;
  runId: string;
}

/** renderer 可见的 run 视图(不含 stagingDir 等 main 内部字段)。 */
export interface LearnRunPublic {
  runId: string;
  status: LearnRunStatus;
  sourceKind: LearnSourceKind;
  /** 发起 run 的 data owner id(local-v1 或云账号 id)。 */
  dataOwnerId?: string;
  /** @deprecated 旧版云账号 run 的归属字段;读取时仅作兼容回退。 */
  ownerUserId?: string;
  /** 用户输入的原始请求文本(hub 源为空串或补充说明)。 */
  input: string;
  /** sourceKind='hub' 时的市场 slug。 */
  hubSlug?: string;
  /** Hub 目录上下文；旧 run 缺失时默认公开目录。 */
  hubCatalogScope?: 'market' | 'team';
  /** 蒸馏 session id(distilling 起有值,renderer 可跳转查看过程)。 */
  sessionId?: string;
  /** 触发 /learn 的会话 id(用于把状态卡插回原会话)。 */
  originSessionId?: string;
  /** 提案的 skill 名(awaiting-review 起有值,取自 frontmatter name)。 */
  skillName?: string;
  /** 提案里 skill 目录下的文件相对路径列表(awaiting-review 起有值)。 */
  proposalFiles?: string[];
  /** 最后一次扫描通过的提案内容指纹(apply 时对冻结副本重算比对,保证
   *  "装进系统的 == 用户最后审查过的";awaiting-review 起有值)。 */
  proposalFingerprint?: string;
  /** 最近一次 getProposalDiff 审查时看到的提案指纹;提案重扫后清空。 */
  reviewedProposalFingerprint?: string;
  /** 最近一次 getProposalDiff 审查时看到的目标目录指纹;null 表示当时无目标。 */
  reviewTargetFingerprint?: string | null;
  usedSessionEvidence: boolean;
  /** failed 时的错误说明(已脱敏,不含 prompt 原文)。 */
  error?: string;
  /** failed 时的稳定错误原因,供 renderer 选择本地化文案。 */
  errorReason?: string;
  /** failed 时的工具循环结构化详情;旧版 run 可能没有该字段。 */
  toolLoop?: ToolLoopErrorDetails;
  /** 蒸馏 session 的最终 assistant 文本(空产出 failed 时展示给用户)。 */
  assistantText?: string;
  /** 产物扫描发现的疑似敏感内容类别(不阻断,审查 UI 高亮提示)。 */
  redactionWarnings?: string[];
  /** unix ms。 */
  createdAt: number;
  updatedAt: number;
}

/** learn:start 请求。 */
export interface LearnStartRequest {
  input: string;
  sourceKind: LearnSourceKind;
  hubSlug?: string;
  hubCatalogScope?: 'market' | 'team';
  originSessionId?: string;
}

/** learn:event push payload。 */
export interface LearnEventPayload {
  type: 'state-changed';
  run: LearnRunPublic;
}

/**
 * 单文件变更 —— 字段与 main/skillhub/snapshot.ts 的 FileChange 逐字段对齐
 * (renderer 的 SkillhubDiffPanel 同样按此形状消费)。shared 不 import main,
 * 故在此重申形状;snapshot.ts 侧有编译期 satisfies 断言保证两者不漂移。
 */
export interface LearnFileChange {
  /** POSIX 相对路径 */
  path: string;
  kind: 'added' | 'removed' | 'modified';
  isBinary: boolean;
  oldContent: string;
  newContent: string;
  oldSize: number;
  newSize: number;
}

/** learn:get-proposal-diff 返回。 */
export interface LearnProposalDiff {
  /** 本地是否已存在同名已装 skill(true = 蒸馏提案将覆盖它)。 */
  targetExists: boolean;
  /** 已存在时目标的绝对路径(审查 UI 明示覆盖对象)。 */
  targetPath?: string;
  changes: LearnFileChange[];
}
