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

## 图片读取与工具发现

网页抓取失败不等于浏览器不可用。渐进发现入口 `browser/server.ts` 要在加载详细工作流之前，
说明浏览器适合继续读取动态页面与图片；具体读图、登录墙与结束条件仍由
`browser-workflow` 维护。不把 HTTP 响应头、跳转地址、DOM 图片标签或 alt 当作已查看图片。

`scripts/eval-browser-image-fallback.mjs` 是显式启动的真实模型对比，不属于默认单测：

```sh
node scripts/eval-browser-image-fallback.mjs --live --codex-home /path/to/authorized/codex-home \
  --baseline-ref <before-commit> --model gpt-6-astra --effort high --repeats 5
```

它调用生产 MCP 的发现、参数解析、规则返回和图片输出，页面运行时使用固定夹具；
A 读取基线 Git 版本，B 使用当前工具发现和配方但保留基线工作流，C 使用全部当前改动。每组使用相同的随机
错误码／版本号图片，答案只通过图片像素交给模型；交错运行顺序，保存所有结果、工具轨迹、
输入／输出／缓存 token 与耗时到独立临时目录，不择优报告。八类场景覆盖抓取失败、短链接、
误导 alt、登录墙、图片删除、静态文章及 X 公开图片／正文；可用 `--only` 和 `--variants` 缩小范围。

这是缩小工具目录后的行为实验，**不是完整 Cindy/Codex 会话或真实浏览器 E2E**，不证明
真实 X 登录、网络、扩展或三种后端均可用。真实网页和后端验证另记，不与夹具成功率混算。
凭证只在内存中使用，不写入报告；手动评测须有用户授权，默认单测不得读取账号。

### 配方发现与图片结果衔接

补充配方应出现在所有声明匹配的站点指南中，而非仅挂到第一个域名。导航及已有标签快照的推荐按明确意图、
URL 路径匹配程度、只读用途排序；`recommendationPaths` 是字面路径段加 `:参数` 的前缀模板，
不执行正则或脚本。推荐不会自动执行配方，也不代表授权。推荐去重包含候选集合，避免访问
首页后吞掉后续帖子页的不同候选，同时不为每条帖子重复推送同一组。

X 公开单帖的 `x-tweet` 可返回原图 URL；有图片时输出 `imageReading.status=not_viewed`
和下一步说明，无图片时不附加。任务依赖图片内容时继续下载并用原生图片工具查看，或在
自己的浏览器标签打开原图截图。它是读图交接提示，不是自动下载、OCR 或已读图的凭证；
不得把这一步当成端到端保证。私密、已删除和网络失败仍按真实结果处理。

## 能力不设限，风险交给审批（2026-10-30）

三端能力对齐，默认不加站点名单、读取边界或字段类限制；安全依靠任务权限档位（询问／自动审核／
完全访问）与自动审核。保留的底线只有：任务文件夹边界（也是共享／远程任务的边界）、不打扰
用户、防冒充，以及[代输入规则](../product-rules/input-handoff.md)（主人
填写的密码、验证码等值只交给宿主，不进模型；权限档位与自动审核不能代替它）。
Agent 自行把后端切到「我的浏览器」的调用
走任务的权限审批（询问档确认、自动审核档复审、完全访问档放行，见
`maker-host/mcp-tool-approval-policy.ts`）；用户在设置里选了「我的浏览器」不经过工具调用，也就
不需要审批。Cindy 打开的标签页不设固定数量上限，闲置 10 分钟自动关闭。

## 「我的浏览器」不占用用户的页签（2026-11-06）

用户自己的页签可能正在用。Agent 默认用 `open` 在 Cindy 窗口里开自己的页面：同一个浏览器
profile，登录态与用户共用，不需要借用户的页签。`tabs` 用 `owner:"user"` / `owner:"cindy"` 标出
归属（由扩展的 `cindyWindow` 得出；旧版扩展不标就不猜），同网站提醒遇到用户页签时只让 Agent
沿用它的地址（多账号网站的 `/u/<n>/` 等），不在上面点击、输入或跳转；用户明确让看「这一页」时
才读取，改动先问。专用浏览器与侧边栏的页面都是 Cindy 自己的，照旧复用。这推翻了 2026-10-29
「先复用已打开的页面（用户开的也算）」中针对用户页签的部分：当时为了避免 Play Console 进错
Google 账号，但结果是 Agent 在用户自己的 ChatGPT 页签上点击并跳转。

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

## 「我的浏览器」连接诊断

设置页的未连接不等于扩展未安装：显示连接状态、启用检查说明，并将扩展商店保留为可选入口；
状态查询失败单独报告，不归为扩展缺失。桥接保留本运行期成功连接的布尔历史，供上层在活跃
客户端列表已清空时继续执行有界重连等待；历史不代表当前在线、不授予页面访问权限，未配对
客户端不等待。扩展本身负责重连，宿主不重放页面动作。

`browser extension connection changed` 在请求或状态读取时记录首次观察到的连接变化，包含
短客户端标识、扩展版本、前后状态、最后请求时间与距今毫秒数；`heartbeat-expired` 表示超过
35 秒没有请求，不证明 Chrome 崩溃或网络中断。没有读取时不会额外启动定时器，因此日志时间
是观察时间而非精确断线时刻。`browser extension bridge closing` 区分宿主主动关闭，
`user browser settings health changed` 记录设置页判据变化。日志不含网页地址、内容或认证材料。

回归位于 `browser-extension/__tests__/bridge.test.ts`、浏览器后端的 `user-browser-backend.test.ts` /
`health-service.test.ts` 与设置页的 `ComputerUseSection.browserHealth.test.tsx`，覆盖过期空列表、
首次读取前已过期、恢复、等待到期、未配对及探测失败。

## 插件更新时的浏览器连接（2026-11-07）

市场与本地插件更新在替换包之前暂停接收新的浏览器作业，等待已接受作业按原有结果或超时结束，
再关闭旧桥接。更新中的清单广播不创建新桥接；安装来源账本提交结束后重新发布完整清单。
来源变化属于桥接签名的一部分；来源信息补齐也必须触发刷新，不依赖重启应用。
不得把更新中间态写成新的配对来源，或自动重放点击、发送、提交等结果可能未知的操作。
真正换源仍按原来源隔离配对，不能自动改写用户选择的控制端。

设置页和 Browser Use 状态区分 `plugin-updating`、`plugin-selection-required` 与 `plugin-missing`。
前两者分别显示更新等待和插件选择入口；只有已安装插件未声明页面控制能力时才提示更新版本。
这些状态仅影响「我的浏览器」的宿主连接，不关闭用户浏览器、不修改用户页签或登录态；
侧边栏和专用浏览器不经过插件桥接，因此不适用这一更新流程。

回归位于 `browserExtensionSlot.test.ts`、`bridge.test.ts`、`user-browser-backend.test.ts`、
`health-service.test.ts` 和 `BrowserBackendSubsection.test.tsx`；界面场景为
`automation-settings/browser-updating` 与 `automation-settings/browser-selection`。
