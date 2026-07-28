// @vitest-environment jsdom
/**
 * confirmDialogScroll.test.tsx — 共享 ConfirmDialog 的「长内容不溢出屏幕」契约。
 *
 * 这里锁三件事(都是授权确认框出过的真实问题):
 * 1. 弹窗自己限高(max-h-[85vh])、标题与按钮固定,长内容在内部滚动;
 * 2. 滚动主体只有一个 —— caller 不必也不该再套一层限高;
 * 3. 弹窗一出现就闪一下滚动条:thumb 默认透明,不提示就等于让用户在
 *    「还有权限没看到」的情况下点同意。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../confirm-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const flashScrollbar = vi.fn();
vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: (el: Element) => flashScrollbar(el),
}));

afterEach(() => {
  cleanup();
  flashScrollbar.mockClear();
});

const longContent = (
  <div>
    {Array.from({ length: 40 }, (_, i) => (
      <p key={i}>权限条目 {i}</p>
    ))}
  </div>
);

describe('ConfirmDialog 长内容布局', () => {
  it('弹窗限高、按钮固定,长内容进内部滚动区', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="更新确认"
        description="从 1.0.0 更新到 2.0.0"
        content={longContent}
        confirmText="更新"
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.className).toContain('max-h-[85vh]');
    expect(dialog.className).toContain('flex-col');

    const scrollers = dialog.querySelectorAll('.overflow-y-auto');
    // 只有共享层这一个滚动主体,不出现嵌套限高。
    expect(scrollers.length).toBe(1);
    const scroller = scrollers[0] as HTMLElement;
    expect(scroller.className).toContain('min-h-0');
    expect(scroller.className).toContain('flex-1');
    expect(scroller.textContent).toContain('权限条目 39');

    // 标题与按钮行不参与压缩,内容再长也留在视口内。
    expect(screen.getByText('更新确认').className).toContain('shrink-0');
    const confirmBtn = screen.getByRole('button', { name: '更新' });
    expect((confirmBtn.parentElement as HTMLElement).className).toContain('shrink-0');
  });

  it('打开时闪一下滚动条,内容里的点击(如展开折叠区)后再闪一次', async () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="更新确认"
        content={longContent}
        confirmText="更新"
      />,
    );
    await vi.waitFor(() => expect(flashScrollbar).toHaveBeenCalled());
    const scroller = screen
      .getByRole('alertdialog')
      .querySelector('.overflow-y-auto') as HTMLElement;
    expect(flashScrollbar.mock.calls[0][0]).toBe(scroller);

    flashScrollbar.mockClear();
    fireEvent.click(screen.getByText('权限条目 0'));
    await vi.waitFor(() => expect(flashScrollbar).toHaveBeenCalledWith(scroller));
  });

  it('没有正文也没有富内容时不渲染滚动区(短弹窗排版不变)', () => {
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="确定退出？" confirmText="退出" />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelectorAll('.overflow-y-auto').length).toBe(0);
    expect(flashScrollbar).not.toHaveBeenCalled();
  });
});
