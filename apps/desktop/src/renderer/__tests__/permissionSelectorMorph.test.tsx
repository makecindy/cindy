// @vitest-environment jsdom

/**
 * PermissionSelector × MorphPopover(容器形变试点)行为回归:
 * - 点击 trigger 打开 listbox(portal 渲染,四档全在)
 * - 选项点击回调 onPermissionModeChange 并收合
 * - Esc / outside pointerdown 关闭
 * - 形变期间 trigger wrapper 隐形,收合后复形(「不是盖一层」的核心语义)
 * jsdom 无布局引擎(rect 全 0),几何/丝滑度不在此测——那部分靠 docs/design-rules/cindy-design-system.md
 * §14.4 的实测要求与人工走查兜底。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // triggerAria 这类 key 用 {label} 插值,mock 直接回吐 label,让按钮可及名可断言
    t: (_key: string, opts?: { defaultValue?: string; label?: string }) =>
      opts?.defaultValue ?? (opts?.label ? String(opts.label) : _key),
  }),
}));

const PERMISSION_MODES = [
  { id: 'ask', displayName: '默认权限', description: 'ask desc' },
  { id: 'acceptEdits', displayName: '允许编辑', description: 'edits desc' },
  { id: 'auto', displayName: '自动审批', description: 'auto desc' },
  { id: 'bypassPermissions', displayName: '完全访问', description: 'bypass desc' },
];
let mockPermissionModes = PERMISSION_MODES;

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: { permissionModes: mockPermissionModes } }),
}));

import { PermissionSelector } from '../components/new-chat/PermissionSelector';

afterEach(() => {
  mockPermissionModes = PERMISSION_MODES;
  cleanup();
  vi.restoreAllMocks();
});

function renderSelector(overrides: Partial<Parameters<typeof PermissionSelector>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <PermissionSelector permissionMode="ask" onPermissionModeChange={onChange} {...overrides} />,
  );
  return { onChange, ...utils };
}

function getTrigger(): HTMLElement {
  return screen.getByRole('button', { name: /默认权限|完全访问/ });
}

describe('PermissionSelector (MorphPopover pilot)', () => {
  // 2026-07-22:PermissionSelector 只在 composer 使用,已统一为「恒走脱身上浮 morph」——
  // 移除 origin/main 的 useMorphPopover opt-in/Radix 回退开关,故删去原「默认用 Radix」用例。
  it('点击 trigger 打开 listbox,四档选项齐全,aria-expanded 同步', async () => {
    renderSelector();
    const trigger = getTrigger();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // 选中档正确标记
    const selected = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toBeTruthy();
  });

  it('打开时聚焦当前选中权限，避免 focus tooltip 错指向首个选项', async () => {
    renderSelector({ permissionMode: 'bypassPermissions' });
    fireEvent.click(getTrigger());

    const selectedOption = await screen.findByRole('option', { name: '完全访问' });
    await waitFor(() => expect(document.activeElement).toBe(selectedOption));
  });

  it.each([
    ['chip', undefined],
    ['field', 'field' as const],
  ])('%s 形态在 capability 异步返回后聚焦当前选中权限', async (_name, triggerVariant) => {
    mockPermissionModes = [];
    const { onChange, rerender } = renderSelector({
      permissionMode: 'bypassPermissions',
      triggerVariant,
    });
    fireEvent.click(screen.getByRole('button', { name: /bypassPermissions/ }));
    await screen.findByRole('listbox');

    mockPermissionModes = PERMISSION_MODES;
    rerender(
      <PermissionSelector
        permissionMode="bypassPermissions"
        onPermissionModeChange={onChange}
        triggerVariant={triggerVariant}
      />,
    );

    const selectedOption = await screen.findByRole('option', { name: '完全访问' });
    await waitFor(() => expect(document.activeElement).toBe(selectedOption));
  });

  it('从当前权限支持方向键、Home、End 访问全部选项', async () => {
    renderSelector({ permissionMode: 'bypassPermissions' });
    fireEvent.click(getTrigger());

    const listbox = await screen.findByRole('listbox');
    const defaultOption = screen.getByRole('option', { name: '默认权限' });
    const bypassOption = screen.getByRole('option', { name: '完全访问' });
    await waitFor(() => expect(document.activeElement).toBe(bypassOption));
    expect(bypassOption.tabIndex).toBe(0);
    expect(defaultOption.tabIndex).toBe(-1);

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(defaultOption);
    expect(defaultOption.tabIndex).toBe(0);
    expect(bypassOption.tabIndex).toBe(-1);
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(bypassOption);
    expect(bypassOption.tabIndex).toBe(0);
    expect(defaultOption.tabIndex).toBe(-1);
    fireEvent.keyDown(listbox, { key: 'Home' });
    expect(document.activeElement).toBe(defaultOption);
    expect(defaultOption.tabIndex).toBe(0);
    expect(bypassOption.tabIndex).toBe(-1);
    fireEvent.keyDown(listbox, { key: 'End' });
    expect(document.activeElement).toBe(bypassOption);
    expect(bypassOption.tabIndex).toBe(0);
    expect(defaultOption.tabIndex).toBe(-1);
  });

  it('点击选项回调 onPermissionModeChange 并收合卸载', async () => {
    const { onChange } = renderSelector();
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');

    fireEvent.click(screen.getByText('完全访问'));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
    // 收合动画(300ms+20)后 portal 卸载
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
  });

  it('Esc 关闭;outside pointerdown 关闭', async () => {
    renderSelector();
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });

    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
  });

  it('脱身上浮:trigger 全程可见,再点 trigger 即关闭(toggle)', async () => {
    renderSelector();
    const trigger = getTrigger();
    const wrap = trigger.closest('span.relative') as HTMLElement;
    expect(wrap).toBeTruthy();

    fireEvent.click(trigger);
    await screen.findByRole('listbox');
    // 脱身上浮语义(2026-07-22 定稿):chip 不隐藏,保住「原地再点一下收起」
    expect(wrap.style.visibility).not.toBe('hidden');

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('disabled 时点击不打开', () => {
    renderSelector({ disabled: true });
    fireEvent.click(screen.getByRole('button', { name: /默认权限/ }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

/**
 * field 形态(设置页表单字段)—— 由「IM 机器人 → 工作目录映射」引入。trigger 换成
 * 与 ModelSelector 的 field trigger 逐字对齐的输入面,选项列表与权限语义不分叉;
 * chip 形态(composer)必须逐字不变。
 */
