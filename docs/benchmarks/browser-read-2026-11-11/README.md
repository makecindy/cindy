# 浏览器读网页实测：Cindy 这一版与上一版、bro、Claude App、Codex App（2026-11-11）

Cindy 的浏览器工具层这一版做了三处改动：核心用法随工具说明给出、新增 `read` 动作、修掉两个缺陷
（见 [核心用法写进工具说明，读页面用 read](../../dev-rules/browser-use.md#核心用法写进工具说明读页面用-read2026-11-12)
和 [打开后在同一次调用里读页面](../../dev-rules/browser-use.md#打开后在同一次调用里读页面先等页面有内容2026-11-11)）。
这份文档记录改动前后的实测，以及和开源项目 [bro](https://github.com/xiaotianxt/bro)、Claude App、
Codex App 放在一起的数字：题目是什么、怎么测的、结果是什么、哪些地方不能直接比，以及怎样自己重跑。
对外海报上的每个数字都能在这里找到出处。

## 先看局限

这些局限决定了下面的数字能说明什么，请先读。

1. **题目是 Cindy 自己出的。** 真实网站 8 题是为对比「读网页」挑的，本机 9 题沿用
   [上一轮实测](https://github.com/makecindy/cindy/pull/9768)。它不是中立的第三方题库。
2. **样本少。** 每格只有 2–3 次，没有做显著性检验。一两秒的差别不能当结论。
3. **不同时段之间有浮动，跨场次的数字只能看量级。** 两个实例：同一份上一版代码跑本机 9 题，上一轮
   是 15.8 秒，这次是 12.8 秒；bro 跑真实网站 8 题，两场分别是 10.0 秒和 7.7 秒（前一场有一次 54 秒，
   去掉它是 8.0 秒）。同一场里交替运行的两方才适合直接比，下面每张表都注明了是不是同场。
4. **两个 App 这次没有重测。** Claude App 和 Codex App 的数字沿用上一轮（方法见
   [那份文档](https://github.com/makecindy/cindy/pull/9768)）：它们是在各自界面里操作，用时从点击发送
   算到答案出现；Cindy 是无界面自动评测，用时是命令行报告的处理时长，不含启动。测法不同、时段不同，
   两个 App 也没有测真实网站这 8 题。
5. **bro 的条件是这边选的。** 1.4.5 版源码构建，全新的、未登录的无界面 Chrome，只开放它的服务端标为
   默认（`bro/default`）的 11 个工具。换成它的日常用法（用户自己的浏览器、已登录、其它工具集）结果可能不同。
   bro 的作者没有参与这次测试。
6. **上一版有 3 次没跑完。** 上一版在 Tailscale 一题上 3 次都没有返回（Playwright 的缺陷，这一版
   升级到 1.63 修掉，见 [运行时维护说明](../../../packages/browser-control-runtime/upstream/MAINTAINING.md)
   的踩坑表），6 分钟后被结束。「上一版 13.3 秒」是其余 21 次的平均；把这 3 次按 6 分钟算是 56.7 秒。
7. **只测了一种用法。** 命令行打印模式、只给浏览器工具，不是完整的 Cindy 会话；浏览器是专用浏览器
   这一种后端，侧边栏和「我的浏览器」没有跑这套题。
8. **真实网站会变。** 答案在每次开跑前从各站点的公开接口取；站点改版、限流或拒绝自动化访问都会让
   某一题失败，那是该去看原因的信号，不一定是退步。
9. **费用是连续运行、提示缓存命中时的数字。** 单独跑一次会更贵。
10. **一台电脑、一个网络、一个时间点。** Apple M5 Ultra，macOS 27.3，Node v22.21.1，Claude Code
    2.1.322；模型 Opus 5.5，推理强度 Medium。

## 海报上的数字从哪来

| 海报上的数字 | 出处 |
| --- | --- |
| 6.4 秒（真实网站任务平均用时） | [bro-after.json](bro-after.json)：`kind=real`、`side=cindy` 的 24 次 `seconds` 的平均 |
| 比上一版少 52%、每次费用少 71% | [bro-before.json](bro-before.json) 同一组的 13.3 秒、$0.147（21 次通过的平均）对 bro-after.json 的 6.4 秒、$0.042。两场不是同场；同场复测见[下文](#三同场复测真实网站-8-题这一版对上一版) |
| 模型来回 4.9 → 2.3 轮 | 同上两个文件的 `turns` |
| 10.2、12.8 秒（本机 9 题） | [fixtures-9.json](fixtures-9.json)：`variant=C`（这一版）和 `variant=A`（上一版）各 27 次 `durationMs` 的平均 |
| 29.7、35.2 秒（Claude App、Codex App） | [上一轮实测](https://github.com/makecindy/cindy/pull/9768)的汇总，没有重测 |
| 9 / 9 个场景快于两个 App | [第二节](#二和-claude-appcodex-app-比本机-9-题)的逐场景表 |
| bro 7.7、14.8 秒；上一版 13.3、15.9 秒；这一版 12.4 秒 | bro-after.json、bro-before.json 按 `kind`、`side` 取平均 |
| 13 个场景里 8 个 Cindy 最快、5 个 bro 更快，相差 0.2–2.4 秒 | [第一节](#一和-bro-比真实网站-8-题--本机-5-题)的逐题表，这一版对同场的 bro |
| 一次读 4 个页面 5–7 → 1.5 秒 | 不经模型直接调用工具的测量：四个 GitHub 发布页一次 `read` 用 1.3–1.7 秒，逐页打开再读要 5–7 秒。数据文件里对应的是 `gh-releases` 一题的 `toolSeconds`：4.5–5.9 秒 → 1.8 秒 |
| Tailscale 文档一题：全卡 → 全过 | bro-before.json 里 `tailscale`、`side=cindy` 的 3 次 `error`；bro-after.json 里 3 次通过 |

## 结果

### 一、和 bro 比（真实网站 8 题 + 本机 5 题）

Cindy 这一版和 bro 是**同一场、交替运行**（bro-after.json）；Cindy 上一版和 bro 是早几个小时的
**另一场**（bro-before.json），所以 bro 有两列。

| | Cindy 这一版 | bro（同场） | Cindy 上一版 | bro（上一版那场） |
| --- | ---: | ---: | ---: | ---: |
| 真实网站：做对 | 24 / 24 | 24 / 24 | 21 / 24 | 24 / 24 |
| 真实网站：平均用时（秒） | 6.4 | 7.7 | 13.3 | 10.0 |
| 真实网站：模型轮数 | 2.3 | 3.1 | 4.9 | 3.2 |
| 真实网站：每次费用 | $0.042 | $0.046 | $0.147 | $0.045 |
| 本机 5 题：做对 | 10 / 10 | 10 / 10 | 10 / 10 | 10 / 10 |
| 本机 5 题：平均用时（秒） | 12.4 | 14.8 | 15.9 | 16.3 |
| 本机 5 题：模型轮数 | 4.5 | 5.5 | 6.0 | 5.6 |
| 本机 5 题：每次费用 | $0.052 | $0.042 | $0.163 | $0.043 |

平均值只算做对的那些次。逐题平均用时（秒）：

| 题目 | Cindy 这一版 | bro（同场） | Cindy 上一版 | bro（上一版那场） |
| --- | ---: | ---: | ---: | ---: |
| `gh-releases` 查 4 个 GitHub 仓库的最新版本 | 6.0 | **5.8** | 14.9 | 5.8 |
| `gh-pr` 在 GitHub 仓库里找一个 PR | 7.8 | **6.6** | 15.0 | 6.4 |
| `crates` crates.io 查版本 | 5.5 | **4.8** | 12.5 | 5.3 |
| `pypi` PyPI 查版本和日期 | **5.7** | 6.3 | 15.2 | 7.5 |
| `hn` Hacker News 搜索 | **5.3** | 7.5 | 13.7 | 24.4 |
| `tailscale` Tailscale 文档里找参数 | **9.9** | 13.3 | 3 次都没返回 | 13.6 |
| `apple` Apple 安全更新表第一行 | **5.1** | 6.4 | 9.2 | 6.6 |
| `wiki` 维基百科长表格里找一行 | **6.3** | 10.5 | 12.3 | 10.0 |
| `form` 填写并提交表单 | **13.6** | 15.7 | 17.4 | 18.7 |
| `catalog` 逐个查看 4 个商品页 | **6.9** | 15.4 | 9.5 | 15.3 |
| `orders` 翻页查找一条订单 | 10.4 | **8.8** | 17.8 | 9.0 |
| `settings` 进设置修改并保存 | 18.4 | **16.0** | 18.6 | 18.9 |
| `badge` 填写内嵌组件里的表单 | **12.9** | 18.3 | 16.5 | 19.8 |

加粗的是这一版和同场 bro 里更快的一方：13 题里 Cindy 8 题、bro 5 题。bro 更快的 5 题相差
0.2–2.4 秒；其中 `gh-releases` 的 0.2 秒在波动范围内，说不上谁快。

「一次读完多个页面」这个做法是看了 bro 之后做的。

### 二、和 Claude App、Codex App 比（本机 9 题）

Cindy 两版是**同一场、交替运行**（fixtures-9.json）；两个 App 的数字是上一轮测的，见局限第 4 条。

| | Cindy 这一版 | Cindy 上一版 | Claude App | Codex App |
| --- | ---: | ---: | ---: | ---: |
| 做对次数 | 27 / 27 | 27 / 27 | 27 / 27 | 26 / 27 |
| 平均用时（秒） | 10.2 | 12.8 | 29.7 | 35.2 |
| 模型轮数 | 3.9 | 5.2 | 未采集 | 未采集 |
| 每次费用 | $0.039 | $0.145 | 未采集 | 未采集 |

| 场景 | Cindy 这一版 | Cindy 上一版 | Claude App | Codex App |
| --- | ---: | ---: | ---: | ---: |
| `form` 填写并提交表单 | 13.6 | 16.5 | 29.2 | 39.8 |
| `catalog` 逐个查看 4 个商品页 | 7.2 | 9.8 | 21.6 | 37.6 |
| `orders` 翻页查找一条订单 | 10.6 | 18.3 | 23.8 | 26.2 |
| `report` 生成报告再读数 | 9.1 | 10.5 | 20.2 | 35.4 |
| `settings` 进设置修改并保存 | 17.0 | 19.1 | 38.2 | 49.9 |
| `vault` 等内容出现再读取 | 10.3 | 12.7 | 28.2 | 35.2 |
| `badge` 填写内嵌组件里的表单 | 10.8 | 13.8 | 53.9 | 57.4 |
| `iframe` 读取嵌入页面的内容 | 6.2 | 5.2 | 38.8 | 15.3 |
| `directory` 站内搜索一个人 | 7.1 | 9.5 | 13.2 | 20.0 |

9 个场景里这一版都快于两个 App。`iframe` 一题这一版比上一版慢 1 秒：上一版一次 `open` 带快照就读到
了，这一版多用了一次 `read`。

两个 App 那一轮里，同一份 Cindy 上一版代码是 15.8 秒，这次是 12.8 秒。按这个浮动把两个 App 的数字
打八折再比，9 个场景的结论不变，但「快多少倍」不要直接拿两场的数字相除。

### 三、同场复测：真实网站 8 题，这一版对上一版

海报上「6.4 秒、比上一版少 52%」的两头不是同一场。为了排除时段浮动，用仓库里的评测脚本在同一场
里交替重跑了一遍（real-sites-ac.json，48 次全部做对）：

| | Cindy 这一版 | Cindy 上一版 |
| --- | ---: | ---: |
| 做对次数 | 24 / 24 | 24 / 24 |
| 平均用时（秒） | 6.9 | 13.1 |
| 模型轮数 | 2.3 | 4.5 |
| 每次费用 | $0.042 | $0.151 |

| 题目 | 这一版 | 上一版 |
| --- | ---: | ---: |
| `gh-releases` | 5.7 | 9.6 |
| `gh-pr` | 9.6 | 14.8 |
| `crates` | 6.6 | 13.8 |
| `pypi` | 5.7 | 18.4 |
| `hn` | 6.0 | 10.4 |
| `tailscale` | 10.1 | 15.8 |
| `apple` | 5.1 | 9.4 |
| `wiki` | 6.0 | 12.9 |

用时少 48%，费用少 72%，和海报用的那两场（少 52%、少 71%）接近。这里的「上一版」只换回了浏览器
工具层的代码，运行时用的是这一版的（Playwright 1.63），所以 Tailscale 一题没有卡死。

## 怎么测的

两套脚本都用本机的 `claude` 命令行，打印模式，只开放浏览器工具，每次运行一个全新的无界面浏览器，
全部结果保留、不挑选。用时取命令行报告的处理时长（`duration_ms`），不含命令行自身的启动。

- **Cindy 两版**（[`scripts/eval-browser-tasks.mjs`](../../../scripts/eval-browser-tasks.mjs)）：真实模型经
  生产环境的浏览器入口驱动真实的无界面 Chrome。`A` 是 `--baseline-ref` 那个提交的浏览器工具层，`C` 是
  当前工作区；两版按题交替，默认 3 个并行。本机题的答案每次随机生成，判对时除了核对回答，还核对页面
  记录到的提交内容。
- **和 bro 比**（[`scripts/benchmarks/browser-task-bro-compare.mjs`](../../../scripts/benchmarks/browser-task-bro-compare.mjs)）：
  同一道题先后交给两边，逐次串行，先跑哪边按轮次交替。Cindy 一侧和上面相同；bro 一侧是一个运行中的
  `bro serve`，加一个装了 bro 扩展的无界面 Chrome。判对只核对回答里的答案。
- **「上一版」指什么**：浏览器工具层和运行时都与 `4ac45b894e` 相同，Playwright 是 1.60.0。
  fixtures-9.json 和 real-sites-ac.json 里的上一版只换回了工具层（见第三节的说明）；bro-before.json
  是整份旧代码。
- **bro 一侧开放的工具**：bro 1.4.5 的服务端一共列出 62 个工具，其中 11 个在元数据里标了
  `bro/default`，其余 51 个用命令行的 `--disallowedTools` 关掉，清单在脚本的 `BRO_HIDDEN_TOOLS` 里。

## 自己重跑

需要本机登录了 `claude` 命令行，会消耗用量。这次四组运行一共约 19 美元（本机 9 题 5.0，真实网站
同场复测 4.6，和 bro 比的两场 6.2 和 3.1）。

```bash
pnpm install

# 一、本机 9 题：这一版对上一版（54 次）
node --import tsx scripts/eval-browser-tasks.mjs --live --baseline-ref 4ac45b894e \
  --model claude-opus-5-5 --effort medium --repeats 3 \
  --only form,catalog,orders,report,settings,vault,badge,iframe,directory

# 二、真实网站 8 题：这一版对上一版（48 次）
node --import tsx scripts/eval-browser-tasks.mjs --live --baseline-ref 4ac45b894e \
  --model claude-opus-5-5 --effort medium --repeats 3 --real-sites \
  --only gh-releases,gh-pr,crates,pypi,hn,tailscale,apple,wiki

# 三、不花用量的自检：不经模型，直接验证 batch、cdp、read 在真实浏览器上的结果
node --import tsx scripts/eval-browser-tasks.mjs --check
```

和 bro 比需要先把 bro 跑起来（步骤也写在脚本开头）：

```bash
# 1. 取 bro 1.4.5 的源码，构建服务端和扩展（扩展产物在 extension/dist）
cargo build --release

# 2. 用一个空目录当 HOME 启动服务端，它会生成 <空目录>/.bro/settings.json
HOME=<空目录> ./target/release/bro serve

# 3. 用全新的资料目录启动一个装了扩展的无界面 Chrome
<chrome> --headless=new --user-data-dir=<另一个空目录> --remote-debugging-port=9377 \
  --load-extension=<bro>/extension/dist --use-mock-keychain --password-store=basic \
  --disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSockets

# 4. 把令牌交给扩展（无界面的 Chrome 没有设置页可以粘贴）
node scripts/benchmarks/browser-task-bro-compare.mjs --set-extension-token 9377 \
  --bro-settings <空目录>/.bro/settings.json
curl http://127.0.0.1:3500/status   # extensionCount 为 1 表示扩展已连上

# 5. 这一版对 bro（68 次）
node scripts/benchmarks/browser-task-bro-compare.mjs --live --bro-settings <空目录>/.bro/settings.json

# 6. 上一版：另开一个工作区检出旧提交，只跑 Cindy 一侧
git worktree add ../cindy-before 4ac45b894e && (cd ../cindy-before && pnpm install)
node scripts/benchmarks/browser-task-bro-compare.mjs --live --sides cindy --repo ../cindy-before
```

第 6 步的上一版会在 Tailscale 一题上卡住，每次 6 分钟后被结束，属于预期。

两个 App 怎样重测，见[上一轮实测](https://github.com/makecindy/cindy/pull/9768)的说明；这一版让
`--serve` 同时打印各题的题目原文，可以直接拿去发给要测的产品。

## 数据里有什么、没有什么

| 文件 | 内容 |
| --- | --- |
| [bro-after.json](bro-after.json) | Cindy 这一版和 bro，同场，68 次 |
| [bro-before.json](bro-before.json) | Cindy 上一版和 bro，同场，68 次（含 3 次没返回的） |
| [fixtures-9.json](fixtures-9.json) | 本机 9 题，这一版对上一版，54 次 |
| [real-sites-ac.json](real-sites-ac.json) | 真实网站 8 题，这一版对上一版，48 次 |

每次运行一行：是否做对、模型轮数、浏览器调用次数和调用序列、费用、用时、模型给出的最终回答；和 bro
比的两个文件另有模型接口耗时、工具耗时、令牌数和工具返回的字符数，以及开跑前取到的各站点答案。
fixtures-9.json 是在评测脚本加上 `--effort` 参数之前跑的，当时的强度是给 `claude` 命令包了一层传
进去的，效果相同，文件里补记了这一项。

没有放进来的：

- **每次运行的完整对话流和浏览器调用轨迹**：体积大，结论用不到；重跑时会写在输出目录里。
- **bro 的令牌、本机路径**：与结论无关。
- **两个 App 的原始记录**：见上一轮实测的说明。
- **海报图片**：不放进仓库，随发布这次改动的 PR 一起给出。
