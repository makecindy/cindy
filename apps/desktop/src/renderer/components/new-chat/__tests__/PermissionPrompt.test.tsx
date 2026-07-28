// @vitest-environment jsdom
/**
 * PermissionPrompt.test.tsx — 权限卡片的档位切换入口。
 *
 * 卡片顶替 composer 时 ChatInput 不挂载,composer 上的权限 chip 和 Shift+Tab 轮切
 * 一起失效,用户在连续授权里没法切到自动放行。这里锁死补上的那条路:
 *   - 不传 modeSwitch 时卡片与改造前一致(chip 不出现);
 *   - 本组件自己**不** onRespond —— 当前 pending 由 maker-core 的 dismissAllPending
 *     按新档结掉(放宽→allow,其它→deny),渲染层不得再叠一次回应;
 *   - 远程断链(disabled)时 chip 与快捷键一起停用;
 *   - 模态(Full access 二次确认)里的按键不穿透成 Allow/Deny;
 *   - 原有 Enter / Ctrl+Enter / Esc 语义不被轮切分支挤掉。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionModeDescriptor } from '@/hooks/useAgentCapabilities';
import type { PendingPermission } from '@/lib/makerChatStore';

// 仓库同款 i18n mock:t 返回 key 本身(带参时拼上参数便于断言)。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args && Object.keys(args).length > 0 ? `${key}:${JSON.stringify(args)}` : key,
  }),
}));

// 真实 PermissionSelector 会拉 capabilities / i18n / MorphPopover;这里只验它被挂上、
// 拿到了当前档,弹层与配色由 PermissionSelector 自己的用例负责。
vi.mock('../PermissionSelector', () => ({
  PermissionSelector: ({ permissionMode }: { permissionMode: string }) => (
    <div data-testid="permission-chip">{permissionMode}</div>
  ),
}));

import { PermissionPrompt } from '../PermissionPrompt';

afterEach(cleanup);

const PERMISSION: PendingPermission = {
  requestId: 'req-1',
  toolName: 'Bash',
  input: { command: 'curl -s https://example.com' },
};

const CYCLE_OPTIONS: PermissionModeDescriptor[] = [
  { id: 'ask', displayName: '询问' },
  { id: 'acceptEdits', displayName: '自动接受编辑' },
  { id: 'bypassPermissions', displayName: '完全访问' },
];

/** registry 默认绑定:Shift+Tab(matchesKeyboardEvent 按 event.code 判定)。 */
function pressCyclePermissionMode() {
  fireEvent.keyDown(window, { key: 'Tab', code: 'Tab', shiftKey: true });
}

