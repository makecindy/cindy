# PR #5712：置顶项目排序的组件证据

- 日期：2026-10-10。
- 被验证的产品代码：`f89e5a4283482d601f600fae0804fe03392ad350`；本次仅补充主题初始化、证据导出及浏览器断言。
- 平台：macOS arm64，Chromium 143.0.7499.4，1000 × 850 viewport。
- 主题：生产 `default-light` / `default-dark`，由生产 `themeService` 和颜色注册表注入。
- 设计依据：[DESIGN.md §5、§10、§14](../../design-rules/DESIGN.md)；证据存放遵循 [design-governance.md §6](../../design-rules/design-governance.md)。

## 证据范围

HTML 直接打包生产 `SortableList` / `CardMasonry` / `DraggableCardColumns`、全局 CSS、排序 CSS、静态 token 及运行期主题。三组项目标题、按钮、输入框、子任务和混合置顶任务均为合成数据，不读取应用数据库或用户项目。标题／子任务边界对应 `ProjectNode` 的拖动边界，但不渲染完整 `ProjectNode`。

这是组件交互证据，不是完整 Electron 应用或真实本地／远端设备验收。文字和列表使用相同的生产 `SortableList`；不模拟两种模式的完整外观。使用 reduced motion，不验证排序动画。排序仅通过真实生产组件的 `onReorder` 更新页面内存，不据此宣称应用重启后的持久化已验证。

旧 fixture 只切换 `.dark` class，缺少运行期颜色 token，因此旧 Light/Dark 矩阵只能证明两种 class 状态下的拖动行为。本次接入生产主题并断言实际 computed style，双模式截图以本次导出为准。

## 可复现导出

在具有本仓依赖的 checkout 根目录运行：

```sh
PINNED_SORT_CHROMIUM_PATH='/path/to/existing/Chromium' \
  node apps/desktop/scripts/fixtures/sidebar-pinned-sort/verify-pinned-sort.cjs \
  --export=/path/to/local/pinned-evidence
```

未指定 `PINNED_SORT_CHROMIUM_PATH` 时使用 Playwright 的既有 Chromium。此命令不安装依赖或浏览器。导出目录应位于 Git 工作区之外或已忽略的临时目录；不要提交生成物。

- `index.html`：自包含交互页；下载后在 Chromium 中打开，选择主题／容器／列数，点击“应用并重置”，然后拖动项目标题。
- `light-text-1-initial.png` 等共 12 张截图：每种主题的文字、列表、三列卡片各一组拖动前后截图。`initial` 指同一实现中拖动前的状态，`reordered` 指完成拖动后，不代表两个代码版本。
- `results.json`：10 个真实鼠标场景的结果、浏览器版本和实际颜色。回归覆盖排序、混合置顶、输入与按钮边界、外部 drop／Escape 后实际 DOM 位置与列归属恢复。

导出的 HTML 使用 `file:` 打开运行同一验证矩阵；JS、CSS 与字体内嵌，无外部网络依赖。CSP 禁止网络资源。页面工具栏和说明仅存在于导出证据，不进入产品。

## 实测颜色

导出文件的 10 个 Chromium 鼠标场景全部通过；已目检最新 Light/Dark 文字和三列卡片截图，标题、正文、操作区域与排序结果均可辨。独立页的主题／容器／列数／混合任务切换另行通过，未请求网络资源或触发页面异常。格式检查、`git diff --check` 和开发文档合同的 10 项检查通过；完整应用验收不在本记录范围内。

| 模式          | 页面背景             | 正文                 | 合成项目行背景       | 行边框               |
| ------------- | -------------------- | -------------------- | -------------------- | -------------------- |
| Default Light | `rgb(248, 248, 246)` | `rgb(38, 38, 38)`    | `rgb(255, 255, 255)` | `rgb(215, 215, 212)` |
| Default Dark  | `rgb(31, 31, 30)`    | `rgb(212, 212, 212)` | `rgb(44, 44, 42)`    | `rgb(60, 60, 58)`    |

## PR 附件入口

[PR #5712](https://github.com/makecindy/cindy/pull/5712)。HTML 和截图保留在本地，未上传为 PR 附件；待人在 PR 网页上传截图后，将该评论链接补在此处。完整 Electron 证据由独立验收提供，本索引不替代该验收。
