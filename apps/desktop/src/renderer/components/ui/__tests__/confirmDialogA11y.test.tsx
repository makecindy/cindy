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
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../confirm-dialog';

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
    render(
      <ConfirmDialog open onOpenChange={() => {}} title="确定退出？" confirmText="退出" />,
    );
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
