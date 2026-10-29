## 这次改了什么

### 摘要

普通任务可以创建长期伙伴，保留来源历史，在独立主任务接续工作。每次主动创建产生独立伙伴；同一次提交的连点或失败重试按请求 ID 返回同一结果。

来源消息、附件和项目文件保持原归属。每位伙伴保存创建时的消息成员范围，历史可浏览、检索并进入既有学习机制；首次发送复用有界上下文交接，不重放旧工具、队列或原生执行句柄。

### 变更类型

- [x] `feat` 新功能
- [x] `fix` 缺陷修复
- [ ] `refactor` / `perf` 重构或性能优化
- [x] `docs` / `test` / `chore` 文档、测试或工程维护

### 范围

- 需求与设计：`docs/task-to-companion.md`。
- Desktop 菜单、普通 Agent 工具 `create_teammate_from_task`、同账号远控和 Mobile 创建入口共用服务。
- 支持本机普通任务及本机导入的 `.cshare` 任务；不含实时共享协作任务、SSH 工作区、批量转换或通用迁移。
- 独立档案、主任务、Home 和记忆；只引用来源历史，不复制整个工作区或项目共享记忆。删除伙伴不删除来源记录和文件。
- 创建沿来源任务的发送锁与空闲检查；请求身份只负责去重。保留重名、队列、owner 与授权校验。
- 模型必须已连接且启用；失效选择返回 `MODEL_SELECTION_UNAVAILABLE`，表单显示既有本地化操作提示并保留输入，不自动换模型。
- 兼容性：无来源的普通创建不变；新增远控入口探测 `version: 2`，旧端不显示或明确拒绝。未修改 system prompt、原生配置或依赖。

### UI 变化

引用的设计规范：`docs/design-rules/DESIGN.md` §1、§5、§10、§11。复用标准表单、Input、按钮和消息渲染器，颜色使用语义 token；手机复用现有菜单表单。

以下为 `pnpm ui:check:publish` 发布的合成截图，不含真实创作、任务或账号资料。完整应用按钮流程另在隔离环境验收，私人截图不上传。

<!-- 由 pnpm ui:check 生成；pnpm ui:check:publish 把截图发到作者 fork 并换上图片链接 -->
- 截图来源：单页验证 `pnpm ui:check --page task-companion --case default --theme all`，Windows · Electron 42.11.12（Chromium 148.0.7778.280，与 Cindy 同一渲染内核）；真实组件与主题，场景数据，不是登录账号下的完整 Cindy
- 版本：`c3049c6337b6`（含未提交改动）
- 结果：2/2 个场景通过
- 页面 `task-companion`：light / dark · zh-CN · 720×800
  - `default`：Create from an existing writing task
  - 未覆盖：Submission, model picker, plugin cards, real database, live device-link and model understanding
  - 场景替换的模块（未验证）：`src/renderer/contexts/AuthContext`、`src/renderer/hooks/useProviders`、`src/renderer/features/bots/BotModelChainEditor`、`src/renderer/components/chat/GhostToolCard`

