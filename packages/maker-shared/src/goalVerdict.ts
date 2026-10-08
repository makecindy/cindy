/**
 * 显示层剥离 /goal 协议块(Desktop 与 Mobile 共用,两端必须一致)。
 *
 * /goal 协议要求模型在末尾吐一个结构化 JSON 块,Desktop main 用代码解析它驱动流程:
 *   - 每个执行轮:`{"goal_status":...}` 裁决块(goal-host/verdict.ts 解析,驱动续跑/停)
 *   - 历史版本可能残留的 `{"goal_setup":...}` 配置块
 * 这些块对用户都是噪声,显示时剥掉;**原文仍保留在 DB / transcript**(只动渲染,不动数据)。
 *
 * 保守只剥**末尾**的块(协议要求块放回复最后),避免误删正文里恰好出现的 JSON:
 *   1. 末尾的 ```json … goal_status|goal_setup … ``` 围栏块(含可选语言标记 / 尾随空白);
 *   2. 没有围栏时,末尾裸的 {"goal_status"|"goal_setup":…} 对象。
 * (块内不含嵌套花括号时成立;note/reason 里若含 `{` `}` 会漏剥,与原 goal_status 行为一致。)
 */

const TRAILING_FENCED_BLOCK = /\n?\s*```(?:json|jsonc)?\s*\{[^{}]*"goal_(?:status|setup)"[^{}]*\}\s*```\s*$/i;
const TRAILING_BARE_BLOCK = /\n?\s*\{[^{}]*"goal_(?:status|setup)"[^{}]*\}\s*$/i;

export function stripGoalVerdictBlock(content: string): string {
  if (
    !content ||
    typeof content !== 'string' ||
    (!content.includes('goal_status') && !content.includes('goal_setup'))
  ) {
    return content;
  }
  if (TRAILING_FENCED_BLOCK.test(content)) {
    return content.replace(TRAILING_FENCED_BLOCK, '').trimEnd();
  }
  if (TRAILING_BARE_BLOCK.test(content)) {
    return content.replace(TRAILING_BARE_BLOCK, '').trimEnd();
  }
  return content;
}
