// @vitest-environment jsdom
/**
 * GhostFormDialogHost.test — form 槽 renderer 落地的组件测试。
 *
 * 测试价值
 * - 生产入口与可观察结果:挂载 GhostFormDialogHost,经 electronAPI.ghosts.onFormRequest 推入表单;
 *   用户看到的报错、点保存/取消/额外操作后回给 main 的答复(resolveForm 的参数)。
 * - Bug／规则依据:新增 form 槽(2026-11-23);DESIGN.md §4 Inputs & Forms(必填项就地报错、聚焦第一个错项)
 *   与 §4 Dialog & Modal(取消 / 额外操作 / 主操作的顺序与语义,不点遮罩关闭)。
 * - 现有覆盖缺口:新组件;main 侧单测只覆盖收口与往返,不覆盖用户在表单里增删条目、必填拦截和
 *   额外操作的二次确认。
 * - 最小失败输入:必填项为空时点保存;新增一条(上一条收起成摘要)后不填就保存,应展开它并提示;
 *   保存后条目 id 不该凭空出现,已有条目 id 要带回;
 *   二次确认点了取消;main 发来 dismissed。
 * - tier:unit(jsdom,只在测试内渲染组件,无真实 IPC)。单独成文件:需要 jsdom 环境,不能并入 node 环境的
 *   formSlot.test.ts;组件此前没有测试文件。
 * - 实测耗时:见 PR 描述。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GhostFormSpec } from '../../../shared/ghostForm';
import { GhostFormDialogHost } from '../GhostFormDialogHost';

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) => (args && Object.keys(args).length ? `${key}:${JSON.stringify(args)}` : key),
  }),
}));

const SPEC: GhostFormSpec = {
  title: '顾雍',
  description: '消息先对上是哪件事再交出去。',
  fields: [
    {
      type: 'list', key: 'topics', label: '要处理的事', hint: null, itemLabel: '事情', addText: '再加一件事', maxItems: 3,
      fields: [{ type: 'text', key: 'what', label: '什么样的消息', hint: null, placeholder: null, required: true, maxLength: 60 }],
    },
  ],
  values: { topics: [{ id: 't1', what: '' }] },
  submitText: null,
  cancelText: null,
  action: { id: 'unfollow', text: '删除关注', danger: true, confirm: '确定删除关注?', icon: 'trash' },
};

describe('GhostFormDialogHost', () => {
  let push: ((payload: unknown) => void) | undefined;
  let dismiss: ((payload: { requestId: string }) => void) | undefined;
  const resolveForm = vi.fn();

  beforeEach(() => {
    mocks.confirm.mockReset();
    resolveForm.mockReset().mockResolvedValue({ handled: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ghosts: {
        onFormRequest: (callback: (payload: unknown) => void) => { push = callback; return () => { push = undefined; }; },
        onFormDismissed: (callback: (payload: { requestId: string }) => void) => { dismiss = callback; return () => { dismiss = undefined; }; },
        resolveForm,
      },
    };
  });

  afterEach(() => cleanup());

  const open = (requestId = 'r1') => {
    render(<GhostFormDialogHost />);
    act(() => push!({ requestId, ghostId: 'xd-feishu', ghostName: 'XD Feishu', spec: SPEC }));
  };

  it('必填项为空时保存被拦下并就地报错;新增一条时上一条收起成摘要,没填的新条目在保存时展开提示;回包带回已有条目 id', () => {
    open();
    expect(screen.getByText('XD Feishu')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.form.save' }));
    expect(resolveForm).not.toHaveBeenCalled();
    expect(screen.getByText('settings.ghosts.form.required')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('什么样的消息'), { target: { value: '让我提交 iOS 审核' } });
    fireEvent.click(screen.getByRole('button', { name: '再加一件事' }));
    // 同时只展开一条:第一条收成以内容为标题的摘要行,只剩新条目的输入框。
    expect(screen.getByRole('button', { name: /让我提交 iOS 审核/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getAllByLabelText('什么样的消息')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /让我提交 iOS 审核/ }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.form.save' }));
    expect(resolveForm).not.toHaveBeenCalled();
    // 保存时展开没填完的那条并就地提示,刚才展开的那条收起。
    expect(screen.getByRole('button', { name: /让我提交 iOS 审核/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('settings.ghosts.form.required')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('什么样的消息'), { target: { value: '报销' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.form.save' }));

    expect(resolveForm).toHaveBeenCalledWith('r1', {
      outcome: 'submit',
      values: { topics: [{ id: 't1', what: '让我提交 iOS 审核' }, { what: '报销' }] },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('额外操作(图标按钮,读屏名字是文案)先过主机二次确认:点了取消不回包,确认后回 action;取消按钮回 cancel', async () => {
    open();
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除关注' })); });
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: '删除关注', description: '确定删除关注?', confirmVariant: 'destructive' }));
    expect(resolveForm).not.toHaveBeenCalled();

    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除关注' })); });
    expect(resolveForm).toHaveBeenCalledWith('r1', { outcome: 'action' });

    cleanup();
    resolveForm.mockClear();
    open('r2');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.form.cancel' }));
    expect(resolveForm).toHaveBeenCalledWith('r2', { outcome: 'cancel' });
  });

  it('main 发来 dismissed(那边已超时结算)时直接收起,不再回包', () => {
    open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => dismiss!({ requestId: 'r1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(resolveForm).not.toHaveBeenCalled();
  });
});
