import type { BrowserWindow } from 'electron';

/**
 * 窗口「对用户不可见」广播 —— Renderer 的装饰动画闸门(hiddenAnimationGate)靠它兜底。
 *
 * 为什么 Renderer 不能只靠自己的 document.visibilityState:Electron 明确规定
 * backgroundThrottling 关闭时 visibilityState 会一直停在 'visible',即使窗口已被最小化
 * 或 hide()。已在 Electron 41.2.0 实测复现:
 *
 *   backgroundThrottling=true   minimize()/hide() → visibilityState 转 'hidden'  ✅
 *   backgroundThrottling=false  minimize()/hide() → visibilityState 仍 'visible' ❌
 *   两种取值下 BrowserWindow 的 hide/minimize 事件都正常触发                     ✅
 *
 * 所以判据是:**凡是会安装 hiddenAnimationGate、又关掉了节流的窗口,都必须装这条广播**,
 * 否则它那份闸门形同虚设。是否安装闸门取决于窗口加载的 renderer 入口——闸门在
 * index.tsx 顶层安装,所以凡加载主 renderer 入口(index.html,含各种 ?view= 变体)的窗口
 * 都装了。这里不列具体窗口清单:新增窗口时清单必然过期,由
 * mainWindowBackgroundThrottling.test.ts 的扫描测试按上述判据兜底(它按窗口计数,
 * 并要求豁免必须显式登记理由)。
 *
 * 两路信号在 Renderer 侧取「或」:本广播不受节流影响、覆盖最小化与 hide;
 * visibilityState 覆盖 macOS 的窗口遮挡(occlusion)——那个没有对应的 Electron 事件。
 * Windows 的遮挡两路都覆盖不到(Electron 文档:occlusion 只在 macOS 影响可见性),
 * 属于已知局限,表现为不冻结,即退回改动前行为。
 *
 * 该 channel 是窗口本地 UI 状态,不进 device-link allowlist —— 那里把 window-* 归为
 * 「永不放行」类别,远程控制端的窗口可见性与被控端无关。
 */
export const WINDOW_HIDDEN_CHANGE_CHANNEL = 'window-hidden-change';

export function installWindowHiddenBroadcast(win: BrowserWindow): void {
  const emit = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const hidden = !win.isVisible() || win.isMinimized();
    win.webContents.send(WINDOW_HIDDEN_CHANGE_CHANNEL, hidden);
  };

  // 逐个注册:BrowserWindow.on 是重载签名,传联合类型的事件名匹配不到任何一个重载。
  win.on('hide', emit);
  win.on('show', emit);
  win.on('minimize', emit);
  win.on('restore', emit);

  // 补发基线:preload 的 createIpcFanOut 是惰性绑定(首个订阅者到来才 ipcRenderer.on),
  // 订阅之前发生的事件会丢。窗口若在 Renderer 起来之前就已隐藏(启动即最小化、
  // show:false 的浮窗等),Renderer 会一直停在初始的「未隐藏」;叠加节流关闭时
  // visibilityState 恒为 visible,就永远不冻结。did-finish-load 对应 window load,必然
  // 晚于 index.tsx 顶层的 installHiddenAnimationGate(),补一发即可拿到正确基线。
  // reload / HMR 重新加载后同样会补发。
  win.webContents.on('did-finish-load', emit);
}
