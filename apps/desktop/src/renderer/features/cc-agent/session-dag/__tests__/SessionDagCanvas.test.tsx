// @vitest-environment jsdom
/** Renderer unit: the old grip-only and reference tests missed body drags and blank drops.
 * Exercise the production canvas with a parent and two siblings: moving, opening, linking and
 * creating a usable child must remain separate, including after the native branch is projected. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);
// jsdom's Event fallback drops pointer coordinates and modifier keys entirely.
if (!window.PointerEvent) {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
}
Element.prototype.setPointerCapture ??= function () {};
Element.prototype.releasePointerCapture ??= function () {};

import { SessionDagCanvas } from '../SessionDagCanvas';
import type { DagNode } from '../types';

function makeNode(id: string, parentId: string | null): DagNode {
  return {
    id,
    parentId,
    sessionId: `session-${id}`,
    userMessageId: `user-${id}`,
    answerMessageId: `answer-${id}`,
    question: `问题-${id}`,
    answer: `回答-${id}。这是一段足够长的正文，用来验证摘要与快照。`,
  };
}
const nodes = [makeNode('n1', null), makeNode('n2', 'n1'), makeNode('n3', 'n1')];
afterEach(() => {
  cleanup();
});
function renderCanvas(overrides: Partial<Parameters<typeof SessionDagCanvas>[0]> = {}) {
  const onOpen = vi.fn(),
    onPin = vi.fn(),
    onAction = vi.fn(),
    onStateChange = vi.fn();
  const utils = render(
    <SessionDagCanvas
      nodes={nodes}
      storageKey="a/d/r"
      onOpen={onOpen}
      onPin={onPin}
      onAction={onAction}
      onStateChange={onStateChange}
      {...overrides}
    />,
  );
  return { ...utils, onOpen, onPin, onAction, onStateChange };
}
const card = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-session-dag-card="${id}"]`) as HTMLElement;
const pointer = (node: HTMLElement, name: RegExp) => within(node).getByRole('button', { name });

function dragTo(handle: HTMLElement, target: Element, clientX: number, clientY: number) {
  const original = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target });
  try {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 40, clientY: 60 });
    fireEvent.pointerMove(target, { pointerId: 7, clientX, clientY });
    fireEvent.pointerUp(target, { pointerId: 7, clientX, clientY });
  } finally {
    if (original) Object.defineProperty(document, 'elementFromPoint', original);
    else Reflect.deleteProperty(document, 'elementFromPoint');
  }
}

describe('SessionDagCanvas 交互合同', () => {
  it('一轮一卡、默认高度，单击卡片开原生对话，Ctrl/Cmd+双击固定对照而不重复打开', async () => {
    const { container, onOpen, onPin } = renderCanvas();
    expect(container.querySelectorAll('[data-session-dag-card]')).toHaveLength(3);
    const first = card(container, 'n1');
    expect(first.style.height).toBe('104px');
    expect(within(first).queryByRole('button', { name: /移动卡片/ })).toBeNull();
    expect(within(first).queryByText('对话轮次')).toBeNull();
    const body = pointer(first, /打开原生对话/);
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 120, clientY: 80 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 121, clientY: 80 });
    fireEvent.click(body, { detail: 1 });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(onOpen.mock.calls[0][0]).toMatchObject({ sessionId: 'session-n1', question: '问题-n1' });
    fireEvent.doubleClick(pointer(first, /打开原生对话/), { ctrlKey: true });
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // Unit regression: a plain text answer used to show the literal "##"; the gesture
  // fixtures alone cannot verify semantic Markdown, inert media, or safe link activation.
  it('原答在卡内展示 Markdown；选字和点击外链不会打开卡片，外部图片不会加载', () => {
    const answer = '## 结论\n\n- **重点**\n\n> 引用\n\n```ts\nconst x = 1;\n```\n\n| 列 |\n| --- |\n| 值 |\n\n[文档](https://example.org/) [本地](file:///unavailable) ![图示](https://example.org/preview.png)\n\n<iframe></iframe>';
    const { container, onOpen } = renderCanvas({ nodes: [{ ...nodes[0], answer }] });
    const node = card(container, 'n1');
    const heading = within(node).getByRole('heading', { level: 2, name: '结论' });
    expect(heading.closest('button')).toBeNull();
    expect(node.querySelector('li strong')?.textContent).toBe('重点');
    expect(node.querySelector('blockquote')?.textContent).toContain('引用');
    expect(node.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(within(node).getByRole('cell', { name: '值' })).toBeTruthy();
    expect(node.querySelector('img,iframe')).toBeNull();
    const [link] = within(node).getAllByRole('link');
    expect(within(node).getAllByRole('link')).toHaveLength(1);
    expect(link.getAttribute('href')).toBe('https://example.org/');
    fireEvent.click(link);
    const selection = window.getSelection()!;
    selection.selectAllChildren(heading);
    try {
      fireEvent.click(heading, { detail: 1 });
      expect(onOpen).not.toHaveBeenCalled();
    } finally { selection.removeAllRanges(); }
    fireEvent.click(heading, { detail: 1 });
    expect(onOpen.mock.calls[0][0].answer).toBe(answer);
  });

  it('菜单只承载历史与固定等管理动作，不再提供编辑回答、准备草稿或重复的手柄动作', async () => {
    const user = userEvent.setup();
    const { container, onAction, onOpen } = renderCanvas();
    const first = card(container, 'n1');
    act(() => pointer(first, /轮次操作/).focus());
    await user.keyboard('{Enter}');
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByRole('menuitem', {name: '固定到对照栏'})).toBeTruthy();
    for (const name of ['编辑问答', '推进', '重问', '旁问', '引用此卡提问…']) {
      expect(menu.queryByRole('menuitem', { name })).toBeNull();
    }
    expect(onOpen).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('失败卡只点一次重问，直接恢复原问题，不进入分叉草稿流程', async () => {
    const failed = { ...nodes[0], runState: 'failed' as const };
    const onRetryFailed = vi.fn();
    const { container, onAction, onStateChange } = renderCanvas({ nodes: [failed], onRetryFailed });
    await act(async () => { fireEvent.click(card(container, failed.id).querySelector('[data-dag-retry-failed]')!); });
    expect(onRetryFailed).toHaveBeenCalledExactlyOnceWith(failed);
    expect(onAction).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelectorAll('[data-session-dag-card]')).toHaveLength(1);
    expect(container.querySelector('[data-session-dag-draft]')).toBeNull();
  });

  it.each([['delete', '删除此卡及后续分支', '确认删除', '撤销：删除分支'], ['recall', '撤回提问', '确认撤回', '撤销：撤回提问']])('%s 先显示权威预览，未确认回执不移除卡片', async (kind, menu, confirm, undoName) => {
    const preview = vi.fn().mockResolvedValue({ token: 't1', details: ['会话 branch 的问题及后代'] });
    const commit = vi.fn().mockResolvedValue({ undoId: 'u1' });
    const undo = vi.fn().mockResolvedValue(undefined);
    const { container } = renderCanvas({ historyReady: true, historyActions: {
      preview, commit, undo, latestUndo: { undoId: 'old-1', label: '撤销删除' },
    } });
    const cardNode = card(container, 'n1');
    fireEvent.pointerDown(pointer(cardNode, /轮次操作/), { button: 0 });
    fireEvent.click(screen.getByRole('menuitem', { name: menu }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/会话 branch 的问题及后代/)).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith(nodes[0], kind, 't1'));
    expect(preview).toHaveBeenCalledWith(nodes[0], kind);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelectorAll('[data-session-dag-card]')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: undoName }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith('u1'));
  });

  it('删除回执未确认时保持预览并展示原因，不重放提交', async () => {
    const commit = vi.fn().mockRejectedValue(new Error('范围变化，请重新核对'));
    const { container } = renderCanvas({ historyReady: true, historyActions: {
      preview: vi.fn().mockResolvedValue({ token: 't2', details: ['将移除所选轮次'] }),
      commit, undo: vi.fn(),
    } });
    fireEvent.pointerDown(pointer(card(container, 'n2'), /轮次操作/), { button: 0 });
    fireEvent.click(screen.getByRole('menuitem', { name: '删除此卡及后续分支' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('将移除所选轮次');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    expect(await within(dialog).findByRole('alert').then(el => el.textContent)).toContain('范围变化');
    expect((within(dialog).getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-session-dag-card]')).toHaveLength(3);
  });

  it('画布快捷键只撤销画布编辑，输入框内 Ctrl+Z 不改卡片', () => {
    const {container} = renderCanvas();
    const body = pointer(card(container,'n1'), /打开原生对话/);
    const left = () => card(container,'n1').parentElement!.style.left;
    const initial = left();
    fireEvent.keyDown(body,{key:'ArrowRight'});
    expect(left()).not.toBe(initial);
    expect(screen.getByRole('button', {name:'撤销：移动卡片'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name:'查找轮次'}));
    fireEvent.keyDown(screen.getByRole('searchbox'), {ctrlKey:true,key:'z'});
    expect(left()).not.toBe(initial);
    fireEvent.keyDown(body,{ctrlKey:true,key:'z'});
    expect(left()).toBe(initial);
  });

  it('删除来源后悬空摘要与子卡不展示也不注入；未投影的有效子卡仍可打开', async () => {
    const {container, onAction} = renderCanvas({ nodes: [nodes[0]], historyReady:true, initialState: {
      positions:{}, revisions:[], references:[{id:'ref',fromNodeId:'n1',toNodeId:'gone',snapshot:{question:'来源',summary:'不可再引用'},createdAt:1}],
      pendingBranches:[{id:'orphan',parentId:'gone',sessionId:'x',point:{x:0,y:0},question:'悬空占位'},
        {id:'waiting',parentId:'n1',sessionId:'not-projected',point:{x:100,y:0},question:'等待投影',delivery:'accepted'}],
    } });
    expect(screen.queryByText('悬空占位')).toBeNull();
    expect(screen.getByRole('button',{name:/已提问 · 打开分支.*等待投影/})).toBeTruthy();
    fireEvent.pointerDown(pointer(card(container,'n1'), /轮次操作/), {button:0});
    expect(screen.queryByText('不可再引用')).toBeNull();
    fireEvent.keyDown(screen.getByRole('menu'), {key:'Escape'});
    dragTo(pointer(card(container,'n1'), /从此轮继续或旁问/), screen.getByRole('region'), 630, 200);
    const input = screen.getByLabelText('子卡问题');
    fireEvent.change(input, {target:{value:'下一轮'}});
    await act(async () => { fireEvent.click(within(input.closest<HTMLElement>('[data-session-dag-draft]')!).getByRole('button',{name:'提问'})); });
    expect(onAction.mock.calls[0][2].context).not.toContain('不可再引用');
  });

  it('拖卡身只移动该卡，Shift 只带走后代；松手不误开，随后仍可单击', async () => {
    const { container, onStateChange, onOpen } = renderCanvas({
      nodes: [...nodes, makeNode('n4', 'n2')],
    });
    const body = pointer(card(container, 'n2'), /打开原生对话/);
    const initialX = (id: string) => parseFloat(card(container, id).parentElement!.style.left);
    const x2 = initialX('n2'),
      x3 = initialX('n3'),
      x4 = initialX('n4');
    const drag = (shiftKey: boolean) => {
      fireEvent.pointerDown(body, {
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        shiftKey,
      });
      fireEvent.pointerMove(body, { pointerId: 1, clientX: 140, clientY: 100, shiftKey });
      fireEvent.pointerUp(body, { pointerId: 1, clientX: 140, clientY: 100, shiftKey });
      fireEvent.click(body, { detail: 1, shiftKey });
      return onStateChange.mock.lastCall![1].positions;
    };
    const single = drag(false);
    expect([single.n2.x, single.n3.x, single.n4.x]).toEqual([x2 + 40, x3, x4]);
    const branch = drag(true);
    expect([branch.n2.x, branch.n3.x, branch.n4.x]).toEqual([x2 + 80, x3, x4 + 40]);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.pointerDown(body, { button: 0, pointerId: 2, clientX: 140, clientY: 100 });
    fireEvent.pointerUp(body, { pointerId: 2, clientX: 140, clientY: 100 });
    fireEvent.click(body, { detail: 1 });
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  it('从 A 拖到 B：受理后引用快照随子卡迁移，只有分支 ID 不算已提问', async () => {
    const accepted = { sessionId: 'session-child', delivery: 'accepted' as const };
    let finish!: (result: typeof accepted) => void;
    const onAction = vi
      .fn<Parameters<typeof SessionDagCanvas>[0]['onAction']>()
      .mockResolvedValueOnce({ sessionId: accepted.sessionId })
      .mockImplementationOnce(
        () =>
          new Promise<typeof accepted>((resolve) => {
            finish = resolve;
          }),
      );
    const { container, onStateChange, rerender, onOpen } = renderCanvas({ onAction });
    const source = card(container, 'n3'),
      target = card(container, 'n2');
    const port = within(source).getByRole('button', { name: '从此轮继续或旁问' });
    dragTo(port, target, 190, 90);
    const dialog = within(screen.getByRole('form', { name: '引用并提问' }));
    expect(dialog.queryByRole('button', { name: '问题-n2' })).toBeNull();
    expect(container.querySelector('[data-session-dag-draft]')).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    const summary = '确认的 A 摘要';
    fireEvent.change(dialog.getByRole('textbox', { name: '摘要快照' }), {
      target: { value: summary },
    });
    fireEvent.change(dialog.getByRole('textbox', { name: '新问题' }), {
      target: { value: '比较路线' },
    });
    const ask = () => dialog.getByRole('button', { name: '提问' });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(ask());
    await waitFor(() => expect((ask() as HTMLButtonElement).disabled).toBe(false));
    expect((dialog.getByLabelText('摘要快照') as HTMLTextAreaElement).value).toBe(summary);
    expect((dialog.getByLabelText('新问题') as HTMLTextAreaElement).value).toBe('比较路线');
    expect(container.querySelector('[data-session-dag-draft]')).toBeNull();
    const operation = onAction.mock.calls[0][2].branchQuestionId;
    expect(operation).toMatch(/\S/);
    fireEvent.click(ask());
    fireEvent.click(ask());
    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenLastCalledWith(nodes[1], 'advance', {
      branchQuestionId: operation,
      question: '比较路线',
      context: expect.stringContaining(summary),
    });
    expect(container.querySelector('[data-session-dag-draft]')).toBeNull();
    expect(onStateChange).not.toHaveBeenCalled();
    finish(accepted);
    expect(
      await screen.findByRole('button', { name: /^已提问 · 打开分支\s*比较路线$/ }),
    ).toBeTruthy();
    expect(screen.queryByRole('form', {name:'引用并提问'})).toBeNull();
    expect(
      container.querySelector('[data-session-dag-draft]')?.getAttribute('data-parent-id'),
    ).toBe('n2');
    const child = makeNode('child', 'n2');
    rerender(
      <SessionDagCanvas
        nodes={[...nodes.map((n) => (n.id === 'n3' ? { ...n, answer: '新的正文' } : n)), child]}
        storageKey="a/d/r"
        onOpen={onOpen}
        onAction={onAction}
        onStateChange={onStateChange}
      />,
    );
    await waitFor(() => expect(container.querySelector('[data-session-dag-draft]')).toBeNull());
    expect(onStateChange.mock.lastCall![1].references).toEqual([
      expect.objectContaining({
        fromNodeId: child.id,
        toNodeId: 'n3',
        snapshot: { question: '问题-n3', summary, sourceVersion: 'origin' },
      }),
    ]);
    fireEvent.pointerDown(pointer(card(container, child.id), /轮次操作/), { button: 0 });
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByText(summary)).toBeTruthy();
    expect(menu.queryByText('新的正文')).toBeNull();
    // A consumed snapshot must not be injected into a subsequent native send.
    fireEvent.keyDown(screen.getByRole('menu'), {key:'Escape'});
    dragTo(pointer(card(container,child.id), /从此轮继续或旁问/), screen.getByRole('region'), 850, 400);
    const input = screen.getByLabelText('子卡问题');
    fireEvent.change(input, {target:{value:'再前进'}});
    await act(async () => { fireEvent.click(within(input.closest<HTMLElement>('[data-session-dag-draft]')!).getByRole('button', {name:'提问'})); });
    expect(onAction.mock.lastCall![2].context).not.toContain(summary);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('画布外、取消和只读拖放都不创建分支或引用', () => {
    const { container, onAction, onOpen, onStateChange, rerender } = renderCanvas();
    const source = card(container, 'n2');
    const branch = pointer(source, /从此轮继续或旁问/);
    const target = card(container, 'n3');
    const blank = screen.getByRole('region');
    const unchanged = () => {
      expect(container.querySelector('[data-session-dag-draft]')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(onAction).not.toHaveBeenCalled();
      expect(onStateChange).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    };
    dragTo(branch, document.body, 550, 220);
    unchanged();
    dragTo(branch, target, 550, 220);
    fireEvent.click(
      within(screen.getByRole('form', { name: '引用并提问' })).getByText('取消'),
    );
    unchanged();
    dragTo(branch, blank, 800, 510);
    expect(screen.getByLabelText('子卡问题')).toBe(document.activeElement);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    unchanged();
    rerender(
      <SessionDagCanvas
        nodes={nodes}
        storageKey="a/d/r"
        readOnly
        onOpen={onOpen}
        onAction={onAction}
        onStateChange={onStateChange}
      />,
    );
    for (const hit of [target, blank]) {
      dragTo(branch, hit, 550, 220);
      unchanged();
    }
  });

  it('在缩放后的落点续写子卡：失败可重试，实际分支到达后接替草稿并保留位置', async () => {
    const onAction = vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'session-child' })
      .mockResolvedValueOnce({ sessionId: 'session-child', delivery: 'accepted' });
    const onOpenPrepared = vi.fn();
    const { container, onOpen, onStateChange, rerender } = renderCanvas({
      onAction,
      onOpenPrepared,
    });
    const surface = container.querySelector<HTMLElement>('[data-dag-scale]')!;
    const region = screen.getByRole('region');
    fireEvent.keyDown(region, { key: '+' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 1200, 700));
    dragTo(pointer(card(container, 'n2'), /从此轮继续或旁问/), surface, 600, 300);
    const input = screen.getByRole('textbox', { name: '子卡问题' }) as HTMLTextAreaElement;
    const draft = input.closest<HTMLElement>('[data-session-dag-draft]')!;
    expect(draft.dataset.parentId).toBe('n2');
    expect([draft.style.left, draft.style.top]).toEqual(['400px', '200px']);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '从此处继续' } });
    expect(onAction).not.toHaveBeenCalled();
    const ask = screen.getByRole('button', { name: '提问' });
    fireEvent.click(ask);
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe('从此处继续');
    const operation = onAction.mock.calls[0][2].branchQuestionId;
    expect(operation).toMatch(/\S/);
    fireEvent.click(ask);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'n2', answerMessageId: 'answer-n2' }),
      'advance',
      { branchQuestionId: operation, question: '从此处继续', context: '' },
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /^已提问 · 打开分支\s*从此处继续$/ }),
    );
    expect(onOpenPrepared).toHaveBeenCalledWith('session-child');
    expect(onAction).toHaveBeenCalledTimes(2); // Opening the new branch must not resubmit.
    const pending = container.querySelector<HTMLElement>('[data-session-dag-draft]')!;
    fireEvent.click(pending.querySelector('[data-dag-summary]')!);
    const summaryInput = pending.querySelector('[data-dag-summary-input]')!;
    fireEvent.change(summaryInput, {target:{value:'落点摘要'}});
    fireEvent.keyDown(summaryInput, {key:'Enter'});
    const project = (more: DagNode[]) =>
      rerender(
        <SessionDagCanvas
          nodes={[...nodes, ...more]}
          storageKey="a/d/r"
          onOpen={onOpen}
          onAction={onAction}
          onStateChange={onStateChange}
        />,
      );
    const other = makeNode('unrelated', 'n2');
    project([other]);
    expect(container.querySelector('[data-session-dag-draft]')).not.toBeNull();
    project([other, makeNode('child', 'n2')]);
    await waitFor(() => expect(container.querySelector('[data-session-dag-draft]')).toBeNull());
    expect(onStateChange.mock.lastCall![1].positions.child).toEqual({ x: 400, y: 200 });
    expect(onStateChange.mock.lastCall![1].summaries).toEqual({child:'落点摘要'});
    expect(card(container,'child').querySelector('[data-dag-summary]')?.textContent).toBe('落点摘要');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('两个不同分支的引用可同时提问；乱序回执只关闭各自编辑器，按原生 ID 挂接同文续推', async () => {
    type Receipt = { sessionId: string; userMessageId: string; reused: true; delivery: 'accepted' };
    const resolves = new Map<string, (r: Receipt) => void>();
    const onAction = vi.fn((parent: DagNode) => new Promise<Receipt>(done => resolves.set(parent.id, done)));
    const {container, rerender, onStateChange, onOpen} = renderCanvas({onAction});
    const port = pointer(card(container, 'n1'), /从此轮继续或旁问/);
    for (const id of ['n2', 'n3']) {
      dragTo(port, card(container, id), 500, 300);
      const form = within(screen.getAllByRole('form', {name:'引用并提问'}).at(-1)!);
      fireEvent.change(form.getByLabelText('新问题'), {target:{value:'相同问题'}});
      fireEvent.click(form.getByRole('button',{name:'提问'}));
    }
    expect([...resolves.keys()]).toEqual(['n2','n3']);
    for (const id of ['n3', 'n2']) {
      await act(async () => resolves.get(id)!({sessionId:`session-${id}`, userMessageId:`native-${id}`, delivery:'accepted', reused:true}));
      expect(screen.queryAllByRole('form', {name:'引用并提问'})).toHaveLength(id === 'n3' ? 1 : 0);
    }
    expect(screen.getAllByRole('button',{name:/已提问 · 打开本分支/})).toHaveLength(2);
    const saved = onStateChange.mock.lastCall![1];
    const sameText = {...makeNode('other','n2'), sessionId:'session-n2', question:'相同问题'};
    const wrongParent = {...makeNode('wrong','n1'),sessionId:'session-n2',userMessageId:'native-n2',question:'相同问题'};
    const project = (extra: DagNode[]) => rerender(<SessionDagCanvas storageKey="a/d/r" nodes={[...nodes,...extra]} onOpen={onOpen} onStateChange={onStateChange} onAction={onAction} />);
    project([sameText, wrongParent]);
    expect(screen.getAllByRole('button',{name:/已提问 · 打开本分支/})).toHaveLength(2);
    const real = ['n2','n3'].map(id => ({...makeNode(`next-${id}`,id),sessionId:`session-${id}`,userMessageId:`native-${id}`,question:'相同问题'}));
    project([sameText, ...real]);
    await waitFor(() => expect(screen.queryByRole('button',{name:/已提问 · 打开本分支/})).toBeNull());
    const final = onStateChange.mock.lastCall![1];
    expect(final.references.map((r: {fromNodeId:string}) => r.fromNodeId).sort()).toEqual(['next-n2','next-n3']);
    for (const child of real) expect(final.positions[child.id]).toEqual(saved.pendingBranches.find((d: {parentId:string}) => child.parentId === d.parentId).point);
  });

  it('同分支缺失发问 ID 或已知忙碌时保留输入，不自行改走分叉', async () => {
    const onAction = vi.fn().mockRejectedValueOnce(Error('末端正在回答，请稍后提问。')).mockResolvedValue({sessionId:'session-n2',reused:true,delivery:'accepted'});
    const {container,onStateChange} = renderCanvas({onAction});
    dragTo(pointer(card(container,'n2'),/从此轮继续或旁问/), screen.getByRole('region'), 650,200);
    const input = screen.getByLabelText('子卡问题') as HTMLTextAreaElement;
    fireEvent.change(input,{target:{value:'保留'}});
    fireEvent.click(screen.getByRole('button',{name:'提问'}));
    expect((await screen.findByRole('alert')).textContent).toContain('末端正在回答');
    expect(onAction).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'提问'}));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('未取得发送确认'));
    expect(input.value).toBe('保留');
    expect(onStateChange).not.toHaveBeenCalled();
    expect(onAction.mock.calls[0][2].branchQuestionId).toEqual(onAction.mock.calls[1][2].branchQuestionId);
  });

  it('1.2.0 无受理标记的历史草稿仍显示待发送，打开它不会触发提问', () => {
    const onOpenPrepared = vi.fn();
    const { onAction } = renderCanvas({
      onOpenPrepared,
      initialState: {
        positions: {},
        revisions: [],
        references: [],
        pendingBranches: [
          {
            id: 'legacy',
            parentId: 'n2',
            point: { x: 40, y: 40 },
            question: '旧问题',
            sessionId: 'legacy-child',
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^待发送 · 打开原生对话\s*旧问题$/ }));
    expect(onOpenPrepared).toHaveBeenCalledWith('legacy-child');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('键盘从 + 选择引用目标：以目标答案为锚点，确认前不提交', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockResolvedValue({ sessionId: 'keyboard-child', delivery: 'accepted' });
    const {container} = renderCanvas({onAction});
    act(() => pointer(card(container, 'n2'), /从此轮继续或旁问/).focus());
    await user.keyboard('{Enter}');
    const item = screen.getByRole('menuitem', {name: /引用/});
    act(() => item.focus());
    await user.keyboard('{Enter}');
    const form = within(screen.getByRole('form', {name:'引用并提问'}));
    const select = form.getByRole('combobox', {name:'引用目标'});
    expect(within(select).queryByRole('option',{name:'问题-n2'})).toBeNull();
    await user.selectOptions(select, 'n1');
    await user.type(form.getByLabelText('新问题'), '从根分叉');
    expect(onAction).not.toHaveBeenCalled();
    act(() => form.getByRole('button',{name:'提问'}).focus());
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button',{name:/已提问 · 打开分支.*从根分叉/})).toBeTruthy();
    expect(onAction).toHaveBeenCalledExactlyOnceWith(nodes[0], 'advance', expect.objectContaining({
      branchQuestionId: expect.stringMatching(/\S/), question:'从根分叉', context: expect.stringContaining('问题-n2'),
    }));
  });

  // Unit: saving a question before the live answer finishes must not freeze its text or send anything.
  it('仅保存问题不发送、不改答案，后续到达的原生回答仍然可见', () => {
    const first = renderCanvas({ nodes: [nodes[0]] });
    const c = card(first.container, 'n1');
    fireEvent.doubleClick(c.querySelector('[data-dag-question]')!);
    fireEvent.change(c.querySelector('[data-dag-question-input]')!, {target:{value:'新的问法'}});
    fireEvent.click(within(c).getByRole('button', {name:'仅保存'}));
    expect(first.onAction).not.toHaveBeenCalled();
    const saved = first.onStateChange.mock.lastCall![1];
    expect(saved.revisions.at(-1)).toMatchObject({ nativeAnswer: true, question:'新的问法', answer:'' });
    first.unmount();
    const again = renderCanvas({ nodes: [{...nodes[0],answer:'## 后来收到的回答'}], initialState:saved });
    expect(card(again.container,'n1').querySelector('[data-dag-question]')?.textContent).toBe('新的问法');
    expect(screen.getByRole('heading', {name:'后来收到的回答'})).toBeTruthy();
  });

  it('旧修订继续渲染；摘要单独保存，重问绑定原生消息', async () => {
    const node = {...nodes[0], userMessageId:'u', answerMessageId:'a'};
    const revision = {id:'r', nodeId:node.id, question:'旧修订问题', answer:'## 旧修订标题', source:'manual' as const, createdAt:1};
    const initialState = { positions:{}, references:[], labels:{n1:'旧标签'}, selectedVersions:{n1:'r'}, revisions:[revision] };
    const first = renderCanvas({nodes:[node], initialState});
    const nodeCard = card(first.container,node.id);
    expect(within(nodeCard).getByRole('heading',{name:'旧修订标题'})).toBeTruthy();
    expect(nodeCard.querySelector('[data-dag-summary]')?.textContent).toBe(revision.question);
    fireEvent.click(nodeCard.querySelector('[data-dag-summary]')!);
    const field = nodeCard.querySelector('[data-dag-summary-input]')!;
    fireEvent.change(field,{target:{value:'单独的摘要'}});
    fireEvent.keyDown(field,{key:'Enter'});
    const saved = first.onStateChange.mock.lastCall![1];
    expect(saved).toMatchObject({revisions:[revision], labels:{n1:'旧标签'}, summaries:{n1:'单独的摘要'}, selectedVersions:{n1:'r'}});
    expect(first.onAction).not.toHaveBeenCalled();
    first.unmount();
    const onAction = vi.fn().mockResolvedValue({sessionId:'retry-session', userMessageId:'u2', delivery:'accepted'});
    const {container, onStateChange, onOpen} = renderCanvas({nodes:[node], initialState:saved, onAction});
    const reopened = card(container, node.id);
    expect(reopened.querySelector('[data-dag-summary]')?.textContent).toBe('单独的摘要');
    fireEvent.doubleClick(reopened.querySelector('[data-dag-question]')!);
    const question = reopened.querySelector<HTMLInputElement>('[data-dag-question-input]')!;
    expect(question.value).toBe(revision.question);
    fireEvent.change(question,{target:{value:'重新发问'}});
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(reopened.querySelector('[data-dag-resubmit]')!);
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(onAction.mock.calls[0]).toEqual([expect.objectContaining({id:'n1',userMessageId:'u',answerMessageId:'a'}), 'retry', expect.objectContaining({question:'重新发问',context:''})]);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.pointerDown(pointer(reopened,/轮次操作/),{button:0});
    fireEvent.click(screen.getByRole('menuitemradio',{name:'模型原答'}));
    expect(reopened.textContent).toContain(node.answer);
    expect(onStateChange.mock.lastCall![1].selectedVersions.n1).toBe('origin');
    expect(reopened.querySelector('[data-dag-summary]')?.textContent).toBe('单独的摘要');
  });

  // Unit regression: same question text, a non-side turn, or the wrong session must
  // never become the answer to a side question. Reopening is a read, not a resend.
  it('手柄回拖展开旁问，受理前零发送副作用；拒绝保留、同文按身份匹配、可收起再读', async () => {
    const receipt = {delivery:'accepted' as const, sessionId:'side-session', userMessageId:'side-user'};
    let finish!: (r:typeof receipt) => void;
    const onAction = vi.fn<Parameters<typeof SessionDagCanvas>[0]['onAction']>()
      .mockRejectedValueOnce(Error('旁问未受理')).mockResolvedValueOnce({sessionId:'side-session',delivery:'accepted'})
      .mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    const native = {...makeNode('result','n1'), ...receipt, side:true, question:'同文旁问',answer:'## 真旁问回答'};
    const decoys = [{...native,id:'wrong-user',userMessageId:'another',answer:'错消息'},
      {...native,id:'wrong-session',sessionId:'other-session',answer:'错会话'},
      {...native,id:'not-aside',side:false,answer:'非旁问'}];
    const {container, onStateChange, onOpen, rerender, unmount} = renderCanvas({onAction, fullFamilyNodes:[...nodes,...decoys]});
    const parent = card(container,'n1');
    dragTo(pointer(parent,/从此轮继续或旁问/),parent,180,110);
    const panel = within(screen.getByRole('region',{name:'旁问'}));
    expect(parent.parentElement!.contains(screen.getByRole('region',{name:'旁问'}))).toBe(true);
    expect(screen.queryByRole('form',{name:'引用并提问'})).toBeNull();
    const input = panel.getByLabelText('旁问问题') as HTMLTextAreaElement;
    fireEvent.change(input,{target:{value:'同文旁问'}});
    expect(onAction).not.toHaveBeenCalled();
    const send = () => panel.getByRole('button',{name:'发送旁问'});
    for (let attempt=1; attempt<=2; attempt++) {
      fireEvent.click(send());
      await waitFor(() => expect((send() as HTMLButtonElement).disabled).toBe(false));
      expect(panel.getByRole('alert').textContent).toBeTruthy();
      expect(input.value).toBe('同文旁问');
      expect(onAction).toHaveBeenCalledTimes(attempt);
      expect(onStateChange.mock.lastCall?.[1]?.asides ?? []).toHaveLength(0);
    }
    const submit = send();
    fireEvent.click(submit); fireEvent.click(submit);
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(onAction.mock.calls[2]).toEqual([expect.objectContaining({id:'n1',answerMessageId:'answer-n1'}),'aside',expect.objectContaining({question:'同文旁问',branchQuestionId:expect.stringMatching(/\S/)})]);
    expect(new Set(onAction.mock.calls.map(c => c[2].branchQuestionId)).size).toBe(1);
    await act(async () => finish(receipt));
    const saved = onStateChange.mock.lastCall![1];
    expect(saved.asides).toEqual([expect.objectContaining({nodeId:'n1',sessionId:'side-session',userMessageId:'side-user',question:'同文旁问'})]);
    for (const n of decoys) expect(panel.queryByText(n.answer)).toBeNull();
    rerender(<SessionDagCanvas storageKey="a/d/r" nodes={nodes} fullFamilyNodes={[...nodes,...decoys,native]} onAction={onAction} onOpen={onOpen} onStateChange={onStateChange} />);
    expect(panel.getByRole('heading',{name:'真旁问回答'})).toBeTruthy();
    fireEvent.click(panel.getByRole('button',{name:'收起旁问'}));
    expect(screen.queryByRole('region',{name:'旁问'})).toBeNull();
    unmount();
    const reopened = renderCanvas({nodes, fullFamilyNodes:[...nodes,...decoys,native], initialState:saved, onAction});
    const original = card(reopened.container,'n1');
    if (!screen.queryByRole('region',{name:'旁问'})) dragTo(pointer(original,/从此轮继续或旁问/),original,180,110);
    const reopenedPanel = within(screen.getByRole('region',{name:'旁问'}));
    expect(reopenedPanel.getByRole('heading',{name:'真旁问回答'})).toBeTruthy();
    fireEvent.change(reopenedPanel.getByLabelText('旁问问题'), {target:{value:'暂时收起不发送'}});
    fireEvent.click(reopenedPanel.getByRole('button',{name:'收起旁问'}));
    fireEvent.click(screen.getByRole('button',{name:'展开旁问'}));
    expect((screen.getByLabelText('旁问问题') as HTMLTextAreaElement).value).toBe('暂时收起不发送');
    reopened.rerender(<SessionDagCanvas nodes={nodes} fullFamilyNodes={nodes} storageKey="a/d/r" historyReady onOpen={onOpen} onAction={onAction}/>);
    expect(screen.queryByText('真旁问回答')).toBeNull();
    expect(screen.queryByText('同文旁问')).toBeNull();
    expect(screen.queryByText(/已提问，等待回答/)).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('滚轮缩放与画布平移改变表面变换；键盘可适配、导航与缩略图', () => {
    const { container } = renderCanvas();
    const region = container.querySelector('[role="region"]') as HTMLElement;
    const surface = container.querySelector('[data-dag-scale]') as HTMLElement;
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 480));
    fireEvent.wheel(region, { deltaY: -120, clientX: 100, clientY: 100 });
    expect(Number(surface.dataset.dagScale)).toBeGreaterThan(1);
    const translation = () =>
      surface.style.transform
        .match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)!
        .slice(1)
        .map(Number);
    const [beforeX, beforeY] = translation();
    fireEvent.pointerDown(region, { button: 0, pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerMove(region, { pointerId: 1, clientX: 450, clientY: 440 });
    fireEvent.pointerUp(region, { pointerId: 1 });
    const [afterX, afterY] = translation();
    expect(afterX - beforeX).toBeCloseTo(50);
    expect(afterY - beforeY).toBeCloseTo(40);
    fireEvent.click(within(region).getByRole('button', { name: '画布缩略图' }));
    expect(within(region).getByRole('img', { name: '画布缩略图' })).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: '适配画布' }));
    const fitted = Number(surface.dataset.dagScale);
    expect(parseFloat(surface.style.width) * fitted).toBeCloseTo(640);
    expect(parseFloat(surface.style.height) * fitted).toBeLessThanOrEqual(480);
    region.focus();
    fireEvent.keyDown(region, { key: '+' });
    expect(Number(surface.dataset.dagScale)).toBeGreaterThan(1);
  });

  it('完整家族就绪才允许导出；隐藏旁问不显示，但导出保留其选中的修订和原文', async () => {
    // Renderer unit: toolbar-only tests cannot detect the canvas passing visible turns as the archive.
    const visible = [nodes[0]],
      family = [nodes[0], { ...nodes[1], side: true }];
    const props = {
      nodes: visible,
      fullFamilyNodes: family,
      storageKey: 'a/d/r',
      onOpen: vi.fn(),
      onAction: vi.fn(),
      initialState: {
        positions: {},
        references: [],
        revisions: [
          {
            id: 'r',
            nodeId: 'n2',
            question: '修订问题',
            answer: '隐藏修订',
            source: 'manual' as const,
            createdAt: 1,
          },
        ],
        selectedVersions: { n2: 'r' },
      },
    };
    const { container, rerender } = renderCanvas(props);
    fireEvent.click(screen.getByLabelText('标签与导出'));
    const download = () =>
      screen.getByRole('button', { name: /导出整图.*JSONL/ }) as HTMLButtonElement;
    expect(download().disabled).toBe(true);
    expect(card(container, 'n2')).toBeNull();
    rerender(<SessionDagCanvas {...props} historyReady />);
    const capture = vi.fn((_blob: Blob) => 'blob:fake');
    const previous = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: capture });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      fireEvent.click(download());
      vi.useRealTimers();
      const [blob] = capture.mock.calls[0];
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
      expect(
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toContainEqual(
        expect.objectContaining({
          id: 'n2',
          original: { question: nodes[1].question, answer: nodes[1].answer },
          selected: { version: 'r', question: '修订问题', answer: '隐藏修订' },
        }),
      );
    } finally {
      click.mockRestore();
      if (previous) Object.defineProperty(URL, 'createObjectURL', previous);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      vi.useRealTimers();
    }
  });

  it('标签与筛选接到画布状态并持久化，标签可沿路径导出', () => {
    const { container, onStateChange } = renderCanvas();
    fireEvent.click(pointer(card(container, 'n1'), /打开原生对话/));
    fireEvent.click(within(container).getByRole('button', { name: '标签与导出' }));
    fireEvent.change(screen.getByLabelText('节点标签'), { target: { value: '重点' } });
    fireEvent.click(screen.getByText('保存'));
    expect(onStateChange.mock.lastCall![1].labels.n1).toBe('重点');
    expect(card(container, 'n1').textContent).toContain('重点');
    fireEvent.click(within(container).getByRole('button', { name: '查找轮次' }));
    fireEvent.change(screen.getByLabelText('搜索问答或标签'), { target: { value: 'n2' } });
    fireEvent.click(within(container).getByRole('button', { name: '下一个匹配' }));
    expect(screen.getByRole('status').textContent).toContain('1 个匹配');
  });
});
