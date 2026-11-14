# 浏览器任务实测：Cindy 与 BrowserMCP（2026-11-14）

[BrowserMCP](https://github.com/jackwener/browsermcp) 是一个开源的浏览器 MCP 服务：Chrome 扩展加本机程序，
主入口是一个常驻的 JavaScript 环境（模型写代码操作 `browser` / `tab` 对象），另有 16 个工具，作者称做了大量
面向 Agent 体验的迭代。这份文档记录同一批题、同一个模型下它和 Cindy 浏览器工具的对比，以及对比中发现并修复的
一个 Cindy 缺陷。汇总和逐次数据见 [results.json](results.json)。

## 先看局限

1. **题目是 Cindy 自己出的。** 本机 13 题来自 [`eval-browser-tasks.mjs`](../../../scripts/eval-browser-tasks.mjs)，
   原本用来验证 Cindy 自己的改动；真实网站 8 题与 [读网页实测](../browser-read-2026-11-11/README.md) 相同。
   它不是中立题库，天然偏向 Cindy 优化过的场景（一次调用读完、连续多步）。
2. **样本少。** 本机题每边每题 3 次，真实网站题每边每题 2 次，没有做显著性检验。
3. **只测了一种用法。** 命令行打印模式、只给各自的浏览器工具，全新未登录的无界面浏览器。BrowserMCP 的主要
   场景是用户自己已登录的 Chrome 和站点适配器，这里没有覆盖；Cindy 只测了专用浏览器这一种后端。
4. **两边的浏览器不同。** Cindy 用本机 Chrome 157，BrowserMCP 用 Chrome for Testing 151（品牌版 Chrome
   不再接受命令行加载扩展；它在 158 上不能用，见下文）。
5. **BrowserMCP 的条件是这边选的。** 0.0.43（提交 `a5c8572`，扩展 0.0.30）源码构建，隔离的临时目录和配置，
   全部 16 个工具都开放。作者没有参与这次测试。
6. **费用是连续运行、提示缓存命中时的数字。** 单独跑一次会更贵。
7. **一台电脑、一个网络、一个时间点。** Apple M5 Ultra，macOS 27.3，Node v22.21.1，Claude Code 2.1.322；
   模型 Opus 5.5，推理强度 Medium。

## 结果

两边在同一场里交错运行。每次运行的平均值：

| | Cindy | BrowserMCP |
| --- | ---: | ---: |
| **本机 13 题** 做对 | 39 / 39 | 39 / 39 |
| 用时 | 14.2 秒 | 21.3 秒 |
| 浏览器调用次数 | 2.5 | 4.9 |
| 模型轮数 | 3.5 | 5.9 |
| 费用 | $0.039 | $0.063 |
| 输入 token | 1.5 万 | 9.3 万 |
| 工具返回的字符数 | 4.4k | 3.5k |
| **真实网站 8 题** 做对 | 14 / 16 | 16 / 16 |
| 用时 | 11.4 秒 | 21.8 秒 |
| 浏览器调用次数 | 1.2 | 3.8 |
| 费用 | $0.040 | $0.061 |

用时、调用次数、费用只算跑完的运行（Cindy 有一次被结束，见下文）。BrowserMCP 的 `docs_get` 和 Cindy 的
`list_tools` 一样不计入浏览器调用。

逐题（做对次数、平均用时、浏览器调用次数）：

| 题目 | Cindy | BrowserMCP |
| --- | --- | --- |
| 填写并提交表单 `form` | 3/3，19.6 秒，3.3 | 3/3，22.7 秒，5.0 |
| 逐个查看 4 个商品页 `catalog` | 3/3，12.1 秒，2.0 | 3/3，20.9 秒，4.0 |
| 翻页查找订单 `orders` | 3/3，17.3 秒，2.3 | 3/3，18.5 秒，3.7 |
| 点按钮生成报告再读数 `report` | 3/3，13.4 秒，2.0 | 3/3，20.0 秒，4.7 |
| 进入设置、修改并保存 `settings` | 3/3，24.7 秒，5.3 | 3/3，32.4 秒，10.3 |
| 点击后等内容出现 `vault` | 3/3，19.0 秒，4.3 | 3/3，18.2 秒，5.0 |
| 封闭 Shadow DOM 表单 `badge` | 3/3，17.2 秒，4.0 | 3/3，23.0 秒，5.3 |
| 跨站 iframe 读取 `iframe` | 3/3，11.4 秒，2.0 | 3/3，18.5 秒，4.3 |
| 站内搜索 `directory` | 3/3，12.3 秒，2.0 | 3/3，18.0 秒，5.0 |
| 脚本稍后渲染的页面 `late` | 3/3，9.4 秒，1.0 | 3/3，28.9 秒，4.3 |
| 先显示 Loading 的页面 `spinner` | 3/3，10.2 秒，1.0 | 3/3，23.4 秒，4.0 |
| 一次读不完的长文档 `manual` | 3/3，10.7 秒，2.0 | 3/3，19.0 秒，4.7 |
| JSON 文档 `status` | 3/3，7.8 秒，1.0 | 3/3，13.0 秒，3.0 |
| GitHub 4 个仓库最新版本 `gh-releases` | 2/2，10.5 秒，1.0 | 2/2，37.5 秒，3.0 |
| GitHub 最早的某类 PR `gh-pr` | 2/2，12.8 秒，1.5 | 2/2，14.7 秒，2.5 |
| crates.io 版本 `crates` | 2/2，9.3 秒，1.0 | 2/2，14.3 秒，3.0 |
| PyPI 版本与日期 `pypi` | 2/2，10.5 秒，2.0 | 2/2，23.4 秒，5.5 |
| Hacker News 搜索 `hn` | 2/2，9.5 秒，1.0 | 2/2，18.6 秒，4.0 |
| Tailscale 文档 `tailscale` | 1/2，19.2 秒，2.0 | 2/2，28.5 秒，5.5 |
| Apple 安全更新 `apple` | 2/2，8.8 秒，1.0 | 2/2，15.4 秒，3.0 |
| 维基百科排名表 `wiki` | 1/2，14.7 秒，0.5 | 2/2，22.1 秒，3.5 |

### 差距从哪来

- **一次调用读完一个网址。** Cindy 的 `read` 在一次调用里打开、等内容出现、读取、关闭；BrowserMCP 打开页面
  不返回内容，要再观察一次，结束前还要单独调 `session_finish`（39 次本机运行里有 37 次）。纯读取题差距
  最大：Cindy 1 次调用，BrowserMCP 3–4 次。
- **固定开销。** BrowserMCP 一开始就下发 16 个工具的完整定义，约 77 KB（`tab_act` 一项 17 KB），每次运行
  平均输入 9.3 万 token；Cindy 的工具按需发现，1.5 万。缓存让费用差距小于 token 差距。
- **它的返回更紧凑。** BrowserMCP 每次工具结果平均比 Cindy 少约 20% 字符；它的观察结果省略空包装、
  只留可操作元素，每个动作还返回 `effect`（`none` / `changed` / `navigated`），告诉模型页面有没有反应。

### Cindy 的两次失败

- **维基一题：模型没有调用浏览器。** 那次运行只有一轮，模型直接写了一段「试了几种方法都读不到」的说明，
  没有任何工具调用。这是模型的偶发行为，与工具无关，记在这里不剔除。
- **Tailscale 一题：读取永远不返回。** 这是 Cindy 的缺陷，已在本改动修复，见下一节。那次运行在 8 分钟后
  被结束，不计入平均用时。

## 发现并修复的缺陷：一个标签页让所有查找卡住

**触发条件**：同一个任务里先做过一次浏览器操作，再用一次 `read` 同时读
`https://tailscale.com/kb/1241/tailscale-up` 和它 308 跳转到的 `https://tailscale.com/docs/reference/tailscale-cli/up`。
不经模型直接调用工具 4/4 必现；本机夹具（含同样的 308 跳转）复现不出来。

**根因**：浏览器运行时每次按标签页编号找页面，都会对所有标签页新建一个 CDP 会话查编号
（`Target.attachToTarget`）。Chrome 对正在跳转的那个标签页不回这条命令，Playwright 也不设期限，于是
任何标签页的查找都挂住。DOM 读取的 20 秒总时限原先在找到页面之后才开始计时，没有兜底。

**修复**：查编号每个标签页最多等 3 秒，超时当作「查不到」（调用方本来就处理这种情况），晚到的会话随即
释放；DOM 读取的总时限从找页面之前开始计时。细节见
[运行时维护说明](../../../packages/browser-control-runtime/upstream/MAINTAINING.md) 踩坑表第 16 条。

**修复后**：直接调用工具 4/4 在约 4.3 秒内返回，两个页面都读到完整正文；用同样的模型和设置再跑
Tailscale 一题 3 次全部做对（平均 17.0 秒），其中一次正好走了「同时读跳转前后两个网址」这条路径。

## BrowserMCP 在 Chrome 158 上不能用

在 Chrome for Testing 158.0.8127.18 上，BrowserMCP 新开带网址的标签页全部失败，每次 15 秒后报
`navigation to … did not start`，有界面和无界面都一样；同一份构建在 151.0.7922.34 上开页约 0.35 秒。
它在扩展里先建空白标签、挂上调试器、再跳转，跳转没有开始。没有进一步定位原因。本机正式版 Chrome 当时是
157，158 发布后它的用户可能会遇到。所以这次对比给它用的是 151。

## 自己重跑

```sh
# 1. 构建 BrowserMCP（npm install 会构建 dist/ 和 extension/dist/）
git clone https://github.com/jackwener/browsermcp && (cd browsermcp && npm install)

# 2. 准备一个仍接受 --load-extension 的浏览器，例如 Playwright 带的 Chrome for Testing 151
export BROWSERMCP_DIR=$PWD/browsermcp
export BROWSERMCP_CHROME="<Chrome for Testing 可执行文件>"

# 3. 本机 13 题；加 --real-sites --only gh-releases,gh-pr,crates,pypi,hn,tailscale,apple,wiki 跑真实网站 8 题
node --import tsx scripts/eval-browser-tasks.mjs --live --baseline-ref origin/main --variants B,C \
  --repeats 3 --parallel 4 --model claude-opus-5-5 --effort medium
```

`--variants B,C` 中 B 是 BrowserMCP，C 是当前工作区（这时 `--baseline-ref` 只记录在结果里）。每次运行的
BrowserMCP 都在独立临时目录里：临时 HOME、全新浏览器配置、写在该配置里的本机程序注册，不改动用户自己的
Chrome、钥匙串或 MCP 客户端配置，见 [`browsermcp-env.mjs`](../../../scripts/benchmarks/browsermcp-env.mjs)。
需要本机登录了 `claude` 命令行，会消耗用量（这次连同修复后的复测共 113 次运行，约 6 美元）。

## 数据里有什么、没有什么

[results.json](results.json) 有每次运行的题目、一方、是否做对、轮数、调用次数、费用、用时、token、工具返回
字符数和调用序列（BrowserMCP 的 `js(n)` 表示一次 `js` 调用，n 是代码长度），按「题组 / 一方」的汇总，以及
修复后的 Tailscale 复测。没有放进来的：每次运行的随机答案、模型回答原文和本机路径。
