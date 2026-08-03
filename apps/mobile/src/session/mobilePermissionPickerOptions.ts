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
  const indexBySemanticId = new Map<string, number>();

  for (const option of options) {
    if (option.id === 'plan') continue;
    const semanticId = option.id === 'default' || option.id === 'ask'
      ? 'default-permissions'
      : option.id;
    const existingIndex = indexBySemanticId.get(semanticId);
    if (existingIndex === undefined) {
      indexBySemanticId.set(semanticId, result.length);
      result.push(option);
      continue;
    }

    const existing = result[existingIndex];
    const existingIsActive = existing.id === activeMode;
    const candidateIsActive = option.id === activeMode;
    if (candidateIsActive || (!existingIsActive && existing.id === 'default' && option.id === 'ask')) {
      result[existingIndex] = option;
    }
  }

  return result;
}
