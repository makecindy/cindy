/**
 * main/im/shared/interactionCardModel.ts
 * ---------------------------------------------------------------------------
 * ask_user_question / plan_review / permission 三类交互卡的**语义层**单一出处。
 *
 * 背景: 同一产品能力此前有两份人肉对齐的实现 —— 个人 IM 侧
 * (im/shared/cardBuilders + cardActionHandler) 与 hook 侧
 * (hook-control/interactions)。两边的 v1 简化规则(只渲染第一问、至多 6 个选项、
 * multiSelect 降级单选、plan 正文截断)与决策对象形状必须一致, 靠注释互相引用维持
 * 太脆。这里把「选项集 + 决策对象 + header/body 拆分」收进一处, 两侧只做渲染:
 *   - IM 侧渲染 @cindy/im InteractiveCardSpec(按钮 payload 是历史兼容契约);
 *   - hook 侧渲染 slack-hook-protocol 的按钮卡 + buttonId -> 决策映射。
 *
 * **渠道差异不在这里统一**(统一是产品决策, 不归本模块): 按钮文案(IM 走 ui 文案包 /
 * hook 走本端硬编码)、卡片标题格式、截断省略号样式、permission 入参摘要上限
 * (hook 600 单行 / IM 800 pretty)都是渲染参数, 由各自渲染侧持有, 本模块只提供
 * 截断工具与常量。
 */

// 只做 type-only 依赖: 本模块被 hook-control/interactions 复用, 那条链路刻意
// 不在运行期加载 maker-core barrel(session-runner 单测按最小面 mock 该包)。
import type {
  AskUserQuestionItem,
  InteractionDecision,
  InteractionRequest,
} from '@cindy/maker-core';

// ── 语义常量 ────────────────────────────────────────────────────────────────

/** ask 卡渲染的最大选项数(v1: 单选, 超出部分丢弃)。 */
export const MAX_OPTIONS = 6;
/** plan 正文截断长度。 */
export const MAX_PLAN_LEN = 1500;
/** 按钮文案截断(Slack plain_text 上限 75, 对齐 IM 的 30)。 */
export const BTN_LABEL_MAX = 30;
/**
 * permission 卡的工具入参摘要截断 —— 两侧**刻意不同**, 属渲染差异:
 * hook 卡是单行 JSON 摘要(卡片只要能看清意图), IM 卡是 pretty JSON 代码块。
 */
export const HOOK_PERMISSION_INPUT_SUMMARY_MAX = 600;
export const IM_PERMISSION_INPUT_PREVIEW_MAX = 800;
/** 无选项降级时唯一按钮的文案(两侧一致)。 */
export const ASK_CONTINUE_LABEL = '继续';

// ── 截断工具 ────────────────────────────────────────────────────────────────

