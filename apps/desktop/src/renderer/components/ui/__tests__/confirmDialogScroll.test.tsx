// @vitest-environment jsdom
/**
 * confirmDialogScroll.test.tsx — 共享 ConfirmDialog 的「长内容不溢出屏幕」契约。
 *
 * 这里锁四件事(都是授权确认框出过的真实问题):
 * 1. 弹窗自己限高(max-h-[85vh])、标题与按钮固定,长内容在内部滚动;
 * 2. 滚动主体只有一个 —— caller 不必也不该再套一层限高;
 * 3. 弹窗一出现就闪一下滚动条:thumb 默认透明,不提示就等于让用户在
 *    「还有权限没看到」的情况下点同意;
 * 4. 确认框打开时,遮罩(Overlay 即全屏 drag 区)仍可拖动无边框窗口,弹窗内容
 *    作为遮罩的 DOM 后代保持 no-drag(挖洞只在 drag 元素的后代上可靠生效),
 *    且居中走布局而非 transform —— app-region 命中区不跟随 transform,挖洞
 *    必须与弹窗视觉位置重合;关闭后遮罩随 Radix Presence 卸载,不留常驻拖拽区。
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

  it('确认框遮罩保留窗口拖动,弹窗以 drag 遮罩的后代挖洞,且居中不走 transform', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="安装插件"
        content={longContent}
        confirmText="安装插件"
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    // 全屏 drag 遮罩(Overlay)是弹窗的 DOM 父级:no-drag 挖洞只在 drag 元素
    // 自己的后代上可靠生效(实机结论,ContentHeader.tsx:155-157),弹窗必须
    // 嵌在遮罩里,而不能是与 drag 遮罩平级的 Portal 兄弟。
    const dragRegion = dialog.parentElement as HTMLElement;
    expect(dragRegion).not.toBeNull();
    expect(
      (dragRegion.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('drag');
    expect(
      (dialog.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    // 遮罩自身带 Radix 管理的 data-state:Portal 的 Presence 依赖它配合
    // 退场动画延迟卸载,弹窗退场(150ms)不会瞬间消失。
    expect(dragRegion.getAttribute('data-state')).toBe('open');
    // 居中必须走布局(inset-0 + m-auto)而非 transform:Electron 的 app-region
    // 命中区按布局矩形计算、不跟随 transform,用 -translate-* 定位会让
    // no-drag 挖洞与弹窗视觉位置错位(点击弹窗内容会变成拖窗)。
    expect(dialog.className).not.toMatch(/-translate-/);
    expect(dialog.className).toContain('inset-0');
    expect(dialog.className).toContain('m-auto');
    expect(dialog.className).toContain('h-fit');
    // 动画必须走无 translate 的 layout keyframes:共享 confirm-content-in/out
    // 的每一帧都烘 translate(-50%, -50%),布局居中弹窗用它会在入退场期间
    // 被甩出 no-drag 挖洞(tailwind.config.ts 注释同步钉住这条分工)。
    expect(dialog.className).toContain('animate-confirm-content-layout-in');
    expect(dialog.className).toContain('animate-confirm-content-layout-out');
    expect(dialog.className).not.toContain('animate-confirm-content-in');
    expect(dialog.className).not.toContain('animate-confirm-content-out');
  });

  it('关闭后全屏 drag 遮罩随 Presence 卸载,不留常驻拖拽区', () => {
    const props = {
      onOpenChange: () => {},
      title: '安装插件',
      content: longContent,
      confirmText: '安装插件',
    };
    const { rerender } = render(<ConfirmDialog open {...props} />);
    const dragRegion = screen.getByRole('alertdialog').parentElement as HTMLElement;

    rerender(<ConfirmDialog open={false} {...props} />);

    // Radix 对 Portal 直接子元素套 Presence:遮罩 data-state 翻转 + 退场动画
    // 结束后卸载(jsdom 无 CSS 动画,走无动画分支立即卸载)。任何路径下
    // 全屏 drag 遮罩都不能残留在 DOM 里 —— 否则会成为常驻的全屏窗口拖拽区,
    // 吞掉整个应用的点击。
    expect(document.body.contains(dragRegion)).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
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
    render(<ConfirmDialog open onOpenChange={() => {}} title="确定退出？" confirmText="退出" />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.querySelectorAll('.overflow-y-auto').length).toBe(0);
    // 对照项：没有显式开放框选的普通确认框仍保持防误选行为。
    expect(dialog.className).toContain('select-none');
    expect(dialog.className).not.toContain('select-text');
    expect(flashScrollbar).not.toHaveBeenCalled();
  });

  it('手输确认逐字匹配且正文可选择，前后空格不能绕过 id 核对', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="企业身份自测"
        description="确认域名"
        content={<div>api.acme.test</div>}
        contentSelectable
        confirmText="安装"
        requireTypedConfirmation={{ expected: 'acme-tool', label: '输入插件 id' }}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByLabelText('输入插件 id');
    const confirmButton = screen.getByRole('button', { name: '安装' });
    const dialog = screen.getByRole('alertdialog');
    // 根节点必须撤掉 select-none；只在子滚动区加 select-text 无法保证展示 id 可框选。
    expect(dialog.className).toContain('select-text');
    expect(dialog.className).not.toContain('select-none');
    expect(dialog.querySelector('.overflow-y-auto')?.className).toContain('select-text');

    fireEvent.change(input, { target: { value: ' acme-tool ' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'acme-tool' } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('手输匹配后按 Enter 仍服从调用方的额外禁用条件', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="企业身份自测"
        confirmText="安装"
        confirmDisabled
        requireTypedConfirmation={{ expected: 'acme-tool', label: '输入插件 id' }}
        onConfirm={onConfirm}
      />,
    );

    const input = screen.getByLabelText('输入插件 id');
    fireEvent.change(input, { target: { value: 'acme-tool' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((screen.getByRole('button', { name: '安装' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
