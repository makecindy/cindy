import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import ts from 'typescript';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import * as mobileInteractionModel from '@/session/interactionModel';
import {
  buildAskQuestionProgressSummary,
  buildAskQuestionReviewPresentation,
  buildAskUserQuestionDecision,
  buildCollapsedPendingInteractionPresentation,
  buildInteractionResolveActionPresentation,
  buildMobilePermissionCardState,
  buildPendingInteractionQueuePresentation,
  buildPermissionDecision,
  buildPermissionDecisionSummary,
  buildPermissionReviewPresentation,
  buildPlanReviewDecision,
  buildPlanReviewDecisionSummary,
  buildPlanReviewEvidencePresentation,
  canCollapsePendingInteraction,
  canStartInteractionResolve,
  encodeMultiSelectAnswer,
  extractPlanOutline,
  formatPermissionInput,
  isPendingInteractionCollapsed,
  isPlanReviewResolveBusy,
  interactionBlocksRemoteComposer,
  interactionKind,
  normalizeAskQuestions,
  pendingInteractionSummaryText,
  pendingInteractionsBlockRemoteComposer,
  prunePendingInteractionCollapsed,
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
  togglePendingInteractionCollapsed,
} from '@/session/interactionModel';
import { askQuestionsIdentity, clearAskUserDraft, saveAskUserDraft } from '@/session/interactionDraftStore';
import type { PendingInteraction } from '@/session/types';