![单页验证截图 1/1](https://raw.githubusercontent.com/whoisjaja/cindy/a3a0b399b93f49ce7a6b351afca073b0e8e0d14c/task-companion-Oyt1Zx/overview.png)

## 怎么验证的

### 自动验证

复用已通过的检查；发布前只为发现的来源发送锁问题补定向回归，没有重跑整仓。

```text
pnpm --filter desktop run typecheck
pnpm --filter mobile run typecheck
pnpm --filter @cindy/mcps run build
pnpm --filter @cindy/device-link run build
通过；后两包 build 为 tsc --noEmit。

pnpm --filter desktop db:validate
pnpm --filter desktop test:migration-replay
0137–0139 静态检查通过，22 项回放通过（5.45 秒）。

pnpm ui:check --page task-companion --case default --theme all
pnpm ui:check:publish artifacts/ui-check/task-companion-Oyt1Zx --remote jaja-fork
2/2 通过，已目检并仅发布合成截图。

pnpm check:dco
pnpm check:dev-docs
pnpm check:test-hygiene
通过。此前 i18n、术语、Mobile scope、设计颜色检查通过。
```

定向 Vitest 均使用既有文件，最小输入及生产入口说明位于测试附近：

| 文件 / 检查 | 保护的行为与最小输入 | 结果 |
| --- | --- | --- |
| `botTx.test.ts` | 普通任务与可见/撤回消息；事务保护队列拒绝、成员范围、请求唯一、删除归属 | 全文件 40 项及变更后定向通过 |
| `botCanonicalSession.test.ts` | 实际 IPC → worker → 主任务；同源新请求创建独立伙伴，同请求回原结果；运行中来源被发送协调器拒绝 | 发布前 2 项通过，21.14 秒；收集 20.73 秒，测试体 70ms。发送锁回归先红后绿 |
| `botRosterView.test.tsx` | 真组件按钮：失败重试保留请求、重新打开生成新请求；模型错误提示具体操作并保留名字 | 请求生命周期及两条模型错误分支通过，后者 2.64 秒 |
| `migrationReplay.test.ts` | 真实迁移器与有数据的旧来源；升级保留消息/成员，清除旧 dev 补回的索引 | 22 项通过，5.45 秒 |
| `remoteHistoryPagination.test.ts` 来源用例 | SQL/原生向量读取、搜索及邻居窗口；晚到/撤回/清空不越过成员范围 | 来源用例通过，10.26 秒；另有下述 4 项基线失败 |
| `botNightlyLearning.test.ts` | 真实 SQL 来源交流进入既有学习，晚到与撤回不进入 | 7 项通过 |
| `botHistoryScope.test.ts` | 已有归属范围查询接入来源参数，未新增独立用例 | 定向通过 |
| helper MCP / `remoteChatHistory.test.ts` | 普通 Agent 发现与调用创建、请求 ID 透传；接收端须确认历史范围 | 35 / 17 项及后续请求 ID 定向通过 |
| device-link allowlist / 自建中转 interop | 业务入口沿既有 invoke 转发，不增加隧道协议 | 55 / 1 项通过 |

其余既有文件未另行逐文件计时，不宣称全部满足 5 秒预算。大文件收集成本已披露；没有放宽有效断言。

### 手工验证

- Windows 隔离实例：生产菜单 → 表单 → 实际按钮 → 新伙伴主任务，用户已试用通过。
- 同一合成来源两次创建不同伙伴与 Home，历史范围分别为 1/2 条；同请求重试回第一位，连点不多建。
- 用户选定单任务经产品导出/导入，801 条记录正文、角色、顺序、时间和工具结果逐条核对；799 条可见历史分页可读，原有撤回边界保留。旧授权凭据按既有导入规则移除。来源无媒体附件或 Worker。
- 升级前后已有伙伴、消息及来源成员逐行哈希保留核对通过；未写正式数据库或原项目文件。
- 真实来源表单的 Claude Code / OpenAI / GPT-6.1-Sol / low 路线起初默认未启用；查明后只在隔离设置启用用户所选路线，再按原表单实际创建并核对去重，没有更换引擎、账号、模型或推理档。
- 单次真实 Codex `gpt-6.1-sol` 接续区分已否定方案、最终决定与待定目标，实际检索来源消息。合成输入与结果见 `docs/acceptance/task-to-companion-live-2026-10-29.md`，未用固定回复证明理解质量。

### 未执行与已知失败

- `remoteHistoryPagination.test.ts` 的 4 项基线失败：`paginates the visible list without hidden rows consuming slots or cursors` 与 `projects parent references using current source visibility without changing local history`，各在两种模式失败。原基线 `5f0b5f42` 的同一测试和源码已定向运行并复现：实际 `background` 而预期 `hidden`，实际保留父任务引用。断言未放宽；尚未验证最新主仓是否另行修复。
- 未做 Mobile 实机、真实跨电脑创建/接管、macOS 目检或所有模型的长期学习验收。Mobile 代码与类型已检查，不冒充实机通过。
- 手机伙伴内来源分页浏览尚未接入，可打开原任务；来源历史不随主力电脑切换自动搬迁。维护者需确认首版边界。
- `ui:check --changed` 因共享依赖选中大量页面而中止，改用相关场景；菜单 UNCOVERED 部分在完整隔离应用 Light 目检，未宣称 Dark 菜单目检。

## 风险

### 风险分类

- [x] SQLite / migration
- [x] 协议兼容
- [x] 权限 / 安全 / 用户数据
- [x] 跨平台差异
- [ ] system prompt
- [ ] 存量插件兼容
- [ ] 原生层 / fingerprint / OTA

### 影响与回滚

- `0137` 增加来源与成员表；`0138` 解除来源唯一限制，增加请求唯一索引；`0139` 只移除隔离试用时旧进程按缓存 schema 补回的来源唯一索引。已执行迁移未重写，实际升级路径有回归。
- 历史共享引用，各伙伴成员范围与学习状态独立；读取仍遵循来源当前撤回、清空、删除边界。
- 按同账号 owner、可信 renderer、任务身份及当前权限档校验；不恢复旧授权，不对共享访客开放，不自动重放远控写请求。
- 回滚可撤下入口，保留来源数据和关系；不手工降级数据库，不删除历史 migration。开发迁移仅在隔离库运行。
- 产品、数据库、权限与跨端边界交维护者正式审查，本 PR 不代表批准，不自动合并。
- 最终生产代码 36 文件，约 580 行新增 / 41 行删除；10 个语言文件各增加一组文案。测试与场景 12 文件，约 331 行新增 / 12 行删除。迁移 SQL 3 文件共 24 行；快照与 journal 约 22,502 行新增，属于 Drizzle 生成元数据。

### 提交前检查

- [x] 已 review 完整 diff，并补回来源发送锁回归
- [x] 每个 PR commit 均带与作者一致的 DCO 签名
- [x] UI 变化注明设计规范并附合成截图
- [x] 未提交凭证、授权文件、真实创作正文、试聊导出包或个人路径
- [x] 设计和协议说明统一为多伙伴、同请求去重的最终语义
- [x] 已说明通过结果、基线失败及未验收边界
