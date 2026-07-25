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

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: { permissionModes: PERMISSION_MODES } }),
}));

import { PermissionSelector } from '../components/new-chat/PermissionSelector';

afterEach(() => {
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
    // 选中档正确标记(焦点策略 2026-07-23 改回落首个可交互项,恢复键盘可达性,见 codex review)
    const selected = screen
      .getAllByRole('option')
      .find((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toBeTruthy();
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

  it('field 形态:输入面样式,与 ModelSelector 的 field trigger 同规格', () => {
    renderSelector({ triggerVariant: 'field' });
    const cls = getTrigger().className;
    expect(cls).toContain('rounded-lg');
    expect(cls).toContain('border-[var(--border-default)]');
    expect(cls).toContain('bg-[var(--settings-input-bg)]');
    expect(cls).toContain('hover:bg-[var(--surface-hover-soft)]');
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('rounded-full');
  });

  it('field 形态 dense 压一档高度(与同排模型字段等高)', () => {
    renderSelector({ triggerVariant: 'field', dense: true });
    expect(getTrigger().className).toContain('h-9');
  });

  // MorphPopover 按「请求侧的可用空间」钳高、不做碰撞翻转,选侧责任在调用方:
  // composer chip 在底部工具栏 → 恒向上(历史行为);field 按 trigger 位置**动态**选
  // 空间大的一侧 —— 恒定任一侧都会在某个位置截断(2026-07 Light 实测:恒 bottom 时
  // 页面末行的菜单被视口底钳得只剩 2 个选项)。
  it('chip 恒向上;field 动态选侧(上方空间大时向上开)', async () => {
    const { unmount } = renderSelector();
    fireEvent.click(getTrigger());
    const chipPanel = await screen.findByRole('listbox');
    expect(chipPanel.closest('[data-morph-side]')?.getAttribute('data-morph-side') ?? 'top').toBe(
      'top',
    );
    unmount();
    cleanup();

    // jsdom 无布局(rect 全 0): 下方空间 = innerHeight - 0 ≥ 上方 0 → 'bottom'
    renderSelector({ triggerVariant: 'field' });
    fireEvent.click(getTrigger());
    const fieldPanel = await screen.findByRole('listbox');
    expect(fieldPanel.closest('[data-morph-side]')?.getAttribute('data-morph-side')).toBe('bottom');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull(), { timeout: 1500 });
    cleanup();

    // trigger 贴近视口底(下方空间 < 上方)→ 向上开
    renderSelector({ triggerVariant: 'field' });
    const trigger = getTrigger();
    trigger.getBoundingClientRect = () =>
      ({ top: 700, bottom: 740, left: 0, right: 200, width: 200, height: 40, x: 0, y: 700 }) as DOMRect;
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true });
    fireEvent.click(trigger);
    const abovePanel = await screen.findByRole('listbox');
    expect(abovePanel.closest('[data-morph-side]')?.getAttribute('data-morph-side')).toBe('top');
  });

  it('field 形态仍走同一份选项列表与危险档配色', async () => {
    const { onChange } = renderSelector({ triggerVariant: 'field' });
    fireEvent.click(getTrigger());
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')).toHaveLength(4);

    fireEvent.click(screen.getByText('完全访问'));
    expect(onChange).toHaveBeenCalledWith('bypassPermissions');
  });

  it('field 形态选中危险档时只染文字,不改底色', () => {
    renderSelector({ triggerVariant: 'field', permissionMode: 'bypassPermissions' });
    const cls = getTrigger().className;
    expect(cls).toContain('text-[var(--perm-bypass-selected-text)]');
    // 底仍是输入面,不因危险档换底色
    expect(cls).toContain('bg-[var(--settings-input-bg)]');
  });
});
