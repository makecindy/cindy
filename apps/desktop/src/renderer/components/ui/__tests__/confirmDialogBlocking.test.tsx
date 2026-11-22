// @vitest-environment jsdom
/**
 * confirmDialogBlocking.test.tsx — confirm({ blocking: true }) 的独立槽位与层级。
 *
 * 测试价值
 * - 生产入口与可观察结果：ConfirmDialogProvider + useConfirmDialog().confirm；用户看到的是
 *   阻断提示（登录过期）是否立刻出现、画在哪一层、关掉后普通确认与下面的面板是否还在、焦点去哪。
 * - Bug／规则依据：登录过期确认框会被 modal-raised 面板压住（PR3 #11982「已知残留」），且普通
 *   确认在队头时它只能排队；DESIGN.md §6 层级刻度 `modal-blocking`（2026-11-22 维护者裁决）。
 * - 现有覆盖缺口：confirmDialogA11y / confirmDialogScroll 只测单个确认框，没有多个确认并存的时序。
 * - 最小失败输入：普通 confirm 显示中再调 confirm({ blocking: true })——修复前第二个排在队列里不出现。
 * - tier：unit（jsdom 内渲染真实 Radix AlertDialog / Dialog，无外部资源）。
 */
import * as Dialog from '@radix-ui/react-dialog';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '../confirm-dialog-provider';
import { Z_INDEX_LAYERS } from '@/styles/generated/token-mappings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: () => {},
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** 越过确认槽位 200ms 的退场计时（fake timers 下推进，不做真实等待）。 */
function passExitTimer(): void {
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

type Confirm = ReturnType<typeof useConfirmDialog>['confirm'];

function renderProvider(children?: React.ReactNode): { confirm: Confirm } {
  const api = {} as { confirm: Confirm };
  function Capture() {
    api.confirm = useConfirmDialog().confirm;
    return null;
  }
  render(
    <ConfirmDialogProvider>
      <Capture />
      {children}
    </ConfirmDialogProvider>,
  );
  return api;
}

const dialogByTitle = (title: string) =>
  screen.queryAllByRole('alertdialog').find((node) => within(node).queryByText(title)) ?? null;

const EXPIRED = { title: '登录已过期', confirmText: '重新登录', showCancel: false, blocking: true } as const;

describe('confirm({ blocking: true })', () => {
  it('普通确认在队头时立即显示，画在 modal-blocking 层；关闭后普通确认仍在且焦点回到它', async () => {
    const { confirm } = renderProvider();
    let regular!: Promise<boolean>;
    act(() => {
      regular = confirm({ title: '删除这个文件？', confirmText: '删除' });
    });
    const regularDialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(regularDialog.contains(document.activeElement)).toBe(true));

    let expired!: Promise<boolean>;
    act(() => {
      expired = confirm(EXPIRED);
    });
    const blockingDialog = dialogByTitle(EXPIRED.title);
    expect(blockingDialog).not.toBeNull();
    // 遮罩与面板都在 modal-blocking：高于所有弹窗、菜单和浮层，低于 Toast。
    expect(Number(blockingDialog!.style.zIndex)).toBe(Z_INDEX_LAYERS['modal-blocking']);
    expect(Number(blockingDialog!.style.zIndex)).toBeGreaterThan(Z_INDEX_LAYERS['modal-popover-nested']);
    expect(Number(blockingDialog!.style.zIndex)).toBeLessThan(Z_INDEX_LAYERS.toast);
    await waitFor(() => expect(blockingDialog!.contains(document.activeElement)).toBe(true));

    fireEvent.click(within(blockingDialog!).getByRole('button', { name: '重新登录' }));
    await expect(expired).resolves.toBe(true);
    await waitFor(() => expect(dialogByTitle(EXPIRED.title)).toBeNull());

    // 普通确认没被顺带关掉，焦点回到它里面，仍能正常作答。
    const stillRegular = dialogByTitle('删除这个文件？');
    expect(stillRegular).not.toBeNull();
    await waitFor(() => expect(stillRegular!.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(stillRegular!).getByRole('button', { name: '删除' }));
    await expect(regular).resolves.toBe(true);
  });

  it('两个阻断提示依次显示，不会同时出现', async () => {
    const { confirm } = renderProvider();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = confirm({ ...EXPIRED, title: '第一条' });
      second = confirm({ ...EXPIRED, title: '第二条' });
    });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(dialogByTitle('第一条')).not.toBeNull();

    fireEvent.click(within(dialogByTitle('第一条')!).getByRole('button', { name: '重新登录' }));
    await expect(first).resolves.toBe(true);
    await waitFor(() => expect(dialogByTitle('第二条')).not.toBeNull());
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    fireEvent.click(within(dialogByTitle('第二条')!).getByRole('button', { name: '重新登录' }));
    await expect(second).resolves.toBe(true);
  });

  // Radix 按挂载顺序管理 FocusScope 与 Esc，不看 zIndex：阻断提示打开后再挂载的普通确认
  // 会抢走焦点和 Esc。阻断期间普通确认只入队不显示（#12118 review）。
  it('先阻断、后普通：普通确认暂缓，焦点与 Esc 留在阻断提示；阻断关闭后普通确认出现并拿到焦点', async () => {
    const { confirm } = renderProvider();
    let expired!: Promise<boolean>;
    act(() => {
      expired = confirm(EXPIRED);
    });
    const blockingDialog = dialogByTitle(EXPIRED.title)!;
    await waitFor(() => expect(blockingDialog.contains(document.activeElement)).toBe(true));

    let regular!: Promise<boolean>;
    act(() => {
      regular = confirm({ title: '允许插件读取这个文件夹？', confirmText: '允许', cancelText: '拒绝' });
    });
    expect(dialogByTitle('允许插件读取这个文件夹？')).toBeNull();
    expect(blockingDialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await expect(expired).resolves.toBe(false);
    await waitFor(() => expect(dialogByTitle(EXPIRED.title)).toBeNull());

    await waitFor(() => expect(dialogByTitle('允许插件读取这个文件夹？')).not.toBeNull());
    const regularDialog = dialogByTitle('允许插件读取这个文件夹？')!;
    await waitFor(() => expect(regularDialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(regularDialog).getByRole('button', { name: '允许' }));
    await expect(regular).resolves.toBe(true);
  });

  it('普通显示中 → 阻断 → 普通当前项被 abort：下一个普通确认不插进来，焦点留在阻断提示', async () => {
    const { confirm } = renderProvider();
    const controller = new AbortController();
    let first!: Promise<boolean>;
    act(() => {
      first = confirm({ title: '第一个普通确认', confirmText: '好' }, controller.signal);
    });
    await waitFor(() => expect(dialogByTitle('第一个普通确认')).not.toBeNull());

    let expired!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      expired = confirm(EXPIRED);
      second = confirm({ title: '第二个普通确认', confirmText: '好' });
    });
    const blockingDialog = dialogByTitle(EXPIRED.title)!;
    await waitFor(() => expect(blockingDialog.contains(document.activeElement)).toBe(true));

    // 普通当前项被 abort 后，推进过普通槽位的退场计时：下一个普通项仍不显示，焦点没被带走。
    vi.useFakeTimers();
    act(() => controller.abort());
    await expect(first).resolves.toBe(false);
    passExitTimer();
    expect(dialogByTitle('第一个普通确认')).toBeNull();
    expect(dialogByTitle('第二个普通确认')).toBeNull();
    expect(blockingDialog.contains(document.activeElement)).toBe(true);
    vi.useRealTimers();

    fireEvent.click(within(blockingDialog).getByRole('button', { name: '重新登录' }));
    await expect(expired).resolves.toBe(true);
    await waitFor(() => expect(dialogByTitle('第二个普通确认')).not.toBeNull());
    fireEvent.click(within(dialogByTitle('第二个普通确认')!).getByRole('button', { name: '好' }));
    await expect(second).resolves.toBe(true);
  });

  it('暂缓中的普通确认被 abort 时直接移出队列并按取消结算', async () => {
    const { confirm } = renderProvider();
    let expired!: Promise<boolean>;
    act(() => {
      expired = confirm(EXPIRED);
    });
    const controller = new AbortController();
    let queued!: Promise<boolean>;
    act(() => {
      queued = confirm({ title: '排队中的普通确认' }, controller.signal);
    });
    act(() => controller.abort());
    await expect(queued).resolves.toBe(false);

    // 阻断提示关闭并越过退场计时后普通槽位恢复：被 abort 的项已出队，不再出现。
    vi.useFakeTimers();
    fireEvent.click(within(dialogByTitle(EXPIRED.title)!).getByRole('button', { name: '重新登录' }));
    await expect(expired).resolves.toBe(true);
    passExitTimer();
    expect(screen.queryAllByRole('alertdialog')).toHaveLength(0);
  });

  it('盖在打开的 Radix 面板上时按钮能点；Esc 只关阻断提示，不顺带关掉下面的面板', async () => {
    const onPanelOpenChange = vi.fn();
    const { confirm } = renderProvider(
      <Dialog.Root open onOpenChange={onPanelOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="z-modal-raised" />
          <Dialog.Content className="z-modal-raised" aria-describedby={undefined}>
            <Dialog.Title>模型高级设置</Dialog.Title>
            <button type="button">面板里的按钮</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>,
    );
    const panel = await screen.findByRole('dialog');

    // showCancel=false 时没有取消按钮；Esc 走 onOpenChange(false)，按取消结算（resolve false）。
    let escaped!: Promise<boolean>;
    act(() => {
      escaped = confirm(EXPIRED);
    });
    let blockingDialog = dialogByTitle(EXPIRED.title)!;
    await waitFor(() => expect(blockingDialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await expect(escaped).resolves.toBe(false);
    await waitFor(() => expect(dialogByTitle(EXPIRED.title)).toBeNull());
    expect(onPanelOpenChange).not.toHaveBeenCalled();
    expect(panel.isConnected).toBe(true);
    // 焦点还给被打断的面板，而不是落到 body。
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));

    // 面板开着（body 被 Radix 设了 pointer-events:none）时，阻断提示是最上层可交互的那一层：
    // 下面的面板不再接收点击，阻断提示的按钮可以点击作答，点它不算点在面板外。
    let clicked!: Promise<boolean>;
    act(() => {
      clicked = confirm(EXPIRED);
    });
    await waitFor(() => expect(dialogByTitle(EXPIRED.title)).not.toBeNull());
    blockingDialog = dialogByTitle(EXPIRED.title)!;
    // Radix 在挂载后的下一拍才把下层切成不可点，先等它生效（真实用户不可能在 0ms 内点到）。
    await waitFor(() => expect(panel.style.pointerEvents).toBe('none'));
    expect(blockingDialog.style.pointerEvents).toBe('auto');
    fireEvent.pointerDown(within(blockingDialog).getByRole('button', { name: '重新登录' }));
    fireEvent.click(within(blockingDialog).getByRole('button', { name: '重新登录' }));
    await expect(clicked).resolves.toBe(true);
    expect(onPanelOpenChange).not.toHaveBeenCalled();
  });
});
