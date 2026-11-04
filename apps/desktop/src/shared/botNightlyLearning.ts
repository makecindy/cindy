/**
 * 伙伴「夜间学习」主进程与渲染层共用的数据形状（规则见 docs/product-rules/bot-routines.md「内置夜间学习」）。
 * 状态正本是伙伴 Home 下的 nightly-learning.json，渲染层只读这里的投影。
 */

export type NightlyLearningFrequency = 'daily' | 'weekly';

export type NightlyLearningOutcome = 'learned' | 'nothing' | 'skipped' | 'failed';

/** 一条可撤销的改动。target 是记忆文件名或技能 slug。 */
export interface NightlyLearningItem {
  id: string;
  kind: 'memory' | 'skill';
  action: 'created' | 'updated' | 'deleted' | 'disabled';
  target: string;
  title: string;
  /** 被并入的那一条（合并时的来源），只用于展示。 */
  mergedInto?: string;
  reason: string;
  undone?: boolean;
}

export interface NightlyLearningRun {
  id: string;
  at: number;
  /** 手动「现在整理」或「现在记成技能」，不是到点运行。 */
  manual?: boolean;
  outcome: NightlyLearningOutcome;
  /** 这次读了多少轮对话。 */
  turns: number;
  items: NightlyLearningItem[];
  /** 失败原因的稳定代码，渲染层按代码出文案，不显示原始报错。 */
  errorCode?: 'MODEL_UNAVAILABLE' | 'INVALID_RESULT' | 'INTERNAL';
}

/** 只出现过一次的做法：先观察，不加载；再遇到同类事才转正为技能。 */
export interface NightlyLearningCandidate {
  id: string;
  title: string;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface NightlyLearningView {
  /** 这台电脑上没有这条内置规则（不是主力电脑、伙伴暂停）时为 null。 */
  enabled: boolean | null;
  frequency: NightlyLearningFrequency;
  pendingTurns: number;
  running: boolean;
  memoryEnabled: boolean;
  lastRun: NightlyLearningRun | null;
  runs: NightlyLearningRun[];
  candidates: NightlyLearningCandidate[];
}
