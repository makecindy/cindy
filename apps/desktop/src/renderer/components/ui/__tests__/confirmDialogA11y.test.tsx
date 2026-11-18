// @vitest-environment jsdom
/**
 * confirmDialogA11y.test.tsx — ConfirmDialog 无障碍关联的契约。
 *
 * 锁两件事(都来自 Full access 确认弹窗的 review,PR #1586):
 * 1. describeContent 开启时 aria-describedby 指向「description + 富内容」整个
 *    滚动区 —— 授权确认的开场朗读必须覆盖权限清单全文,否则屏幕阅读器用户
 *    在没听到实际权限的情况下就能确认;缺省关闭时保持 Radix 原生行为不变。
 * 2. confirmIcon 是纯装饰:必须 aria-hidden,且按钮的可访问名称仍等于
 *    confirmText —— 图标不得混进读屏输出或破坏按名称查询。
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../confirm-dialog';
import { ConfirmDialogProvider } from '../confirm-dialog-provider';
import { useConfirmTaskArchive } from '@/features/cc-agent/hooks/useConfirmTaskArchive';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: () => {},
}));

afterEach(cleanup);

const permissionList = (
  <div>
    <p>文件与文件夹:读取和修改工作区外的文件</p>
    <p>终端命令:直接执行终端命令与脚本</p>
  </div>
);

describe('ConfirmDialog describeContent', () => {
  it('开启时 aria-describedby 指向含 description 与富内容的滚动区', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="开启 Full access？"
        description="Full access 会关闭工作区沙箱:"
        content={permissionList}
        describeContent
        confirmText="开启 Full access"
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const target = document.getElementById(describedBy as string) as HTMLElement;
    // 指向的是滚动区本体:开场朗读同时覆盖引导句与逐条权限。
    expect(target.className).toContain('overflow-y-auto');
    expect(target.textContent).toContain('Full access 会关闭工作区沙箱:');
    expect(target.textContent).toContain('终端命令:直接执行终端命令与脚本');
  });

  it('缺省关闭时保持 Radix 原生行为:描述仅覆盖 description,不含富内容', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="更新确认"
        description="从 1.0.0 更新到 2.0.0"
        content={permissionList}
        confirmText="更新"
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const target = document.getElementById(describedBy as string) as HTMLElement;
    expect(target.textContent).toBe('从 1.0.0 更新到 2.0.0');
  });

  it('无 description 且未开启 describeContent 时不带 aria-describedby(既有行为)', () => {
    render(<ConfirmDialog open onOpenChange={() => {}} title="确定退出？" confirmText="退出" />);
    expect(screen.getByRole('alertdialog').getAttribute('aria-describedby')).toBeNull();
  });
});

describe('ConfirmDialog confirmIcon', () => {
  it('图标 aria-hidden,按钮可访问名称仍等于 confirmText', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="开启 Full access？"
        description="说明"
        confirmIcon={<svg data-testid="warn-icon" />}
        confirmText="开启 Full access"
      />,
    );
    // 图标不计入可访问名称:按 confirmText 原文查询必须命中。
    const confirmBtn = screen.getByRole('button', { name: '开启 Full access' });
    const iconWrapper = confirmBtn.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper.querySelector('[data-testid="warn-icon"]')).not.toBeNull();
  });
});

describe('ConfirmDialog action layout', () => {
  it('places Cancel first and keeps it focused on open', () => {
    render(<ConfirmDialog open onOpenChange={() => {}}
      title="Confirm" description="Description" confirmText="Confirm action" cancelText="Keep" />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      ['Keep', 'Confirm action'],
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
  });
  it('uses the same two actions and announces the loss when discard is checked', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="归档任务"
        description="归档前会保存更改。" confirmText="归档" cancelText="取消"
        dontShowAgainLabel="丢弃未提交的更改"
        checkedOverrides={{
          description: '未提交的更改和新文件将无法恢复。',
          confirmText: '丢弃并归档',
          confirmVariant: 'destructive',
        }}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole('alertdialog', { description: '归档前会保存更改。' });
    const checkbox = within(dialog).getByRole('checkbox', { name: '丢弃未提交的更改' });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual(
      ['取消', '归档'],
    );
    fireEvent.click(checkbox);
    expect(screen.getByRole('alertdialog', { description: '未提交的更改和新文件将无法恢复。' })).toBe(dialog);
    const actions = within(dialog).getAllByRole('button');
    expect(actions.map((button) => button.textContent)).toEqual(['取消', '丢弃并归档']);
    fireEvent.click(actions[1]);
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ dontShowAgain: true });
  });

  it('orders three actions Cancel, tertiary, primary in a widened dialog', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="ChatGPT 登录已失效"
        description="请先恢复登录"
        confirmText="打开 ChatGPT App"
        tertiaryText="重新登录 ChatGPT"
        cancelText="稍后处理"
        maxWidth={520}
      />,
    );

    expect(screen.getByRole('alertdialog').style.maxWidth).toBe('520px');
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      ['稍后处理', '重新登录 ChatGPT', '打开 ChatGPT App'],
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '稍后处理' }));
  });
});

// PR #11291 review: closing a background file tab must identify that task even
// after selecting discard. The generic dialog tests above do not call the archive
// hook with a target. Unit input: one named task, recoverable base text, dirty state.
describe('archive target identity', () => {
  it('keeps the target name in both states without the recovery promise on discard', () => {
    function ArchiveButton() {
      const confirm = useConfirmTaskArchive();
      return <button onClick={() => { void confirm('dirty-discardable', [], {
        title: 'Background task',
        description: 'Background task can be restored from the archived view.',
      }); }}>Open archive</button>;
    }
    render(<ConfirmDialogProvider><ArchiveButton /></ConfirmDialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open archive' }));
    const title = 'ccAgent.sidebar.confirmArchive.title · Background task';
    const dialog = screen.getByRole('alertdialog', { name: title });
    const checkbox = within(dialog).getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(screen.getByRole('alertdialog', { name: title })).toBe(dialog);
    expect(dialog.textContent).not.toContain('can be restored');
    expect(screen.getByRole('button', { name: 'ccAgent.sidebar.confirmArchive.discardAndArchive' })).toBeTruthy();
  });
});
