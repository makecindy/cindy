/**
 * 供应商组(同账号)：组所在电脑把某个供应商的多台电脑合成一组，同账号的其他电脑选这个供应商时，
 * 先经本通道问组所在电脑「该用哪台」，再自己直接连到那台运行 Agent。
 * 产品规则见 docs/product-rules/provider-groups.md。
 *
 * 只进同账号 allowlist：供应商分享的受邀者与共享任务访客一律拒绝(被控端 dispatch 拦截执行，
 * 不落 ipcMain handler)。请求与回包的结构由 Desktop 两端共同维护(apps/desktop/src/shared/providerGroup.ts)，
 * 旧版电脑回 `CHANNEL_NOT_ALLOWED`，控制端当作那台没有组。
 */
export const PROVIDER_GROUP_REMOTE_CHANNEL = 'provider-group:remote';