/** prune 的权威性开关:全量快照到手 = 权威;离线清空投影 = 非权威。 */
const AUTHORITATIVE = { authoritative: true } as const;
const NOT_AUTHORITATIVE = { authoritative: false } as const;

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
      title: '可以只允许一次，也可以本任务总是允许',
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
      autoReviewUnavailable: false,
      autoReviewReason: null,
      canAlwaysAllow: false,
      code: 'pnpm --filter mobile test',
      description: 'Run the requested test command.',
      riskSummary: null,
      summary: {
        title: '允许后电脑端会继续执行',
        detail: '工具: Bash',
      },
      title: '允许运行这条命令？',
      toolName: 'Bash',
    });
  });

  it('localizes auto-review unavailable confirmation copy instead of the English fallback', () => {
    const presentation = buildPermissionReviewPresentation({
      kind: 'permission',
      requestId: 'p-unavailable',
      toolName: 'Bash',
      description: 'Automatic review could not finish, so this action needs your confirmation.',
      metadata: { autoReviewUnavailable: true },
      input: { command: 'npx tsc --noEmit' },
    });
    expect(presentation.autoReviewUnavailable).toBe(true);

    expect(i18n.t('interaction.permission.autoReviewUnavailable')).not.toBe(
      'interaction.permission.autoReviewUnavailable',
    );
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

  it('keeps Host-owned decision builders out of the mobile adapter', () => {
    expect('buildIssueConfirmReviewPresentation' in mobileInteractionModel).toBe(false);
    expect('buildIssueConfirmDecision' in mobileInteractionModel).toBe(false);
    expect('normalizeIssueConfirm' in mobileInteractionModel).toBe(false);
  });

  it('keeps plugin setup nonblocking and terminal setup read-only', () => {
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 2, terminal: true } })).toBe('desktop-only');
    expect(interactionBlocksRemoteComposer({ request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } })).toBe(false);
    expect(interactionBlocksRemoteComposer({ request: { kind: 'permission', requestId: 'perm-1' } })).toBe(true);
  });

  it('keeps every plugin setup phase, error code and action kind translated in all locales', async () => {
    const previous = i18n.language;
    try {
      for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
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
    for (const lang of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
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
    const page = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    const tree = ts.createSourceFile('session.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let initializer: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'pendingInteractionBlocksComposer') initializer = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (!initializer) throw new Error('Missing production pending composer gate');
    const blocks = new Function('pendingInteractionsBlockRemoteComposer', 'pending', 'return (' + initializer.getText(tree) + ')');
    const pending = [{ request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } }, { request: { kind: 'permission', requestId: 'perm-1' } }];
    expect(blocks(pendingInteractionsBlockRemoteComposer, pending)).toBe(true);
    expect(blocks(pendingInteractionsBlockRemoteComposer, pending.slice(0, 1))).toBe(false);
    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } },
      { request: { kind: 'permission', requestId: 'perm-1' } },
    ])).toBe(true);
    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } },
    ])).toBe(false);
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
      title: '允许运行这条命令？',
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
    // 收起时固定高度必须失效:否则「收起」只是换了张空 bar,surface 照样占满屏。
    expect(shouldUseFullHeightPendingInteractionSurface({
      activeKind: selectedPlan ? interactionKind(selectedPlan) : null,
      collapsed: true,
      planViewerState: 'expanded',
    })).toBe(false);
  });

  it('keeps the pending collapse intent per request and survives list churn', () => {
    const pending = [
      { request: { kind: 'ask_user_question', requestId: 'ask-1', questions: [{ question: '按哪种方式做?' }] } },
      { request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash' } },
    ] as unknown as PendingInteraction[];

    expect(isPendingInteractionCollapsed([], 'ask-1')).toBe(false);
    // 没有 requestId 的卡不可能被收起(收起态以 requestId 为键)。
    expect(isPendingInteractionCollapsed(['ask-1'], null)).toBe(false);

    const collapsed = togglePendingInteractionCollapsed([], 'ask-1');
    expect(collapsed).toEqual(['ask-1']);
    expect(isPendingInteractionCollapsed(collapsed, 'ask-1')).toBe(true);
    expect(isPendingInteractionCollapsed(collapsed, 'perm-1')).toBe(false);
    expect(togglePendingInteractionCollapsed(collapsed, 'ask-1')).toEqual([]);

    // 队列刷新(同一批卡再来一遍)不得清掉收起意图 —— 这正是旧卡内 state 的病根。
    expect(prunePendingInteractionCollapsed(collapsed, pending, AUTHORITATIVE)).toBe(collapsed);
    // 卡被回答 / 被撤后收起记录要清掉,免得同 requestId 复现时直接以收起态出现。
    expect(prunePendingInteractionCollapsed(collapsed, [pending[1]!], AUTHORITATIVE)).toEqual([]);
    // 空集合走 identity 返回:effect 里 setState 每帧换引用会无限重入。
    const empty: readonly string[] = [];
    expect(prunePendingInteractionCollapsed(empty, [], AUTHORITATIVE)).toBe(empty);
  });

  it('prunes the collapse intent only under an authoritative pending snapshot', () => {
    const collapsed = ['ask-1', 'perm-1'];

    // 非权威的空(markDeviceOffline 按设计清掉了这份依赖实时连接的投影):不能清,
    // 否则重连后同一张卡以展开态灌回来占满屏 —— 本 PR 要治的病换条路径复发。
    expect(prunePendingInteractionCollapsed(collapsed, [], NOT_AUTHORITATIVE)).toBe(collapsed);
    // 权威的空(被控端确认全都处理完了):要清,否则最后一条收起记录永远留着。
    expect(prunePendingInteractionCollapsed(collapsed, [], AUTHORITATIVE)).toEqual([]);

    const restored = [
      { request: { kind: 'ask_user_question', requestId: 'ask-1', questions: [{ question: '还在等回答' }] } },
    ] as unknown as PendingInteraction[];
    // 重连后的权威非空快照:ask-1 还在 → 保留收起;perm-1 已终结 → 清掉。
    expect(prunePendingInteractionCollapsed(collapsed, restored, AUTHORITATIVE)).toEqual(['ask-1']);
    // 非权威的非空同样不清:重连后可能先到一条 push 增量、全量快照还没来,那份列表
    // 只含增量那张卡,按它过滤会把 perm-1 的收起记录误清 —— 与离线空列表同一类误判。
    expect(prunePendingInteractionCollapsed(collapsed, restored, NOT_AUTHORITATIVE)).toBe(collapsed);

    // 非权威窗口里不清,集合仍要有界:上限截断最旧的。
    const many = Array.from({ length: 12 }, (_, i) => `req-${i}`);
    const bounded = prunePendingInteractionCollapsed(many, [], NOT_AUTHORITATIVE);
    expect(bounded).toHaveLength(8);
    expect(bounded[0]).toBe('req-4');
    expect(bounded[7]).toBe('req-11');
  });

  it('keeps the collapsed bar screen-reader label on the question the user is actually on', () => {
    const item = {
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-label-1',
        questions: [{ question: '第一问是什么' }, { question: '第二问是什么' }],
      },
    } as unknown as PendingInteraction;

    // 还没翻页:标签用第一问。
    const first = buildCollapsedPendingInteractionPresentation({
      item,
      queueTitle: '等待回答',
      requestId: 'ask-label-1',
    });
    expect(first.summaryText).toBe('第一问是什么');
    expect(first.accessibilityLabel).toContain('第一问是什么');

    // 进入第二问后,读屏念的必须是第二问 —— 这条钉的就是 label 本身,不是渲染代码文本。
    const identity = askQuestionsIdentity(normalizeAskQuestions(item.request.questions));
    saveAskUserDraft('ask-label-1', {
      answers: {},
      currentIndex: 1,
      customInput: '',
      questionsIdentity: identity,
      selectedLabels: [],
      showCustomInput: false,
    });
    const second = buildCollapsedPendingInteractionPresentation({
      item,
      queueTitle: '等待回答',
      requestId: 'ask-label-1',
    });
    expect(second.summaryText).toBe('第二问是什么');
    expect(second.accessibilityLabel).toContain('第二问是什么');
    expect(second.accessibilityLabel).not.toContain('第一问是什么');

    // 收起期间同一 requestId 换了问题:旧草稿的进度不能带进新内容,摘要回到第一问。
    const replaced = buildCollapsedPendingInteractionPresentation({
      item: { request: {
        kind: 'ask_user_question',
        requestId: 'ask-label-1',
        questions: [{ question: '新的第一问' }, { question: '新的第二问' }],
      } } as unknown as PendingInteraction,
      queueTitle: '等待回答',
      requestId: 'ask-label-1',
    });
    expect(replaced.summaryText).toBe('新的第一问');
    clearAskUserDraft('ask-label-1');

    // 没有专属摘要的卡(手机端答不了的那类)退回队列标题,标签不留空。
    const fallback = buildCollapsedPendingInteractionPresentation({
      item: { request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 } } as unknown as PendingInteraction,
      queueTitle: '电脑端处理',
      requestId: 'setup-1',
    });
    expect(fallback.summaryText).toBeNull();
    expect(fallback.accessibilityLabel).toContain('电脑端处理');
  });

  it('offers the collapse affordance only for requests the phone can actually resolve', () => {
    // 队列混着 plugin_setup 时用户能从队列头切过去,那张卡答不了(只能取消 / 回电脑端),
    // 给它挂「点开回答」既是错的语义,也绕过了 above-composer 放置点不给收起的保护。
    expect(canCollapsePendingInteraction({
      request: { kind: 'ask_user_question', requestId: 'ask-1', questions: [{ question: 'q' }] },
    } as unknown as PendingInteraction)).toBe(true);
    expect(canCollapsePendingInteraction({
      request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash' },
    } as unknown as PendingInteraction)).toBe(true);
    expect(canCollapsePendingInteraction({
      request: { kind: 'plan_review', requestId: 'plan-1', plan: 'x' },
    } as unknown as PendingInteraction)).toBe(true);
    expect(canCollapsePendingInteraction({
      request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 },
    } as unknown as PendingInteraction)).toBe(false);
    expect(canCollapsePendingInteraction({
      request: { kind: 'issue_confirm', requestId: 'issue-1' },
    } as unknown as PendingInteraction)).toBe(false);
    expect(canCollapsePendingInteraction(null)).toBe(false);
  });

  it('summarizes what each pending kind is waiting on, without shared Chinese defaults', () => {
    expect(pendingInteractionSummaryText({
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1',
        questions: [{ question: '手机来源提示这一条，按哪种方式做?' }, { question: '第二问' }],
      },
    } as unknown as PendingInteraction)).toBe('手机来源提示这一条，按哪种方式做?');
    // 多问卡按当前进度取问题:收起条写第一问、展开后停在第二问就是错位(#1493 review)。
    expect(pendingInteractionSummaryText({
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1b',
        questions: [{ question: '第一问' }, { question: '第二问' }, { question: '第三问' }],
      },
    } as unknown as PendingInteraction, 2)).toBe('第三问');
    // 越界 / 非法索引夹回有效范围,不渲染 undefined。
    expect(pendingInteractionSummaryText({
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1c',
        questions: [{ question: '第一问' }, { question: '第二问' }],
      },
    } as unknown as PendingInteraction, 9)).toBe('第二问');
    expect(pendingInteractionSummaryText({
      request: {
        kind: 'ask_user_question',
        requestId: 'ask-1d',
        questions: [{ question: '第一问' }, { question: '第二问' }],
      },
    } as unknown as PendingInteraction, Number.NaN)).toBe('第一问');
    // permission 用工具名而非 permissionTitle:后者是共享层中文直出(「允许使用 X?」),
    // 直接渲染会让 en / ja / ko 下的收起条念混语。
    expect(pendingInteractionSummaryText({
      request: { kind: 'permission', requestId: 'perm-1', toolName: 'Bash', title: '允许使用 Bash?' },
    } as unknown as PendingInteraction)).toBe('Bash');
    // 计划卡取正文首行并剥掉 markdown 标题标记。
    expect(pendingInteractionSummaryText({
      request: { kind: 'plan_review', requestId: 'plan-1', plan: '\n## 重构 InteractionPanel\n- 第一步' },
    } as unknown as PendingInteraction)).toBe('重构 InteractionPanel');
    // 正文为空时退到文件路径,仍然给得出「在等什么」。
    expect(pendingInteractionSummaryText({
      request: { kind: 'plan_review', requestId: 'plan-2', plan: '   ', planFilePath: 'docs/plan.md' },
    } as unknown as PendingInteraction)).toBe('docs/plan.md');
    // 超长首行截断,收起条永远是一行。
    const long = pendingInteractionSummaryText({
      request: { kind: 'ask_user_question', requestId: 'ask-2', questions: [{ question: 'x'.repeat(200) }] },
    } as unknown as PendingInteraction);
    expect(long).toHaveLength(80);
    expect(long?.endsWith('…')).toBe(true);
    // 手机端终结不了的卡没有专属摘要,收起条退回队列标题。
    expect(pendingInteractionSummaryText({
      request: { kind: 'plugin_setup', requestId: 'setup-1', revision: 1 },
    } as unknown as PendingInteraction)).toBeNull();
  });

  // Bug #1493: an offline empty projection must never retire a collapsed request.
  it.each(['markDeviceOffline', 'markDevicesOffline', 'removeDevice', 'clear'] as const)('revokes pending authority through %s and publishes a fresh empty snapshot', (action) => {
    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('d1', 'Desktop', [{ id: 's1', name: 'Fixture', status: 'active' } as never]);
    remoteSessionStore.setPendingInteractions('s1', []);
    expect(remoteSessionStore.hasAuthoritativePendingInteractions('s1')).toBe(true);
    if (action === 'clear') remoteSessionStore.clear();
    else if (action === 'markDevicesOffline') remoteSessionStore.markDevicesOffline(['d1']);
    else remoteSessionStore[action]('d1');
    expect(remoteSessionStore.hasAuthoritativePendingInteractions('s1')).toBe(false);
    let notifications = 0;
    const unsubscribe = remoteSessionStore.subscribe(() => { notifications++; });
    try {
      remoteSessionStore.setPendingInteractions('s1', []);
      expect(remoteSessionStore.hasAuthoritativePendingInteractions('s1')).toBe(true);
      expect(notifications).toBe(1);
      remoteSessionStore.setPendingInteractions('s1', []);
      expect(notifications).toBe(1);
    } finally { unsubscribe(); remoteSessionStore.clear(); }
  });

  it('translates the collapse affordances in every locale', async () => {
    const previous = i18n.language;
    try {
      for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
        await i18n.changeLanguage(locale);
        for (const key of [
          'interaction.panel.collapse',
          'interaction.panel.collapsePendingCard',
          'interaction.panel.collapsedHint',
        ]) {
          expect(i18n.t(key), `${locale} ${key}`).not.toBe(key);
        }
        const expanded = i18n.t('interaction.panel.expandPendingCard', { title: 'Fixture question' });
        expect(expanded, `${locale} expandPendingCard`).toContain('Fixture question');
      }
    } finally {
      await i18n.changeLanguage(previous);
    }

    for (const lang of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
      const bundle = JSON.parse(readFileSync(resolve(process.cwd(), `src/i18n/locales/${lang}/interaction.json`), 'utf8'));
      expect(bundle.panel?.expandPendingCard, `${lang}/panel.expandPendingCard`).toContain('{{title}}');
      // 旧的问题卡专属文案随卡内收起一起下线,不留悬空 key。
      expect(bundle.panel?.collapseQuestionCard, `${lang}/panel.collapseQuestionCard`).toBeUndefined();
      expect(bundle.panel?.expandQuestionCard, `${lang}/panel.expandQuestionCard`).toBeUndefined();
    }
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

  it.each(['ask_user_question', 'plan_review'])('does not treat a rejected %s receipt as success even when the request is absent', async (kind) => {
    let queries = 0;
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => ({ accepted: false }),
      getPendingInteractions: async () => { queries++; return []; },
    }, 's1', 'req-1', { kind }, { sleep: noSleep })).rejects.toThrow(i18n.t('interaction.panel.decisionNotAccepted'));
    expect(queries).toBe(0);
  });

  it.each([{ accepted: true }, undefined])('accepts a successful or legacy receipt %j', async (receipt) => {
    await expect(mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => receipt,
      getPendingInteractions: async () => { throw new Error('should not reconcile'); },
    }, 's1', 'req-1', {}, { sleep: noSleep })).resolves.toBeUndefined();
  });

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

  it('BACKPRESSURE 自动退避重试，被控端未执行时不误报失败', async () => {
    let resolveCalls = 0;
    await mobileInteractionModel.resolveInteractionResilient({
      resolveInteraction: async () => {
        resolveCalls++;
        if (resolveCalls === 1) {
          throw Object.assign(new Error('buffer full'), { code: 'BACKPRESSURE' });
        }
      },
      getPendingInteractions: async () => {
        throw new Error('权威查询不应触发');
      },
    }, 's1', 'req-1', { behavior: 'allow' }, { sleep: noSleep });
    expect(resolveCalls).toBe(2);
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
