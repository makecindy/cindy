/**
 * interactionCardModel 跨实现一致性单测。
 *
 * 语义层收敛后, ask / plan / permission 三类交互卡由两个渲染侧共用同一份模型:
 *   - IM 侧: im/shared/cardBuilders(+ cardActionHandler 的按压->决策映射)
 *   - hook 侧: hook-control/interactions.composeInteractionCard
 * 本文件用同一组 InteractionRequest 夹具驱动两侧, 断言**选项集与决策对象**语义
 * 对齐(渲染差异 —— 按钮文案来源、标题格式、省略号样式 —— 允许不同)。
 */

import { describe, expect, it } from 'vitest';

import { SESSION_PERMISSION_DESTINATION, type InteractionRequest } from '@cindy/maker-core';

import { composeInteractionCard } from '../../../hook-control/interactions';
import { ui } from '../../feishu/uiText';
import { createCardBuilders } from '../cardBuilders';
import {
  buildAskAnswerDecision,
  buildPermissionAllowAlwaysDecision,
  buildPermissionAllowOnceDecision,
  buildPermissionDenyDecision,
  buildPlanApproveDecision,
  buildPlanDenyDecision,
  composeInteractionModel,
  BTN_LABEL_MAX,
  MAX_OPTIONS,
  MAX_PLAN_LEN,
  PERMISSION_USER_DENIED_REASON,
  PLAN_USER_REJECTED_REASON,
} from '../interactionCardModel';
import { cancelPending, registerPending } from '../pendingInteractions';

const cards = createCardBuilders(ui, () => 'high');

/** IM 侧按压 -> 决策: 与 cardActionHandler.decisionFromPress 同一张表。 */
function imDecisionFromButton(
  buttonId: string,
  payload: Record<string, unknown>,
  toolName?: string,
) {
  switch (buttonId) {
    case 'permission:allow:once':
      return buildPermissionAllowOnceDecision();
    case 'permission:allow:always':
      return toolName
        ? buildPermissionAllowAlwaysDecision(toolName)
        : buildPermissionAllowOnceDecision();
    case 'permission:deny':
      return buildPermissionDenyDecision(PERMISSION_USER_DENIED_REASON);
    case 'plan:approve':
      return buildPlanApproveDecision();
    case 'plan:reject':
      return buildPlanDenyDecision(PLAN_USER_REJECTED_REASON);
    case 'ask:pick':
    case 'ask:noop':
      return buildAskAnswerDecision(
        String(payload.questionText ?? payload.questionHeader ?? 'q'),
        String(payload.optionLabel ?? ''),
      );
    default:
      return null;
  }
}

type AskRequest = Extract<InteractionRequest, { kind: 'ask_user_question' }>;
type PlanRequest = Extract<InteractionRequest, { kind: 'plan_review' }>;
type PermissionRequest = Extract<InteractionRequest, { kind: 'permission' }>;

const LONG_LABEL = '一个非常长的选项标签'.repeat(6);

const ASK_MULTI: AskRequest = {
  kind: 'ask_user_question',
  requestId: 'req-ask-multi',
  questions: [
    {
      question: '这次用哪个方案实现?',
      header: '方案选择',
      // v1: multiSelect 降级单选
      multiSelect: true,
      options: [
        ...Array.from({ length: 8 }, (_, i) => ({ label: `方案 ${i}` })),
        { label: LONG_LABEL },
      ],
    },
    { question: '第二问在 v1 不渲染', options: [{ label: '不该出现' }] },
  ],
};

const ASK_NO_OPTIONS: AskRequest = {
  kind: 'ask_user_question',
  requestId: 'req-ask-free',
  questions: [{ question: '接下来做什么?' }],
};

const ASK_LONG_LABEL: AskRequest = {
  kind: 'ask_user_question',
  requestId: 'req-ask-long',
  // header 与 question 相同 -> question 不进正文
  questions: [{ question: '选一个', header: '选一个', options: [{ label: LONG_LABEL }] }],
};

const PLAN_LONG: PlanRequest = {
  kind: 'plan_review',
  requestId: 'req-plan',
  plan: '第一步做这个, 第二步做那个。'.repeat(300),
};

const PERMISSION_RICH: PermissionRequest = {
  kind: 'permission',
  requestId: 'req-perm',
  toolName: 'Bash',
  input: { command: `echo ${'x'.repeat(3000)}` },
  displayName: '运行命令',
  description: '在工作目录执行 shell 命令',
};

