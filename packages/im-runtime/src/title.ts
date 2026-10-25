export const FBOT_TITLE_PREFIX = "FBot · ";

/** 草稿占位 title, 跟 desktop 'New Maker' 同语义 — 等首条消息到来后由 oneshot 替换。 */
export const FBOT_DRAFT_TITLE = `${FBOT_TITLE_PREFIX}New`;

export function fbotTitle(
  displayName: string,
  prefix: string = FBOT_TITLE_PREFIX,
): string {
  const name = displayName.replace(/\s+/g, " ").trim().slice(0, 40);
  // 空显示名回落到 'New',与 FBOT_DRAFT_TITLE 拼出同一个草稿占位(`FBot · New`)。
  // 此前写死 'New Maker' 会拼出 `FBot · New Maker`:既和本模块自己的草稿常量不一致,
  // 也把 desktop 的哨兵串漏进了用户可见的飞书会话标题。
  return `${prefix}${name || "New"}`;
}
