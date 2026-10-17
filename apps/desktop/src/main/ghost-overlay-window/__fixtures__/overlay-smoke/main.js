// overlay-smoke 电子脑（逻辑页）。
// 宿主以「普通脚本」加载本文件（<script src="/main.js">，见 ghostFiles.ghostBootHtml），
// 因此不要使用 ES module 的 import/export，也不存在 Node 全局。可用能力只有：
//   - window.cindy（ghostPreload 注入的管子桥）
//   - BroadcastChannel（与 overlay.html 同源；页面零桥，不引用 window.cindy）
(function () {
  'use strict';

  const CHANNEL = 'overlay-smoke';

  function overlayRequest(kind, fields) {
    const payload = Object.assign({ type: 'overlay-request', kind }, fields || {});
    return window.cindy.send(payload).catch((error) => {
      // 结构化失败（如用户关闭浮窗开关 → { ok:false, errorCode:'OVERLAY_USER_DISABLED' }）
      // 以 resolved 值返回，不会进这里；这里只兜 IPC 级 reject（如槽未就绪）。
      console.warn('[overlay-smoke] overlay-request failed:', kind, error);
    });
  }

  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    const message = event && event.data;
    if (!message || message.type !== 'overlay-interactive') return;
    overlayRequest('set-interactive', { interactive: message.interactive === true });
  };

  // 宿主工具调用：本 smoke 不实现任何工具，收到调用照常忽略即可。
  window.cindy.onHostMessage(() => {
    /* no-op */
  });

  // 插件被拉起即挂载并显示（mount 已含预热 + show；补一次 show 幂等）。
  // 真实链路里 ready 握手由宿主 dom-ready / did-finish-load 事件驱动，电子脑无需发 ready。
  overlayRequest('mount');
  overlayRequest('show');
})();
