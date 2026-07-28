import type { PermissionModeDescriptor } from '../hooks/useAgentCapabilities';
import type { PermissionMode } from './userPreferences.types';

/**
 * cycle-permission-mode 快捷键 (默认 Shift+Tab) 的轮切纯函数。
 *
 * 在当前会话 capabilities 提供的全部模式间按列表顺序循环 —— 与
 * PermissionSelector 下拉展示的是同一份列表, 键盘轮切与鼠标选择看到的
 * 顺序一致。规则:
 * - 当前模式在列表中 → 下一项 (末位回绕到首位);
 * - 当前模式不在列表中 (如 codex 会话带着 cc 的模式值) → 列表第一项;
 * - 列表不足 2 项 → 返回 null, 调用方不消费按键 (Shift+Tab 保持原生行为)。
 */
export function getNextPermissionMode(
  current: PermissionMode,
  options: readonly PermissionModeDescriptor[],
): PermissionMode | null {
  if (options.length < 2) return null;
  const index = options.findIndex((option) => option.id === current);
  if (index === -1) return options[0]!.id;
  return options[(index + 1) % options.length]!.id;
}
