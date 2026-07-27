import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import * as mobileInteractionModel from '@/session/interactionModel';
import {
  buildAskQuestionProgressSummary,
  buildAskQuestionReviewPresentation,
  buildAskUserQuestionDecision,
  buildInteractionResolveActionPresentation,
  buildMobilePermissionCardState,
  buildPendingInteractionQueuePresentation,
  buildPermissionDecision,
  buildPermissionDecisionSummary,
  buildPermissionReviewPresentation,
  buildPlanReviewDecision,
  buildPlanReviewDecisionSummary,
  buildPlanReviewEvidencePresentation,
  canStartInteractionResolve,
  encodeMultiSelectAnswer,
  extractPlanOutline,
  formatPermissionInput,
  isPlanReviewResolveBusy,
  interactionBlocksRemoteComposer,
  interactionKind,
  normalizeAskQuestions,
  pendingInteractionsBlockRemoteComposer,
  remoteInteractionHandling,
  REMOTE_PLUGIN_SETUP_ACTION_KINDS,
  REMOTE_PLUGIN_SETUP_ERROR_CODES,
  REMOTE_PLUGIN_SETUP_PHASES,
  permissionRiskSummary,
  permissionTitle,
  selectActivePendingInteraction,
  selectPendingInteractionByRequestId,
  selectionFromAnswer,
  sessionScopedPermissionSuggestions,
  shouldUseFullHeightPendingInteractionSurface,
  sortPendingInteractions,
} from '@/session/interactionModel';
import type { PendingInteraction } from '@/session/types';

