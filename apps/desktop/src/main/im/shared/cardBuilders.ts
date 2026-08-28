/**
 * main/im/shared/cardBuilders.ts
 * ---------------------------------------------------------------------------
 * Pure functions: InteractionRequest → @cindy/im InteractiveCardSpec。按钮的
 * payload 带 `requestId` 与 kind 专属数据, cardActionHandler 据此构造
 * InteractionDecision。
 *
 * 渠道差异只有两处, 由工厂注入:
 *   - ui: 文案包(ImUiTextPack)
 *   - getDefaultEffortFor: /model picker 每行的 effort 标签(依赖渠道 config
 *     的 effortOverrides)
 *
 * payload 兼容性注意: botContextId 在 payload 里沿用历史 key 名 `botAppId` —
 * 聊天里已存在的旧卡片按钮还带着这个 key, 改名会让旧卡片按压后 handler 取不到
 * 值。新渠道也统一用该 key(语义 = IdentityKey.botContextId)。
 */

import type {
  AskUserQuestionItem,
  InteractionRequest,
  AgentKind,
  Effort,
  PermissionModeDescriptor,
} from '@cindy/maker-core';
import type { ProviderSection } from '@cindy/model-providers';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import type { InteractiveCardSpec } from '@cindy/im';

import { autoReviewUnavailablePromptLine } from './autoReviewUnavailablePrompt';
import type { ImUiTextPack } from './types';
import {
  composeInteractionModel,
  needsAskMultiCard,
  truncateBlock,
  truncateInline,
  BTN_LABEL_MAX,
  IM_PERMISSION_INPUT_PREVIEW_MAX,
  MAX_OPTIONS,
  MAX_PLAN_LEN,
} from './interactionCardModel';
import type { ControlProject, ControlSession, RecentControlSession } from './controlProjects';

/** IM 卡片文本截断(实现见 interactionCardModel.truncateBlock)。 */
const truncate = truncateBlock;

/** 工具入参 -> pretty JSON 预览(IM 卡片正文有排版空间, 与 hook 侧的单行摘要不同)。 */
function previewInput(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input, null, 2), IM_PERMISSION_INPUT_PREVIEW_MAX);
  } catch {
    return '<unserializable>';
  }
}

export interface ImCardBuilders {
  buildPermissionCard(
    req: Extract<InteractionRequest, { kind: 'permission' }>,
  ): InteractiveCardSpec;
  buildAskUserCard(
    req: Extract<InteractionRequest, { kind: 'ask_user_question' }>,
  ): InteractiveCardSpec | null;
  /**
   * 多题/多选打勾卡(仅提供 ui.cards.ask.multi 的渠道): 按当前勾选态重建整卡。
   * 首发与每次 ask:multi 按键后的原地 patch 共用, 保证两处渲染永不漂移。
   */
  buildAskMultiCard(args: {
    requestId: string;
    questions: AskUserQuestionItem[];
    selections: ReadonlyMap<number, ReadonlySet<number>>;
  }): InteractiveCardSpec;
  buildPlanReviewCard(
    req: Extract<InteractionRequest, { kind: 'plan_review' }>,
  ): InteractiveCardSpec;
  buildModelPickerCard(args: {
    sessionId: string;
    /** 当前 IM session 的 agent;用于按 agent 派生 model 默认 effort。 */
    agentKind: AgentKind;
    /** 按供应商分段的模型列表(与应用内选择器同源,每行 = (供应商, 模型))。 */
    sections: ProviderSection[];
    currentModelId: string;
    /** 当前会话显式选定的供应商 id(高亮当前来源那行)。 */
    currentProviderId: string | null;
    currentEffort: string | null;
    defaultEffortByModel?: Record<string, string>;
  }): InteractiveCardSpec;
  buildPermissionModePickerCard(args: {
    sessionId: string;
    agentKind: AgentKind;
    modes: PermissionModeDescriptor[];
    currentMode: string;
  }): InteractiveCardSpec;
  buildControlPickerCard(args: {
    botAppId: string;
    projects: ControlProject[];
    currentAttachedTitle?: string | null;
    /** thread 模型: 接管锚点卡 messageId — 透传进所有按钮 payload。 */
    anchorMessageId?: string;
  }): InteractiveCardSpec;
  buildControlSessionPickerCard(args: {
    botAppId: string;
    workingDir: string;
    displayName: string;
    sessions: ControlSession[];
    anchorMessageId?: string;
  }): InteractiveCardSpec;
  /**
   * `/project` 项目切换卡(projectSwitching 渠道专用): 列 desktop 项目工作区,
   * 选中把当前 IM 会话行切到该目录(bot 原生会话, 非接管)。
   */
  buildProjectPickerCard(args: {
    botAppId: string;
    projects: ControlProject[];
    /** 当前会话所在目录的显示名(项目名或 ui.cards.project.dialogueName)。 */
    currentName: string;
  }): InteractiveCardSpec;
  /** `/session` 跨工作区最近会话直达卡(选中走 control:session-pick 接管)。 */
  buildRecentSessionPickerCard(args: {
    botAppId: string;
    sessions: RecentControlSession[];
  }): InteractiveCardSpec;
  buildResolvedCard(label: string): InteractiveCardSpec;
  /** 「群会话不能用完全访问」失败时的私聊修复卡(仅提供 permissionModeFix 文案的渠道)。 */
  buildPermissionModeFixCard(args: {
    sessionId: string;
    agentKind: AgentKind;
    sessionTitle: string;
  }): InteractiveCardSpec;
  /** 授权卡收口: 保留原始正文 + 追加决策结果, 去掉按钮。 */
  buildResolvedPermissionCard(
    original: { title: string; body: string },
    label: string,
  ): InteractiveCardSpec;
}

