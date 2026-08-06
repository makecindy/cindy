/**
 * 崩溃触发的判定 —— 三条自动路径里「什么算崩溃」由这里回答。
 *
 * 两条不变量（需求 §4.1、§11）：
 *
 *  1. **复用生命周期模块已有的结论，不另立一套**。自挂 `process` 事件会漏掉渲染进程崩溃
 *     （白屏），并把可恢复的悬空 promise 误报成崩溃。这里只吃 `lifecycle.beginShutdown`
 *     的 `reason` 字符串。
 *  2. **原生崩溃靠启动尸检兜底**。segfault / 被系统 kill / 主线程 hang 时 JS 层根本没机会
 *     反应，只有下次启动扫 run marker 才能知道「上次运行异常退出且无任何退出记录」。
 *
 * 纯逻辑：不 import electron、不 import lifecycle（避免与 lifecycle 形成循环——接线由
 * `index.ts` 用回调完成）。
 */

import type { PreviousRunReportKind } from '../startup-diagnostics';

/**
 * `beginShutdown` 的 reason 是否算致命崩溃。
 *
 * 放行两类：
 *  - `uncaughtException` —— main 进程未捕获异常。注意 lifecycle 在进入 `beginShutdown`
 *    之前已经把 broken stdio（EIO/EPIPE）与瞬时网络错误（ETIMEDOUT 等）分流掉了，
 *    所以能走到这里的都是真致命。
 *  - `render-process-gone:<reason>` —— 渲染进程崩溃（白屏）。同样地，意识沙箱与
 *    `<webview>` guest 的崩溃在 lifecycle 里已经 return，不会进入 `beginShutdown`。
 *
 * 不放行：`before-quit`（用户主动退出）、`signal:*`（Ctrl+C / kill）、
 * `update-relaunch`（更新重启）以及任何未来新增的正常退出入口——**未知 reason 一律不算
 * 崩溃**，方向与来源白名单一致（宁可漏报一次崩溃，也不要把正常退出当崩溃反复上传）。
 */
export function isFatalCrashReason(reason: string): boolean {
  if (reason === 'uncaughtException') return true;
  if (reason.startsWith('render-process-gone:')) return true;
  return false;
}

/**
 * 启动尸检的哪些结论要触发补传标记。
 *
 * 只认「无任何退出记录」这两类：
 *  - `abnormal` —— run marker 停在 `running`：native crash / 外部 kill / hang。
 *  - `corrupt`  —— 标记文件解析失败：进程多半死在写标记的瞬间。
 *
 * 刻意**不**认 `crash-exit` 与 `shutdown-incomplete`：那两类都经过了 lifecycle，
 * 崩溃当时已经由 `isFatalCrashReason` 写过标记，这里再补一条会造成同一次崩溃上报两遍。
 */
export function shouldBackfillForReportKind(kind: PreviousRunReportKind): boolean {
  return kind === 'abnormal' || kind === 'corrupt';
}

/**
 * 从尸检报告里取崩溃时刻（作为补传的裁剪锚点）。
 *
 * 优先 `heartbeatAt`：心跳跑在 main event loop 上，它冻结的时刻就是「进程最后一次还活着」
 * 的证据，比 `startedAt` 精确得多（hang 的场景下两者可能差几小时）。都取不到时返回 null，
 * 由调用方用「现在」兜底——锚点不准只影响裁剪优先级，不影响能不能传。
 */
export function crashAtFromMarker(marker?: {
  heartbeatAt?: string;
  startedAt?: string;
}): number | null {
  for (const candidate of [marker?.heartbeatAt, marker?.startedAt]) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * 多个待补传标记合并成一次上报时的**归组元数据**:令牌与崩溃时刻都取「最早那次崩溃」的标记。
 * 后台按 `crashToken` 把崩溃即时上报与这次启动补传归成同一次崩溃(需求 §4.5)。
 *
 * ⚠️ token 与 crashAtMs 必须来自**同一个**标记(2026-08-06 review):`claimAll()` 按文件系统
 * `readdir` 顺序返回,`claimed[0]` 不一定是最早那次。若 token 取 `claimed[0]`、crashAtMs 取
 * `min(anchors)`,两者会来自不同崩溃——补传就带着「最早崩溃的时刻 + 另一次崩溃的令牌」,既归不
 * 进最早那次的即时上报,又把另一次的令牌占用掉。这里先选出拥有**最早 crashAtMs** 的标记,token
 * 与 crashAtMs 都从它取。并列最早时取先出现的那个(稳定,不依赖 readdir 顺序之外的东西)。
 *
 * 空数组返回两个 `undefined`(调用方在无标记时本就不会走到上报)。
 */
export function selectBackfillGrouping(
  claimed: readonly { marker: { token: string; crashAtMs: number } }[],
): { crashToken: string | undefined; crashAtMs: number | undefined } {
  let earliest: { marker: { token: string; crashAtMs: number } } | undefined;
  for (const c of claimed) {
    if (!earliest || c.marker.crashAtMs < earliest.marker.crashAtMs) earliest = c;
  }
  return { crashToken: earliest?.marker.token, crashAtMs: earliest?.marker.crashAtMs };
}
