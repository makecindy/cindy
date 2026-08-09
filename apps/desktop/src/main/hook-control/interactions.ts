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
 * 卡片合成语义(ask 只渲染第一道问题、至多 6 个选项、multiSelect 降级单选、
 * plan 正文截断 1500、按钮->决策对象)已收进 im/shared/interactionCardModel ——
 * 与 IM 渠道同一份语义(同一产品能力的两个渠道不该有体验分叉), 本文件只做
 * hook 协议卡的渲染与挂起注册表。
 *
 * 超时与收口: hook 是无人值守链路, 任何交互都必须有界 —— 注册时挂 30min
 * 超时, 按 kind 的安全默认自决并通知调用方发 interaction.cancel 改写卡片;
 * turn 结束时未决交互同样按默认收口(cancelForRequest)。
 *
 * (原文写这 30min 是"短于 session-runner 的 60min 整 turn 硬超时"。**那条硬超时
 * 2026-08-01 已撤**, 见 session-runner 的「turn 时长策略」——所以它现在不是抢在别人
 * 前面, 而是**这条链路上唯一的有界兜底**: maker-core 的 turn stall 看门狗刻意把
 * "等用户回应交互"排除在静默之外, 不会来救。个人 IM 那侧没有等价定时器, 见
 * docs/product-rules/telegram-bot-parity.md 缺口 2g。)
 *
 * 纯逻辑模块: 不做 IO, 帧的发送由调用方(session-runner + dispatcher)注入的
 * 回调承担, 单测直接驱动(规则 14)。
 */

import type { InteractionButton, InteractionRequestPayload } from '@cindy/slack-hook-protocol';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import {
  composeInteractionModel,
  truncateInline as truncate,
  BTN_LABEL_MAX,
  HOOK_PERMISSION_INPUT_SUMMARY_MAX,
  MAX_PLAN_LEN,
} from '../im/shared/interactionCardModel.js';

/** 卡片标题截断(hook 协议卡标题一行放得下的量)。 */
const TITLE_MAX = 60;
/** 超时 / 收口自决时写进决策的 reason(系统代码, 非用户反馈)。 */
const TIMEOUT_REASON = 'hook_interaction_timeout';

/** 工具入参 -> 单行 JSON 摘要(不可序列化时降级为空串, 卡片少一行而已)。 */
function summarizeInput(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json || json === '{}') return '';
    return truncate(json, HOOK_PERMISSION_INPUT_SUMMARY_MAX);
  } catch {
    return '';
  }
}

/** 未决交互超时: 到点按安全默认收口并撤卡。理由与边界见模块头「超时与收口」。 */
export const HOOK_INTERACTION_TIMEOUT_MS = 30 * 60_000;

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
 * 权限请求渲染成「允许一次 / 本任务总是允许 / 拒绝」三按钮卡, 超时安全默认
 * **拒绝**(用户显式选了收紧档, 放行才是意外)。
 */
export function composeInteractionCard(req: InteractionRequest): ComposedInteractionCard | null {
  const model = composeInteractionModel(req);
  // ask 没有问题项 / 未来未知 kind: 不出卡
  if (!model) return null;

  if (model.kind === 'ask_user_question') {
    // buttonId 是过网线的兼容契约, 由本端从语义 choice 映射:
    // 无选项降级 -> ask:continue(空答案), 有选项 -> ask:<序号>。
    const decisions = new Map<string, InteractionDecision>();
    const buttons: InteractionButton[] = model.choices.map((choice) => {
      const id = model.degraded ? 'ask:continue' : `ask:${choice.index}`;
      decisions.set(id, choice.decision);
      return { id, label: truncate(choice.label ?? '', BTN_LABEL_MAX), style: choice.style };
    });
    return {
      card: {
        kind: 'ask_user_question',
        title: `❓ ${truncate(model.headerText, TITLE_MAX)}`,
        body: model.questionBody,
        buttons,
      },
      decisions,
      defaultDecision: model.buildDefaultDecision(TIMEOUT_REASON),
      fallbackReason: '等待回答超时, 任务已按“未回答”继续',
    };
  }

  if (model.kind === 'plan_review') {
    const [approve, reject] = model.choices;
    return {
      card: {
        kind: 'plan_review',
        title: '📋 计划待审阅',
        body: truncate(model.plan, MAX_PLAN_LEN),
        buttons: [
          { id: 'plan:approve', label: '批准执行', style: approve.style },
          { id: 'plan:reject', label: '打回', style: reject.style },
        ],
      },
      decisions: new Map<string, InteractionDecision>([
        ['plan:approve', approve.decision],
        ['plan:reject', reject.decision],
      ]),
      // 超时按安全默认 deny;恒带 dismissed(系统性 dismissal, 别让 codex 把超时
      // reason 当用户反馈发起修订 turn) —— 见 interactionCardModel。
      defaultDecision: model.buildDefaultDecision(TIMEOUT_REASON),
      fallbackReason: '等待审阅超时, 计划未获批准',
    };
  }

  const [allowOnce, allowAlways, deny] = model.choices;
  const inputSummary = summarizeInput(model.input);
  const body = [
    model.description,
    `工具: \`${model.toolName}\``,
    inputSummary ? `\`\`\`${inputSummary}\`\`\`` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
  return {
    card: {
      kind: 'permission',
      title: `🔐 权限请求: ${truncate(model.displayTitle, TITLE_MAX)}`,
      body,
      buttons: [
        { id: 'perm:allow', label: '允许一次', style: allowOnce.style },
        { id: 'perm:always', label: '本任务总是允许', style: allowAlways.style },
        { id: 'perm:deny', label: '拒绝', style: deny.style },
      ],
    },
    decisions: new Map<string, InteractionDecision>([
      ['perm:allow', allowOnce.decision],
      ['perm:always', allowAlways.decision],
      ['perm:deny', deny.decision],
    ]),
    defaultDecision: model.buildDefaultDecision(TIMEOUT_REASON),
    fallbackReason: '等待授权超时, 已拒绝该权限请求',
  };
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