describe('composeInteractionModel — v1 规则', () => {
  it('ask: 只取第一问, 至多 MAX_OPTIONS 个选项, multiSelect 降级单选', () => {
    const model = composeInteractionModel(ASK_MULTI)!;
    expect(model.kind).toBe('ask_user_question');
    if (model.kind !== 'ask_user_question') throw new Error('unreachable');
    expect(model.question.question).toBe('这次用哪个方案实现?');
    expect(model.choices).toHaveLength(MAX_OPTIONS);
    expect(model.degraded).toBe(false);
    // 选项 label 是原文(截断长度是渲染参数, 不在语义层做)
    expect(model.choices.map((c) => c.label)).toEqual([
      '方案 0',
      '方案 1',
      '方案 2',
      '方案 3',
      '方案 4',
      '方案 5',
    ]);
    // header !== question -> question 进正文
    expect(model.headerText).toBe('方案选择');
    expect(model.questionBody).toBe('这次用哪个方案实现?');
  });

  it('ask: header 与 question 相同则正文为空; 无选项降级为单个「继续」(空答案)', () => {
    const same = composeInteractionModel(ASK_LONG_LABEL)!;
    if (same.kind !== 'ask_user_question') throw new Error('unreachable');
    expect(same.questionBody).toBe('');

    const free = composeInteractionModel(ASK_NO_OPTIONS)!;
    if (free.kind !== 'ask_user_question') throw new Error('unreachable');
    expect(free.degraded).toBe(true);
    expect(free.choices).toHaveLength(1);
    expect(free.choices[0].answerText).toBe('');
    expect(free.choices[0].decision).toEqual({
      kind: 'ask_user_question',
      answers: { '接下来做什么?': '' },
    });
  });

  it('无问题项 / 未知 kind 不出卡', () => {
    expect(
      composeInteractionModel({ kind: 'ask_user_question', requestId: 'x', questions: [] }),
    ).toBeNull();
    expect(
      composeInteractionModel({ kind: 'unknown' } as unknown as InteractionRequest),
    ).toBeNull();
  });

  it('permission 的会话级 addRules destination 与 maker-core 常量同值(防漂移)', () => {
    const decision = buildPermissionAllowAlwaysDecision('Bash');
    expect(decision).toEqual({
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: SESSION_PERMISSION_DESTINATION,
        },
      ],
    });
  });
});

