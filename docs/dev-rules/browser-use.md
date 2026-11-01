# Browser Use：三种浏览器后端的共同规则

Browser Use 有三种执行端，由用户在 Browser Use 设置里选：专用浏览器（独立实例，`external`）、
侧边栏（`rsb-webview`）和「我的浏览器」（经官方 Cindy Chrome 扩展控制用户自己的 Chrome，
`user-browser`，契约见[插件安全与编写](plugin-security-and-authoring.md)）。本文只放三端共同
遵守的决定；工具层代码在 `packages/lizi-mcps/src/browser/`，配方加载在
`apps/desktop/src/main/browser-recipes/`。

## 优化做在共享层，三端都受益（2026-10-29）

用哪种浏览器是用户的选择，体验改进不能只落在一种后端上。参数容错、结果整形、截断上限、
提示语等优化默认改工具层（`tools.ts`）、`browser-workflow` 规则、配方与站点指南；只有某个
后端独有的缺口才改该后端。改某个后端时检查其它两个是否有同样问题，一并处理或说明为何不适用。
用真实任务实测时三种浏览器都要跑（至少覆盖改动涉及的路径），对比结论、用时、调用次数与报错。

## 能力不设限，风险交给审批（2026-10-30）

三端能力对齐，默认不加站点名单、读取边界或字段类限制；安全依靠任务权限档位（询问／自动审核／
完全访问）与自动审核。保留的底线只有：任务文件夹边界（也是共享／远程任务的边界）、不打扰
用户、防冒充、Chrome 调试接口授权，以及[代输入规则](../product-rules/input-handoff.md)（主人
填写的密码、验证码等值只交给宿主，不进模型；权限档位与自动审核不能代替它）。
Agent 自行把后端切到「我的浏览器」的调用
走任务的权限审批（询问档确认、自动审核档复审、完全访问档放行，见
`maker-host/mcp-tool-approval-policy.ts`）；用户在设置里选了「我的浏览器」不经过工具调用，也就
不需要审批。Cindy 打开的标签页不设固定数量上限，闲置 10 分钟自动关闭。

## 专用浏览器不吞外部链接（2026-10-30）

专用浏览器复用系统默认的 Chromium 浏览器 App、只换 user-data-dir；macOS LaunchServices 按
bundle id 投递打开链接事件，外部链接会落到 Cindy 的实例。采用的方案：在 Agent 浏览器里识别由
外部链接打开的标签，在请求发出前拦下并转回用户自己的浏览器（默认 profile；仅 macOS，
`ExternalLinkHandoff`）。没有选改用 Cindy 自带的 Chrome for Testing（要多下载约 150 MB，且
影响「使用我的浏览器登录态」）或避开默认浏览器；后续讨论不要再默认推这两条。

## 配方目录（2026-10-23）

默认内置清单与可追溯的上游全量来源分开维护：默认清单按实际用途筛选——移除不合适或过期的
站点，补充 Cindy 自己需要的能力（应用商店、游戏平台评价、文献与图书查询等）——而不是为了
差异改名或堆数量。排除项清单与筛选在 `packages/opencli-vendor/cindy/catalog.ts`
（`excludedSites` / `excludedCommands`），`scripts/check-opencli-recipes.mjs` 校验被排除的条目没有
泄漏进产品目录；后续同步上游时不能自动恢复已排除的条目。保留上游署名与许可证，不把引入的
第三方实现说成原创。
