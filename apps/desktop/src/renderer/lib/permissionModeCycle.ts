import type { PermissionModeDescriptor } from '../hooks/useAgentCapabilities';
import type { PermissionMode } from './userPreferences.types';

/**
 * 把持久化的档位值收敛成"当前 agent 真正暴露的那一档"。
 *
 * 会话里可能存着 legacy 值(如 `default`)或另一个 agent 的专有档(codex 会话带着
 * cc 的 `acceptEdits`),而 capabilities 只列本 agent 支持的档。PermissionSelector
 * 一直用这套规则决定"哪一项显示为选中"(不在清单里 → 落到首项,即 ask),所以任何
 * 拿当前档去比较或轮切的地方都必须先过同一道归一,否则会出现:
 * - 点击界面上已选中的那项被判成"改了档",绕过同档短路 → 白写一次 setPermissionMode
 *   (进而 dismissAllPending 结掉手里的 pending 请求);
 * - Shift+Tab 从 `default` 轮切时选到 ask 本身,而不是前进到下一档。
 *
 * options 为空(capabilities 还没到)时原样返回,不猜。
 */
export function canonicalizePermissionMode(
  mode: PermissionMode,
  options: readonly PermissionModeDescriptor[],
): PermissionMode {
  if (options.length === 0) return mode;
  if (options.some((option) => option.id === mode)) return mode;
  return options[0]!.id;
}

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
