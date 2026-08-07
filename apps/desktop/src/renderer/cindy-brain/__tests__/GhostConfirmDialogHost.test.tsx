// @vitest-environment jsdom
/**
 * GhostConfirmDialogHost.test.tsx — confirm 槽 renderer 落地的契约。
 *
 * 锁两件事(2026-08-07 连接授权确认改造):
 * 1. 宿主受信确认的 detail(第二段正文)渲染在确认框里,纯文本、secondary 色;
 * 2. 用户点击后经 resolveConfirm 回包(确认 true / 取消 false),main 据此结算。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { GhostConfirmDialogHost } from '../GhostConfirmDialogHost';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'settings.ghosts.confirm.dialogTitle') return `确认操作（${String(options?.name ?? '')}）`;
      if (key === 'commonUi.confirmDialog.confirm') return '确定';
      if (key === 'commonUi.confirmDialog.cancel') return '取消';
      return key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: vi.fn(),
}));

// 捕获 onConfirmRequest 回调,测试里手动触发。
let capturedCallback: ((payload: {
  requestId: string;
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  body: string;
  detail?: string;
  title?: string;
  confirmText: string | null;
  cancelText: string | null;
  danger: boolean;
}) => void) | null = null;

const resolveConfirm = vi.fn(async () => ({ handled: true }));

beforeEach(() => {
  capturedCallback = null;
  resolveConfirm.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ghosts: {
      onConfirmRequest: (cb: typeof capturedCallback) => {
        capturedCallback = cb;
        return () => {};
      },
      resolveConfirm,
    },
  };
});

afterEach(() => {
  Reflect.deleteProperty(window, 'electronAPI');
  document.body.innerHTML = '';
});

// 渲染宿主(包在 ConfirmDialogProvider 里,useConfirmDialog 需要 context) + 触发一次确认请求。
async function renderAndRequest(payload: Parameters<NonNullable<typeof capturedCallback>>[0]) {
  render(
    <ConfirmDialogProvider>
      <GhostConfirmDialogHost />
    </ConfirmDialogProvider>,
  );
  expect(capturedCallback).toBeTruthy();
  // 回调内部是异步状态更新(confirm promise + provider 弹框),须包进 act,
  // 否则 React 在 act 边界外更新直接报 AggregateError。
  act(() => capturedCallback!(payload));
  return {
    dialog: await screen.findByRole('alertdialog'),
  };
}

describe('GhostConfirmDialogHost', () => {
  it('connection 确认:标题合并插件名 + 精简正文 + detail,点取消回包 false', async () => {
    await renderAndRequest({
      requestId: 'r1',
      ghostId: 'xdt-knowledge',
      ghostName: '心动小镇知识库',
      // 宿主受信确认:标题已合并插件名(main 拼「添加连接地址 · 心动小镇知识库」),
      // body 不含插件名;renderer 据此不再渲染独立身份头文字(避免重复)。
      title: '添加连接地址 · 心动小镇知识库',
      body: '请求添加连接地址 xdtown-knowledge-api.xdgtw.cn',
      detail: '允许后，该插件可经主机访问此地址(知识库 API)；你提供的凭证只会注入这个地址的请求。',
      confirmText: '允许访问',
      cancelText: '取消',
      danger: false,
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('添加连接地址 · 心动小镇知识库');
    expect(dialog.textContent).toContain('请求添加连接地址 xdtown-knowledge-api.xdgtw.cn');
    expect(dialog.textContent).toContain('允许后，该插件可经主机访问此地址');
    // 关闭对话框让 confirm promise settle,避免 cleanup 时挂起。
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('r1', false));
  });

  it('confirm 槽不传 title 时用默认「插件「x」请你确认」标题', async () => {
    await renderAndRequest({
      requestId: 'r1b',
      ghostId: 'some-ghost',
      ghostName: '某插件',
      body: '确认要执行这个操作吗？',
      confirmText: null,
      cancelText: null,
      danger: false,
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('确认操作（某插件）');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('r1b', false));
  });

  it('detail 缺省时只渲染 body,不出现空段落', async () => {
    await renderAndRequest({
      requestId: 'r2',
      ghostId: 'some-ghost',
      ghostName: '某插件',
      body: '确认要执行这个操作吗？',
      confirmText: null,
      cancelText: null,
      danger: true,
    });
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('确认要执行这个操作吗？');
    expect(dialog.textContent).not.toContain('允许后');
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('r2', false));
  });

  it('点「允许」经 resolveConfirm 回包 true', async () => {
    await renderAndRequest({
      requestId: 'r3',
      ghostId: 'xdt-knowledge',
      ghostName: '心动小镇知识库',
      body: '插件「心动小镇知识库」请求添加连接地址 api.example.com',
      detail: '允许后，该插件可经主机访问此地址',
      confirmText: '允许访问',
      cancelText: '取消',
      danger: false,
    });
    await userEvent.click(screen.getByRole('button', { name: '允许访问' }));
    await waitFor(() => expect(resolveConfirm).toHaveBeenCalledWith('r3', true));
  });
});
