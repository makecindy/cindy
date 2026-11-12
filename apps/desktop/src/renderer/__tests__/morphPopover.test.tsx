// @vitest-environment jsdom

/**
 * MorphPopover(脱身上浮容器形变原语)交互契约。
 *
 * 2026-07-22 用户定稿:脱身上浮取代 origin/main 的「原位取代 + ghost 幽灵层」方案。
 * 故本文件按新语义重写(取代旧 ghost/left-定位/focus-first-action/scroll-close 契约):
 *   - 打开聚焦 [data-morph-autofocus] → 首个 input → 面板容器(不抢焦到首个按钮,§14.2)
 *   - 关闭仅键盘(Esc)归还 trigger 焦点;鼠标关闭(选项/outside)不回焦(防误弹 trigger tooltip)
 *   - 传了 restoreFocusTarget 时,指针关闭立刻回该目标(选完模型能接着打字);
 *     Esc 仍回 trigger(§14.2);其它控件已接走则不抢
 *   - outside pointerdown 关闭,但嵌套 Radix portal(data-radix-popper-content-wrapper)内不算 outside
 *   - trigger chip 全程可见(不隐藏),再点即关(toggle)
 *   - 无 ghost 幽灵层
 * jsdom 无布局引擎(rect 全 0),几何/丝滑度靠 DESIGN.md §14.4 实测兜底,不在此测。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MORPH_CONTENT_RESIZE_EVENT, MorphPopover } from '../components/ui/morph-popover';

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

function captureFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return () => act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(16);
  });
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
  // #9403: the existing focus tests did not cover invisible frames before opening.
  // Production MorphPopover must reveal on the first frame (immediately for reduced
  // motion). Minimal input: open one panel; old code needed a second rAF. Tier: unit.
  it.each([false, true])('reveals without an extra invisible frame (reduced motion: %s)', (reduced) => {
    setReducedMotion(reduced);
    const flushFrame = captureFrames();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = screen.getByRole('group', { name: 'Morph panel' });
    if (!reduced) {
      expect(panel.style.opacity).toBe('0');
      flushFrame();
    }
    expect(panel.style.opacity).toBe('1');
  });

  // The earlier focus/toggle cases use reduced motion; they cannot catch a queued
  // opening frame revealing an already closed panel. Tier: unit, no real waits.
  it('cancels the pending reveal when closed before its first frame', () => {
    setReducedMotion(false);
    const flushFrame = captureFrames();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    fireEvent.click(trigger);
    const panel = screen.getByRole('group', { name: 'Morph panel' });
    fireEvent.click(trigger);
    flushFrame();
    expect(panel.dataset.state).toBe('closed');
    expect(panel.style.opacity).toBe('0');
  });

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

  it('restoreFocusTarget:鼠标选完后把焦点送回指定输入,而不是 trigger 或 body', async () => {
    function RestoreHomeHarness() {
      const [open, setOpen] = useState(false);
      const composerRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={composerRef} aria-label="Composer" />
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            restoreFocusTarget={() => composerRef.current}
            trigger={
              <button type="button" onClick={() => setOpen((current) => !current)}>
                Toggle
              </button>
            }
          >
            <button type="button" onClick={() => setOpen(false)}>
              Select model
            </button>
          </MorphPopover>
        </>
      );
    }

    render(<RestoreHomeHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const action = await screen.findByRole('button', { name: 'Select model' });
    action.focus();
    fireEvent.pointerDown(action);
    fireEvent.click(action);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Select model' })).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText('Composer'));
  });

  it('restoreFocusTarget:鼠标选完在收合动画开始时就把焦点送回输入,不等卸掉', async () => {
    setReducedMotion(false);
    function RestoreHomeImmediateHarness() {
      const [open, setOpen] = useState(false);
      const composerRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={composerRef} aria-label="Composer" />
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            restoreFocusTarget={() => composerRef.current}
            panelAriaLabel="Immediate restore panel"
            trigger={
              <button type="button" onClick={() => setOpen((current) => !current)}>
                Toggle
              </button>
            }
          >
            <button type="button" onClick={() => setOpen(false)}>
              Select model
            </button>
          </MorphPopover>
        </>
      );
    }

    render(<RestoreHomeImmediateHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const action = await screen.findByRole('button', { name: 'Select model' });
    action.focus();
    fireEvent.pointerDown(action);
    fireEvent.click(action);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Composer')));
    expect(screen.getByRole('group', { name: 'Immediate restore panel' })).toBeTruthy();
  });

  it('restoreFocusTarget:Esc 关闭仍回 trigger,不改 §14.2 键盘归还', async () => {
    function RestoreHomeEscHarness() {
      const [open, setOpen] = useState(false);
      const composerRef = useRef<HTMLTextAreaElement>(null);
      return (
        <>
          <textarea ref={composerRef} aria-label="Composer" />
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            restoreFocusTarget={() => composerRef.current}
            panelAriaLabel="Restore home panel"
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Toggle
              </button>
            }
          >
            <button type="button">First action</button>
          </MorphPopover>
        </>
      );
    }

    render(<RestoreHomeEscHarness />);
    const trigger = screen.getByRole('button', { name: 'Toggle' });
    fireEvent.click(trigger);
    await screen.findByRole('group', { name: 'Restore home panel' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Restore home panel' })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('restoreFocusTarget:焦点已被其它控件接走时不抢回', async () => {
    function RestoreHomeHandoffHarness() {
      const [open, setOpen] = useState(false);
      const composerRef = useRef<HTMLTextAreaElement>(null);
      const destinationRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <textarea ref={composerRef} aria-label="Composer" />
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            restoreFocusTarget={() => composerRef.current}
            trigger={
              <button type="button" onClick={() => setOpen(true)}>
                Toggle
              </button>
            }
          >
            <button
              type="button"
              onClick={() => {
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

    render(<RestoreHomeHandoffHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue elsewhere' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue elsewhere' })).toBeNull(),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Destination' }));
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

  // #9536: 「+」添加目录页自己滚列表。外壳 settle 后再 auto，会和内层并排两条竖向滚动条。
  // 最小输入：子树带 data-morph-scroll="inner"。没有该标记的菜单仍由外壳滚动。Tier: unit。
  it('子面板声明内滚时，外壳 settle 后仍保持 overflow hidden', async () => {
    render(
      <Harness>
        <div data-morph-scroll="inner">inner list</div>
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const content = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(content.style.overflowY).toBe('hidden');
    });
  });

  it('没有内滚标记时，外壳 settle 后恢复 overflow auto', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const content = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(content.style.overflowY).toBe('auto');
    });
  });

  // #9536 复审：滚动归属只在打开后的 settle 里判一次。往返切页（「+」→添加目录→返回）
  // 不会再跑那次判定，返回主面板后外壳停在 hidden，列表再也滚不动。
  // 最小输入：打开后先是内滚页；切页时在新内容提交前派发重量事件（与面板的 useLayoutEffect 同序）。
  // Tier: unit。
  it('往返切页后按当前内容重新判定外壳是否滚动', async () => {
    function Page({
      kind,
      onCommit,
    }: {
      kind: 'inner' | 'main';
      onCommit: () => void;
    }) {
      useLayoutEffect(() => {
        onCommit();
      }, [onCommit]);
      return kind === 'inner' ? (
        <div data-morph-scroll="inner">directory list</div>
      ) : (
        <div>main list</div>
      );
    }
    function Host() {
      const [open, setOpen] = useState(false);
      const [page, setPage] = useState<'inner' | 'main'>('inner');
      const notify = () => {
        document
          .querySelector('[aria-label="Morph panel"] > div')
          ?.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT));
      };
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Toggle
          </button>
          <button type="button" onClick={() => setPage('main')}>
            Show main
          </button>
          <button type="button" onClick={() => setPage('inner')}>
            Show inner
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelAriaLabel="Morph panel"
            trigger={<span />}
          >
            <Page kind={page} onCommit={notify} />
          </MorphPopover>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const content = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(content.style.overflowY).toBe('hidden');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show main' }));
    expect(content.querySelector('[data-morph-scroll="inner"]')).toBeNull();
    expect(content.style.overflowY).toBe('auto');

    fireEvent.click(screen.getByRole('button', { name: 'Show inner' }));
    expect(content.querySelector('[data-morph-scroll="inner"]')).toBeTruthy();
    expect(content.style.overflowY).toBe('hidden');
  });

  // #9536 / #9573：外壳被锁成 hidden 后，内层必须接过外壳量到的确定高度。
  // 只有 max-h-full 时父层高度仍是 auto，长列表按全部条目撑高，底部被外壳裁掉。
  // 生产入口：MorphPopover 打开内滚页。现有用例只断言 overflowY，不看内层高度。
  // 最小输入：外壳 scrollHeight 400，上限 240。切回无标记页后外壳恢复可滚，内层高度被清掉。
  // Tier: unit。
  it('内滚页接过外壳的确定高度，返回主面板后外壳恢复滚动', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'group' ? 400 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    function Host() {
      const [open, setOpen] = useState(false);
      const [page, setPage] = useState<'inner' | 'main'>('inner');
      const notify = () => {
        document
          .querySelector('[aria-label="Morph panel"] > div')
          ?.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT));
      };
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Toggle
          </button>
          <button type="button" onClick={() => setPage('main')}>
            Show main
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelWidth={480}
            maxContentHeight={240}
            panelAriaLabel="Morph panel"
            trigger={<span />}
          >
            <PinnedPage kind={page} onCommit={notify} />
          </MorphPopover>
        </>
      );
    }
    function PinnedPage({
      kind,
      onCommit,
    }: {
      kind: 'inner' | 'main';
      onCommit: () => void;
    }) {
      useLayoutEffect(() => {
        onCommit();
      }, [onCommit]);
      return kind === 'inner' ? (
        <div data-morph-scroll="inner">directory list</div>
      ) : (
        <div>main list</div>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    const content = panel.firstElementChild as HTMLElement;
    await waitFor(() => {
      expect(panel.style.height).toBe('240px');
      expect(content.style.overflowY).toBe('hidden');
    });
    const inner = content.querySelector('[data-morph-scroll="inner"]') as HTMLElement;
    expect(inner.style.height).toBe('240px');

    fireEvent.click(screen.getByRole('button', { name: 'Show main' }));
    expect(content.querySelector('[data-morph-scroll="inner"]')).toBeNull();
    expect(content.style.overflowY).toBe('auto');
  });

  // #9573 复审：内容包装若是 h-full，ResizeObserver 量到的高度恒等于外壳，搜索过滤后列表变短
  // 不会触发 syncPanelToContent，弹层保留打开时的高度留下大块空白。
  // 生产入口：MorphPopover 打开后内容变矮，外壳高度必须跟着收缩，且不超过 maxContentHeight。
  // 现有用例只断言 overflow，没有覆盖高度跟随。最小输入：打开时内容高 400，随后缩到 80，上限 240。
  // Tier: unit。
  it('搜索后结果变少时外壳高度跟着收缩，且不超过内容高度上限', async () => {
    const contentHeight = { current: 400 };
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'group' ? contentHeight.current : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    function Host() {
      const [open, setOpen] = useState(false);
      const [lines, setLines] = useState(8);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Toggle
          </button>
          <button type="button" onClick={() => setLines(1)}>
            Filter
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelWidth={480}
            maxContentHeight={240}
            panelAriaLabel="Morph panel"
            trigger={<span />}
          >
            <div>
              {Array.from({ length: lines }, (_, index) => (
                <div key={index}>row {index}</div>
              ))}
            </div>
          </MorphPopover>
        </>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await waitFor(() => {
      expect(panel.style.height).toBe('240px');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await waitFor(() => {
      expect(screen.getAllByText(/^row /)).toHaveLength(1);
    });
    // 搜索后列表变矮。内容包装不再用 h-full，自然高度能被量到；面板显式请求重测，外壳跟着收缩。
    contentHeight.current = 80;
    const content = panel.firstElementChild as HTMLElement;
    content.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    expect(panel.style.height).toBe('80px');
  });

  // #9573 复审（codex P2）：内滚层的定高会算进外壳 scrollHeight。旧实现在量自然高度前
  // 不松这层定高，于是「上一轮的整段高度 + 边框」被当成新内容高度写回去，短列表在内容
  // 没变、也没搜索的情况下也会一路长到上限。jsdom 没有排版，这里按浏览器的口径模拟：
  // 内层带定高时外壳 scrollHeight = 定高 + 2px 边框。
  // 最小输入：短列表内容 200、上限 240，连续三次内容重测。Tier: unit。
  it('内滚层的定高不会被当成内容高度叠回外壳', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'group') return 0;
      const inner = this.querySelector('[data-morph-scroll="inner"]') as HTMLElement | null;
      const pinned = inner ? Number.parseFloat(inner.style.height) || 0 : 0;
      return Math.max(200, pinned + (pinned > 0 ? 2 : 0));
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Toggle
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelWidth={480}
            maxContentHeight={240}
            panelAriaLabel="Morph panel"
            trigger={<span />}
          >
            <div data-morph-scroll="inner">short list</div>
          </MorphPopover>
        </>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await waitFor(() => {
      expect(panel.style.height).toBe('200px');
    });
    const content = panel.firstElementChild as HTMLElement;
    const inner = panel.querySelector('[data-morph-scroll="inner"]') as HTMLElement;
    expect(inner.style.height).toBe('200px');

    for (let round = 0; round < 3; round += 1) {
      content.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    }
    expect(panel.style.height).toBe('200px');
    expect(inner.style.height).toBe('200px');
  });

  // #9573 复审（codex P2）：量自然高度要先松掉内层定高,列表在那一刻会展开到完整内容高度,
  // 浏览器随即把 scrollTop 夹回 0。jsdom 没有排版,这里在 scrollHeight 读取时模拟这次夹取:
  // 内层处于「无定高」状态就把 scrollTop 置 0。没有保存/恢复的实现会停在上一步的 0。
  // 生产入口:删除引用目录 / 扫描结果更新都会重新量高。Tier: unit。
  it('重新量高时保留内滚列表的滚动位置', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') !== 'group') return 0;
      const inner = this.querySelector('[data-morph-scroll="inner"]') as HTMLElement | null;
      // 浏览器口径:定高被清掉的那一刻列表撑满,滚动位置被夹到 0。
      if (inner && inner.style.height === '') inner.scrollTop = 0;
      return 400;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Toggle
          </button>
          <MorphPopover
            open={open}
            onOpenChange={setOpen}
            panelWidth={480}
            maxContentHeight={240}
            panelAriaLabel="Morph panel"
            trigger={<span />}
          >
            <div data-morph-scroll="inner">long list</div>
          </MorphPopover>
        </>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await waitFor(() => {
      expect(panel.style.height).toBe('240px');
    });
    const content = panel.firstElementChild as HTMLElement;
    const inner = panel.querySelector('[data-morph-scroll="inner"]') as HTMLElement;
    expect(inner.style.height).toBe('240px');

    inner.scrollTop = 120;
    content.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    expect(inner.scrollTop).toBe(120);
  });

  // #9573 复审：普通动效下，扫描结果 / 模型列表会在 220ms 开场动画内派发重测。
  // 旧监听当场改宽高，会把正在过渡的面板拽到终态。生产入口：MorphPopover 打开后、settle 前派发重测。
  // 现有收缩用例走 reduced-motion，settle 已完成，盖不住这条时序。
  // 最小输入：开场量到 120，动画中途内容变成 400 并派发重测；flush 开场帧后高度仍是 120，
  // 推进 220ms 后补跑并写成 400。Tier: unit。
  it('开场期间派发重测不改变面板高度，settle 后补跑一次并应用新高度', () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    const flushFrame = captureFrames();
    const contentHeight = { current: 120 };
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'group' ? contentHeight.current : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    render(
      <Harness>
        <div>rows</div>
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = screen.getByRole('group', { name: 'Morph panel' });
    flushFrame();
    expect(panel.style.height).toBe('120px');

    contentHeight.current = 400;
    const content = panel.firstElementChild as HTMLElement;
    content.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    expect(panel.style.height).toBe('120px');

    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(panel.style.height).toBe('400px');
    vi.useRealTimers();
  });

  // #9573 复审：scrollHeight 不含上下边框，写入的 height 是 border-box。少这 2px 时
  // max-h-full 的内容区被压短，没有内滚标记的面板（权限 / Agent）会多出一条竖向滚动条。
  // 生产入口：MorphPopover 打开后按内容量高。现有收缩用例的 scrollHeight 是 mock，边框为 0，
  // 看不出差额。最小输入：内容高 100，外壳上下边框各 1px，视口放得下。写入高度必须是 102，
  // 外壳 settle 后仍是 auto（内容放得下，不需要滚）。Tier: unit。
  it('内容能完整放下时，写入的高度包含上下边框，外壳不自滚', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'group' ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 800, 120, 30));
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    render(
      <Harness>
        <div>one row</div>
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle' }));
    const panel = await screen.findByRole('group', { name: 'Morph panel' });
    await waitFor(() => {
      expect(panel.style.height).toBe('100px');
    });
    // jsdom 不计算样式表边框。写到元素上之后重测一次，getComputedStyle 才能读到 1px。
    panel.style.borderTopWidth = '1px';
    panel.style.borderBottomWidth = '1px';
    panel.style.borderStyle = 'solid';
    const content = panel.firstElementChild as HTMLElement;
    content.dispatchEvent(new CustomEvent(MORPH_CONTENT_RESIZE_EVENT, { bubbles: true }));
    expect(panel.style.height).toBe('102px');
    expect(content.style.overflowY).toBe('auto');
    expect(content.querySelector('[data-morph-scroll="inner"]')).toBeNull();
  });
});