export function createCardBuilders(
  ui: ImUiTextPack,
  getDefaultEffortFor: (modelId: string, agentKind?: AgentKind) => Effort,
): ImCardBuilders {
  /**
   * 多题/多选打勾卡: 逐问渲染问题正文, 每个选项一枚切换按钮(题号锚定到
   * 正文的问题序号, 勾选态用 selectedMark 前缀反馈), 末尾一枚提交按钮一次性
   * 上交全部已答问题。按钮 id/payload 与 cardActionHandler 的 ask:multi /
   * ask:multi-submit 分支对应; 按键后的原地 patch 复用同一函数重建整卡。
   */
  function askMultiCard(args: {
    requestId: string;
    questions: AskUserQuestionItem[];
    selections: ReadonlyMap<number, ReadonlySet<number>>;
  }): InteractiveCardSpec {
    const m = ui.cards.ask.multi!;
    const bodyLines: string[] = [];
    const buttons: InteractiveCardSpec['buttons'] = [];
    // 单独一道多选题沿用单问卡标题观感; 多道题才用「确认几件事」总标题。
    const title =
      args.questions.length === 1
        ? ui.cards.ask.title(args.questions[0].header || args.questions[0].question)
        : m.title;
    args.questions.forEach((question, qi) => {
      const headerText = question.header || question.question;
      const hint = question.multiSelect ? m.multiSelectHint : '';
      bodyLines.push(`**${qi + 1}. ${headerText}**${hint}`);
      if (question.header && question.header !== question.question) {
        bodyLines.push(question.question);
      }
      const options = (question.options ?? []).slice(0, MAX_OPTIONS);
      if (options.length === 0) {
        // 自由文本问题无法在打勾卡里给输入框: 正文已在上面渲染, 不出按钮;
        // 提交时该问按未答省略, agent 会追问。不要写 noOptionsHint —— 那句
        // 「直接发文字」在打勾卡里没有对应输入路径。
        return;
      }
      const selected = args.selections.get(qi);
      options.forEach((opt, oi) => {
        // 勾选前缀也占按钮文案预算; 按钮是单行, 用单行省略号截断
        // (块级截断的换行后缀会掉进按钮文案)。
        // 飞书 v1 单 action 模块最多 5 个按钮, 由 @cindy/im 的
        // buildInteractiveCardV1 按模块拆分, 这里不截断选项。
        const prefix = `${selected?.has(oi) === true ? m.selectedMark : ''}${qi + 1}·`;
        buttons.push({
          id: 'ask:multi',
          label: prefix + truncateInline(opt.label, BTN_LABEL_MAX - prefix.length - 1),
          type: 'default',
          payload: { requestId: args.requestId, q: qi, o: oi },
        });
      });
    });
    buttons.push({
      id: 'ask:multi-submit',
      label: m.submitLabel,
      type: 'primary',
      payload: { requestId: args.requestId },
    });
    return { title, body: bodyLines.join('\n\n'), buttons };
  }

  return {
    // ── permission ──────────────────────────────────────────────────────────

    buildPermissionCard(req) {
      const model = composeInteractionModel(req);
      const params = `${ui.cards.permission.paramsLabel}\n\`\`\`json\n${previewInput(model.input)}\n\`\`\``;
      const unavailable = autoReviewUnavailablePromptLine(req);
      return {
        title: ui.cards.permission.title(model.toolName),
        body: unavailable ? `${unavailable}\n\n${params}` : params,
        buttons: [
          {
            id: 'permission:allow:once',
            label: ui.cards.permission.btnAllowOnce,
            type: 'primary',
            payload: { requestId: req.requestId },
          },
          // Auto 故障降级会标 forcePrompt：Claude 丢 permissionUpdates，
          // Codex 把 acceptForSession 收成单次 allow。展示「总是允许」等于说谎。
          ...(!unavailable ? [{
            id: 'permission:allow:always',
            label: ui.cards.permission.btnAllowAlways,
            type: 'default' as const,
            payload: { requestId: req.requestId },
          }] : []),
          {
            id: 'permission:deny',
            label: ui.cards.permission.btnDeny,
            type: 'danger',
            payload: { requestId: req.requestId },
          },
        ],
      };
    },

    // ── ask_user_question ───────────────────────────────────────────────────
    // v1 简化(只渲染第一问 / 至多 6 个选项 / multiSelect 降级单选)已收进
    // interactionCardModel.composeInteractionModel — 这里只做渲染。
    // 例外: 渠道提供了 ui.cards.ask.multi(卡片可原地更新)且请求命中
    // needsAskMultiCard(多题 / 含多选)时, 改发打勾卡。

    buildAskUserCard(req) {
      const model = composeInteractionModel(req);
      if (!model) return null;
      if (model.kind === 'ask_user_question' && ui.cards.ask.multi && needsAskMultiCard(req)) {
        return askMultiCard({
          requestId: req.requestId,
          questions: req.questions,
          selections: new Map(),
        });
      }

      const { headerText, question } = model;
      const bodyExtra = model.questionBody ? `\n${model.questionBody}` : '';

      if (model.degraded) {
        return {
          title: ui.cards.ask.title(headerText),
          body: bodyExtra
            ? `${bodyExtra}\n\n${ui.cards.ask.noOptionsHint}`
            : ui.cards.ask.noOptionsHint,
          buttons: [
            {
              id: 'ask:noop',
              label: model.choices[0].label ?? '',
              type: 'default',
              payload: {
                requestId: req.requestId,
                // SDK 端 answers 必须用 question.question 全文做 key
                // (cc-code QuestionView.tsx:167: questionText = question.question)。
                // headerText 只作卡片标题, 不参与 answers 匹配。
                questionText: question.question,
                questionHeader: headerText,
                optionLabel: model.choices[0].answerText ?? '',
              },
            },
          ],
        };
      }

      return {
        title: ui.cards.ask.title(headerText),
        body: bodyExtra || ' ',
        buttons: model.choices.map((choice) => ({
          id: 'ask:pick',
          label: truncate(choice.label ?? '', BTN_LABEL_MAX),
          type: 'default' as const,
          payload: {
            requestId: req.requestId,
            questionText: question.question,
            questionHeader: headerText,
            optionLabel: choice.answerText ?? '',
          },
        })),
      };
    },

    buildAskMultiCard: askMultiCard,

    // ── plan_review ─────────────────────────────────────────────────────────

    buildPlanReviewCard(req) {
      const model = composeInteractionModel(req);
      return {
        title: ui.cards.plan.title,
        body: truncate(model.plan, MAX_PLAN_LEN),
        buttons: [
          {
            id: 'plan:approve',
            label: ui.cards.plan.btnApprove,
            type: 'primary',
            payload: { requestId: req.requestId },
          },
          {
            id: 'plan:reject',
            label: ui.cards.plan.btnReject,
            type: 'danger',
            payload: { requestId: req.requestId },
          },
        ],
      };
    },

    // ── model picker (slash /model) ─────────────────────────────────────────

    buildModelPickerCard(args) {
      const { sessionId, agentKind, sections, currentModelId, currentProviderId, currentEffort, defaultEffortByModel } =
        args;
      // 当前选中模型展示名:跨所有分段按 id 找;IM 卡片当前仍保持描述留空。
      const currentLabel =
        sections.flatMap((s) => s.models).find((m) => m.id === currentModelId)?.displayName ??
        currentModelId;

      return {
        title: ui.cards.model.title,
        body:
          ui.cards.model.currentLine(currentLabel, currentEffort, '') +
          `\n\n${ui.cards.model.hint}`,
        // 每个 (供应商, 模型) 各一个按钮,label =「供应商 / 模型名 (effort)」;payload 带 providerId,
        // model:pick 据此 setSessionProvider 锁定路由源。同模型多供应商时各自成行、互不冲突。
        buttons: sections.flatMap((sec) =>
          sec.models.map((m) => {
            const effort = defaultEffortByModel?.[m.id] ?? getDefaultEffortFor(m.id, agentKind);
            const isCurrent = m.id === currentModelId && sec.provider.id === currentProviderId;
            return {
              id: 'model:pick',
              label: ui.cards.model.optionLabel(sec.provider.name, m.displayName, effort),
              type: isCurrent ? ('primary' as const) : ('default' as const),
              payload: {
                // requestId is only for InteractionRequest binding — model:pick
                // doesn't go through pendingInteractions. Use a sentinel so card
                // action parser still recognises it as a valid action.
                requestId: `model-pick:${sessionId}`,
                sessionId,
                modelId: m.id,
                modelLabel: m.displayName,
                providerId: sec.provider.id,
                effort,
              },
            };
          }),
        ),
      };
    },

    // ── permission mode picker (slash /permission) ──────────────────────────

    buildPermissionModePickerCard(args) {
      const { sessionId, agentKind, modes, currentMode } = args;
      const current = modes.find((m) => m.id === currentMode);
      const currentLabel = current?.displayName ?? currentMode;
      const currentDescription = current?.description ?? '';

      return {
        title: ui.cards.permissionMode.title,
        body:
          ui.cards.permissionMode.currentLine(currentLabel, currentDescription) +
          `\n\n${ui.cards.permissionMode.hint}`,
        buttons: modes.map((m) => ({
          id: 'permmode:pick',
          label: ui.cards.permissionMode.optionLabel(m.displayName),
          type: m.id === currentMode ? ('primary' as const) : ('default' as const),
          payload: {
            // Sentinel — permmode:pick doesn't go through pendingInteractions.
            requestId: `permmode-pick:${sessionId}`,
            sessionId,
            agentKind,
            mode: m.id,
            modeLabel: m.displayName,
          },
        })),
      };
    },

    // ── control picker (slash /ctr) ─────────────────────────────────────────
    //
    // 列出 desktop 端的工作区让用户挑一个接管。空列表也要返回卡片 (只有"退出"
    // 按钮), 让用户能看到"没东西可接管"而不是默默无响应。

    buildControlPickerCard(args) {
      const { botAppId, projects, currentAttachedTitle } = args;
      // thread 模型专用: 锚点卡 messageId 随 payload 走完整个选择流程, 终态时
      // cardActionHandler 用它把锚点卡变身"已接管"。feishu 不传 → payload 不变。
      const anchorPayload = args.anchorMessageId
        ? { anchorMessageId: args.anchorMessageId }
        : {};
      const bodyPrefix = currentAttachedTitle
        ? `${ui.cards.control.attachedSwitchHint(currentAttachedTitle)}\n\n`
        : '';
      // botAppId(= botContextId)嵌入每个按钮 payload — cardAction 通道
      // (IMCardActionEvent) 只带 senderId, 不带 contextId, 而 cardActionHandler
      // 需要 (botContextId, userId) 这对 key 才能调 exitControl。走 payload 传
      // 最干净: 不依赖任何全局状态, 也不需要从 senderId 反查 DB。
      const exitBtn = {
        id: 'control:exit',
        label: ui.cards.control.btnExit,
        type: 'danger' as const,
        payload: { requestId: 'control-exit', botAppId, ...anchorPayload },
      };

      if (projects.length === 0) {
        return {
          title: ui.cards.control.title,
          body: bodyPrefix + ui.cards.control.emptyBody,
          buttons: [exitBtn],
        };
      }

      return {
        title: ui.cards.control.title,
        body: bodyPrefix + ui.cards.control.hint,
        buttons: [
          ...projects.map((p) => ({
            id: 'control:pick',
            label: truncate(p.displayName, 30),
            type: 'default' as const,
            payload: {
              // Sentinel — control:pick 不走 pendingInteractions, 只用 requestId
              // 字段保持 cardActionParser 校验通过。
              requestId: `control-pick:${p.workingDir}`,
              botAppId,
              workingDir: p.workingDir,
              displayName: p.displayName,
              ...anchorPayload,
            },
          })),
          exitBtn,
        ],
      };
    },

    /**
     * /ctr 第二步: 工作区下的 session 选择卡片。
     *
     * 入参 displayName/workingDir 用于卡片标题展示和"后退"按钮 payload。"后退"
     * 按钮不带 workingDir, cardActionHandler 收到 control:back 直接重新调
     * listProjectsForControl 重建 project picker 卡片。
     */
    buildControlSessionPickerCard(args) {
      const { botAppId, workingDir, displayName, sessions } = args;
      const anchorPayload = args.anchorMessageId
        ? { anchorMessageId: args.anchorMessageId }
        : {};
      // 控制按钮排序: sessions → New → 后退 → 退出
      // - New 在 sessions 之后、back 之前: 跟 session-pick 同语义 (终态选择),
      //   但是"开新会话"而非接管已有, 所以紧贴 sessions 列表; back 是导航,
      //   退出是终止, 危险按钮放最后减少误触。
      const newBtn = {
        id: 'control:new',
        label: ui.cards.control.btnNew,
        type: 'primary' as const,
        payload: {
          requestId: `control-new:${workingDir}`,
          botAppId,
          workingDir,
          displayName,
          ...anchorPayload,
        },
      };
      const backBtn = {
        id: 'control:back',
        label: ui.cards.control.btnBack,
        type: 'default' as const,
        payload: { requestId: 'control-back', botAppId, ...anchorPayload },
      };
      const exitBtn = {
        id: 'control:exit',
        label: ui.cards.control.btnExit,
        type: 'danger' as const,
        payload: { requestId: 'control-exit', botAppId, ...anchorPayload },
      };

      if (sessions.length === 0) {
        return {
          title: ui.cards.control.sessionPickerTitle(displayName),
          body: ui.cards.control.sessionPickerEmptyBody(displayName),
          buttons: [newBtn, backBtn, exitBtn],
        };
      }

      return {
        title: ui.cards.control.sessionPickerTitle(displayName),
        body: ui.cards.control.sessionPickerHint,
        buttons: [
          ...sessions.map((s) => ({
            id: 'control:session-pick',
            label: truncate(s.title || s.id.slice(-8), 30),
            type: 'default' as const,
            payload: {
              // Sentinel - 与 control:pick 保持同样模式, 不走 pendingInteractions。
              requestId: `control-session-pick:${s.id}`,
              botAppId,
              sessionId: s.id,
              sessionTitle: s.title,
              workingDir,
              displayName,
              ...anchorPayload,
            },
          })),
          newBtn,
          backBtn,
          exitBtn,
        ],
      };
    },

    /**
     * `/session` 跨工作区最近会话直达卡 — 选中即接管(control:session-pick
     * 同一终态路径), 与 /ctr 的分步选择互补。
     */
    buildRecentSessionPickerCard(args) {
      const recentUi = ui.cards.control.recentSessions;
      if (!recentUi) {
        throw new Error('buildRecentSessionPickerCard requires ui.cards.control.recentSessions');
      }
      const { botAppId, sessions } = args;
      const exitBtn = {
        id: 'control:exit',
        label: ui.cards.control.btnExit,
        type: 'danger' as const,
        payload: { requestId: 'control-exit', botAppId },
      };
      if (sessions.length === 0) {
        return { title: recentUi.title, body: recentUi.emptyBody, buttons: [exitBtn] };
      }
      return {
        title: recentUi.title,
        body: recentUi.hint,
        buttons: [
          ...sessions.map((s) => ({
            id: 'control:session-pick',
            label: truncate(
              recentUi.optionLabel(s.title || s.id.slice(-8), s.workspaceDisplayName || null),
              30,
            ),
            type: 'default' as const,
            payload: {
              requestId: `control-session-pick:${s.id}`,
              botAppId,
              sessionId: s.id,
              sessionTitle: s.title,
              displayName: s.workspaceDisplayName,
            },
          })),
          exitBtn,
        ],
      };
    },

    /**
     * `/project` 项目切换卡。按钮 payload 同 control 卡约定: botAppId 走
     * payload(cardAction 通道只带 senderId), requestId 是 sentinel。
     */
    buildProjectPickerCard(args) {
      const projectUi = ui.cards.project;
      if (!projectUi) {
        throw new Error('buildProjectPickerCard requires ui.cards.project (projectSwitching channel)');
      }
      const { botAppId, projects, currentName } = args;
      const dialogueBtn = {
        id: 'project:dialogue',
        label: projectUi.btnDialogue,
        type: 'default' as const,
        payload: { requestId: 'project-dialogue', botAppId },
      };
      const cancelBtn = {
        id: 'project:cancel',
        label: projectUi.btnCancel,
        type: 'danger' as const,
        payload: { requestId: 'project-cancel', botAppId },
      };
      if (projects.length === 0) {
        return {
          title: projectUi.title,
          body: projectUi.emptyBody,
          buttons: [dialogueBtn, cancelBtn],
        };
      }
      return {
        title: projectUi.title,
        body: projectUi.hint(currentName),
        buttons: [
          ...projects.map((p) => ({
            id: 'project:pick',
            label: truncate(p.displayName, 30),
            type: 'default' as const,
            payload: {
              requestId: `project-pick:${p.workingDir}`,
              botAppId,
              workingDir: p.workingDir,
              displayName: p.displayName,
            },
          })),
          dialogueBtn,
          cancelBtn,
        ],
      };
    },

    /** Card to replace an interactive card with after the user resolved it. */
    buildResolvedCard(label) {
      return {
        body: label,
        buttons: [],
      };
    },

    /**
     * 「群会话不能用完全访问」的私聊修复卡 — 一键把会话切回 auto。payload
     * 带 sessionId + agentKind(cardAction 通道只带 senderId, 业务 id 走 payload)。
     */
    buildPermissionModeFixCard(args: {
      sessionId: string;
      agentKind: AgentKind;
      sessionTitle: string;
    }): InteractiveCardSpec {
      const fixUi = ui.cards.permissionModeFix;
      if (!fixUi) {
        throw new Error('buildPermissionModeFixCard requires ui.cards.permissionModeFix (feishu)');
      }
      return {
        title: fixUi.title,
        body: fixUi.body(args.sessionTitle),
        buttons: [
          {
            id: 'permissionMode:fix-auto',
            label: fixUi.btnFix,
            type: 'primary' as const,
            payload: {
              sessionId: args.sessionId,
              agentKind: args.agentKind,
            },
          },
        ],
      };
    },

    /**
     * 授权卡被点击后的收口形态: **保留原始正文**(工具名 + 参数预览 — 用户
     * 需要看到自己刚刚批准的是什么), 去掉按钮, 末尾追加决策结果一行。
     * 与 buildResolvedCard 的差异正在于不吞掉决策正文。
     */
    buildResolvedPermissionCard(
      original: { title: string; body: string },
      label: string,
    ): InteractiveCardSpec {
      return {
        title: original.title,
        body: `${original.body}\n\n${label}`,
        buttons: [],
      };
    },
  };
}

// ── schedule done (Phase 3 占位 / Phase 4 IPC 接入) ──────────────────────────
// scheduler-host/notifier.ts 当前因 owner openId 解析未通走 sendText 兜底，
// Phase 4 IPC 引入 schedule.notifyFeishuTarget 后再切到 sendInteractiveCard。
// 这里先把 builder 写死，避免 Phase 4 临时再现编。不依赖 ui 文案包, 保持
// 模块级导出。
export function buildScheduleDoneCard(
  schedule: Schedule,
  run: ScheduleRun,
): InteractiveCardSpec {
  const ok = run.status === 'success';
  const titlePrefix = ok ? '✅' : '❌';
  return {
    title: `${titlePrefix} [Schedule] ${schedule.name}`,
    body: ok
      ? `已完成。\nsessionId: \`${run.sessionId ?? '-'}\`\nrun: \`${run.id.slice(0, 12)}\``
      : `失败：${run.errorMsg ?? 'unknown'}`,
    buttons:
      ok && run.sessionId
        ? [
            {
              id: 'schedule:open-session',
              label: '查看任务',
              type: 'primary',
              payload: {
                requestId: `schedule-open:${run.id}`,
                sessionId: run.sessionId,
              },
            },
          ]
        : [],
  };
}
