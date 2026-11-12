# Desktop 登录身份列表滚动证据

PR #3323 的 macOS Electron 实际渲染截图，用于证明登录身份超过 3 项时仍可访问后续身份。

- [滚动前：前三项保持原构图](./evidence/macos-five-accounts-before-scroll.png)
- [滚动后：第 4 项 XDS 与第 5 项 22 完整可见](./evidence/macos-five-accounts-after-scroll.png)

验证环境：2026-08-28，macOS，CN Desktop dev，1280 × 800，devicePixelRatio 2，独立 userData 沙箱。认证响应来自开发专用离线场景，只用于验证 Desktop 的布局、滚动与身份选择动作，不代表真实企业账号的完整端到端登录。

可复核数据：列表视口 352 CSS px，内容高度 604 CSS px，滚动到底部时 `scrollTop=252`；`平台测试企业`、`XDS`、`22` 均完整位于列表视口内。
