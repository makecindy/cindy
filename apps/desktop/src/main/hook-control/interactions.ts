/**
 * hook-control/interactions.ts
 * ---------------------------------------------------------------------------
 * hook 链路的「执行中交互」桌面侧核心: 把 maker-core 的 InteractionRequest
 * 合成渠道无关的按钮卡(interaction.request payload), 并维护
 * interactionId -> 挂起决策 的注册表。
 *
 * 设计原则(与协议注释对齐): **决策语义全部留在本端** —— 卡片按钮只带语义
 * 中立的 buttonId 过网线, 每个按钮对应的 InteractionDecision 在注册时存进
 * 本地映射; server 按钮回传 buttonId, 这里查表 resolve。好处:
 *   - server 是哑渲染器, 新增交互 kind 不需要 server 升级;
 *   - answers 的 question 全文匹配等易碎约定(见 im/shared/cardActionHandler
 *     的 qKey 注释)不过网线, 单端维护。
 *
 * 卡片合成语义对齐 im/shared/cardBuilders 的 v1 简化(同一产品能力的两个
 * 渠道不该有体验分叉): ask 只渲染第一道问题、至多 6 个选项、multiSelect
 * 降级单选; plan 正文截断 1500。
 *
 * 超时与收口: hook 是无人值守链路, 任何交互都必须有界 —— 注册时挂 30min
 * 超时(短于 session-runner 的 60min 整 turn 硬超时, 保证超时后 turn 还能
 * 正常收口), 超时按 kind 的安全默认自决并通知调用方发 interaction.cancel
 * 改写卡片; turn 结束时未决交互同样按默认收口(cancelForRequest)。
 *
 * 纯逻辑模块: 不做 IO, 帧的发送由调用方(session-runner + dispatcher)注入的
 * 回调承担, 单测直接驱动(规则 14)。
 */

import type { InteractionButton, InteractionRequestPayload } from '@cindy/slack-hook-protocol';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

/** ask 卡渲染的最大选项数(与 im/shared/cardBuilders MAX_OPTIONS 一致)。 */
const MAX_OPTIONS = 6;
/** plan 正文截断长度(与 im/shared/cardBuilders MAX_PLAN_LEN 一致)。 */
const MAX_PLAN_LEN = 1500;
/** 按钮文案截断(Slack plain_text 上限 75, 对齐 IM 的 30)。 */
const BTN_LABEL_MAX = 30;
/** permission 卡的工具入参摘要截断(JSON 全文可能巨大, 卡片只要能看清意图)。 */
const PERM_INPUT_SUMMARY_MAX = 600;

/** 工具入参 -> 单行 JSON 摘要(不可序列化时降级为空串, 卡片少一行而已)。 */
function summarizeInput(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === '{}') return '';
    return truncate(json, PERM_INPUT_SUMMARY_MAX);
  } catch {
    return '';
  }
}

/** 未决交互超时(必须短于 session-runner 的整 turn 硬超时 60min)。 */
export const HOOK_INTERACTION_TIMEOUT_MS = 30 * 60_000;

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 合成结果: 过网线的卡片 + 留在本端的按钮->决策映射与安全默认。 */
export interface ComposedInteractionCard {
  card: Pick<InteractionRequestPayload, 'kind' | 'title' | 'body' | 'buttons'>;
  /** buttonId -> 按下即生效的决策。 */
  decisions: Map<string, InteractionDecision>;
  /** 超时 / turn 收口时的安全默认决策。 */
  defaultDecision: InteractionDecision;
  /** 默认自决时改写卡片的人话文案(interaction.cancel.reason)。 */
  fallbackReason: string;
}

/**
 * InteractionRequest -> 卡片 + 决策映射。
 * 返回 null 表示该 kind 不出卡(未来未知 kind), 由调用方按 kind 安全默认
 * 就地自决。permission 自 Slack 按目录权限偏好上线起出卡: 非 bypass 会话的
 * 权限请求渲染成「允许一次 / 本对话总是允许 / 拒绝」三按钮卡, 超时安全默认
 * **拒绝**(用户显式选了收紧档, 放行才是意外)。
 */