describe('PermissionSelector triggerVariant', () => {
  it('默认 chip 形态:composer 胶囊,无输入面边框', () => {
    renderSelector();
    const cls = getTrigger().className;
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('border-transparent');
    expect(cls).not.toContain('settings-input-bg');
  });

  it('普通会话的超窄态也收成图标，field 形态不受影响', () => {
    const { unmount } = renderSelector({ iconOnly: true });
    const compactTrigger = getTrigger();
    expect(compactTrigger.className).toContain('w-[34px]');
    expect(compactTrigger.textContent).toBe('');
    expect(compactTrigger.getAttribute('aria-label')).toContain('默认权限');

    unmount();
    renderSelector({ iconOnly: true, triggerVariant: 'field' });
    expect(getTrigger().textContent).toContain('默认权限');
  });

  it('field 形态:输入面样式,与 ModelSelector 的 field trigger 同规格(pill,§4 Select 触发器)', () => {
    renderSelector({ triggerVariant: 'field' });
    const cls = getTrigger().className;
    // DESIGN.md §4 Select & Dropdown:单行 select trigger 同单行输入,胶囊形(9999px),
    // 不是 8px 内圆角(那一档只留给穿不了 pill 的控件)。
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('border-[var(--border-default)]');
    expect(cls).toContain('bg-[var(--settings-input-bg)]');
    expect(cls).toContain('hover:bg-[var(--surface-hover-soft)]');
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('rounded-lg');
  });

  it('field 形态 dense 压一档高度(与同排模型字段等高)', () => {
    renderSelector({ triggerVariant: 'field', dense: true });
    expect(getTrigger().className).toContain('h-9');
  });

  // 弹层原语按形态分叉(权限语义共用一份):chip = MorphPopover(容器形变是 composer
  // 专属类目,§14.4,恒向上);field = **Radix Popover**(锚点随设置页滚动跟随、collision
  // 自动翻转)。此前两版尝试(恒 bottom / morph 动态选侧)都被实测打回:morph 只在打开时
  // 测一次 fixed 几何,恒定侧在页面首/末行截断,且滚动时面板脱锚 —— 设置页一律走 Radix。
  it('chip 走 morph(向上);field 走 Radix Popover,不再是 morph', async () => {
    const { unmount } = renderSelector();
    fireEvent.click(getTrigger());
    const chipPanel = await screen.findByRole('listbox');
    expect(chipPanel.closest('[data-morph-side]')?.getAttribute('data-morph-side') ?? 'top').toBe(
      'top',
    );
    unmount();
    cleanup();

    renderSelector({ triggerVariant: 'field' });
    fireEvent.click(getTrigger());
    const fieldPanel = await screen.findByRole('listbox');
    // Radix PopoverContent 而非 morph 面板:无 data-morph-side 祖先,有 Radix 定位包装
    expect(fieldPanel.closest('[data-morph-side]')).toBeNull();
    const popperWrapper = fieldPanel.closest('[data-radix-popper-content-wrapper]');
    expect(popperWrapper).not.toBeNull();
    // DESIGN.md §4:下拉面板无阴影(分离感来自层色/描边)。共享 PopoverContent 默认
    // shadow-md,field 面板必须显式压掉(codex review 2026-07-25)。
    const content = popperWrapper?.firstElementChild as HTMLElement;
    expect(content.className).toContain('shadow-none');
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('field 形态仍走同一份选项列表与危险档配色', async () => {
    const { onChange } = renderSelector({ triggerVariant: 'field' });
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')).toHaveLength(4);

    fireEvent.click(screen.getByText('完全访问'));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('field 形态打开时同样聚焦当前选中权限', async () => {
    renderSelector({ triggerVariant: 'field', permissionMode: 'bypassPermissions' });
    fireEvent.click(getTrigger());

    const selectedOption = await screen.findByRole('option', { name: '完全访问' });
    await waitFor(() => expect(document.activeElement).toBe(selectedOption));
  });

  it('ariaContext 前置到 trigger 可及名(多实例同屏读屏区分,不传则原样)', () => {
    renderSelector({ triggerVariant: 'field', ariaContext: '权限模式 · chat' });
    expect(screen.getByRole('button', { name: '权限模式 · chat:默认权限' })).toBeTruthy();
  });

  it('field 形态选中危险档时只染文字,不改底色', () => {
    renderSelector({ triggerVariant: 'field', permissionMode: 'bypassPermissions' });
    const cls = getTrigger().className;
    expect(cls).toContain('text-[var(--perm-bypass-selected-text)]');
    // 底仍是输入面,不因危险档换底色
    expect(cls).toContain('bg-[var(--settings-input-bg)]');
  });
});
