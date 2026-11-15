# macOS 截图窗口识别回归验证

环境：macOS 26.4（25E246），Apple Silicon，单显示器。

用户验收：2026-10-29 从本 worktree 启动的独立 Global 开发版中，用户完成选区测试并明确确认
“选区验收通过”。此人工结论限于选区行为，不扩展为滚动截图、录制或多屏验收。

## 问题与修复

PR #7661 的 `window-at` 使用 AppKit 窗口命中，但 stdin 驱动的原生 helper
没有初始化 `NSApplication`，在可见窗口内仍返回 `hwnd: 0`。主进程据此取消吸附目标。
在读取首条请求前初始化应用连接，并使用 `.prohibited` 保持后台身份；请求结构、
窗口排除规则和未知遮挡处理均未改动。

## 验证结果

- `node apps/desktop/scripts/check-macos-region-snapping.mjs`：通过，3.53 秒（含两份 Swift
  编译）。实际运行生产 helper，验证冷启动与第二次启动、焦点／鼠标保持、滚动内容区、
  标题栏整窗、真实遮挡、排除截图浮层、浮层覆盖下的内容区、忽略鼠标事件，以及重新接收事件。
- 同一脚本在修复前源码和本机安装版 helper 上均失败：可枚举到测试窗口，但冷启动命中
  持续返回 `hwnd: 0`。使用 `--helper=<binary>` 可复现，无需修改已安装应用。
- Desktop 截图 main、renderer 和 shared 定向单测：9 个文件、111 项通过，1.69 秒。
- `pnpm --filter desktop run --if-present typecheck`：通过。
- `pnpm ui:check --page region-capture --case snapping --theme all`：2/2 通过，4.5 秒；
  已查看本地总览图，Light/Dark 的选框、区域切换和锁定正常。未上传截图。
- `pnpm check:test-hygiene`、`pnpm check:dev-docs`、`git diff --check`：通过。

## 测试价值和边界

新增脚本属于显式原生 E2E，不进入默认 unit。既有单测替换原生进程回复，无法发现
AppKit 未初始化；最小失败输入是新 helper 对真实可见窗口中心的一次 `window-at`。
测试临时二进制使用独立系统临时目录，结束后关闭测试进程、清理目录并恢复原前台应用
（仅在测试应用仍在前台时）。不读取用户窗口内容，不移动系统鼠标，不修改系统权限。

透明像素不等于鼠标穿透：本机系统对半透明测试窗的透明部分仍命中前窗，独立 AppKit
应用与 helper 结果一致；用例验证遵从系统实际命中，不把“无条件穿透透明像素”记为通过。
测试浮层覆盖目标且边界不同，模拟截图面板；未覆盖同进程、完全相同边界的 AX 兄弟窗口。

原生测试使用受控 AppKit 窗口；UI 验证使用生产截图组件和模拟截图源，不能冒充完整
Desktop 快捷键到截屏的端到端验收。未验证 Windows 实机、Intel Mac、多显示器、未授权
辅助功能和签名安装包；生产改动仅在 macOS helper，未替换当前运行的安装版。