export function composeInteractionCard(req: InteractionRequest): ComposedInteractionCard | null {
  if (req.kind === 'ask_user_question') {
    const question = req.questions[0];
    if (!question) return null;
    const headerText = question.header || question.question;
    const options = (question.options ?? []).slice(0, MAX_OPTIONS);
    const bodyExtra =
      question.header && question.header !== question.question ? question.question : '';

    const decisions = new Map<string, InteractionDecision>();
    const buttons: InteractionButton[] = [];
    if (options.length === 0) {
      // 自由问答无选项: 无人值守链路给不了自由文本, 只能"继续"(空答案) ——
      // 与 IM 渠道的 noOptions 降级一致
      buttons.push({ id: 'ask:continue', label: '继续', style: 'default' });
      decisions.set('ask:continue', {
        kind: 'ask_user_question',
        // answers key 必须是 question.question 全文(SDK 按全文匹配, 见
        // im/shared/cardActionHandler.decisionFromPress 的 qKey 注释)
        answers: { [question.question]: '' },
      });
    } else {
      options.forEach((opt, i) => {
        const id = `ask:${i}`;
        buttons.push({ id, label: truncate(opt.label, BTN_LABEL_MAX), style: 'default' });
        decisions.set(id, {
          kind: 'ask_user_question',
          answers: { [question.question]: opt.label },
        });
      });
    }
    return {
      card: {
        kind: req.kind,
        title: `❓ ${truncate(headerText, 60)}`,
        body: bodyExtra,
        buttons,
      },
      decisions,
      defaultDecision: { kind: 'ask_user_question', answers: {} },
      fallbackReason: '等待回答超时, 任务已按“未回答”继续',
    };
  }

  if (req.kind === 'plan_review') {
    const decisions = new Map<string, InteractionDecision>([
      ['plan:approve', { kind: 'plan_review', behavior: 'allow' }],
      [
        'plan:reject',
        { kind: 'plan_review', behavior: 'deny', reason: 'user_rejected', dismissed: true },
      ],
    ]);
    return {
      card: {
        kind: req.kind,
        title: '📋 计划待审阅',
        body: truncate(req.plan, MAX_PLAN_LEN),
        buttons: [
          { id: 'plan:approve', label: '批准执行', style: 'primary' },
          { id: 'plan:reject', label: '打回', style: 'danger' },
        ],
      },
      decisions,
      defaultDecision: {
        kind: 'plan_review',
        behavior: 'deny',
        reason: 'hook_interaction_timeout',
        // 系统性 dismissal: 别让 codex 把超时 reason 当用户反馈发起修订 turn
        dismissed: true,
      },
      fallbackReason: '等待审阅超时, 计划未获批准',
    };
  }

  if (req.kind === 'permission') {
    const decisions = new Map<string, InteractionDecision>([
      ['perm:allow', { kind: 'permission', behavior: 'allow' }],
      [
        'perm:always',
        {
          kind: 'permission',
          behavior: 'allow',
          // 会话级 addRules: claude-code 直接消费; codex 把非空 permissionUpdates
          // 视为会话级放行(见 maker-core events.ts 的 permissionUpdates 注释)
          permissionUpdates: [
            { type: 'addRules', rules: [{ toolName: req.toolName }], behavior: 'allow', destination: 'session' },
          ],
        },
      ],
      ['perm:deny', { kind: 'permission', behavior: 'deny', reason: 'user_denied' }],
    ]);
    const inputSummary = summarizeInput(req.input);
    const body = [
      req.description ?? '',
      `工具: \`${req.toolName}\``,
      inputSummary ? `\`\`\`${inputSummary}\`\`\`` : '',
    ]
      .filter((s) => s.length > 0)
      .join('\n');
    return {
      card: {
        kind: req.kind,
        title: `🔐 权限请求: ${truncate(req.displayName ?? req.title ?? req.toolName, 60)}`,
        body,
        buttons: [
          { id: 'perm:allow', label: '允许一次', style: 'primary' },
          { id: 'perm:always', label: '本对话总是允许', style: 'default' },
          { id: 'perm:deny', label: '拒绝', style: 'danger' },
        ],
      },
      decisions,
      defaultDecision: { kind: 'permission', behavior: 'deny', reason: 'hook_interaction_timeout' },
      fallbackReason: '等待授权超时, 已拒绝该权限请求',
    };
  }

  // 未来未知 kind: 不出卡, 调用方按 kind 安全默认就地自决
  return null;
}

/** 挂起交互条目。 */
interface PendingHookInteraction {
  decisions: Map<string, InteractionDecision>;
  defaultDecision: InteractionDecision;
  fallbackReason: string;
  resolve: (d: InteractionDecision) => void;
  timer: NodeJS.Timeout;
  /** 默认自决时通知调用方发 interaction.cancel(改写 server 侧卡片)。 */
  onFallback: (reason: string) => void;
}

/** interactionId -> 挂起条目(模块级单例: 决策帧按 interactionId 全局配对)。 */
const pending = new Map<string, PendingHookInteraction>();

/**
 * 登记一个挂起交互, 返回决策 Promise(按钮回流 / 超时默认 / 收口清扫三者
 * 之一 resolve, 永不 reject —— 交互失败不该炸 turn)。调用方(session-runner)
 * 自行记录本轮登记过的 interactionId, turn 收口时逐个 cancelHookInteraction。
 */
export function registerHookInteraction(opts: {
  interactionId: string;
  composed: ComposedInteractionCard;
  onFallback: (reason: string) => void;
  timeoutMs?: number;
}): Promise<InteractionDecision> {
  const { interactionId, composed, onFallback } = opts;
  return new Promise<InteractionDecision>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(interactionId);
      if (!entry) return;
      pending.delete(interactionId);
      entry.onFallback(entry.fallbackReason);
      entry.resolve(entry.defaultDecision);
    }, opts.timeoutMs ?? HOOK_INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    pending.set(interactionId, {
      decisions: composed.decisions,
      defaultDecision: composed.defaultDecision,
      fallbackReason: composed.fallbackReason,
      resolve,
      timer,
      onFallback,
    });
  });
}

/**
 * 按钮决策回流(interaction.decision)。true = 配对成功已 resolve;
 * false = 未知 interactionId(已超时/已收口/重复按压)或未知 buttonId, 忽略。
 */
export function resolveHookInteraction(interactionId: string, buttonId: string): boolean {
  const entry = pending.get(interactionId);
  if (!entry) return false;
  const decision = entry.decisions.get(buttonId);
  if (!decision) return false; // 未知按钮(伪造/陈旧卡片), 保持挂起等真实决策
  pending.delete(interactionId);
  clearTimeout(entry.timer);
  entry.resolve(decision);
  return true;
}

/**
 * 单个交互按安全默认收口(turn 结束清扫用)。幂等: 已 resolve 的返回 false。
 * reason 覆盖注册时的 fallbackReason(收口场景的文案与超时不同)。
 */
export function cancelHookInteraction(interactionId: string, reason: string): boolean {
  const entry = pending.get(interactionId);
  if (!entry) return false;
  pending.delete(interactionId);
  clearTimeout(entry.timer);
  entry.onFallback(reason);
  entry.resolve(entry.defaultDecision);
  return true;
}
