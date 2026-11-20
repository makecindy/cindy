/**
 * 模型组(同账号)：在一台电脑上给另一台电脑开新任务时，用那台电脑自己的模式。
 * 产品规则见 docs/product-rules/model-groups.md「在另一台电脑上开的新任务」。
 *
 * 发起端只读那台的模式列表、把选中的模式 id 交给那台；选路(额度、例外、轮流位置)与提交都在那台按它自己的
 * 配置做，发起端不把本机的模式套过去。只进同账号 allowlist：供应商分享的受邀者与共享任务访客一律拒绝
 * (被控端 dispatch 拦截执行，不落 ipcMain handler)。请求与回包的结构由 Desktop 两端共同维护
 * (apps/desktop/src/shared/modelGroupsRemote.ts)。旧版电脑回 `CHANNEL_NOT_ALLOWED`，发起端当作那台不支持，
 * 不显示模型组，也不改用本机的模式。
 */
export const MODEL_GROUPS_REMOTE_CHANNEL = 'model-groups:remote';
