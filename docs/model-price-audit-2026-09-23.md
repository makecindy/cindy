# 2026-09-23 模型参考价缺口核对

本次对照远程文件评测使用的型号核查 Server 正本和客户端离线 Registry，
只更新参考价，不更新 Gateway 的实际售价、用户覆盖、调用权限或协议。
新版 revision 为 `2026-09-23T00:00:00.005Z`，完整 Registry 两仓保持一致。
Muse 1.2 的现有 XD 路由显式关联 global 价格组，覆盖按供应商/型号解析与 V4/V5 投影。
客户端同时追平 Server 已有的 GPT-6 Sol、GPT-6 Luna、Opus 5.5 三个条目；
这些不是本次新增的服务端模型。
整表同步会使客户端继承服务端已有的 Opus 5.5 排序与默认家族选择，
默认可见 Opus 从 5 更新为 5.5；未修改选择算法，用户显式覆盖仍优先。

## 补入项

单位为每百万 Token；日期 2026-09-23 是本目录采纳快照日，不推断厂商历史生效日。

| 型号                 | 市场/币种  | 输入 | 输出 | 缓存读取 | 缓存写入 | 处理                                             |
| -------------------- | ---------- | ---: | ---: | -------: | -------: | ------------------------------------------------ |
| Kimi K3              | global/USD |    3 |   15 |      0.3 |        3 | 补写入价，含 XD 公共型号副本                     |
| Kimi K3              | cn/CNY     |   20 |  100 |        2 |       20 | 补写入价                                         |
| HY4 preview          | cn/CNY     |    6 |   18 |      0.3 |     未知 | 公共型号及现有路由参考价组                       |
| Muse Spark 1.2 / 1.3 | global/USD | 1.25 | 4.25 |     0.15 |     未知 | 1.2 补价；1.3 仅新增公共资料，不新增接入成员     |
| Gemini 3.8 Flash     | global/USD | 0.75 | 3.75 |    0.075 |     未知 | 仅公共资料；2027-01-01 起分别为 1.5 / 7.5 / 0.15 |

K3 保留旧价格区间，新区间补写入字段；尚未核实的 1h 写入价保持缺失。
Gemini 的按小时缓存存储费不是缓存写入费，不能填入 cacheWritePerMtok。

官方来源（2026-09-23 核实）：

- [Kimi 国际平台](https://platform.kimi.ai/) 与 [国内平台](https://platform.kimi.com/) 首页明确列出上述写入价；[TTL说明](https://platform.kimi.ai/docs/pricing/chat)说明默认5分钟、另有1小时档。
- [腾讯 TokenHub](https://cloud.tencent.com/product/tokenhub)：广州地域 HY4 preview 参考价。
- [Meta Model API](https://dev.meta.ai/docs/pricing-rate-limits)：Muse 1.2/1.3 Standard 共用价格；不采用允许训练数据的 Contributor 折扣。
- [Gemini API](https://ai.google.dev/gemini-api/docs/pricing)：3.8 Flash Standard，含明确的2027年价格切换日；不将 Flex/Batch 混入 standard。

## 保留的缺口

- **Kimi K2.8 preview**：评测报告使用的 [B.AI参考价](https://docs.b.ai/llmservice/models/kimi-k2.8-preview/) 是该供应商自己的报价。当前目录无 B.AI 路由，Kimi Code 也不是 B.AI；因此不写入厂商官方价组或其它路由。输入/输出/读取/写入 1/4/0.25/1 USD 只能作为报告情景估算，不能伪称官方价。
- **DeepSeek V4.1 Flash**：[官方定价](https://api-docs.deepseek.com/quick_start/pricing/)按UTC工作日、日内时段及中国节假日区分峰谷。当前目录只有日历日期范围，不能表达这张时刻表；未把峰期 0.3/1.2/0.006 USD 写成全天价格，也未借 V4 的别名替代 V4.1 精确型号。此处需要独立的时段价格合同后才能准确补齐。
- **K3 1h缓存写入**：数字价未核实，保持未知；不能从默认写入价猜倍率。
- 其它已配置且本次未发现缺字段的评测型号保持原价与历史区间。本次不是全目录所有媒体、订阅与区域价格审计。

## 发布与验证边界

本次仅更新文件并验证解析/价区间选择/旧版投影，不代表已部署。
发布时先部署 Server，再发布客户端；核对实际目录响应须同时携带
`registrySchemaVersion=5&registryMedia=1`，否则可能得到既有的冻结兼容快照。
旧客户端的冻结目录 `legacy-providers.json` 不修改。

验证记录：

- Server 与客户端完整 Registry JSON 深比较一致。
- 客户端 model-providers：45 个文件、1043 项测试通过。
- Desktop 目录发现：同步 Opus 5.5 预期后，36 项测试通过。
- Server 全量单测：2469 项通过、285 项跳过；Server typecheck 通过。
- 客户端扩大回归首次 Desktop 有 10 项失败：目录同步导致的 1 项已修正并定向复验；
  其余 9 项来自 claudeOrphanReaper / codexAuthIsolatedSandbox，
  在同一 HEAD 的干净主分支单独复现为相同 9 项失败。
- 客户端 model-providers 类型检查有 4 条既有测试类型错误，涉及
  kimiCodeDefaults / mimoV26Regression / modelNativeApi；本轮在同 HEAD 干净主分支复跑，得到相同 4 条错误。
  不将单测通过表述为完整类型检查通过。
- 扩大回归的 Mobile、lizi-mcps、maker-core、model-providers、orca-workflow 均通过。
  根门禁仍因上述 Desktop 基线失败退出 1，不声称整仓全绿。
