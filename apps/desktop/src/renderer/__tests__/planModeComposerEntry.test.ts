// @vitest-environment jsdom

/**
 * planModeComposerEntry.test.tsx
 * ---------------------------------------------------------------------------
 * issue #475 — 模式入口与统一 composer 建议面板的 DOM 级渲染断言:
 *   - ExtraDirsButton 只保留 MorphPopover 触发器;
 *   - 计划模式 / 协同模式作为 action 与 @ 资源共用 AtMentionPanel;
 *   - PlanModeIndicator:激活 chip 文案 + 退出按钮;disabled 时隐藏退出按钮
 *   - PlanActionCard:取消收敛为次级动作(仅 Esc,无独立行)与 ⏎ 去重
 *     (编辑反馈时批准行 ⏎ 隐藏,反馈 ⏎ 仅在有文字时出现且可点击发送)
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ExtraDirsButton 的目录添加确认弹窗依赖 Provider;本测试只覆盖菜单项渲染,mock 掉。
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: async () => true }),
}));

vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: () => null,
}));

import { ExtraDirsButton } from '@/components/new-chat/ExtraDirsButton';
import { AtMentionPanel } from '@/components/new-chat/AtMentionPanel';
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';
import { PlanModeIndicator } from '@/components/new-chat/PlanModeIndicator';
import { PlanViewerCard } from '@/components/new-chat/PlanViewerCard';
import {
  buildComposerSuggestionEntries,
  nextEnabledSuggestionIndex,
  type ComposerSuggestionAction,
  type ComposerSuggestionEntry,
  type ComposerPluginSuggestion,
} from '@/lib/composerSuggestion';

const iosSimulatorPluginSuggestion: ComposerPluginSuggestion = {
  item: {
    type: 'plugin-command',
    name: 'iOS Simulator',
    relPath: 'cindy://host-capability/ios-simulator',
    pluginId: 'ios-simulator',
  },
};

const disabledIOSSimulatorPluginSuggestion: ComposerPluginSuggestion = {
  ...iosSimulatorPluginSuggestion,
  disabled: true,
  disabledReason: 'extraDirs.pluginDisabled',
};

const skillOnlyPluginSuggestion: ComposerPluginSuggestion = {
  item: {
    type: 'plugin-command',
    name: 'Skill only',
    relPath: 'cindy://plugin/skill-only',
    pluginId: 'skill-only',
  },
  disabled: true,
  disabledReason: 'extraDirs.pluginAgentInvoked',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('统一 composer 建议入口', () => {
  it('ExtraDirsButton 保留 MorphPopover 触发器、按下态与引用目录数量', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      createElement(ExtraDirsButton, {
        extraDirsCount: 2,
        hasReferenceDirs: true,
        open: false,
        onOpenChange,
        panel: createElement('div', {}, 'panel'),
      }),
    );
    expect(screen.getByText('×2')).toBeTruthy();
    const trigger = screen.getByLabelText('extraDirs.menuAria');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(
      createElement(ExtraDirsButton, {
        extraDirsCount: 2,
        hasReferenceDirs: true,
        open: true,
        onOpenChange,
        panel: createElement('div', {}, 'panel'),
      }),
    );
    expect(
      screen.getByRole('button', { name: 'extraDirs.menuAria' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('计划模式、协同与 Plugin 进入同一 AtMentionPanel', () => {
    const onPlanToggle = vi.fn();
    const actions: ComposerSuggestionAction[] = [
      {
        id: 'new-goal',
        label: 'goal.newGoalMenuItem',
        run: vi.fn(),
      },
      {
        id: 'plan-mode',
        label: 'planMode.menuItem',
        checked: true,
        run: () => onPlanToggle(false),
      },
      {
        id: 'collaboration',
        label: 'newChat.collaboration.modeLabel',
        checked: false,
        disabled: true,
        disabledReason: 'policy unavailable',
        run: vi.fn(),
      },
    ];
    const entries = buildComposerSuggestionEntries({
      query: '',
      actions,
      resources: [],
      plugins: [
        {
          item: {
            type: 'plugin-command',
            name: 'Cindy Art',
            relPath: 'art',
            pluginId: 'cindy-art',
          },
        },
      ],
    });
    const onSelect = (entry: ComposerSuggestionEntry) => {
      if (entry.kind === 'action') entry.action.run();
    };
    render(
      createElement(AtMentionPanel, {
        query: '',
        state: { kind: 'ready', items: [], truncated: false },
        entries,
        focusedIndex: 0,
        onFocusedIndexChange: vi.fn(),
        onSelect,
        onClose: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(screen.getByText('goal.newGoalMenuItem')).toBeTruthy();
    expect(screen.getByText('Cindy Art')).toBeTruthy();
    const plan = screen.getByRole('menuitemcheckbox', { name: 'planMode.menuItem' });
    expect(plan.getAttribute('aria-checked')).toBe('true');
    expect(plan.className).toContain('rounded-[8px]');
    expect(plan.className).toContain('px-3');
    expect(plan.className).toContain('py-2');
    expect(plan.className).toContain('hover:bg-[var(--model-item-hover)]');
    fireEvent.click(plan);
    expect(onPlanToggle).toHaveBeenCalledWith(false);
    expect(
      (
        screen.getByRole('menuitemcheckbox', {
          name: 'newChat.collaboration.modeLabel: policy unavailable',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('键盘导航跳过 disabled 条目', () => {
    const entries: ComposerSuggestionEntry[] = [
      {
        kind: 'action',
        action: { id: 'new-goal', label: 'goal', disabled: true, run: vi.fn() },
      },
      {
        kind: 'action',
        action: { id: 'plan-mode', label: 'plan', checked: false, run: vi.fn() },
      },
    ];
    expect(nextEnabledSuggestionIndex(entries, 1, 1)).toBe(1);
    expect(nextEnabledSuggestionIndex(entries, 0, 1)).toBe(1);
    expect(nextEnabledSuggestionIndex(entries, 1, -1)).toBe(1);
  });

  it('引用目录管理复用统一面板的独立 section，移除按钮支持键盘访问', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const entries = buildComposerSuggestionEntries({
      query: '',
      actions: [{ id: 'add-extra-dir', label: 'extraDirs.add', run: vi.fn() }],
      resources: [],
      plugins: [],
    });
    render(
      createElement(AtMentionPanel, {
        query: '',
        state: { kind: 'ready', items: [], truncated: false },
        entries,
        focusedIndex: 0,
        onFocusedIndexChange: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onRetry: vi.fn(),
        referenceDirs: { dirs: ['/repo-shared'], onRemove },
      }),
    );
    expect(screen.getByText('extraDirs.sectionTitle')).toBeTruthy();
    expect(screen.getByText('repo-shared')).toBeTruthy();
    const removeButton = screen.getByLabelText('extraDirs.remove');
    expect(removeButton.className).toContain('focus-visible:opacity-100');
    expect(removeButton.className).toContain('focus-visible:ring-2');
    removeButton.focus();
    expect(document.activeElement).toBe(removeButton);
    await user.keyboard('{Enter}');
    expect(onRemove).toHaveBeenCalledWith('/repo-shared');
  });

  it('Host capability 插件由统一建议面板交给 composer 处理，不伪造 command', () => {
    const entries = buildComposerSuggestionEntries({
      query: '',
      actions: [],
      resources: [],
      plugins: [iosSimulatorPluginSuggestion],
    });
    const onSelect = vi.fn();
    render(
      createElement(AtMentionPanel, {
        query: '',
        state: { kind: 'ready', items: [], truncated: false },
        entries,
        focusedIndex: 0,
        onFocusedIndexChange: vi.fn(),
        onSelect,
        onClose: vi.fn(),
        onRetry: vi.fn(),
        embedded: true,
      }),
    );

    const pluginRow = screen.getByRole('button', { name: 'iOS Simulator' });
    expect((pluginRow as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(pluginRow);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'resource',
      item: iosSimulatorPluginSuggestion.item,
    });
  });

  it('已停用优先显示停用状态；可用但无直接入口的 Skill 标为 Agent 自动调用', () => {
    const disabledEntries = buildComposerSuggestionEntries({
      query: '',
      actions: [],
      resources: [],
      plugins: [disabledIOSSimulatorPluginSuggestion],
    });
    const { rerender } = render(
      createElement(AtMentionPanel, {
        query: '',
        state: { kind: 'ready', items: [], truncated: false },
        entries: disabledEntries,
        focusedIndex: 0,
        onFocusedIndexChange: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onRetry: vi.fn(),
        embedded: true,
      }),
    );
    expect(screen.getByText('extraDirs.pluginDisabled')).toBeTruthy();

    const skillOnlyEntries = buildComposerSuggestionEntries({
      query: '',
      actions: [],
      resources: [],
      plugins: [skillOnlyPluginSuggestion],
    });
    rerender(
      createElement(AtMentionPanel, {
        query: '',
        state: { kind: 'ready', items: [], truncated: false },
        entries: skillOnlyEntries,
        focusedIndex: 0,
        onFocusedIndexChange: vi.fn(),
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onRetry: vi.fn(),
        embedded: true,
      }),
    );
    expect(screen.getByText('extraDirs.pluginAgentInvoked')).toBeTruthy();
  });
});

describe('PlanModeIndicator 激活 chip', () => {
  it('渲染标题与提示, 点 X 触发退出', () => {
    const onExit = vi.fn();
    render(createElement(PlanModeIndicator, { onExit }));
    expect(screen.getByText('planMode.indicator.title')).toBeTruthy();
    expect(screen.getByText('planMode.indicator.hint')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('planMode.exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('disabled 时隐藏退出按钮', () => {
    render(createElement(PlanModeIndicator, { onExit: () => {}, disabled: true }));
    expect(screen.queryByLabelText('planMode.exit')).toBeNull();
  });
});

describe('PlanActionCard 取消(Esc)与 ⏎ 去重', () => {
  it('取消是次级动作:不渲染独立取消行, Esc(非编辑态)触发 onCancel', () => {
    const onCancel = vi.fn();
    render(createElement(PlanActionCard, { requestId: 'pr-2', onRespond: vi.fn(), onCancel }));
    // 不与批准/反馈同级 —— 卡片里没有取消行文案
    expect(screen.queryByText('newChat.planReview.cancel')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledWith('pr-2');
  });

  it('编辑反馈时批准行 ⏎ 隐藏; 反馈 ⏎ 仅在有文字时出现且点击即发送', () => {
    const onRespond = vi.fn();
    const { container } = render(
      createElement(PlanActionCard, { requestId: 'pr-4', onRespond, onCancel: vi.fn() }),
    );
    // 初始:只有批准行一个 ⏎(lucide corner-down-left)
    const enterIcons = () => container.querySelectorAll('svg.lucide-corner-down-left');
    expect(enterIcons()).toHaveLength(1);

    // 进入反馈编辑:批准行 ⏎ 隐藏,空文本时无发送 ⏎ → 0 个
    fireEvent.click(screen.getByText('newChat.planReview.feedbackPlaceholder'));
    expect(enterIcons()).toHaveLength(0);

    // 输入文字 → 发送 ⏎ 出现(全程唯一),点击即提交反馈
    const textarea = screen.getByPlaceholderText('newChat.planReview.feedbackPlaceholder');
    fireEvent.change(textarea, { target: { value: '再加一步测试' } });
    expect(enterIcons()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('newChat.planReview.submitFeedbackAria'));
    expect(onRespond).toHaveBeenCalledWith('pr-4', false, '再加一步测试');
  });

  it('工具条取消按钮聚焦时 Enter 触发取消, 不触发全局批准', () => {
    const onCancel = vi.fn();
    const onRespond = vi.fn();
    render(
      createElement(
        'div',
        {},
        createElement(PlanViewerCard, {
          pending: {
            requestId: 'pr-5',
            plan: '# Plan\n\n1. Do it',
            planFilePath: '/repo/plan.md',
          },
          viewerState: 'expanded',
          workingDir: '/repo',
          lastExpandedState: 'expanded',
          onStateChange: vi.fn(),
          onCancel,
        }),
        createElement(PlanActionCard, { requestId: 'pr-5', onRespond, onCancel }),
      ),
    );

    const cancelButton = screen.getByLabelText('newChat.planReview.cancel (Esc)');
    fireEvent.keyDown(cancelButton, { key: 'Enter' });
    fireEvent.click(cancelButton);

    expect(onRespond).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