/** IM 卡片截断: 折行后追加「…(已截断)」(卡片正文有排版空间)。 */
export function truncateBlock(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n\n…(已截断)` : s;
}

/** hook 卡片截断: 单行省略号(标题 / 单行摘要用)。 */
export function truncateInline(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── 决策构造(唯一出处) ──────────────────────────────────────────────────────

/**
 * ask 的一条答案。
 *
 * answers 的 key 必须是 question.question 全文 — SDK 用全文匹配
 * (cc-code QuestionView.tsx:167: questionText = question.question)。
 * questionHeader 只是卡片标题 chip, 用它做 key 会让模型在 answers 里找不到
 * 自己的问题, 误判"用户没选答案"。(出处: im/shared/cardActionHandler
 * decisionFromPress 的 qKey 注释 + hook-control/interactions。)
 */
export function buildAskAnswerDecision(
  questionText: string,
  answerText: string,
): InteractionDecision {
  return { kind: 'ask_user_question', answers: { [questionText]: answerText } };
}

/** ask 的安全默认: 空 answers(超时 / turn 收口 = "未回答"继续)。 */
export function buildAskNoAnswerDecision(): InteractionDecision {
  return { kind: 'ask_user_question', answers: {} };
}

/** permission: 只允许这一次。 */
export function buildPermissionAllowOnceDecision(): InteractionDecision {
  return { kind: 'permission', behavior: 'allow' };
}

/**
 * permission: 「本任务总是允许」。
 *
 * 会话级 addRules: claude-code 直接消费(同 toolName 的后续调用跳过 canUseTool
 * 回调); codex 把非空 permissionUpdates 视为会话级放行(见 maker-core events.ts
 * 的 permissionUpdates 注释)。
 *
 * 注: 按钮文案用「任务」(产品术语, 与应用内 permissions.alwaysAllowForSession
 * 一致), 但 addRules 的作用域是技术意义上的 agent session, 两者刻意不同名。
 *
 * destination 与 maker-core 的 SESSION_PERMISSION_DESTINATION /
 * createSessionPermissionUpdate 同值, 这里就地写死只为不给 hook 链路引入
 * maker-core 运行期依赖; 漂移由本模块单测钉住(见 __tests__)。
 */
export function buildPermissionAllowAlwaysDecision(toolName: string): InteractionDecision {
  return {
    kind: 'permission',
    behavior: 'allow',
    permissionUpdates: [
      { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' },
    ],
  };
}

/** permission 拒绝(reason 是渠道语义: 用户点拒绝 / 超时 / turn 收口)。 */
export function buildPermissionDenyDecision(reason: string): InteractionDecision {
  return { kind: 'permission', behavior: 'deny', reason };
}

/** plan: 批准执行。 */
export function buildPlanApproveDecision(): InteractionDecision {
  return { kind: 'plan_review', behavior: 'allow' };
}

/**
 * plan: 打回 / 未获批准。恒带 dismissed —— 系统性 dismissal, 别让 codex 把
 * reason 当用户反馈发起修订 turn。
 */
export function buildPlanDenyDecision(reason: string): InteractionDecision {
  return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
}

/** 用户点「打回」的 reason(两侧一致)。 */
export const PLAN_USER_REJECTED_REASON = 'user_rejected';
/** 用户点「拒绝」的 reason(两侧一致)。 */
export const PERMISSION_USER_DENIED_REASON = 'user_denied';

// ── 语义模型 ────────────────────────────────────────────────────────────────

export type InteractionChoiceStyle = 'primary' | 'default' | 'danger';

/** 一个可按下的选项(渠道各自映射到自己的历史 buttonId, choiceId 不过网线)。 */
export interface InteractionChoice {
  /** 稳定语义 id。 */
  choiceId: string;
  /** 选项序号(hook 侧按 index 生成 buttonId)。 */
  index: number;
  /**
   * 按钮文案来自请求数据时为原文、未截断(ask 选项);来自渠道文案包时为 null
   * (permission / plan 的按钮文案是渲染侧资产)。
   */
  label: string | null;
  /** ask 专用: 写进 answers 的答案文本(无选项降级时为空串)。 */
  answerText?: string;
  style: InteractionChoiceStyle;
  /** 按下即生效的决策。 */
  decision: InteractionDecision;
}

interface BaseInteractionModel {
  choices: InteractionChoice[];
  /** 超时 / turn 收口时的安全默认决策(reason 由渠道给, 文案语义不同)。 */
  buildDefaultDecision(reason: string): InteractionDecision;
}

export interface AskInteractionModel extends BaseInteractionModel {
  kind: 'ask_user_question';
  /** v1: 只取第一问。 */
  question: AskUserQuestionItem;
  /** 卡片标题文本: header 优先, 缺省用问题全文。 */
  headerText: string;
  /** header 与 question 不同才把 question 放正文, 否则空串。 */
  questionBody: string;
  /** true = 自由问答无选项, 降级为唯一的「继续」(空答案)。 */
  degraded: boolean;
}

export interface PlanInteractionModel extends BaseInteractionModel {
  kind: 'plan_review';
  /** 正文原文(截断在渲染侧 —— 省略号样式两侧不同)。 */
  plan: string;
}

export interface PermissionInteractionModel extends BaseInteractionModel {
  kind: 'permission';
  toolName: string;
  /** hook 卡标题用的展示名: displayName > title > toolName。 */
  displayTitle: string;
  description: string;
  input: Record<string, unknown>;
}

export type InteractionModel =
  AskInteractionModel | PlanInteractionModel | PermissionInteractionModel;

/**
 * InteractionRequest -> 语义模型。返回 null = 不出卡, 调用方按 kind 安全默认
 * 就地自决(ask 没有问题项, 或未来未知 kind)。
 *
 * v1 简化(两侧共用, 同一产品能力的两个渠道不该有体验分叉):
 *   - ask 只渲染第一道问题;
 *   - 至多 MAX_OPTIONS 个选项, multiSelect 降级单选;
 *   - 无选项时降级成单个「继续」(空答案) —— 无人值守链路给不了自由文本。
 */
export function composeInteractionModel(
  req: Extract<InteractionRequest, { kind: 'ask_user_question' }>,
): AskInteractionModel | null;
export function composeInteractionModel(
  req: Extract<InteractionRequest, { kind: 'plan_review' }>,
): PlanInteractionModel;
export function composeInteractionModel(
  req: Extract<InteractionRequest, { kind: 'permission' }>,
): PermissionInteractionModel;
export function composeInteractionModel(req: InteractionRequest): InteractionModel | null;
export function composeInteractionModel(req: InteractionRequest): InteractionModel | null {
  if (req.kind === 'ask_user_question') {
    const question = req.questions[0];
    if (!question) return null;
    const headerText = question.header || question.question;
    const options = (question.options ?? []).slice(0, MAX_OPTIONS);
    const questionBody =
      question.header && question.header !== question.question ? question.question : '';
    const choices: InteractionChoice[] =
      options.length === 0
        ? [
            {
              choiceId: 'ask:continue',
              index: 0,
              label: ASK_CONTINUE_LABEL,
              answerText: '',
              style: 'default',
              decision: buildAskAnswerDecision(question.question, ''),
            },
          ]
        : options.map((opt, index) => ({
            choiceId: `ask:option:${index}`,
            index,
            label: opt.label,
            answerText: opt.label,
            style: 'default' as const,
            decision: buildAskAnswerDecision(question.question, opt.label),
          }));
    return {
      kind: 'ask_user_question',
      question,
      headerText,
      questionBody,
      degraded: options.length === 0,
      choices,
      buildDefaultDecision: () => buildAskNoAnswerDecision(),
    };
  }

  if (req.kind === 'plan_review') {
    return {
      kind: 'plan_review',
      plan: req.plan,
      choices: [
        {
          choiceId: 'plan:approve',
          index: 0,
          label: null,
          style: 'primary',
          decision: buildPlanApproveDecision(),
        },
        {
          choiceId: 'plan:reject',
          index: 1,
          label: null,
          style: 'danger',
          decision: buildPlanDenyDecision(PLAN_USER_REJECTED_REASON),
        },
      ],
      buildDefaultDecision: (reason) => buildPlanDenyDecision(reason),
    };
  }

  if (req.kind === 'permission') {
    return {
      kind: 'permission',
      toolName: req.toolName,
      displayTitle: req.displayName ?? req.title ?? req.toolName,
      description: req.description ?? '',
      input: req.input,
      choices: [
        {
          choiceId: 'permission:allow-once',
          index: 0,
          label: null,
          style: 'primary',
          decision: buildPermissionAllowOnceDecision(),
        },
        {
          choiceId: 'permission:allow-always',
          index: 1,
          label: null,
          style: 'default',
          decision: buildPermissionAllowAlwaysDecision(req.toolName),
        },
        {
          choiceId: 'permission:deny',
          index: 2,
          label: null,
          style: 'danger',
          decision: buildPermissionDenyDecision(PERMISSION_USER_DENIED_REASON),
        },
      ],
      buildDefaultDecision: (reason) => buildPermissionDenyDecision(reason),
    };
  }

  // 未来未知 kind: 不出卡, 调用方按 kind 安全默认就地自决
  return null;
}
