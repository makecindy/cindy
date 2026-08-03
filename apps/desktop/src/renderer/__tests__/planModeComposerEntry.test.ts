// @vitest-environment jsdom

/**
 * planModeComposerEntry.test.tsx
 * ---------------------------------------------------------------------------
 * issue #475 — 模式菜单一级入口的 DOM 级渲染断言:
 *   - ExtraDirsButton:「计划模式」/「协同模式」菜单项与「新建目标」同级;
 *     勾选态 aria-checked;单独提供任一模式也能渲染「+」按钮
 *   - PlanModeIndicator:激活 chip 文案 + 退出按钮;disabled 时隐藏退出按钮
 *   - PlanActionCard:取消收敛为次级动作(仅 Esc,无独立行)与 ⏎ 去重
 *     (编辑反馈时批准行 ⏎ 隐藏,反馈 ⏎ 仅在有文字时出现且可点击发送)
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { PlanActionCard } from '@/components/new-chat/PlanActionCard';
import { PlanModeIndicator } from '@/components/new-chat/PlanModeIndicator';
import { PlanViewerCard } from '@/components/new-chat/PlanViewerCard';
import type { InstalledGhost } from '../../shared/ghost';

const installedPlugin: InstalledGhost = {
  manifest: {
    schemaVersion: 2,
    id: 'cindy-art',
    name: 'Cindy Art',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'draw', description: 'Draw.' }],
    command: 'art',
  },
  dir: '/tmp/cindy-art',
  enabled: true,
};

const installedMermaidPlugin: InstalledGhost = {
  manifest: {
    schemaVersion: 2,
    id: 'cindy-mermaid',
    name: 'Mermaid',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'render', description: 'Render a Mermaid diagram.' }],
    command: 'mermaid',
  },
  dir: '/tmp/cindy-mermaid',
  enabled: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExtraDirsButton 模式菜单项', () => {
  it('附件接线单独存在时也渲染「+」入口，并把多选文件交给 composer', () => {
    const onAddFiles = vi.fn();
    const { container } = render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        onAddFiles,
      }),
    );
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(fileInput?.multiple).toBe(true);

    const trigger = screen.getByLabelText('extraDirs.menuAria');
    expect(trigger.getAttribute('aria-haspopup')).toBeNull();
    fireEvent.click(trigger);
    const openPicker = screen.getByRole('button', { name: 'extraDirs.addFiles' });
    const inputClick = vi.spyOn(fileInput!, 'click');
    fireEvent.click(openPicker);
    expect(inputClick).toHaveBeenCalledTimes(1);

    const image = new File(['image'], 'photo.png', { type: 'image/png' });
    const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(fileInput!, { target: { files: [image, video] } });
    expect(onAddFiles).toHaveBeenCalledWith([image, video]);
    expect(fileInput?.value).toBe('');
  });

  it('菜单打开后 composer 变为 disabled 时，附件行同步禁用', () => {
    const onAddFiles = vi.fn();
    const props = { extraDirs: [], onAddFiles };
    const { container, rerender } = render(createElement(ExtraDirsButton, props));
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    const inputClick = vi.spyOn(fileInput!, 'click');

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    rerender(createElement(ExtraDirsButton, { ...props, disabled: true }));

    const openPicker = screen.getByRole('button', { name: 'extraDirs.addFiles' });
    expect((openPicker as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(openPicker);
    expect(inputClick).not.toHaveBeenCalled();
  });

  it('codex 只凭 planMode 也渲染「+」入口, 菜单里出现计划模式 toggle', () => {
    const onToggle = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        planMode: { enabled: false, onToggle },
      }),
    );
    const trigger = screen.getByLabelText('extraDirs.menuAria');
    fireEvent.click(trigger);

    const item = screen.getByRole('menuitemcheckbox', { name: /planMode\.menuItem/ });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('开启态菜单项 aria-checked=true, 再点回调 false; 与新建目标同级共存', () => {
    const onToggle = vi.fn();
    const onNewGoal = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        onChange: () => {},
        onNewGoal,
        planMode: { enabled: true, onToggle },
      }),
    );
    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));

    // 新建目标与计划模式同级出现在同一菜单
    expect(screen.getByText('goal.newGoalMenuItem')).toBeTruthy();
    const item = screen.getByRole('menuitemcheckbox', { name: /planMode\.menuItem/ });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('只凭协同模式也渲染「+」入口, 关闭态点击打开完整 Worker 配置', () => {
    const onChange = vi.fn();
    const onOpenDetails = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        collaboration: {
          enabled: false,
          worker: 'codex',
          onChange,
          onOpenDetails,
        },
      }),
    );

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'newChat.collaboration.modeLabel',
    });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('协同开启态与目标/计划同级共存, 使用橙色状态并可直接关闭', () => {
    const onChange = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        onChange: () => {},
        onNewGoal: vi.fn(),
        planMode: { enabled: false, onToggle: vi.fn() },
        collaboration: { enabled: true, worker: 'cc', onChange },
      }),
    );

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    expect(screen.getByText('goal.newGoalMenuItem')).toBeTruthy();
    expect(screen.getByText('planMode.menuItem')).toBeTruthy();
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'newChat.collaboration.modeLabel',
    });
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(item.className).toContain('bg-[var(--model-item-hover)]');
    expect(screen.getByText('newChat.collaboration.modeLabel').className).toContain(
      'text-[var(--warning-accent)]',
    );
    expect(item.querySelector('svg.lucide-check')).toBeTruthy();
    fireEvent.click(item);
    expect(onChange).toHaveBeenCalledWith({ enabled: false, worker: 'cc' });
  });

  it('策略暂不可用时保留可重试的协同菜单项', () => {
    const onDisabledActivate = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        collaboration: {
          enabled: false,
          worker: 'pi',
          onChange: vi.fn(),
          disabled: true,
          disabledReason: 'policy unavailable',
          onDisabledActivate,
        },
      }),
    );

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    const item = screen.getByRole('menuitemcheckbox', {
      name: 'newChat.collaboration.modeLabel: policy unavailable',
    });
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(item);
    expect(onDisabledActivate).toHaveBeenCalledTimes(1);
  });

  it('没有任何入口时保持不渲染', () => {
    const { container } = render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('Codex 接入 onChange 后显示引用目录、数量与增删入口', () => {
    const onChange = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: ['/repo-shared'],
        workingDir: '/repo',
        onChange,
      }),
    );

    expect(screen.getByText('×1')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    expect(screen.getByText('extraDirs.sectionTitle')).toBeTruthy();
    expect(screen.getByText('repo-shared')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('extraDirs.remove'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('展示所有已安装 Plugin，并把可用项交给 composer 放置', () => {
    const onPluginSelect = vi.fn();
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        plugins: [installedPlugin],
        onPluginSelect,
      }),
    );

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    expect(screen.getByText('extraDirs.pluginsTitle')).toBeTruthy();
    const pluginRow = screen.getByRole('button', { name: 'Cindy Art' });
    expect(pluginRow.querySelector('span')?.className).toContain('size-5');
    fireEvent.click(pluginRow);
    expect(onPluginSelect).toHaveBeenCalledWith(installedPlugin);
  });

  it('复用 Plugin 页的功能兜底图标，避免无包内头像时入口不一致', () => {
    render(
      createElement(ExtraDirsButton, {
        extraDirs: [],
        plugins: [installedMermaidPlugin],
        onPluginSelect: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByLabelText('extraDirs.menuAria'));
    const pluginRow = screen.getByRole('button', { name: 'Mermaid' });
    expect(pluginRow.querySelector('svg.lucide-workflow')).toBeTruthy();
    expect(pluginRow.querySelector('svg.lucide-package')).toBeNull();
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
