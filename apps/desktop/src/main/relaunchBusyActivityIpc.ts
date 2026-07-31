/**
 * relaunchBusyActivityIpc.ts — 「现在重启会打断什么」查询的 IPC 装配。
 * ---------------------------------------------------------------------------
 * 判定逻辑在 relaunchBusyActivity.ts(纯函数、零 Electron 依赖);这里只负责 handler 注册与
 * **授权边界**。单独成文件是为了能按仓库既有的 *IpcBoundary 测试模式直接测 handler ——
 * bootstrap-electron.ts 那个模块 import 一次就会拉起整个 app 启动链,没法单测。
 *
 * sender 断言不是可选项:按 docs/dev-rules/electron-security-and-process-boundaries.md §5,
 * 新增 handler 不得以「旧代码没校验」为由省略 sender 验证。这个 handler 读的是全局会话 /
 * Claude / Ghost 活动态 —— 带 preload 的窗口被导航到不可信内容、WebView、子 frame 都能发
 * IPC,不校验就等于把「本机现在在跑什么」这类信息暴露给它们。
 */

import { ipcMain } from 'electron';

import { createLogger } from './logger.js';
import { evaluateRelaunchBusyActivity, type RelaunchBusyActivitySources } from './relaunchBusyActivity.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';

export const RELAUNCH_BLOCKING_ACTIVITY_CHANNEL = 'update-relaunch:blocking-activity';

const log = createLogger('relaunch-activity');

/**
 * 注册手动更新重启的阻断查询。
 *
 * `sources` 用工厂形态传入(而非直接给值):handler 每次被调用都要拿**当时**的跟踪器,
 * maker 会在 app session owner 边界被整体换掉,提前捕获会读到过期实例。
 */
export function registerRelaunchBusyActivityIpc(
  resolveSources: () => RelaunchBusyActivitySources,
): void {
  // **幂等注册**,不是防御性冗余:调用点(bootstrap-electron 的 registerMakerIpcsAfterSplash)
  // 在它之后还有会抛的初始化,而那个 try 的 catch 明写「下次 splash retry 再尝试」,重试时
  // makerIpcsRegistered 仍是 false —— 于是这行会被执行第二次。ipcMain.handle 对同一 channel
  // 第二次注册会抛「Attempted to register a second handler」,那不只是本 handler 注册失败:
  // 异常会从这里穿出去,把**排在它后面的全部 maker IPC 注册**一起掀掉,而且每次重试都卡在
  // 同一行 —— 结果是 maker 链路永久不可用。先 remove 再 handle,让重复调用总是收敛到
  // 「一个当前有效的 handler」。
  ipcMain.removeHandler(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL);
  ipcMain.handle(RELAUNCH_BLOCKING_ACTIVITY_CHANNEL, async (event) => {
    assertTrustedAppRendererEvent(event);
    const result = await evaluateRelaunchBusyActivity(resolveSources());
    if (result.busy) {
      log.info('manual relaunch has live activity', { reasons: result.reasons });
    }
    return result.busy;
  });
}