// buildMobilePermissionCardState 已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦
// (全局 mock 默认 en-US)。共享层(@cindy/maker-shared/interaction)的中文直出不受影响。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('interactionModel', () => {
  it('projects resolve button state for mobile pending interaction actions', () => {
    expect(buildInteractionResolveActionPresentation({
      label: '确认提交',
      requestId: 'issue-1',
      invalidReason: '补齐标题和正文后才能提交。',
    })).toEqual({
      disabled: true,
      disabledReason: '补齐标题和正文后才能提交。',
      label: '确认提交',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '允许一次',
      confirmLabel: '确认允许一次',
      armed: true,
      requestId: 'permission-1',
    })).toEqual({
      disabled: false,
      disabledReason: null,
      label: '确认允许一次',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '提交',
      requestId: 'ask-1',
      busy: true,
    })).toMatchObject({
      disabled: true,
      disabledReason: '正在把决定回传到电脑端，请不要重复提交。',
      label: '提交中',
    });
  });

  it('reuses shared requestId duplicate-submit guard', () => {
    expect(canStartInteractionResolve({
      requestId: 'ask-1',
      submittingRequestId: null,
    })).toBe(true);
    expect(canStartInteractionResolve({
      requestId: 'ask-1',
      submittingRequestId: 'ask-1',
    })).toBe(false);
  });

  it('builds mobile decision summaries for pending interaction cards', () => {
    expect(buildPermissionDecisionSummary({
      toolName: 'Bash',
      riskSummary: null,
      canAlwaysAllow: true,
    })).toEqual({
      title: '可以只允许一次，也可以本会话总是允许',
      detail: '工具: Bash',
    });
    expect(buildPermissionDecisionSummary({
      toolName: 'Bash',
      riskSummary: 'danger',
      canAlwaysAllow: false,
    }).title).toBe('高风险授权需要二次确认');

    expect(buildAskQuestionProgressSummary({
      currentIndex: 1,
      total: 3,
      multiSelect: true,
    })).toEqual({
      title: '第 2/3 个问题',
      detail: '可多选，也可以输入其他回答。',
    });

    expect(buildPlanReviewDecisionSummary({
      outlineCount: 2,
      hasFilePath: true,
      edited: false,
    })).toEqual({
      title: '批准后电脑端会按计划继续执行',
      detail: '2 个章节 · 有计划文件',
    });
    expect(buildPlanReviewDecisionSummary({
      outlineCount: 0,
      hasFilePath: false,
      edited: true,
    })).toMatchObject({
      title: '已编辑计划，批准后按当前版本执行',
      detail: '无章节目录 · 无计划文件路径',
    });

  });

  it('formats permission requests like the desktop prompt', () => {
    expect(formatPermissionInput('Bash', { command: 'pnpm test' })).toBe('pnpm test');
    expect(formatPermissionInput('Write', { file_path: '/repo/a.ts', content: 'x' })).toBe('/repo/a.ts');
    expect(permissionTitle({ kind: 'permission', requestId: 'p1', toolName: 'Bash' })).toBe(
      '允许使用 Bash?',
    );
  });

  it('projects compact permission review evidence through the shared mobile model', () => {
    const presentation = buildPermissionReviewPresentation({
      kind: 'permission',
      requestId: 'p1',
      displayName: 'Shell',
      toolName: 'Bash',
      description: 'Run the requested test command.',
      input: { command: 'pnpm --filter mobile test' },
    });

    expect(presentation).toEqual({
      canAlwaysAllow: false,
      code: 'pnpm --filter mobile test',
      description: 'Run the requested test command.',
      riskSummary: null,
      summary: {
        title: '允许后电脑端会继续执行',
        detail: '工具: Bash',
      },
      title: '允许使用 Shell?',
      toolName: 'Bash',
    });
  });

  it('projects ask question review presentation through the shared mobile model', () => {
    const presentation = buildAskQuestionReviewPresentation({
      currentIndex: 1,
      questions: [
        { question: 'First?' },
        {
          header: 'Mock',
          question: 'Continue the mobile fixture?',
          options: [
            { label: 'Continue', description: 'Keep the fixture moving.' },
            { label: 'Pause', description: 'Stop after this step.' },
          ],
        },
      ],
    });

    expect(presentation).toMatchObject({
      allowsCustomAnswer: true,
      currentIndex: 1,
      currentNumber: 2,
      header: 'Mock',
      multiSelect: false,
      optionCount: 2,
      pageLabel: '2/2',
      summary: {
        title: '第 2/2 个问题',
        detail: '选择一个回答，或输入其他回答。',
      },
      title: 'Continue the mobile fixture?',
      totalCount: 2,
    });
  });

  it('keeps issue confirmation unsupported in the mobile adapter and panel', () => {
    const interactionPanelSource = readFileSync(resolve(process.cwd(), 'src/session/InteractionPanel.tsx'), 'utf8');

    expect('buildIssueConfirmReviewPresentation' in mobileInteractionModel).toBe(false);
    expect('buildIssueConfirmDecision' in mobileInteractionModel).toBe(false);
    expect('normalizeIssueConfirm' in mobileInteractionModel).toBe(false);
    expect(interactionPanelSource).toContain("if (kind === 'issue_confirm')");
    expect(interactionPanelSource).toContain("t('interaction.panel.issueConfirmUnsupported')");
    expect(interactionPanelSource).not.toContain('buildIssueConfirmReviewPresentation');
  });

  it('gives plugin setup requests a cancel exit instead of a dead card', () => {
    const interactionPanelSource = readFileSync(resolve(process.cwd(), 'src/session/InteractionPanel.tsx'), 'utf8');

    // 桌面把 plugin_setup 也推给控制端,而配置动作只能在桌面完成。手机侧必须留
    // 取消出口:没有出口 + 卡接管输入框 = 会话锁死(线上已复现)。
    expect(interactionPanelSource).toContain("if (kind === 'plugin_setup')");
    expect(interactionPanelSource).toContain('buildPluginSetupCancelDecision(item.request)');
    // testID 与 UnsupportedCard 区分开,UI 测试才能精确定位这张卡的取消按钮(#540 review)。
    expect(interactionPanelSource).toContain('interaction.pluginSetup.cancelButton');
    expect(interactionPanelSource).not.toContain('interaction.unsupported.cancelButton');
    // 未知 kind 仍回退到 UnsupportedCard 的 request 预览,整段一次限行:每行各自
    // numberOfLines 会把总高度放大成 6 × 行数。
    expect(interactionPanelSource).toContain('const summaryText = contentToPreview(request);');
    expect(interactionPanelSource).not.toContain('lines.map((line, index)');
    // plugin_setup 移出 UnsupportedCard 后,当初为它加的形参不能留成没人走的分支。
    // 钉形参声明与 JSX 传参本身,不做全文匹配——注释里可以照常说明这段历史。
    for (const dead of ['summaryLines?:', 'summaryLines={', 'kindLabel?:', 'kindLabel={']) {
      expect(interactionPanelSource, dead).not.toContain(dead);
    }
    // 取消由被控端按 expectedRevision 裁决,不能乐观撤卡(撤了可能其实没取消);
    // 但仍要按该 revision 封顶抑制,否则取消前发出的慢快照会把卡写回来。
    expect(interactionPanelSource).toContain('optimisticDismiss: false');
    expect(interactionPanelSource).toContain('resolvedRevision: cancelDecision.expectedRevision');
    expect(interactionPanelSource).toContain('markInteractionRevisionResolved');
    // terminal 快照(被控端已 settle)不得给取消按钮:那只会点出一个「看起来成功」
    // 的 no-op。门控以共享分类器为单一真相源。
    expect(interactionPanelSource).toContain("remoteInteractionHandling(item) === 'cancel-only'");
    expect(remoteInteractionHandling({
      request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 2, terminal: true },
    })).toBe('desktop-only');

    expect(interactionBlocksRemoteComposer({
      request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 },
    })).toBe(false);
    expect(interactionBlocksRemoteComposer({
      request: { kind: 'permission', requestId: 'perm-1' },
    })).toBe(true);
  });

  it('renders plugin setup as a full read-only status card, not a flat summary', () => {
    const interactionPanelSource = readFileSync(resolve(process.cwd(), 'src/session/InteractionPanel.tsx'), 'utf8');

    // 手机端做不了配置动作,这张卡的全部价值在「看懂」:哪个插件、卡在哪一步、
    // 为什么失败、回电脑端要做什么。退回扁平摘要就等于把这些信息又丢了。
    expect(interactionPanelSource).toContain('function PluginSetupCard(');
    expect(interactionPanelSource).toContain('buildRemotePluginSetupPresentation(item.request)');
    expect(interactionPanelSource).not.toContain('pluginSetupSummaryLines');
    expect(interactionPanelSource).toContain('interaction.pluginSetup.phase.${step.phase}');
    expect(interactionPanelSource).toContain('interaction.pluginSetup.error.${step.errorCode}');
    expect(interactionPanelSource).toContain('interaction.pluginSetup.action.${step.actionKind}');
    // any_of 组要提示「任选其一」,否则用户以为每一步都得做。
    expect(interactionPanelSource).toContain("t('interaction.pluginSetup.chooseOne')");
    // 已 settle 的收尾帧不该再引导用户「去电脑端完成」。
    expect(interactionPanelSource).toContain('presentation.terminal ? null');
    // 状态色只用两个语义色 + 灰阶(mobile-design-guide §1)。
    expect(interactionPanelSource).toContain('colors.statusReady');
    expect(interactionPanelSource).toContain('colors.statusAccent');
  });

  it('keeps every plugin setup phase, error code and action kind translated in all locales', async () => {
    const previous = i18n.language;
    try {
      for (const locale of ['zh-CN', 'en', 'ja', 'ko']) {
        await i18n.changeLanguage(locale);
        for (const phase of REMOTE_PLUGIN_SETUP_PHASES) {
          const key = `interaction.pluginSetup.phase.${phase}`;
          expect(i18n.t(key), `${locale} ${key}`).not.toBe(key);
        }
        for (const code of REMOTE_PLUGIN_SETUP_ERROR_CODES) {
          const key = `interaction.pluginSetup.error.${code}`;
          expect(i18n.t(key), `${locale} ${key}`).not.toBe(key);
        }
        for (const kind of REMOTE_PLUGIN_SETUP_ACTION_KINDS) {
          // inline_form 走带字段名的专属文案,不在 action 目录里。
          if (kind === 'inline_form') continue;
          const key = `interaction.pluginSetup.action.${kind}`;
          expect(i18n.t(key), `${locale} ${key}`).not.toBe(key);
        }
        for (const key of [
          'interaction.pluginSetup.completeOnDesktop',
          'interaction.pluginSetup.chooseOne',
          'interaction.pluginSetup.progress',
          'interaction.pluginSetup.desktopActionHint',
          'interaction.pluginSetup.inlineFormAction',
          'interaction.pluginSetup.inlineFormActionGeneric',
          // 读屏聚合分隔符:硬编码「，」会让非中文 locale 念出中文标点(#540 review)
          'interaction.pluginSetup.a11ySeparator',
        ]) {
          expect(i18n.t(key), `${locale} ${key}`).not.toBe(key);
        }
      }
    } finally {
      await i18n.changeLanguage(previous);
    }
  });

  it('localizes queue titles and kind labels instead of rendering the shared Chinese defaults', () => {
    const interactionPanelSource = readFileSync(resolve(process.cwd(), 'src/session/InteractionPanel.tsx'), 'utf8');

    // 共享层的 title / label 是中文直出;控制端必须按 locale 翻译后再渲染,否则
    // 队列头在 en / ja / ko 下仍是中文。
    // kind 来自远端、可为任意字符串:必须先经白名单归一再拼 i18next key,
    // 否则带 `.` / `__proto__` 的值会参与路径解析。
    expect(interactionPanelSource).toContain('interaction.kinds.${localizedInteractionKindKey(itemKind)}.${field}');
    expect(interactionPanelSource).toContain('const LOCALIZED_INTERACTION_KINDS = new Set([');
    expect(interactionPanelSource).not.toContain('interaction.kinds.${kind}.');
    expect(interactionPanelSource).not.toContain('title: selectedQueueItem?.title');
    // positionLabel 会被插进队列切换的 accessibility 文案,同样必须翻译,
    // 否则读屏在非中文 locale 下念混语。
    expect(interactionPanelSource).toContain("t('interaction.panel.queuePositionCurrent')");
    expect(interactionPanelSource).toContain("t('interaction.panel.queuePositionNth', { index: index + 1 })");

    for (const lang of ['zh-CN', 'en', 'ja', 'ko']) {
      const bundle = JSON.parse(readFileSync(resolve(process.cwd(), `src/i18n/locales/${lang}/interaction.json`), 'utf8'));
      for (const kind of ['permission', 'ask_user_question', 'plan_review', 'issue_confirm', 'plugin_setup', 'fallback']) {
        expect(bundle.kinds?.[kind]?.title, `${lang}/${kind}.title`).toBeTruthy();
        expect(bundle.kinds?.[kind]?.label, `${lang}/${kind}.label`).toBeTruthy();
      }
      for (const key of ['queuePositionCurrent', 'queuePositionNext', 'queuePositionNth']) {
        expect(bundle.panel?.[key], `${lang}/panel.${key}`).toBeTruthy();
      }
      expect(bundle.panel?.queuePositionNth, `${lang}/panel.queuePositionNth`).toContain('{{index}}');
    }
  });

  it('keys mobile composer blocking off the whole pending set', () => {
    const sessionScreenSource = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 阻塞判定必须喂整个 pending 集合;喂 activePendingInteraction 会让用户切到
    // 一张手机处理不了的卡就绕过仍待处理的权限 / 提问 / 计划卡。
    expect(sessionScreenSource).toContain('pendingInteractionsBlockRemoteComposer(pending)');
    expect(sessionScreenSource).not.toContain('interactionBlocksRemoteComposer(activePendingInteraction)');

    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } },
      { request: { kind: 'permission', requestId: 'perm-1' } },
    ])).toBe(true);
    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } },
    ])).toBe(false);
  });

  it('keeps read-only pending interactions as a short desktop-style blocker', () => {
    const interactionPanelSource = readFileSync(resolve(process.cwd(), 'src/session/InteractionPanel.tsx'), 'utf8');
    const readOnlyStart = interactionPanelSource.indexOf('if (readOnlyReason) {');
    const readOnlyEnd = interactionPanelSource.indexOf('return (', interactionPanelSource.indexOf('}', readOnlyStart));
    const readOnlySource = interactionPanelSource.slice(readOnlyStart, readOnlyEnd);

    expect(readOnlySource).toContain("t('interaction.panel.readOnlyTitle')");
    expect(readOnlySource).toContain('{readOnlyReason}');
    expect(readOnlySource).not.toContain('当前请求类型');
    expect(readOnlySource).not.toContain('不会回传协作编排决定');
    expect(readOnlySource).not.toContain('手机版会保留会话显示');
    expect(interactionPanelSource).not.toContain('interaction.readOnlyHint');
    expect(interactionPanelSource).not.toContain('hintText: {');
  });

  it('flags high-risk shell permission requests for mobile confirmation', () => {
    expect(permissionRiskSummary({
      kind: 'permission',
      requestId: 'p1',
      toolName: 'Bash',
      input: { command: 'pnpm test' },
    })).toBeNull();

    expect(permissionRiskSummary({
      kind: 'permission',
      requestId: 'p2',
      toolName: 'Bash',
      input: { command: 'git reset --hard HEAD && rm -rf node_modules' },
    })).toContain('可能修改系统');

    expect(permissionRiskSummary({
      kind: 'permission',
      requestId: 'p3',
      toolName: 'Read',
      input: { file_path: '/repo/app.ts' },
    })).toBeNull();
  });

  it('keeps high-risk mobile permissions to allow-once confirmation only', () => {
    const presentation = buildPermissionReviewPresentation({
      kind: 'permission',
      requestId: 'p-high',
      toolName: 'Bash',
      input: { command: 'git reset --hard HEAD && rm -rf node_modules' },
      suggestions: [{ destination: 'session', rules: [{ toolName: 'Bash' }] }],
    });

    expect(presentation.canAlwaysAllow).toBe(true);
    expect(buildMobilePermissionCardState({
      armedDecision: null,
      presentation,
    })).toMatchObject({
      canShowAlwaysAllow: false,
      isHighRisk: true,
      riskWarningText: expect.stringContaining('可能修改系统'),
      title: '允许使用 Bash?',
    });
    expect(buildMobilePermissionCardState({
      armedDecision: 'allow-once',
      presentation,
    })).toMatchObject({
      canShowAlwaysAllow: false,
      isHighRisk: true,
      riskWarningText: '确认允许后才会把决定回传到电脑端。',
      title: '确认高风险操作',
    });
  });

  it('keeps plan review retryable after a failed remote response', () => {
    expect(isPlanReviewResolveBusy({ busy: true })).toBe(true);
    expect(isPlanReviewResolveBusy({ busy: false })).toBe(false);
    expect(buildInteractionResolveActionPresentation({
      label: '批准执行',
      requestId: 'plan-1',
      busy: isPlanReviewResolveBusy({ busy: false }),
    })).toMatchObject({
      disabled: false,
      label: '批准执行',
    });
  });

  it('keys mobile full-height plan layout off the selected pending request', () => {
    const interactions: PendingInteraction[] = [
      { persistId: 'plan', request: { kind: 'plan_review', requestId: 'plan-1' } },
      { persistId: 'ask', request: { kind: 'ask_user_question', requestId: 'ask-1' } },
    ];

    const selectedAsk = selectPendingInteractionByRequestId(interactions, 'ask-1');
    const selectedPlan = selectPendingInteractionByRequestId(interactions, 'plan-1');

    expect(selectedAsk?.request.requestId).toBe('ask-1');
    expect(shouldUseFullHeightPendingInteractionSurface({
      activeKind: selectedAsk ? interactionKind(selectedAsk) : null,
      planViewerState: 'expanded',
    })).toBe(false);
    expect(shouldUseFullHeightPendingInteractionSurface({
      activeKind: selectedPlan ? interactionKind(selectedPlan) : null,
      planViewerState: 'expanded',
    })).toBe(true);
    expect(shouldUseFullHeightPendingInteractionSurface({
      activeKind: selectedPlan ? interactionKind(selectedPlan) : null,
      planViewerState: 'half',
    })).toBe(false);
  });

  it('serializes permission allow-once, deny, and session scoped suggestions', () => {
    const sessionRule = { destination: 'session', rules: [{ toolName: 'Bash' }] };
    const projectRule = { destination: 'project', rules: [{ toolName: 'Bash' }] };
    const suggestions = sessionScopedPermissionSuggestions([sessionRule, projectRule, null]);

    expect(suggestions).toEqual([sessionRule]);
    expect(buildPermissionDecision('allow')).toMatchObject({
      kind: 'permission',
      behavior: 'allow',
    });
    expect(buildPermissionDecision('deny', { reason: 'User denied' })).toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'User denied',
    });
    expect(buildPermissionDecision('allow', { permissionUpdates: suggestions })).toMatchObject({
      kind: 'permission',
      behavior: 'allow',
      permissionUpdates: [sessionRule],
    });
  });

  it('normalizes AskUserQuestion payload and keeps desktop multi-select encoding', () => {
    const questions = normalizeAskQuestions([
      {
        question: '用哪个库?',
        header: '选择',
        multiSelect: true,
        options: [
          { label: 'React Native', description: '原生端' },
          { label: 'Expo' },
        ],
      },
      { question: 123 },
    ]);

    expect(questions).toHaveLength(1);
    const answer = encodeMultiSelectAnswer(
      questions[0].options ?? [],
      new Set(['Expo']),
      '自定义',
    );
    expect(answer).toBe(JSON.stringify(['Expo', '自定义']));
    expect(selectionFromAnswer(questions[0], answer)).toMatchObject({
      customInput: '自定义',
      showCustomInput: true,
    });
    expect(buildAskUserQuestionDecision({ '用哪个库?': answer })).toEqual({
      kind: 'ask_user_question',
      answers: { '用哪个库?': answer },
    });
  });

  it('serializes plan review approve and feedback decisions', () => {
    expect(buildPlanReviewDecision(true, '# Plan')).toEqual({
      kind: 'plan_review',
      behavior: 'allow',
      editedPlan: '# Plan',
      reason: undefined,
    });
    expect(buildPlanReviewDecision(false, '# Plan', '补测试')).toEqual({
      kind: 'plan_review',
      behavior: 'deny',
      editedPlan: undefined,
      reason: '补测试',
    });
  });

  it('projects compact plan review evidence through the shared mobile model', () => {
    const presentation = buildPlanReviewEvidencePresentation({
      edited: false,
      filePath: 'C:\\repo\\xdt-maker\\plans\\mobile-remote-control.md',
      maxOutlineItems: 1,
      plan: [
        '# 主窗口',
        '先处理 pending 请求。',
        '## 测试',
        '覆盖视觉基线。',
      ].join('\n'),
    });

    expect(presentation).toMatchObject({
      compactPath: '.../mobile-remote-control.md',
      fileName: 'mobile-remote-control.md',
      outlineOverflowCount: 1,
      outlineTotalCount: 2,
      summary: {
        title: '批准后电脑端会按计划继续执行',
        detail: '2 个章节 · 有计划文件',
      },
    });
    expect(presentation.outlineItems).toHaveLength(1);
    expect(presentation.outlineItems[0]).toMatchObject({
      title: '主窗口',
      preview: '先处理 pending 请求。',
    });
  });

  it('matches the desktop pending-interaction priority order', () => {
    const interactions: PendingInteraction[] = [
      { request: { kind: 'issue_confirm', requestId: 'issue-1' } },
      { request: { kind: 'ask_user_question', requestId: 'ask-1' } },
      { request: { kind: 'permission', requestId: 'permission-1' } },
      { request: { kind: 'plan_review', requestId: 'plan-1' } },
      { request: { kind: 'custom', requestId: 'custom-1' } },
    ];

    expect(sortPendingInteractions(interactions).map((item) => item.request.requestId)).toEqual([
      'plan-1',
      'permission-1',
      'ask-1',
      'issue-1',
      'custom-1',
    ]);
    expect(selectActivePendingInteraction(interactions)?.request.requestId).toBe('plan-1');
    expect(selectActivePendingInteraction([])).toBeNull();
  });

  it('projects the pending interaction queue for the mobile header', () => {
    const presentation = buildPendingInteractionQueuePresentation([
      { request: { kind: 'ask_user_question', requestId: 'ask-1' } },
      { request: { kind: 'permission', requestId: 'permission-1' } },
      { request: { kind: 'plan_review', requestId: 'plan-1' } },
    ]);

    expect(presentation).toMatchObject({
      countLabel: '3 个',
      hint: '先看计划，必要时反馈修改，确认后电脑端才继续执行。',
      title: '需要确认执行计划',
      items: [
        { label: '计划', positionLabel: '当前', requestId: 'plan-1' },
        { label: '授权', positionLabel: '接着', requestId: 'permission-1' },
        { label: '问题', positionLabel: '第 3', requestId: 'ask-1' },
      ],
    });
  });

  it('extracts plan outline from desktop-supported markdown headings', () => {
    const outline = extractPlanOutline([
      '# 总览',
      '先处理登录和连接。',
      '```ts',
      '## 代码里的假标题',
      '```',
      '## 交互细节 ##',
      '保留桌面端语义。',
      '#### 太深的标题',
      '### 测试',
    ].join('\n'));

    expect(outline).toEqual([
      {
        id: 'plan-heading-1',
        title: '总览',
        level: 1,
        line: 1,
        preview: '先处理登录和连接。',
      },
      {
        id: 'plan-heading-6',
        title: '交互细节',
        level: 2,
        line: 6,
        preview: '保留桌面端语义。',
      },
      {
        id: 'plan-heading-9',
        title: '测试',
        level: 3,
        line: 9,
        preview: '',
      },
    ]);
  });

  it('ignores headings inside tilde fences when extracting plan outline', () => {
    expect(extractPlanOutline([
      '~~~',
      '# fenced',
      '~~~',
      '## Real',
    ].join('\n'))).toEqual([
      {
        id: 'plan-heading-4',
        title: 'Real',
        level: 2,
        line: 4,
        preview: '',
      },
    ]);
  });

});

