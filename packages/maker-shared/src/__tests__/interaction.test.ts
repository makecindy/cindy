import { describe, expect, it } from 'vitest';
import {
  buildAskQuestionProgressSummary,
  buildAskQuestionReviewPresentation,
  buildAskUserQuestionDecision,
  buildIssueConfirmDecision,
  buildIssueConfirmDecisionSummary,
  buildIssueConfirmReviewPresentation,
  buildInteractionResolveActionPresentation,
  buildPendingInteractionQueuePresentation,
  buildPermissionDecision,
  buildPermissionDecisionSummary,
  buildPermissionReviewPresentation,
  buildPlanReviewDecision,
  buildPlanReviewDecisionSummary,
  buildPlanReviewEvidencePresentation,
  buildPluginSetupCancelDecision,
  buildRemotePluginSetupPresentation,
  canStartInteractionResolve,
  encodeMultiSelectAnswer,
  extractPlanOutline,
  formatPermissionInput,
  interactionBlocksRemoteComposer,
  normalizeAskQuestions,
  normalizeIssueConfirm,
  pendingInteractionsBlockRemoteComposer,
  permissionRiskSummary,
  permissionTitle,
  remoteInteractionHandling,
  selectActivePendingInteraction,
  selectionFromAnswer,
  sessionScopedPermissionSuggestions,
  sortPendingInteractions,
  type PendingInteractionLike,
} from '../interaction.js';

