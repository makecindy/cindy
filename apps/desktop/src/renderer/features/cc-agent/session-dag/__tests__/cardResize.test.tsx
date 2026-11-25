// @vitest-environment jsdom
/** Renderer unit: a CSS-only resize used to leave arrows, serialized geometry and projected
 * placeholders at their original size. Exercise the canvas under zoom and on receipt projection. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SessionDagCanvas } from '../SessionDagCanvas';
import { autoLayout, contentBounds } from '../layout';
import type { DagCanvasState, DagNode } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  if (!window.PointerEvent)
    vi.stubGlobal(
      'PointerEvent',
      class extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, options: PointerEventInit) {
          super(type, options);
          this.pointerId = options.pointerId ?? 0;
        }
      },
    );
});
afterEach(cleanup);
const root: DagNode = {
  id: 'root',
  parentId: null,
  sessionId: 'session',
  question: '问题',
  answer: '回答',
};
const child: DagNode = { ...root, id: 'child', parentId: 'root', userMessageId: 'second' };
const snapshot = (): DagCanvasState => ({ positions: {}, references: [], revisions: [] });
const props = () => ({
  nodes: [root, child],
  storageKey: 'account/device/root',
  onOpen: vi.fn(),
  onAction: vi.fn(),
  onStateChange: vi.fn(),
});
const card = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-session-dag-card="${id}"]`)!;
const grip = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-dag-resize]')!;

it('缩放下按画布像素预览实线、只保存一次、可撤销并按命名空间回读', () => {
  const p = props(),
    { container: c, rerender } = render(<SessionDagCanvas {...p} />);
  const region = screen.getByRole('region'),
    h = grip(card(c, 'root'));
  fireEvent.keyDown(region, { key: '=' });
  fireEvent.pointerDown(h, { button: 0, pointerId: 11, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(h, { pointerId: 11, clientX: 110, clientY: 60 });
  expect(card(c, 'root').style.width).toBe('360px');
  expect(card(c, 'root').style.height).toBe('144px');
  expect(c.querySelector('path[d^="M 408 120 C"]')).not.toBeNull();
  expect(p.onStateChange).not.toHaveBeenCalled();
  fireEvent.pointerUp(h, { pointerId: 11, clientX: 110, clientY: 60 });
  expect(p.onStateChange).toHaveBeenCalledTimes(1);
  const [key, saved] = p.onStateChange.mock.calls[0];
  expect(key).toBe(p.storageKey);
  expect(saved.sizes).toEqual({ root: { width: 360, height: 144 } });
  expect(p.onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(region, { key: 'z', ctrlKey: true });
  expect(card(c, 'root').style.width).toBe('280px');
  rerender(<SessionDagCanvas {...p} storageKey="other" readOnly />);
  expect(grip(card(c, 'root'))).toBeNull();
  expect(card(c, 'root').style.height).toBe('104px');
  rerender(<SessionDagCanvas {...p} initialState={saved} />);
  expect(card(c, 'root').style.width).toBe('360px');
});

it('占位尺寸按原生问题 ID 接替，撤销跟随接替而不复活占位', () => {
  const p = props(),
    before = snapshot();
  before.pendingBranches = [
    {
      id: 'draft',
      parentId: 'root',
      point: { x: 600, y: 180 },
      sessionId: 'session',
      question: '问题',
      reused: true,
      userMessageId: 'second',
      delivery: 'accepted',
    },
  ];
  const { container: c, rerender } = render(
    <SessionDagCanvas {...p} nodes={[root]} initialState={before} />,
  );
  const provisional = c.querySelector<HTMLElement>('[data-session-dag-draft="draft"]')!;
  fireEvent.click(provisional.querySelector('[data-dag-summary]')!);
  const input = screen.getByRole('textbox', { name: '编辑节点名' });
  fireEvent.change(input, { target: { value: '尺寸与摘要' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(grip(provisional), { key: 'ArrowRight', shiftKey: true });
  expect(provisional.style.width).toBe('312px');
  rerender(<SessionDagCanvas {...p} initialState={before} />);
  expect(c.querySelector('[data-session-dag-draft]')).toBeNull();
  expect(card(c, 'child').style.width).toBe('312px');
  const saved = p.onStateChange.mock.lastCall![1];
  expect(saved.positions.child).toEqual({ x: 600, y: 180 });
  expect(saved.sizes).toEqual({ child: { width: 312, height: 104 } });
  expect(saved.summaries).toEqual({ child: '尺寸与摘要' });
  fireEvent.keyDown(screen.getByRole('region'), { key: 'z', ctrlKey: true });
  expect(card(c, 'child').style.width).toBe('280px');
  expect(card(c, 'child').querySelector('[data-dag-summary]')?.textContent).toBe('尺寸与摘要');
  fireEvent.keyDown(screen.getByRole('region'), { key: 'z', ctrlKey: true });
  expect(card(c, 'child').querySelector('[data-dag-summary]')?.textContent).toBe('问题');
  expect(c.querySelector('[data-session-dag-draft]')).toBeNull();
});

it('整理时为实际行高和列宽留空间，适配范围包含放大的最右卡', () => {
  const nodes = [root, child, { ...child, id: 'sibling' }],
    sizes = { root: { width: 600, height: 280 }, child: { width: 500, height: 400 } };
  const pos = autoLayout(nodes, sizes),
    bounds = contentBounds(nodes, pos, sizes);
  expect(pos.child.x).toBeGreaterThan(pos.root.x + 600);
  expect(pos.sibling.y).toBeGreaterThan(pos.child.y + 400);
  expect(bounds.width).toBeGreaterThan(pos.child.x + 500);
});