describe('跨实现一致性 — IM cardBuilders vs hook composeInteractionCard', () => {
  it('ask(多问 / 多选 / 超长 label): 两侧选项集与决策逐项对齐', () => {
    const model = composeInteractionModel(ASK_MULTI)!;
    if (model.kind !== 'ask_user_question') throw new Error('unreachable');
    const hook = composeInteractionCard(ASK_MULTI)!;
    const im = cards.buildAskUserCard(ASK_MULTI)!;

    // 选项个数一致, 第二问一律不渲染
    expect(hook.card.buttons).toHaveLength(MAX_OPTIONS);
    expect(im.buttons).toHaveLength(MAX_OPTIONS);
    expect(JSON.stringify(hook.card)).not.toContain('不该出现');
    expect(JSON.stringify(im)).not.toContain('不该出现');

    // 决策逐项对齐: hook 查表 vs IM 从按钮 payload 还原
    const hookDecisions = hook.card.buttons.map((b) => hook.decisions.get(b.id));
    const imDecisions = im.buttons.map((b) =>
      imDecisionFromButton(b.id, b.payload as Record<string, unknown>),
    );
    expect(hookDecisions).toEqual(model.choices.map((c) => c.decision));
    expect(imDecisions).toEqual(hookDecisions);

    // 超长 label 两侧截断长度一致(省略号样式不同, 属渲染差异)
    const longOnly = composeInteractionCard(ASK_LONG_LABEL)!;
    const imLongOnly = cards.buildAskUserCard(ASK_LONG_LABEL)!;
    expect(longOnly.card.buttons[0].label.slice(0, BTN_LABEL_MAX)).toBe(
      LONG_LABEL.slice(0, BTN_LABEL_MAX),
    );
    expect(imLongOnly.buttons[0].label.slice(0, BTN_LABEL_MAX)).toBe(
      LONG_LABEL.slice(0, BTN_LABEL_MAX),
    );
    // 截断只影响按钮文案, answers 里的答案仍是原文
    expect(longOnly.decisions.get('ask:0')).toEqual({
      kind: 'ask_user_question',
      answers: { 选一个: LONG_LABEL },
    });
    expect(
      imDecisionFromButton(
        imLongOnly.buttons[0].id,
        imLongOnly.buttons[0].payload as Record<string, unknown>,
      ),
    ).toEqual(longOnly.decisions.get('ask:0'));
  });

  it('ask(无选项): 两侧都降级为单个「继续」且答案为空串', () => {
    const hook = composeInteractionCard(ASK_NO_OPTIONS)!;
    const im = cards.buildAskUserCard(ASK_NO_OPTIONS)!;
    expect(hook.card.buttons.map((b) => b.label)).toEqual(['继续']);
    expect(im.buttons.map((b) => b.label)).toEqual(['继续']);
    const expected = { kind: 'ask_user_question', answers: { '接下来做什么?': '' } };
    expect(hook.decisions.get('ask:continue')).toEqual(expected);
    expect(
      imDecisionFromButton(im.buttons[0].id, im.buttons[0].payload as Record<string, unknown>),
    ).toEqual(expected);
  });

  it('plan(超长正文): 两侧同截断上限、同决策(approve / reject 都带 dismissed)', () => {
    const hook = composeInteractionCard(PLAN_LONG)!;
    const im = cards.buildPlanReviewCard(PLAN_LONG);
    // 同一截断上限, 截断后的正文正体一致(省略号样式两侧不同)
    expect(hook.card.body.slice(0, MAX_PLAN_LEN)).toBe(im.body!.slice(0, MAX_PLAN_LEN));
    expect(hook.card.body.slice(0, MAX_PLAN_LEN)).toBe(PLAN_LONG.plan.slice(0, MAX_PLAN_LEN));

    const imDecisions = im.buttons.map((b) =>
      imDecisionFromButton(b.id, b.payload as Record<string, unknown>),
    );
    const hookDecisions = hook.card.buttons.map((b) => hook.decisions.get(b.id));
    expect(hookDecisions).toEqual([
      { kind: 'plan_review', behavior: 'allow' },
      { kind: 'plan_review', behavior: 'deny', reason: 'user_rejected', dismissed: true },
    ]);
    expect(imDecisions).toEqual(hookDecisions);
  });

  it('permission(带 description 与大 input): 两侧三选项同序同决策', () => {
    const hook = composeInteractionCard(PERMISSION_RICH)!;
    const im = cards.buildPermissionCard(PERMISSION_RICH);
    expect(hook.card.buttons.map((b) => b.style)).toEqual(['primary', 'default', 'danger']);
    expect(im.buttons.map((b) => b.type)).toEqual(['primary', 'default', 'danger']);

    // IM 的「总是允许」toolName 取自 pendingInteractions 存的原请求
    const imDecisions = im.buttons.map((b) =>
      imDecisionFromButton(b.id, b.payload as Record<string, unknown>, 'Bash'),
    );
    const hookDecisions = hook.card.buttons.map((b) => hook.decisions.get(b.id));
    expect(hookDecisions).toEqual([
      { kind: 'permission', behavior: 'allow' },
      {
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'allow',
            destination: SESSION_PERMISSION_DESTINATION,
          },
        ],
      },
      { kind: 'permission', behavior: 'deny', reason: 'user_denied' },
    ]);
    expect(imDecisions).toEqual(hookDecisions);

    // 两侧都渲染 toolName 与入参摘要, 但上限不同(600 单行 vs 800 pretty) —— 渲染差异
    expect(hook.card.body).toContain('Bash');
    expect(hook.card.body.length).toBeLessThan(800);
    expect(im.body).toContain('command');
    expect(im.body!.length).toBeLessThan(1000);
  });

  it('安全默认: IM cancelPending 与 hook defaultDecision 同形(只有 reason 由渠道给)', async () => {
    const reason = 'turn_closed';
    for (const req of [ASK_NO_OPTIONS, PLAN_LONG, PERMISSION_RICH]) {
      const model = composeInteractionModel(req)!;
      const p = registerPending(req.requestId, model.kind, 'msg-1');
      // 取消成功时交还卡片地址(调用方据此收口卡片), 取消不到才是 null。
      expect(cancelPending(req.requestId, reason)).toEqual({ messageId: 'msg-1' });
      await expect(p).resolves.toEqual(model.buildDefaultDecision(reason));
    }
    // hook 侧同一模型 + 自己的超时 reason
    const hookPerm = composeInteractionCard(PERMISSION_RICH)!;
    expect(hookPerm.defaultDecision).toEqual(
      composeInteractionModel(PERMISSION_RICH).buildDefaultDecision('hook_interaction_timeout'),
    );
    const hookPlan = composeInteractionCard(PLAN_LONG)!;
    expect(hookPlan.defaultDecision).toEqual(
      composeInteractionModel(PLAN_LONG).buildDefaultDecision('hook_interaction_timeout'),
    );
    const hookAsk = composeInteractionCard(ASK_NO_OPTIONS)!;
    expect(hookAsk.defaultDecision).toEqual({ kind: 'ask_user_question', answers: {} });
  });

  it('授权卡收口(buildResolvedPermissionCard): 保留原始正文, 去按钮, 追加决策结果', () => {
    const im = cards.buildPermissionCard(PERMISSION_RICH);
    const resolved = cards.buildResolvedPermissionCard(
      { title: im.title ?? '', body: im.body ?? '' },
      '✅ 已允许（仅本次）',
    );
    // 原始正文(工具名 + 参数预览)完整保留
    expect(resolved.body).toContain(im.body!);
    expect(resolved.title).toBe(im.title);
    // 决策结果追加在末尾
    expect(resolved.body!.endsWith('✅ 已允许（仅本次）')).toBe(true);
    // 按钮清空 — 已决策的卡不能再点
    expect(resolved.buttons).toEqual([]);
  });
});