describe('interaction shared model', () => {
  it('builds resolve action presentation for requestId, busy, invalid, and confirm states', () => {
    expect(buildInteractionResolveActionPresentation({
      label: '允许一次',
      requestId: 'p1',
    })).toEqual({
      disabled: false,
      disabledReason: null,
      label: '允许一次',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '允许一次',
      confirmLabel: '确认允许一次',
      armed: true,
      requestId: 'p1',
    })).toMatchObject({
      disabled: false,
      label: '确认允许一次',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '允许一次',
      requestId: null,
    })).toEqual({
      disabled: true,
      disabledReason: '这个远程交互缺少 requestId，无法回传决定。',
      label: '允许一次',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '提交',
      busy: true,
      requestId: 'ask-1',
    })).toEqual({
      disabled: true,
      disabledReason: '正在把决定回传到电脑端，请不要重复提交。',
      label: '提交中',
    });

    expect(buildInteractionResolveActionPresentation({
      label: '确认提交',
      invalidReason: '补齐标题和正文后才能提交。',
      requestId: 'issue-1',
    })).toEqual({
      disabled: true,
      disabledReason: '补齐标题和正文后才能提交。',
      label: '确认提交',
    });
  });

  it('guards duplicate resolve submissions by requestId', () => {
    expect(canStartInteractionResolve({
      requestId: 'permission-1',
      submittingRequestId: null,
    })).toBe(true);
    expect(canStartInteractionResolve({
      requestId: 'permission-1',
      submittingRequestId: 'permission-1',
    })).toBe(false);
    expect(canStartInteractionResolve({
      requestId: null,
      submittingRequestId: 'permission-1',
    })).toBe(false);
  });

  it('builds decision summaries for pending interaction cards', () => {
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

    expect(buildIssueConfirmDecisionSummary({
      type: 'bug',
      canSubmit: false,
    })).toEqual({
      title: '补齐标题和正文后才能提交',
      detail: '类型: Bug',
    });
  });

  it('formats permission requests like the desktop prompt', () => {
    expect(formatPermissionInput('Bash', { command: 'pnpm test' })).toBe('pnpm test');
    expect(formatPermissionInput('Write', { file_path: '/repo/a.ts', content: 'x' })).toBe('/repo/a.ts');
    expect(permissionTitle({ kind: 'permission', requestId: 'p1', toolName: 'Bash' })).toBe(
      '允许使用 Bash?',
    );
  });

  it('builds compact permission review evidence for mobile approval cards', () => {
    const presentation = buildPermissionReviewPresentation({
      kind: 'permission',
      requestId: 'p1',
      toolName: 'Bash',
      input: { command: 'git reset --hard HEAD && rm -rf node_modules' },
      suggestions: [
        { destination: 'session', rules: [{ toolName: 'Bash' }] },
        { destination: 'project', rules: [{ toolName: 'Bash' }] },
      ],
    });

    expect(presentation).toMatchObject({
      canAlwaysAllow: true,
      code: 'git reset --hard HEAD && rm -rf node_modules',
      riskSummary: expect.stringContaining('可能修改系统'),
      summary: {
        title: '高风险授权需要二次确认',
        detail: '先核对命令内容，再点一次确认允许；不确定就拒绝。',
      },
      title: '允许使用 Bash?',
      toolName: 'Bash',
    });
  });

  it('builds ask question review presentation for mobile answer cards', () => {
    const presentation = buildAskQuestionReviewPresentation({
      currentIndex: 4,
      questions: [{
        header: '测试计划',
        question: 'iOS 视觉回归先覆盖哪一类交互?',
        multiSelect: true,
        options: [
          { label: 'Pending 队列', description: '覆盖当前和后续待处理请求。' },
          { label: '消息渲染' },
        ],
      }],
    });

    expect(presentation).toMatchObject({
      allowsCustomAnswer: true,
      currentIndex: 0,
      currentNumber: 1,
      header: '测试计划',
      multiSelect: true,
      optionCount: 2,
      pageLabel: '1/1',
      summary: {
        title: '第 1/1 个问题',
        detail: '可多选，也可以输入其他回答。',
      },
      title: 'iOS 视觉回归先覆盖哪一类交互?',
      totalCount: 1,
    });

    expect(buildAskQuestionReviewPresentation({ currentIndex: 0, questions: [] })).toMatchObject({
      allowsCustomAnswer: false,
      current: null,
      pageLabel: '0/0',
      summary: {
        title: '没有具体问题',
        detail: '可以提交空回答让电脑端继续。',
      },
    });
  });

  it('builds issue confirm review presentation for mobile confirmation cards', () => {
    expect(buildIssueConfirmReviewPresentation({
      draft: {
        title: 'Mobile fixture issue',
        body: 'Generated by the mock host controls scenario.',
        type: 'bug',
      },
      env: {
        appVersion: '0.0.0-mobile-e2e',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: 'fixture',
      },
      uiLanguage: 'zh-CN',
    })).toEqual({
      bodyCharCount: 45,
      canSubmit: true,
      envLabel: '0.0.0-mobile-e2e / darwin / arm64 / fixture / zh-CN',
      issueTypeLabel: 'Bug',
      summary: {
        title: '草稿完整，可以确认提交',
        detail: '类型: Bug',
      },
      titleCharCount: 20,
    });
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

  it('builds compact plan review evidence for mobile approval surfaces', () => {
    const presentation = buildPlanReviewEvidencePresentation({
      edited: true,
      filePath: '/tmp/xdt-maker-mobile-visual/mobile-v1-plan.md',
      maxOutlineItems: 2,
      plan: [
        '# Mobile Remote Control',
        '先把 iOS 端远程控制流程做成稳定体验。',
        '## Shared Core',
        '- 使用桌面一致的展示模型。',
        '## Visual Tests',
        '- 截图基线必须覆盖 pending。',
      ].join('\n'),
    });

    expect(presentation).toMatchObject({
      compactPath: '.../mobile-v1-plan.md',
      fileName: 'mobile-v1-plan.md',
      filePath: '/tmp/xdt-maker-mobile-visual/mobile-v1-plan.md',
      hasPlanText: true,
      outlineOverflowCount: 1,
      outlineTotalCount: 3,
      summary: {
        title: '已编辑计划，批准后按当前版本执行',
        detail: '3 个章节 · 有计划文件',
      },
    });
    expect(presentation.outlineItems.map((item) => item.title)).toEqual([
      'Mobile Remote Control',
      'Shared Core',
    ]);
  });

  it('matches the desktop pending-interaction priority order', () => {
    const interactions: PendingInteractionLike[] = [
      { request: { kind: 'issue_confirm', requestId: 'issue-1' } },
      { request: { kind: 'ask_user_question', requestId: 'ask-1' } },
      { request: { kind: 'permission', requestId: 'permission-1' } },
      { request: { kind: 'plan_review', requestId: 'plan-1' } },
      { request: { kind: 'plugin_setup', requestId: 'setup-1' } },
      { request: { kind: 'custom', requestId: 'custom-1' } },
    ];

    expect(sortPendingInteractions(interactions).map((item) => item.request.requestId)).toEqual([
      'plan-1',
      'permission-1',
      'ask-1',
      'issue-1',
      'setup-1',
      'custom-1',
    ]);
    expect(selectActivePendingInteraction(interactions)?.request.requestId).toBe('plan-1');
    expect(selectActivePendingInteraction([])).toBeNull();
  });

  it('projects a mobile-friendly pending interaction queue from desktop priority order', () => {
    const interactions: PendingInteractionLike[] = [
      { request: { kind: 'issue_confirm', requestId: 'issue-1' } },
      { request: { kind: 'ask_user_question', requestId: 'ask-1' } },
      { request: { kind: 'permission', requestId: 'permission-1' } },
      { request: { kind: 'plan_review', requestId: 'plan-1' } },
      { request: { kind: 'custom', requestId: 'custom-1' } },
    ];

    expect(buildPendingInteractionQueuePresentation(interactions, { maxVisible: 3 })).toMatchObject({
      countLabel: '5 个',
      hint: '先看计划，必要时反馈修改，确认后电脑端才继续执行。',
      overflowCount: 2,
      title: '需要确认执行计划',
      totalCount: 5,
      items: [
        {
          active: true,
          kind: 'plan_review',
          label: '计划',
          positionLabel: '当前',
          requestId: 'plan-1',
        },
        {
          active: false,
          kind: 'permission',
          label: '授权',
          positionLabel: '接着',
          requestId: 'permission-1',
        },
        {
          active: false,
          kind: 'ask_user_question',
          label: '问题',
          positionLabel: '第 3',
          requestId: 'ask-1',
        },
      ],
    });

    expect(buildPendingInteractionQueuePresentation(interactions, { readOnly: true }).hint)
      .toBe('协作只读模式，仅展示电脑端请求。');
    expect(buildPendingInteractionQueuePresentation([])).toMatchObject({
      active: null,
      countLabel: '当前',
      title: '没有待处理请求',
      totalCount: 0,
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

  it('normalizes issue confirmation and builds bridge-compatible decisions', () => {
    const payload = normalizeIssueConfirm({
      kind: 'issue_confirm',
      requestId: 'i1',
      draft: { title: 'Bug', body: 'Steps', type: 'bug' },
      env: { appVersion: '0.1.0', platform: 'darwin', arch: 'arm64' },
    });

    expect(payload).toMatchObject({
      draft: { title: 'Bug', body: 'Steps', type: 'bug' },
      env: { appVersion: '0.1.0', platform: 'darwin', arch: 'arm64' },
    });
    expect(buildIssueConfirmDecision(true, payload!.draft, 'zh-CN')).toEqual({
      confirmed: true,
      title: 'Bug',
      body: 'Steps',
      type: 'bug',
      uiLanguage: 'zh-CN',
    });
    expect(buildIssueConfirmDecision(false)).toEqual({ confirmed: false });
  });

  it('only lets remotely resolvable interactions take over the controller composer', () => {
    expect(remoteInteractionHandling({ request: { kind: 'permission', requestId: 'p1' } })).toBe('resolvable');
    expect(remoteInteractionHandling({ request: { kind: 'ask_user_question', requestId: 'a1' } })).toBe('resolvable');
    expect(remoteInteractionHandling({ request: { kind: 'plan_review', requestId: 'pl1' } })).toBe('resolvable');
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 's1', revision: 1 } })).toBe('cancel-only');
    // 收尾帧不再 actionable,取消也没有意义。
    expect(remoteInteractionHandling({
      request: { kind: 'plugin_setup', requestId: 's1', revision: 2, terminal: true },
    })).toBe('desktop-only');
    // cancel-only 与 buildPluginSetupCancelDecision 对齐:拿不到合法 revision 就不是
    // 「能取消」,否则调用方只看 handling 会误判。
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 's1' } })).toBe('desktop-only');
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 's1', revision: 1.5 } })).toBe('desktop-only');
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 's1', revision: -1 } })).toBe('desktop-only');
    expect(remoteInteractionHandling({ request: { kind: 'plugin_setup', requestId: 's1', revision: 0 } })).toBe('cancel-only');
    expect(remoteInteractionHandling({ request: { kind: 'issue_confirm', requestId: 'i1' } })).toBe('desktop-only');
    // 被控端将来新增的类型默认落进「不阻塞」,不会再把手机会话锁死。
    expect(remoteInteractionHandling({ request: { kind: 'future_kind', requestId: 'f1' } })).toBe('desktop-only');

    expect(interactionBlocksRemoteComposer({ request: { kind: 'permission', requestId: 'p1' } })).toBe(true);
    expect(interactionBlocksRemoteComposer({ request: { kind: 'plugin_setup', requestId: 's1', revision: 1 } })).toBe(false);
    expect(interactionBlocksRemoteComposer({ request: { kind: 'future_kind', requestId: 'f1' } })).toBe(false);
    expect(interactionBlocksRemoteComposer(null)).toBe(false);
  });

  it('keys composer blocking off the whole pending set, not the card being viewed', () => {
    // 混合队列:切到 plugin_setup 只是换了查看对象,那张权限卡仍在等回答 —— 输入框
    // 不能因此放开,否则用户绕过了仍待处理的阻塞交互。
    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 's1', revision: 1 } },
      { request: { kind: 'permission', requestId: 'p1' } },
    ])).toBe(true);

    // 整批都是本端终结不了的卡:输入框回来。
    expect(pendingInteractionsBlockRemoteComposer([
      { request: { kind: 'plugin_setup', requestId: 's1', revision: 1 } },
      { request: { kind: 'issue_confirm', requestId: 'i1' } },
      { request: { kind: 'future_kind', requestId: 'f1' } },
    ])).toBe(false);

    expect(pendingInteractionsBlockRemoteComposer([])).toBe(false);
  });

  it('builds a revision-pinned plugin setup cancel decision and a readable remote summary', () => {
    expect(buildPluginSetupCancelDecision({
      kind: 'plugin_setup',
      requestId: 's1',
      revision: 3,
    })).toEqual({ kind: 'plugin_setup', action: 'cancel', expectedRevision: 3 });

    // revision 缺失 / 非法时不构造决定:被控端只接受与当前快照一致的 revision,
    // 发出去也只会被丢弃,调用方据此不给取消入口。
    expect(buildPluginSetupCancelDecision({ kind: 'plugin_setup', requestId: 's1' })).toBeNull();
    expect(buildPluginSetupCancelDecision({ kind: 'plugin_setup', requestId: 's1', revision: 1.5 })).toBeNull();
    expect(buildPluginSetupCancelDecision({ kind: 'plugin_setup', requestId: 's1', revision: -1 })).toBeNull();
    expect(buildPluginSetupCancelDecision({ kind: 'permission', requestId: 'p1', revision: 1 })).toBeNull();

  });

  it('projects a full read-only plugin setup status card for controllers', () => {
    const presentation = buildRemotePluginSetupPresentation({
      kind: 'plugin_setup',
      requestId: 's1',
      revision: 2,
      ghost: {
        id: 'cindy-web-search',
        name: ' Cindy Web Search ',
        iconDataUrl: 'data:image/png;base64,AAAA',
      },
      intro: ' 需要一个搜索 API key ',
      steps: [
        {
          id: 'brave',
          groupId: 'search-key',
          groupMode: 'any_of',
          title: ' Brave key ',
          description: ' 用 Brave 的搜索 API ',
          phase: 'failed',
          errorCode: 'SAVE_FAILED',
          action: {
            id: 'inline:opaque',
            kind: 'inline_form',
            form: { fields: [{ id: 'value', type: 'secret', label: ' Brave API key ' }] },
          },
        },
        {
          id: 'tavily',
          groupId: 'search-key',
          groupMode: 'any_of',
          title: 'Tavily key',
          phase: 'pending',
          action: { id: 'oauth:opaque', kind: 'oauth_connect' },
        },
        {
          id: 'model',
          groupId: 'model',
          groupMode: 'any_of',
          title: '连接模型服务',
          phase: 'satisfied',
        },
      ],
    });

    expect(presentation).toEqual({
      ghostName: 'Cindy Web Search',
      iconDataUrl: 'data:image/png;base64,AAAA',
      intro: '需要一个搜索 API key',
      satisfiedCount: 1,
      stepCount: 3,
      terminal: false,
      groups: [
        {
          id: 'search-key',
          // 组内两项 → 「任选其一」
          anyOf: true,
          steps: [
            {
              id: 'brave',
              title: 'Brave key',
              description: '用 Brave 的搜索 API',
              phase: 'failed',
              errorCode: 'SAVE_FAILED',
              actionKind: 'inline_form',
              inlineFieldLabel: 'Brave API key',
            },
            {
              id: 'tavily',
              title: 'Tavily key',
              description: null,
              phase: 'pending',
              errorCode: null,
              actionKind: 'oauth_connect',
              inlineFieldLabel: null,
            },
          ],
        },
        {
          id: 'model',
          // 单项组没有「任选其一」语义,提示只会让用户困惑
          anyOf: false,
          steps: [{
            id: 'model',
            title: '连接模型服务',
            description: null,
            phase: 'satisfied',
            errorCode: null,
            actionKind: null,
            inlineFieldLabel: null,
          }],
        },
      ],
    });
  });

  it('collapses unknown plugin setup enums instead of passing them through to copy lookups', () => {
    const presentation = buildRemotePluginSetupPresentation({
      kind: 'plugin_setup',
      requestId: 's1',
      revision: 1,
      terminal: true,
      steps: [
        // 被控端新版本引入的值:降级为 null,少一个徽标而不是查表查出 key 字面量
        { id: 'a', title: 'A', phase: 'teleporting', errorCode: 'NOT_A_CODE', action: { id: 'x', kind: 'mind_control' } },
        { id: 'b', title: '   ' },
        'not-a-step',
      ],
    });

    expect(presentation.terminal).toBe(true);
    expect(presentation.stepCount).toBe(1);
    expect(presentation.groups).toEqual([{
      id: 'a-group',
      anyOf: false,
      steps: [{
        id: 'a',
        title: 'A',
        description: null,
        phase: null,
        errorCode: null,
        actionKind: null,
        inlineFieldLabel: null,
      }],
    }]);

    // 远程 URL 图标一律丢弃:只接受内联 data:image/。
    expect(buildRemotePluginSetupPresentation({
      kind: 'plugin_setup',
      requestId: 's1',
      ghost: { id: 'g', name: 'G', iconDataUrl: 'https://example.com/icon.png' },
    }).iconDataUrl).toBeNull();

    // 换个 kind 传进来必须返回空投影,而不是从任意 request 上刮字段让误用「看起来正常」。
    expect(buildRemotePluginSetupPresentation({
      kind: 'permission',
      requestId: 'p1',
      ghost: { id: 'x', name: 'Not a plugin setup' },
      intro: 'nope',
      steps: [{ id: 's', title: 'nope' }],
    })).toEqual({
      ghostName: null,
      iconDataUrl: null,
      intro: null,
      groups: [],
      satisfiedCount: 0,
      stepCount: 0,
      terminal: false,
    });
  });
});
