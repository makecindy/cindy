// @vitest-environment jsdom

/**
 * agentSelect.test.tsx
 * ---------------------------------------------------------------------------
 * 覆盖引擎(harness)选择器的三层约定:
 *
 *   A. AgentSelect 控件
 *      1. trigger 显示当前引擎,展开后每个引擎一行、当前项打勾
 *      2. 选中另一个引擎 → onChange 带新 vendor;选中当前项不重复回调
 *      3. 打开时初始焦点落在**当前选中行**(不是第一行)——键盘用户上来就站在
 *         「上次用的引擎」上
 *      4. disabled 时点击不展开
 *
 *   B. 选项表单一来源
 *      AGENT_OPTIONS 由 lib/agentVendors 的 SELECTABLE_VENDORS 派生,顺序一致、
 *      每项都有 label 与 Mark —— 新增引擎时两个控件同时生效,不会漏一处。
 *
 * 「引擎选择跨重启保留」的回归在 newMakerDraft.test.ts(它持有 localStorage stub)。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentSelect } from '@/components/new-chat/AgentSelect';
import { AGENT_OPTIONS } from '@/components/new-chat/agentOptions';
import { SELECTABLE_VENDORS, isSelectableVendor } from '@/lib/agentVendors';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'newChat.agentSelect.label') return '引擎';
      if (key === 'newChat.agentSelect.trigger.aria') return `选择引擎：${options?.agent ?? ''}`;
      return key;
    },
  }),
}));

// MorphPopover 的形变动画依赖 getBoundingClientRect / rAF 测量,jsdom 下无意义;
// 但它的**聚焦优先级**是本组件的关键契约,必须如实复刻:形变结束后聚焦
// [data-morph-autofocus] → input → 面板内第一个可交互项。只把动画摘掉、聚焦
// 照搬,漏标记 data-morph-autofocus 时焦点会落到第一行,测试即刻失败
// (真实实现见 components/ui/morph-popover.tsx 的 focus target 选择)。
vi.mock('@/components/ui/morph-popover', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    MorphPopover: ({ open, trigger, children }: {
      open: boolean;
      trigger: React.ReactNode;
      children: React.ReactNode;
    }) => {
      const panelRef = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        if (!panel) return;
        const target =
          panel.querySelector<HTMLElement>('[data-morph-autofocus]:not([disabled])') ??
          panel.querySelector<HTMLElement>('input, textarea') ??
          panel.querySelector<HTMLElement>('button:not([disabled]), [role="option"]') ??
          panel;
        target.focus({ preventScroll: true });
      }, [open]);
      return (
        <div>
          {trigger}
          {open ? (
            <div ref={panelRef} data-testid="agent-select-panel">
              {children}
            </div>
          ) : null}
        </div>
      );
    },
  };
});

describe('AgentSelect', () => {
  it('trigger 显示当前引擎;展开后每个引擎一行,当前项打勾', () => {
    render(<AgentSelect value="codex" onChange={() => {}} />);

    const trigger = screen.getByRole('button', { name: '选择引擎：Codex' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(AGENT_OPTIONS.length);
    expect(options.map((o) => o.textContent)).toEqual(AGENT_OPTIONS.map((o) => o.label));

    const selected = options.filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-testid')).toBe('agent-select-option-codex');
  });

  it('选中另一个引擎 → onChange 带新 vendor;选中当前项不重复回调', () => {
    const onChange = vi.fn();
    render(<AgentSelect value="codex" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Codex' }));
    fireEvent.click(screen.getByTestId('agent-select-option-cc'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('cc');

    onChange.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Codex' }));
    fireEvent.click(screen.getByTestId('agent-select-option-codex'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('打开时初始焦点落在当前选中行,不是第一行(经 data-morph-autofocus)', async () => {
    render(<AgentSelect value="codex" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Codex' }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('agent-select-option-codex'));
    });
    expect(document.activeElement).not.toBe(screen.getByTestId('agent-select-option-cc'));
    // 标记必须落在选中行上 —— MorphPopover 只认它,缺了就回落到第一行
    expect(
      screen.getByTestId('agent-select-option-codex').getAttribute('data-morph-autofocus'),
    ).toBe('true');
    expect(
      screen.getByTestId('agent-select-option-cc').getAttribute('data-morph-autofocus'),
    ).toBeNull();
  });

  it('中途 disabled 会收敛 open 状态,恢复可用后不会自己弹回来', () => {
    const { rerender } = render(<AgentSelect value="cc" onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Claude' }));
    expect(screen.getByTestId('agent-select-panel')).toBeTruthy();

    // worktree 创建中等场景:disabled 中途变 true
    rerender(<AgentSelect value="cc" onChange={() => {}} disabled />);
    expect(screen.queryByTestId('agent-select-panel')).toBeNull();

    // 恢复可用 —— 面板不应未经点击自己打开
    rerender(<AgentSelect value="cc" onChange={() => {}} />);
    expect(screen.queryByTestId('agent-select-panel')).toBeNull();
  });

  it('↑↓ 在选项间循环移动,末项回首项', async () => {
    render(<AgentSelect value={AGENT_OPTIONS[0].vendor} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: `选择引擎：${AGENT_OPTIONS[0].label}` }));

    const idOf = (i: number) => screen.getByTestId(`agent-select-option-${AGENT_OPTIONS[i].vendor}`);
    await waitFor(() => expect(document.activeElement).toBe(idOf(0)));

    // 依次 ↓ 走完全部选项,最后一项再 ↓ 回到首项(引擎数量无关)
    for (let i = 1; i < AGENT_OPTIONS.length; i += 1) {
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe(idOf(i));
    }
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(idOf(0));

    // ↑ 从首项回到末项
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(idOf(AGENT_OPTIONS.length - 1));
  });

  it('hiddenVendors 隐藏未注册的引擎,但当前选中值始终保留', () => {
    // Pi 二进制缺失时创建入口要隐藏,否则会建出 `Agent 'pi' is not registered` 的会话
    render(<AgentSelect value="cc" onChange={() => {}} hiddenVendors={['pi']} />);
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Claude' }));
    expect(screen.queryByTestId('agent-select-option-pi')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(AGENT_OPTIONS.length - 1);
  });

  it('hiddenVendors 含当前值时不隐藏它(否则触发器显示列表里没有的引擎)', () => {
    render(<AgentSelect value="pi" onChange={() => {}} hiddenVendors={['pi']} />);
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Pi' }));
    expect(screen.getByTestId('agent-select-option-pi')).toBeTruthy();
  });

  it('disabled 时点击不展开', () => {
    render(<AgentSelect value="cc" onChange={() => {}} disabled />);
    fireEvent.click(screen.getByRole('button', { name: '选择引擎：Claude' }));
    expect(screen.queryByTestId('agent-select-panel')).toBeNull();
  });

  it('触发器不设内联定宽,名称也不 flex-1(两者都会让短名后面留空白)', () => {
    // jsdom 没有布局,测不了像素;这里锁的是「造成空白的两个成因」不再出现:
    // 曾经写死 width=112 + 名称 flex-1,「Pi」这种短名后面拖一大截空白、
    // chevron 被顶到最右(用户实测反馈 2026-08-02)。实际观感以人工目检为准。
    render(<AgentSelect value="pi" onChange={() => {}} />);
    const trigger = screen.getByRole('button', { name: '选择引擎：Pi' });
    expect(trigger.style.width).toBe('');
    // 名称不能 flex-1 撑满 —— 撑满等价于定宽,chevron 照样被顶到最右
    const label = trigger.querySelector('span.truncate');
    expect(label).not.toBeNull();
    expect(label?.className).not.toContain('flex-1');
  });

  it('maxLabelWidth 只钳制名称,不给触发器定宽', () => {
    render(<AgentSelect value="cc" onChange={() => {}} maxLabelWidth={60} />);
    const trigger = screen.getByRole('button', { name: '选择引擎：Claude' });
    expect(trigger.style.width).toBe('');
    expect(trigger.querySelector<HTMLElement>('span.truncate')?.style.maxWidth).toBe('60px');
  });

  it('iconOnly 窄态不渲染名称,可访问名仍来自 aria-label', () => {
    render(<AgentSelect value="cc" onChange={() => {}} iconOnly />);
    const trigger = screen.getByRole('button', { name: '选择引擎：Claude' });
    expect(trigger.textContent).toBe('');
  });
});

describe('引擎选项表(单一来源)', () => {
  it('AGENT_OPTIONS 与 SELECTABLE_VENDORS 同序同长,且每项都有 label / Mark', () => {
    expect(AGENT_OPTIONS.map((o) => o.vendor)).toEqual([...SELECTABLE_VENDORS]);
    for (const opt of AGENT_OPTIONS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(typeof opt.Mark).toBe('function');
    }
  });

  it('isSelectableVendor 只认表内的引擎', () => {
    for (const v of SELECTABLE_VENDORS) expect(isSelectableVendor(v)).toBe(true);
    // 'orca' 不是用户可选引擎(已被协同 toggle 取代);其余非法输入一律拒绝
    for (const v of ['orca', '', 'claude-code', 42, null, undefined]) {
      expect(isSelectableVendor(v)).toBe(false);
    }
  });
});