describe('resolveInteractionResilient', () => {
  const noSleep = async () => undefined;
  const pendingItem = (requestId: string) => ({ request: { requestId } });

  it('NOT_CONNECTED(请求未出本机)自动重试直到成功,不触发权威查询', async () => {
    let resolveCalls = 0;
    let pendingCalls = 0;
    await mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        resolveCalls++;
        if (resolveCalls < 3) throw Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' });
      },
      getPendingInteractions: async () => {
        pendingCalls++;
        return [];
      },
    }, 's1', 'req-1', { behavior: 'allow' }, { sleep: noSleep });
    expect(resolveCalls).toBe(3);
    expect(pendingCalls).toBe(0);
  });

  it('歧义失败(超时)后 requestId 已不在 pending → 视为已生效,按成功收敛', async () => {
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        throw Object.assign(new Error('no invoke-result within 30000ms'), { code: 'INVOKE_TIMEOUT' });
      },
      getPendingInteractions: async () => [pendingItem('req-other')],
    }, 's1', 'req-1', {}, { sleep: noSleep })).resolves.toBeUndefined();
  });

  it('歧义失败后 requestId 仍在 pending → 抛原错误,面板保持可重试', async () => {
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        throw Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' });
      },
      getPendingInteractions: async () => [pendingItem('req-1')],
    }, 's1', 'req-1', {}, { sleep: noSleep })).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
  });

  it('权威查询也失败 → 抛原错误(不吞掉、不误判成功)', async () => {
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        throw Object.assign(new Error('timeout'), { code: 'INVOKE_TIMEOUT' });
      },
      getPendingInteractions: async () => {
        throw new Error('also offline');
      },
    }, 's1', 'req-1', {}, { sleep: noSleep })).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
  });

  it('重复提交被拒(desktop 已解决)但 pending 已空 → 自愈为成功', async () => {
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        throw new Error('unknown interaction request');
      },
      getPendingInteractions: async () => [],
    }, 's1', 'req-1', {}, { sleep: noSleep })).resolves.toBeUndefined();
  });

  it('NOT_CONNECTED 重试耗尽后同样走权威查询分辨', async () => {
    let resolveCalls = 0;
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        resolveCalls++;
        throw Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' });
      },
      getPendingInteractions: async () => [pendingItem('req-1')],
    }, 's1', 'req-1', {}, { sleep: noSleep })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    expect(resolveCalls).toBe(4); // 首次 + 3 次重试
  });
});
