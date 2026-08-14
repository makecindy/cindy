import type { MobileChoiceOption } from '@/session/agentCapabilities';

/**
 * `default` 是旧协议权限 id，`ask` 是当前协议里相同的“默认权限”语义。能力拉取
 * 失败时兼容列表可能同时带回两者；展示层必须合并，否则用户会看到两个完全相同
 * 的选项。若当前值正好是其中一个，保留当前 id；否则优先保留现代 `ask`。
 */
export function permissionOptionsForDisplay(
  options: readonly MobileChoiceOption[],
  activeMode: string,
): MobileChoiceOption[] {
  const result: MobileChoiceOption[] = [];
  let defaultPermissionsIndex: number | undefined;

  for (const option of options) {
    if (option.id === 'plan') continue;
    if (option.id !== 'default' && option.id !== 'ask') {
      result.push(option);
      continue;
    }

    if (defaultPermissionsIndex === undefined) {
      defaultPermissionsIndex = result.length;
      result.push(option);
      continue;
    }

    const existing = result[defaultPermissionsIndex];
    const existingIsActive = existing.id === activeMode;
    const candidateIsActive = option.id === activeMode;
    if (candidateIsActive || (!existingIsActive && existing.id === 'default' && option.id === 'ask')) {
      result[defaultPermissionsIndex] = option;
    }
  }

  return result;
}