describe('PermissionPrompt modeSwitch', () => {
  it('不传 modeSwitch 时不渲染档位 chip', () => {
    render(<PermissionPrompt permission={PERMISSION} onRespond={vi.fn()} />);

    expect(screen.queryByTestId('permission-chip')).toBeNull();
    expect(screen.getByText('agentIsland.native.allowOnce')).toBeTruthy();
  });

  it('传入时把当前档挂到卡片上', () => {
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'acceptEdits',
          onPermissionModeChange: vi.fn(),
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    expect(screen.getByTestId('permission-chip').textContent).toBe('acceptEdits');
  });

  it('Shift+Tab 轮到下一档,渲染层自身不 onRespond(pending 归 maker-core 结)', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('可用档不足 2 个时不消费按键', () => {
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: [{ id: 'ask', displayName: '询问' }],
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it('远程断链(disabled)时快捷键轮切一并停用', () => {
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={vi.fn()}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
          disabled: true,
        }}
      />,
    );

    pressCyclePermissionMode();

    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  // 切 Full access 会在卡片仍挂载时弹二次确认框。确认框聚焦的是普通 <button>,
  // 不挡就会让确认框上的 Enter/Esc 顺带回答掉这条工具请求。
  it('模态内的 Enter / Esc 不穿透到卡片动作', () => {
    const onRespond = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange: vi.fn(),
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const cancelButton = document.createElement('button');
    dialog.appendChild(cancelButton);
    document.body.appendChild(dialog);

    fireEvent.keyDown(cancelButton, { key: 'Enter', code: 'Enter', bubbles: true });
    fireEvent.keyDown(cancelButton, { key: 'Escape', code: 'Escape', bubbles: true });

    expect(onRespond).not.toHaveBeenCalled();
    document.body.removeChild(dialog);
  });

  // 档位菜单是 MorphPopover,portal 到 body、不在卡片 DOM 子树内。不挡的话键盘用户
  // 在菜单里按 Esc 关菜单会顺带 Deny 掉请求,按 Enter 选档会先被 Allow once 截胡。
  it.each([
    ['权限档菜单(listbox)', { role: 'listbox' }],
    ['MorphPopover 面板', { 'data-morph-side': 'top' }],
    ['chip trigger(aria-haspopup)', { 'aria-haspopup': 'listbox' }],
  ])('%s 里的 Enter / Esc 不穿透到卡片动作', (_label, attrs) => {
    const onRespond = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange: vi.fn(),
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    const layer = document.createElement('div');
    for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v);
    const option = document.createElement('button');
    layer.appendChild(option);
    document.body.appendChild(layer);

    fireEvent.keyDown(option, { key: 'Enter', code: 'Enter', bubbles: true });
    fireEvent.keyDown(option, { key: 'Escape', code: 'Escape', bubbles: true });

    expect(onRespond).not.toHaveBeenCalled();
    document.body.removeChild(layer);
  });

  // 协同布局下 lead 与 worker 各挂一个 CCAgentSessionView,右栏折叠时 body 仍挂载。
  // 看不见的实例若也注册 window 快捷键,一次按键会把用户没看见的那张卡上的请求
  // 一并结掉(Shift+Tab 尤其隐蔽:切档连带 dismiss pending)。
  it('shortcutsActive=false 时不注册任何 window 快捷键', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        shortcutsActive={false}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    pressCyclePermissionMode();

    expect(onRespond).not.toHaveBeenCalled();
    expect(onPermissionModeChange).not.toHaveBeenCalled();
    // 卡片本身照常渲染,只是不吃键盘。
    expect(screen.getByTestId('permission-chip')).toBeTruthy();
  });

  it('多实例并存时只有可见的那张响应快捷键', () => {
    const visibleRespond = vi.fn();
    const hiddenRespond = vi.fn();
    render(
      <>
        <PermissionPrompt permission={PERMISSION} onRespond={hiddenRespond} shortcutsActive={false} />
        <PermissionPrompt permission={PERMISSION} onRespond={visibleRespond} />
      </>,
    );

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });

    expect(visibleRespond).toHaveBeenCalledWith({ behavior: 'allow' });
    expect(hiddenRespond).not.toHaveBeenCalled();
  });

  // Orca 协同 tab 打开时 lead 与 focused worker 的 viewVisible 都是 true,只靠"可见"
  // 过滤仍会两张卡都注册 handler,一次按键结掉两个会话的请求。所有权走 LIFO 栈:
  // 最近出现的那张卡吃键盘,它退场后交还给上一张。
  it('两张都可见时只有最后出现的那张吃快捷键', () => {
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const { unmount: unmountSecond } = (() => {
      render(<PermissionPrompt permission={PERMISSION} onRespond={firstRespond} />);
      return render(<PermissionPrompt permission={PERMISSION} onRespond={secondRespond} />);
    })();

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(secondRespond).toHaveBeenCalledWith({ behavior: 'allow' });
    expect(firstRespond).not.toHaveBeenCalled();

    // 后来的那张退场 → 所有权交还给先前那张。
    secondRespond.mockClear();
    unmountSecond();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(firstRespond).toHaveBeenCalledWith({ behavior: 'allow' });
    expect(secondRespond).not.toHaveBeenCalled();
  });

  // 键盘用户 Tab 到卡片按钮后:Shift+Tab 是"回上一个控件"、Enter 是"按下这颗按钮",
  // 都不该被 window handler 抢走(抢走会变成想 Deny 却 Allow、想挪焦点却切了档)。
  it('焦点在卡片按钮上时快捷键让位给原生键盘语义', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    const denyButton = screen.getByText('agentIsland.native.deny').closest('button')!;
    fireEvent.keyDown(denyButton, { key: 'Enter', code: 'Enter', bubbles: true });
    fireEvent.keyDown(denyButton, { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true });

    expect(onRespond).not.toHaveBeenCalled();
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  // 授权是一次性决定:长按 Enter 连发的 keydown 不能把同一条请求重复 settle。
  it('长按连发的重复 keydown 只作数一次', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={PERMISSION} onRespond={onRespond} />);

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', repeat: true });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', repeat: true });

    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  // cycle-permission-mode 允许被改绑成 Ctrl+Enter。卡片按钮上白纸黑字写着
  // "Always allow",界面承诺什么按键就得做什么 —— 决定键优先于可改绑的轮切键。
  it('轮切键被改绑到 Ctrl+Enter 时,卡片印的决定键仍然优先', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    render(
      <PermissionPrompt
        permission={{ ...PERMISSION, suggestions: [{ destination: 'session' }] }}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'allow', decisionClassification: 'user_permanent' }),
    );
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });

  it('没有 modeSwitch 时 Shift+Tab 不做任何事', () => {
    const onRespond = vi.fn();
    render(<PermissionPrompt permission={PERMISSION} onRespond={onRespond} />);

    pressCyclePermissionMode();

    expect(onRespond).not.toHaveBeenCalled();
  });

  it('轮切分支不影响 Enter / Esc 的既有语义', () => {
    const onRespond = vi.fn();
    const onPermissionModeChange = vi.fn();
    const { rerender } = render(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );

    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    expect(onRespond).toHaveBeenCalledWith({ behavior: 'allow' });

    onRespond.mockClear();
    rerender(
      <PermissionPrompt
        permission={PERMISSION}
        onRespond={onRespond}
        modeSwitch={{
          permissionMode: 'ask',
          onPermissionModeChange,
          vendorKey: 'cc',
          cycleOptions: CYCLE_OPTIONS,
        }}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'deny', decisionClassification: 'user_reject' }),
    );
    expect(onPermissionModeChange).not.toHaveBeenCalled();
  });
});
