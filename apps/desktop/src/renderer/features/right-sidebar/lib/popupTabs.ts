/**
 * popupTabs —— 记录"由 guest 页面脚本(window.open / target=_blank)催生"的
 * web-browser tab id 集合。
 *
 * 为什么需要:webview guest 调 `window.close()` 会触发 webview 的 `close` DOM
 * 事件,宿主可据此自动关掉对应 tab(OAuth callback 页的标准收尾动作,不接就会
 * 残留空 tab)。但真实浏览器只允许"脚本打开的窗口被脚本关闭",普通 tab 调
 * `window.close()` 会被忽略——不区分来源会让任意网页有能力关掉用户正在用的
 * tab。本模块就是那个"script-opened"标记。
 *
 * 纯 renderer 内存态,不持久化。已知失效边界(全部同一种降级):标记只活在**当前
 * renderer**里,所以 app 重启、以及侧边栏宿主迁移(内嵌 ↔ 独立子窗口,MainLayout
 * 会 releaseAll + 让新 renderer 重新水合同一批 tab)之后,旧 popup tab 会被当成
 * 普通 tab —— 它后来的 `window.close()` 被忽略,用户手关一次即可(等于本修复前
 * 的行为)。
 *
 * 为什么接受:这个判定是**安全方向**的判定,失效方向是 fail-closed(少关一个
 * tab),而不是"让任意网页能关用户的 tab"。要消除它就得把 provenance 持久化进
 * tab state / DB,为一个"迁移窗口内正好有 popup 在授权"的边角场景增加 schema 与
 * 迁移面积,不划算。
 */

const popupSpawnedTabIds = new Set<string>();

/** popup 路由创建 tab 后登记(RightSidebarShell 的 onRsbBrowserPopup 路径)。 */
export function markPopupSpawnedTab(tabId: string): void {
  popupSpawnedTabIds.add(tabId);
}

/** guest `window.close()` 时查询:只有 popup 催生的 tab 允许自关。 */
export function isPopupSpawnedTab(tabId: string): boolean {
  return popupSpawnedTabIds.has(tabId);
}

/**
 * tab **真正从 store 关闭**后清除登记。唯一调用点是 `store.closeTab` 的成功分支
 * —— 所有关闭入口(用户手关 / closeAllTabs / agent close tab-op / guest 自关)都
 * 汇聚到那里,标记不会随某条特定路径泄漏;IPC 失败回滚(tab 又回来了)则不清。
 *
 * 清理时机必须跟 tab 生命周期而不是 webview 实例生命周期:pool release(LRU
 * 淘汰 / 宿主迁移)只销毁 webview,tab 仍在 bucket,标记必须保留——否则重建后的
 * callback 页 window.close() 会被误判为普通 tab 而失效。
 */
export function unmarkPopupSpawnedTab(tabId: string): void {
  popupSpawnedTabIds.delete(tabId);
}

/** Test-only reset. */
export function _resetPopupTabsForTests(): void {
  popupSpawnedTabIds.clear();
}
