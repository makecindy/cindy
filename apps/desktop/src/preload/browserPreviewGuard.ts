/**
 * browserPreviewGuard —— BROWSER_PARTITION session 级 preload（经 setPreloads 注入）。
 *
 * 无条件禁用 WebRTC：CSP 的 `connect-src` 无法约束 RTCPeerConnection 的
 * ICE/STUN/TURN 流量（preview 页恶意脚本可把数据分块编码进 TURN 凭据外带，
 * 且建立数据通道不需要任何设备权限）——codex-connector P1, round 7。
 *
 * 为什么全量禁用而非仅预览页：
 *  - RSB 的 guest preload 无法按 URL 分流（webview preload 与 session preload
 *    都在文档创建前执行，无法等待导航判定）；
 *  - BROWSER_PARTITION 是 agent 专用浏览器（非用户日常浏览器），自动化场景
 *    （表单/登录/页面操作/截图）无 WebRTC 需求；
 *  - fail-closed：宁可多禁不可漏禁。
 * 外置 Chrome 路径用 Playwright addInitScript 按预览页注入（见 pw-session.ts
 * LOCAL PATCH），两侧最终效果一致：预览页不存在 RTCPeerConnection。
 */
try {
  Object.defineProperty(window, 'RTCPeerConnection', {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(window, 'webkitRTCPeerConnection', {
    value: undefined,
    configurable: true,
  });
} catch {
  /* sandbox 环境异常忽略（仍 fail-closed：异常时页面同样拿不到注入） */
}
