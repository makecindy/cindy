# 浏览器网页任务四方实测：Cindy 新旧版、Claude App、Codex App（2026-11-11）

同一批 9 件网页任务，分别交给 Cindy 浏览器工具层的新旧两版、Claude App 和 Codex App 去做，
记录做对次数、用时和操作次数。这份文档说明题目是什么、怎么测的、结果是什么、哪些地方不能
直接比，以及怎样自己重跑一遍。汇总数据见 [results.json](results.json)。

## 先看局限

这些局限决定了下面的数字能说明什么，请先读。

1. **题目是 Cindy 自己出的。** 这套题原本用来验证 Cindy 浏览器工具层的一次改动
   （[一次调用多步、底层出口](../../dev-rules/browser-use.md#一次调用多步底层出口与按模式给规则2026-11-10)），
   其中 5 题考「连续多步」、2 题考「常规入口够不着的页面」，只有 2 题是对照；`badge` 一题还是看到
   首轮结果后补的。它不是中立的第三方题库，天然偏向这次改动覆盖的场景。
2. **页面是本机测试页，不是真实网站。** 没有登录、验证码、广告、慢网络和反自动化。
3. **Cindy 和两个 App 的测法不同。** Cindy 是无界面自动评测，用时为命令行报告的处理时长，
   不含启动；两个 App 是在各自界面里操作，用时从点击发送算到答案出现。Codex App 从点击到它
   开始处理实测约 2 秒，这段在 Cindy 的数字里没有对应部分。
4. **判对的标准不同。** Cindy 的评测除了核对回答，还核对页面记录到的提交内容（表单各字段、
   设置各项是否填对）。两个 App 只核对了回答里的答案，没有核对页面记录，标准更松。
5. **样本少。** Cindy 每个场景新旧各 3 次；两个 App 的用时各取 2 轮（Claude App 的 `orders` 一题
   取了三次，原因见「怎么测的」）。同一题两次之间能差几秒到十几秒，没有做显著性检验。
6. **模型不同。** Cindy 与 Claude App 用同一个模型（Opus 5.5 Medium），Codex App 用 GPT-6.1 Sol
   （推理强度高）。和 Codex App 的差距里混着模型差异。
7. **Claude App 的结束时刻不是日志给的。** 它不在本机保存对话记录，结束时刻靠约 1.7 秒读一次窗口
   文字夹出来，单次误差约 ±1 秒（有一次 ±4.5 秒）。别人无法核对原始记录，只能自己重跑。
8. **操作次数不是同一把尺。** Cindy 和 Codex App 记的是工具调用次数（一次调用里可以含多步），
   Claude App 记的是界面上显示的动作数，口径更细，这一栏对它偏不利。
9. **一台电脑、一个账号、一个时间点。** Apple M5 Ultra，macOS 27.3，Node v22.21.1；
   Claude App 4.23118、Codex App 26.1103。产品和模型更新后结果会变。

## 题目

题目、测试页和判分逻辑都在 [`scripts/eval-browser-tasks.mjs`](../../../scripts/eval-browser-tasks.mjs)
的 `TASKS` 里。每次运行随机生成一套答案，没有固定答案可背。

| 编号 | 场景 | 要拿到什么 |
| --- | --- | --- |
| `form` | 填写并提交一张表单（文本、下拉、单选、勾选） | 提交后显示的确认码 |
| `catalog` | 逐个查看 4 个商品页 | 4 个只在详情页出现的 SKU |
| `orders` | 翻页查找一条订单（5 页） | 状态为 REFUNDED 的订单号和金额 |
| `report` | 点按钮生成报告再读数 | 报告里的 Total |
| `settings` | 从菜单进入设置、改三项并保存 | 保存后显示的回执号 |
| `vault` | 点击后等内容出现再读取 | 延迟显示的访问码 |
| `badge` | 填写页面内嵌组件里的表单 | 签发后显示的编号 |
| `iframe` | 读取嵌入页面里的内容 | 嵌入面板里的支持码 |
| `directory` | 站内搜索一个人 | 这个人的分机号 |

## 结果

| | Cindy 新版 | Cindy 旧版 | Claude App | Codex App |
| --- | ---: | ---: | ---: | ---: |
| 做对次数 | 27 / 27 | 27 / 27 | 27 / 27 | 26 / 27 |
| 平均用时（秒） | 15.8 | 20.6 | 29.7 | 35.2 |
| 平均操作次数 | 3.2 | 6.7 | 7.1 | 5.5 |

- Codex App 的用时已扣除它的自动审批（平均 5.9 秒）；不扣是 41.1 秒。
- Codex App 没做成的那次是 `badge`：它在内置浏览器里操作不了内嵌组件，停下来请求改用系统浏览器，
  自动审批没有放行。这次用了 94.6 秒，计入平均。
- Cindy 旧版指基线 `799a8b40ee`，新版指 `cc055c5a25`，两者只差浏览器工具层。

各场景平均用时（秒，Codex App 已扣自动审批）：

| 场景 | Cindy 新版 | Cindy 旧版 | Claude App | Codex App |
| --- | ---: | ---: | ---: | ---: |
| 填写并提交一张表单 | 20.9 | 20.8 | 29.2 | 39.8 |
| 逐个查看 4 个商品页 | 12.2 | 19.0 | 21.6 | 37.6 |
| 翻页查找一条订单 | 18.3 | 19.9 | 23.8 | 26.2 |
| 点按钮生成报告再读数 | 13.5 | 13.0 | 20.2 | 35.4 |
| 进入设置、修改并保存 | 22.0 | 24.4 | 38.2 | 49.9 |
| 点击后等内容出现再读取 | 17.3 | 20.4 | 28.2 | 35.2 |
| 填写页面内嵌组件里的表单 | 16.4 | 49.6 | 53.9 | 57.4 |
| 读取嵌入页面里的内容 | 7.6 | 7.9 | 38.8 | 15.3 |
| 站内搜索一个人 | 13.7 | 10.5 | 13.2 | 20.0 |

9 个场景里 Cindy 新版有 8 个快于两个 App；站内搜索 Claude App 更快一点（13.2 对 13.7 秒），
Cindy 旧版在这一题也比新版快。

Codex App 的时间主要花在等模型上：按它日志里「收到消息到完成」的时长拆，两轮平均约 39 秒里，
等模型约 30 秒，自动审批约 6 秒，工具真正执行约 3 秒。

## 怎么测的

### Cindy 新旧版

```bash
node --import tsx scripts/eval-browser-tasks.mjs --live --baseline-ref 799a8b40ee \
  --model claude-opus-5-5 --effort medium --repeats 3
```

真实模型经生产环境的浏览器入口驱动真实的无界面 Chrome，新旧两版交错运行，全部结果保留。
需要本机登录了 `claude` 命令行，会消耗用量（这次 54 次运行约 8.5 美元）。

### 两个 App

- **Claude App**：新会话，模型 Opus 5.5 Medium，权限 Auto，使用它内置的浏览器。
- **Codex App**：Codex 模式，模型 GPT-6.1 Sol，推理强度高，权限选自动审批，不选项目，
  使用它内置的浏览器。
- 每题新开一个对话，把题目原文发进去，不追问、不提示。
- 共 3 轮。第 1 轮两个 App 同时运行，只用来计做对次数；第 2、3 轮各自单独逐题运行，用来计时。
- **Codex App 的用时**取自它本机的会话日志，由
  [`browser-task-codex-timing.mjs`](../../../scripts/benchmarks/browser-task-codex-timing.mjs) 解析；
  自动审批耗时是每一次审查从开始到结束的时长之和。
- **Claude App 的用时**：测试页前面加一层记录请求的转发
  （[`browser-task-request-log.mjs`](../../../scripts/benchmarks/browser-task-request-log.mjs)），
  先等到这一题的关键请求出现，再每约 1.7 秒读一次窗口文字，取「还没有答案」和「已有答案」两次
  读取的中点。没有出现过确认弹窗，所以没有可扣的审批时间。
  第 2 轮里 `form`、`orders`、`vault` 各测了两次：`form` 的第一次两次读取相隔 13 秒，`vault` 的第一次
  没读到答案出现，这两次不计入；`orders` 的两次都夹出了区间，都计入，所以这一题的 23.8 秒是三次的
  平均（只取每轮后一次是 22.8 秒）。哪些样本计入，见 results.json 里的 `usedForTiming`。
- 发消息和读窗口是由 Cindy 通过操作电脑完成的。Codex App 同时跑（第 1 轮）和单独跑（第 2、3 轮）
  相比，除 `badge` 外 8 题按会话日志时长（`logSeconds`）平均是 38.7 对 35.1 秒，单独跑快约 3.6 秒；
  8 题里 4 题更快、4 题更慢，样本少，不能确定有没有差别。

## 自己重跑

```bash
# 1. 启动测试页：打印地址、本轮 run id、9 道题的题目原文和答案
node --import tsx scripts/eval-browser-tasks.mjs --serve

# 2. 把 prompts 里的题目发给要测的产品，对照 answers 判对；
#    <地址>/__state?run=<run id> 能看到页面记录的提交内容

# 3. 可选：给没有本地记录的产品计时。先加一层记录请求的转发，题目里的地址换成转发的端口
node scripts/benchmarks/browser-task-request-log.mjs proxy http://127.0.0.1:<测试页端口> 58501 requests.log
node scripts/benchmarks/browser-task-request-log.mjs wait requests.log 'POST /form/submit' --since <发送时刻的毫秒时间戳>

# 4. Codex App：一轮跑完后，从它的日志算每题用时
node scripts/benchmarks/browser-task-codex-timing.mjs <run id>
```

各题用来判断「页面操作已做完」的请求：`form` 是 `POST /form/submit`，`catalog` 是第 4 个
`GET /product`，`orders` 是目标订单所在页的 `orders/data`，`report` 是 `report/data`，`settings` 是
`POST /settings/save`，`vault` 是 `POST /vault/code`，`badge` 是 `POST /badge/issue`，`directory` 是带
`q=okafor` 的 `directory/search`。`iframe` 的嵌入页面由另一个端口提供，不经过转发，只能看到外层
页面的 `GET /embed`。

## 数据里有什么、没有什么

[results.json](results.json) 里有：Cindy 54 次运行的逐次结果（是否通过、轮数、调用次数、费用、用时、
调用序列），Codex App 三轮逐题的用时拆分，Claude App 逐次的请求时刻、答案出现的区间和动作数，
以及上面两张表的汇总。时间都是相对发送时刻的秒数。

没有放进来的：

- **Codex App 的原始会话日志**：里面有账号标识和完整对话，只公开从中算出的数字。
- **Claude App 的对话记录**：它不在本机保存。
- **测试时的随机答案和本机路径**：与结论无关。
