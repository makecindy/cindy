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
  InteractionRequest,
  AgentKind,
  AskUserQuestionItem,
  Effort,
  PermissionModeDescriptor,
} from '@cindy/maker-core';
import type { ProviderSection } from '@cindy/model-providers';
import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';
import type { InteractiveCardSpec } from '@cindy/im';

import type { ImUiTextPack } from './types';
import type { ControlProject, ControlSession, RecentControlSession } from './controlProjects';

const MAX_PLAN_LEN = 1500;
const MAX_INPUT_PREVIEW = 800;
const MAX_OPTIONS = 6;

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n\n…(已截断)` : s;
}

function previewInput(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input, null, 2), MAX_INPUT_PREVIEW);
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
}

export function createCardBuilders(
  ui: ImUiTextPack,
  getDefaultEffortFor: (modelId: string, agentKind?: AgentKind) => Effort,
): ImCardBuilders {
  return {
    // ── permission ──────────────────────────────────────────────────────────

    buildPermissionCard(req) {
      return {
        title: ui.cards.permission.title(req.toolName),
        body: `${ui.cards.permission.paramsLabel}\n\`\`\`json\n${previewInput(req.input)}\n\`\`\``,
        buttons: [
          {
            id: 'permission:allow:once',
            label: ui.cards.permission.btnAllowOnce,
            type: 'primary',
            payload: { requestId: req.requestId },
          },
          {
            id: 'permission:allow:always',
            label: ui.cards.permission.btnAllowAlways,
            type: 'default',
            payload: { requestId: req.requestId },
          },
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
    // v1 simplification (mirrors legacy cardRenderer behaviour):
    // - render only the FIRST question
    // - max 6 options (single-select); multiSelect is downgraded to single-select

    buildAskUserCard(req) {
      const question: AskUserQuestionItem | undefined = req.questions[0];
      if (!question) return null;

      const headerText = question.header || question.question;
      const options = (question.options ?? []).slice(0, MAX_OPTIONS);
      const bodyExtra =
        question.header && question.header !== question.question
          ? `\n${question.question}`
          : '';

      if (options.length === 0) {
        return {
          title: ui.cards.ask.title(headerText),
          body: bodyExtra
            ? `${bodyExtra}\n\n${ui.cards.ask.noOptionsHint}`
            : ui.cards.ask.noOptionsHint,
          buttons: [
            {
              id: 'ask:noop',
              label: '继续',
              type: 'default',
              payload: {
                requestId: req.requestId,
                // SDK 端 answers 必须用 question.question 全文做 key
                // (cc-code QuestionView.tsx:167: questionText = question.question)。
                // headerText 只作卡片标题, 不参与 answers 匹配。
                questionText: question.question,
                questionHeader: headerText,
                optionLabel: '',
              },
            },
          ],
        };
      }

      return {
        title: ui.cards.ask.title(headerText),
        body: bodyExtra || ' ',
        buttons: options.map((opt) => ({
          id: 'ask:pick',
          label: truncate(opt.label, 30),
          type: 'default' as const,
          payload: {
            requestId: req.requestId,
            questionText: question.question,
            questionHeader: headerText,
            optionLabel: opt.label,
          },
        })),
      };
    },

    // ── plan_review ─────────────────────────────────────────────────────────

    buildPlanReviewCard(req) {
      return {
        title: ui.cards.plan.title,
        body: truncate(req.plan, MAX_PLAN_LEN),
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
              label: '查看会话',
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
