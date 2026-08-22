/**
 * 打开一个伙伴默认就是打开 TA 的对话，但有两种时候不能抢跑：
 *
 * - `settingsOpen`：用户要看的是设置页，不是对话。
 * - `addRequested`：URL 上还带着老的 `?add=1`（阵容还是模态那阵子的深链）。
 *   这一帧正在被重定向到 `/bots/roster`，此时再去建/跳主任务，用户会先被扔进
 *   一个对话再被拽走。
 *
 * 阵容页面化之后不再有「模态开着」这一态，所以 `addOpen` 不复存在。
 */
export function shouldDeferCanonicalBotSessionNavigation(input: {
  settingsOpen: boolean;
  addRequested: boolean;
}): boolean {
  return input.settingsOpen || input.addRequested;
}
