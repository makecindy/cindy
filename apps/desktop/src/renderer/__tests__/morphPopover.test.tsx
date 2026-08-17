// @vitest-environment jsdom

/**
 * MorphPopover(脱身上浮容器形变原语)交互契约。
 *
 * 2026-07-22 用户定稿:脱身上浮取代 origin/main 的「原位取代 + ghost 幽灵层」方案。
 * 故本文件按新语义重写(取代旧 ghost/left-定位/focus-first-action/scroll-close 契约):
 *   - 打开聚焦 [data-morph-autofocus] → 首个 input → 面板容器(不抢焦到首个按钮,§14.2)
 *   - 关闭仅键盘(Esc)归还 trigger 焦点;鼠标关闭(选项/outside)不回焦(防误弹 trigger tooltip)
 *   - outside pointerdown 关闭,但嵌套 Radix portal(data-radix-popper-content-wrapper)内不算 outside
 *   - trigger chip 全程可见(不隐藏),再点即关(toggle)
 *   - 无 ghost 幽灵层
 * jsdom 无布局引擎(rect 全 0),几何/丝滑度靠 DESIGN.md §14.4 实测兜底,不在此测。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MorphPopover } from '../components/ui/morph-popover';

function setReducedMotion(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function Harness({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <MorphPopover
        open={open}
        onOpenChange={setOpen}
        panelAriaLabel="Morph panel"
        trigger={
          <button type="button" onClick={() => setOpen((current) => !current)}>
            Toggle
          </button>
        }
      >
        {children ?? <button type="button">First action</button>}
      </MorphPopover>
      <button type="button">Outside</button>
      <div data-radix-popper-content-wrapper="">
        <button type="button">Nested portal action</button>
      </div>
    </>
  );
}

beforeEach(() => {
  // reduced-motion 直切:开场 focus 与收合卸载都无动画延时,断言稳定
  setReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MorphPopover interaction contract', () => {
  it('keeps the portaled panel outside Electron window drag regions', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });

    expect((panel.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion).toBe(
      'no-drag',
    );
  });

  it('打开聚焦首个可交互项;Esc 关闭并把焦点归还 trigger', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });

    fireEvent.click(trigger);
    const firstAction = await screen.findByRole('button', { name: 'First action' });
    // 无 autofocus/input 时落到首个可交互项(键盘可直接操作),不停在 role=group 容器
    await waitFor(() => expect(document.activeElement).toBe(firstAction));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
    // 键盘关闭:焦点归还 trigger(§14.2 无障碍)
    expect(document.activeElement).toBe(trigger);
  });

  it('焦点离开交互层(Tab 到面板外)则关闭', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await screen.findByRole('group', { name: 'Morph panel' });

    // 焦点移到面板/trigger 之外的控件 → 关闭
    act(() => screen.getByRole('button', { name: 'Outside' }).focus());
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
  });

  it('允许显式的外部 autofocus 目标保持焦点且不误关闭面板', async () => {
    function ExternalFocusHarness() {
      const [open, setOpen] = useState(false);
      const composerRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={composerRef} aria-label="Composer" />
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            autoFocusTarget={() => composerRef.current}
            panelAriaLabel="External focus panel"
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Open with composer focus
              </button>
            }
          >
            <button type="button">Suggestion</button>
          </MorphPopover>
          <button type="button">Unrelated control</button>
        </>
      );
    }

    render(<ExternalFocusHarness />);
    const trigger = screen.getByRole('button', { name: 'Open with composer focus' });
    trigger.focus();
    fireEvent.click(trigger);

    const panel = await screen.findByRole('group', { name: 'External focus panel' });
    const composer = screen.getByLabelText('Composer');
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(panel).toBeTruthy();

    // autoFocusTarget 属于当前交互层:点击编辑器调整光标时不能被 outside pointerdown 收起。
    fireEvent.pointerDown(composer);
    expect(screen.getByRole('group', { name: 'External focus panel' })).toBeTruthy();

    act(() => screen.getByRole('button', { name: 'Unrelated control' }).focus());
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'External focus panel' })).toBeNull(),
    );
  });

  it('动作把焦点交接到别处时不抢回 trigger(焦点已在面板外)', async () => {
    function FocusHandoffHarness() {
      const [open, setOpen] = useState(false);
      const destinationRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Toggle
              </button>
            }
          >
            <button
              type="button"
              onClick={() => {
                // 真实交接:动作显式把焦点移到目标面,再关闭
                destinationRef.current?.focus();
                setOpen(false);
              }}
            >
              Continue elsewhere
            </button>
          </MorphPopover>
          <button ref={destinationRef} type="button">
            Destination
          </button>
        </>
      );
    }

    render(<FocusHandoffHarness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue elsewhere' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue elsewhere' })).toBeNull(),
    );
    // 焦点已被动作交接到 Destination(面板外)→ 收合不抢回 trigger,焦点留在目标面
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Destination' }));
  });

  it('鼠标选择菜单动作后不回焦 trigger,避免重新弹出 trigger tooltip', async () => {
    function PointerSelectionHarness() {
      const [open, setOpen] = useState(false);
      return (
        <MorphPopover
          open={open}
          onOpenChange={setOpen}
          trigger={
            <button type="button" onClick={() => setOpen(true)}>
              Toggle
            </button>
          }
        >
          <button type="button" onClick={() => setOpen(false)}>
            Select action
          </button>
        </MorphPopover>
      );
    }

    render(<PointerSelectionHarness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    fireEvent.click(trigger);
    const action = await screen.findByRole('button', { name: 'Select action' });
    action.focus();
    fireEvent.pointerDown(action);
    fireEvent.click(action);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Select action' })).toBeNull());
    expect(document.activeElement).not.toBe(trigger);
  });

  it('动作延迟打开下一层交互面时不在收合结束后抢回 trigger', async () => {
    setReducedMotion(false);

    function DelayedFocusHandoffHarness() {
      const [open, setOpen] = useState(false);
      const destinationRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Toggle
              </button>
            }
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                // Radix Dialog 会在菜单开始收合后才 autofocus 新弹层。
                window.setTimeout(() => destinationRef.current?.focus(), 10);
              }}
            >
              Open dialog
            </button>
          </MorphPopover>
          <button ref={destinationRef} type="button">
            Dialog field
          </button>
        </>
      );
    }

    render(<DelayedFocusHandoffHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const action = await screen.findByRole('button', { name: 'Open dialog' });
    action.focus();
    fireEvent.click(action);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open dialog' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dialog field' }));
  });

  it('outside pointerdown 交接给相邻 MorphPopover 时旧层不延迟抢回焦点', async () => {
    setReducedMotion(false);

    function SiblingHandoffHarness() {
      const [modelOpen, setModelOpen] = useState(false);
      const [agentOpen, setAgentOpen] = useState(false);
      return (
        <>
          <MorphPopover
            open={modelOpen}
            onOpenChange={setModelOpen}
            panelAriaLabel="Model panel"
            trigger={
              <button type="button" aria-expanded={modelOpen} onClick={() => setModelOpen(true)}>
                Model
              </button>
            }
          >
            <input aria-label="Search models" />
          </MorphPopover>
          <MorphPopover
            open={agentOpen}
            onOpenChange={setAgentOpen}
            panelAriaLabel="Agent panel"
            trigger={
              <button
                type="button"
                aria-expanded={agentOpen}
                // AgentSelect 为保持 composer focus-within 视觉会阻止鼠标默认聚焦。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAgentOpen(true)}
              >
                Agent
              </button>
            }
          >
            <button type="button" data-morph-autofocus>
              Current agent
            </button>
          </MorphPopover>
        </>
      );
    }

    render(<SiblingHandoffHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    const search = await screen.findByRole('textbox', { name: 'Search models' });
    await waitFor(() => expect(document.activeElement).toBe(search));

    const agentTrigger = screen.getByRole('button', { name: 'Agent' });
    // 真实点击从 pointerdown 到 click 有按压时长。旧层从 pointerdown 起计 240ms 收合，
    // 新层到 click 才开始 220ms autofocus；按压超过 20ms 时旧层会先走到回焦终点。
    fireEvent.pointerDown(agentTrigger);
    fireEvent.mouseDown(agentTrigger);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    fireEvent.mouseUp(agentTrigger);
    fireEvent.click(agentTrigger);
    expect(agentTrigger.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 260));
    });
    expect(agentTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Current agent' }));
  });

  it('嵌套 Radix portal 内 pointerdown 不算 outside;真正 outside pointerdown 关闭', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    await screen.findByRole('group', { name: 'Morph panel' });

    // 嵌套 portal(如模型行 effort 子面板)内点击:面板保持打开
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Nested portal action' }));
    expect(screen.getByRole('group', { name: 'Morph panel' })).toBeTruthy();

    // 面板外点击:关闭
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
  });

  it('脱身上浮:trigger chip 全程可见,再点 trigger 即关闭(toggle)', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    const wrap = trigger.closest('span.relative') as HTMLElement;
    expect(wrap).toBeTruthy();

    fireEvent.click(trigger);
    await screen.findByRole('group', { name: 'Morph panel' });
    // chip 不隐藏(区别于已废弃的原位取代方案)
    expect(wrap.style.visibility).not.toBe('hidden');

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Morph panel' })).toBeNull());
  });

  it('无 ghost 幽灵层(脱身上浮不再需要)', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    expect(panel.querySelector('[data-morph-ghost]')).toBeNull();
  });

  it('内容区 overflow-x 保持 hidden,避免 1px border-box 偏差闪出横向滚动条', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const content = panel.firstElementChild as HTMLElement;
    expect(content.className).toContain('overflow-x-hidden');
    await waitFor(() => {
      expect(content.style.overflowX).toBe('hidden');
    });
  });
});
