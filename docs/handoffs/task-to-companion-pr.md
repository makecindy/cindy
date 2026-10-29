# feat(bots): 从已有任务创建伙伴

## 这次改了什么

### 摘要

普通任务菜单可创建长期伙伴。原任务、消息和附件保留原归属，新伙伴关联创建时的消息，
在新主任务继续；来源历史可在桌面伙伴历史页分页浏览、按伙伴检索，并进入既有夜间学习。
首次发送复用现有有界交接，不恢复旧执行句柄、工具或队列。

### 变更类型与范围

- `feat`；设计正本：[从已有任务创建伙伴](../task-to-companion.md)。
- Desktop、本机 Agent 工具、同账号远控与手机创建入口共用服务。
- 一个普通本机来源任务对应一个新伙伴；不含批量导入、通用迁移或人格分析。
- 来源记录仍在来源电脑；更换伙伴主力电脑不自动搬迁来源历史。手机伙伴内来源分页视图未接入，原任务仍可打开。
- 不改变已有创建请求；新远程入口先探测，旧端不显示。未修改系统提示词。

### UI 变化

复用伙伴创建表单、原消息渲染器和手机菜单表单。颜色沿语义 token；依据
[DESIGN.md](../design-rules/DESIGN.md) §1、§5、§10、§11，手机复用现有文字与操作组件。

离屏检查：`pnpm ui:check --page task-companion --case all --theme all --locale zh-CN,en --engine chromium`，
8/8 通过，Light/Dark 截图已目检。证据目录为
`artifacts/ui-check/task-companion-IoPcdc/`。场景替换了账号、供应商发现、模型选择器和插件卡；
截图验证新增字段与历史正文，不代表真实发送或这些被替换组件已验收。
`--changed` 因共享文案选中大量页面，运行后中止并改用上述定向检查。未发布截图。
职责字段收敛到标准 `Input` 后，又定向检查创建表单：4/4 通过，已目检，证据为
`artifacts/ui-check/task-companion-8Ta4Cg/`，包含实际填写职责字段的交互断言。工作区设计颜色检查无新增未分类项。

## 怎么验证的

### 自动验证

| 验证 | 结果与保护的行为 |
| --- | --- |
| Desktop、Mobile `typecheck`；`@cindy/mcps`、`@cindy/device-link` `build`（均为 `tsc --noEmit`） | 通过；后两包没有独立 typecheck script |
| Desktop `db:validate`、`test:migration-replay` | 通过；向前迁移 `0137`、空库与历史库升级；回放 21 项，墙钟 7.69 秒 |
| `botTx.test.ts` | 40 项通过；新增来源事务用例保护队列拒绝、消息成员范围、重复创建和删除归属 |
| `botCanonicalSession.test.ts` 定向创建与历史查询 | 通过；实际 IPC、创建服务、worker 事务、canonical 创建和重试；首次换模交接与来源交接同时保留，撤回后重新读取；定向墙钟约 20 秒，测试体约 65 ms，主要耗时在已有大文件收集 |
| `remoteHistoryPagination.test.ts` 的来源快照用例 | SQL/原生向量两种模式通过；读取与检索只含捕获成员，撤回、清空及邻居窗口不泄漏隐藏内容；定向墙钟 10.26 秒，测试体约 50 ms |
| `botNightlyLearning.test.ts` | 7 项通过；新增真实 SQL 来源用例证明来源进入既有学习流程，晚到与撤回内容不进入；未用模拟模型结果宣称理解质量 |
| `botHistoryScope`、任务授权及 MCP 审批定向检查 | 通过；既有归属与权限档继续有效 |
| helper MCP 入口、远程历史回执 | 35 / 17 项通过；普通 Agent 可发现创建工具，跨端历史范围须被接收端明确确认 |
| device-link allowlist、自建中转 interop | 55 / 1 项通过；沿通用 invoke 转发，无需 relay 代码修改 |
| i18n、术语表、测试卫生、Mobile scope | 通过；保留已有非阻断警告 |

新增测试均并入既有文件，使用隔离数据库或临时 Home。未新增测试矩阵、外网测试账号或真实创作数据。
canonical 全文件首轮出现两处旧调用参数预期差异，补齐新的 `teammateId` 范围后已定向复验；没有删减原断言。

### 已知验证限制

- `remoteHistoryPagination.test.ts` 全文件有 4 项既有断言与现行代码不一致：
  `paginates the visible list without hidden rows consuming slots or cursors`
  和 `projects parent references` 各在两种模式失败。期望隐藏记录为 `hidden`，现行未改动的
  `botRemoteSessionAccess.ts` 将其视为主人可按 ID 读取的 `background`，并保留对应父任务引用。
  本次新增来源用例通过；上述断言未放宽，交由独立修复处理。
- 未运行完整客户端的真实模型接续验收、手机实机和 macOS 目检。当前贯通证据为真实生产
  服务入口＋隔离数据库测试及离屏组件检查；不声称完整 UI → 真实模型端到端已通过。
- 来源历史不会随伙伴切换主力电脑自动迁移。真实多电脑创建与手机表单仍需人工验收。

## 风险

- SQLite / 用户数据：只新增来源关系与消息 ID 成员表；原记录和附件不搬迁。准备状态支持
  初始化失败后补完，成功后的重试不重置用户设置。
- 协议：新增同账号业务入口与可选历史范围回执，旧端拒绝／不显示，不自动重放写操作。
- 回滚：可移除创建入口；已写入关系保留在数据库，不手工降级数据库或修改历史 migration。
- 维护者重点确认：来源历史留在来源电脑的首版边界、真实模型接续质量、手机入口体验。

## 交付边界

分支 `cindy/cheerful-goldberg`，复用宿主分配的 worktree。未操作真实创作任务、正式应用或其他任务，
未 push、创建 PR、发布或打安装包。本文件是本地 PR 正文草稿，不代表维护者批准。

规模：业务改动约 580 行新增，集中在 37 个入口和适配文件；测试与界面场景
11 文件，约 240 行新增；十种端侧语言文件各增加一组文案。另有 Drizzle 自动生成
的完整 schema snapshot 与 journal，约 7,492 行，属于迁移元数据，不是额外业务实现。
