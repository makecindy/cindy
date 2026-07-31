# 自动 Code Review 审阅口径

本文件供 `.github/workflows/pr-code-review.yml` 触发的自动 reviewer 读取。人工
review 的完整口径见 `docs/dev-rules/development-workflow.md` §3，本文件不另立标准，
只把它翻译成自动 reviewer 能直接执行的形式。

## 1. 先读规则再评审

本仓的规则是正本，不要凭通用最佳实践判断对错：

- `AGENTS.md` —— 规则索引与触发条件，先看它决定该读哪几份。
- `docs/dev-rules/` —— 工程规则；`docs/product-rules/` —— 产品行为规则；
  `docs/design-rules/DESIGN.md` —— 权威视觉规范。
- `.github/PULL_REQUEST_TEMPLATE.md` —— 风险分类的口径。

diff 命中哪个模块，就读 `AGENTS.md` 索引里对应那条指向的规则文件，再评审。

## 2. 严重度映射

`docs/dev-rules/development-workflow.md` §3 用 P0／P1／P2，本 workflow 的评论用
P1／P2。按下表转换，**不要**把仓库口径的 P2 改写成评论里的 P2 上报：

| 仓库口径 | 评论标记 | 含义 |
| --- | --- | --- |
| P0：红线／崩溃／数据丢失／跨平台失效／安全 | `P1` | 不改不能合 |
| P1：明显 bug／规范违反／影响面没处理干净 | `P2` | 本次必须修 |
| P2：可选优化／风格偏好 | 不上报 | 整条略过，不降级也不换个说法上报 |

## 3. 不要重复机器门禁

以下问题 `client-ci` 与其他 workflow 已经逐条断言，命中即红，自动 reviewer 报了
只是占用有限的 finding 名额：

- 四语言 i18n key 结构、术语表译法、品牌名占位符（`check:i18n` /
  `check:i18n-glossary` / `check:brand-terminology`）。
- 受控源文件里的生产端点与飞书 App ID 字面量（`check:endpoints`）。
- migration 序号连续性、journal／snapshot 对齐、历史 migration 冻结
  （`desktop db:validate`）。
- scheduler 反向依赖、cron 三方库、scheduler renderer 色值白名单
  （`ci:scheduler-guard`）。
- mobile 的 Issue Confirm 范围守门（`mobile test:scope`）。
- typecheck、单测、DCO 签名、PR 正文「引用的设计规范」字段（`pr-design-basis`，
  仅在变更命中 UI 路径时校验该字段）。

另外，**不要**因为「PR 正文没写清楚」「commit message 格式」这类流程问题开评论。
注意这一条与上面那张清单的理由不同：它**不是**因为有机器门禁覆盖。`pr-template-rules`
只校验 `.github/PULL_REQUEST_TEMPLATE.md` 这个模板文件本身的二级标题，且只在模板、
校验脚本或该 workflow 自身变动时触发，从不读取任何具体 PR 的正文；也就是说「摘要、
怎么验证的、风险」这些必填段落缺失时，机器不会拦。这里仍然让自动 reviewer 略过，
是因为 PR 叙述质量属于人工 review 的范围，不该占用有限的 finding 名额——这是范围
划分，不是覆盖声明。

## 4. 重点看机器查不到的部分

按 PR 模板的风险分类，优先看这些：

- **凭证与本地存储**：凭证、令牌、授权文件是否写进了仓库或可能被 Git 跟踪的路径；
  用户数据落盘位置是否越界。见 `docs/dev-rules/credentials-and-local-storage.md`。
- **Electron 进程边界**：renderer／preload／IPC／CSP／WebView／导航与特权能力的改动
  是否扩大了攻击面。见 `docs/dev-rules/electron-security-and-process-boundaries.md`。
- **数据库**：新 migration 的正确性与可回滚性、companion 脚本必须是 CommonJS
  （生产 Electron 用 `require()` 加载，ESM 语法只在用户端炸）。见
  `docs/dev-rules/database-and-migrations.md`。
- **mobile 冷更边界**：改动是否触碰 `app.json`／`app.config.js`／`eas.json`／
  `apps/mobile/package.json`／`plugins/`／`modules/` 等进入 runtime fingerprint 的输入。
  命中就在评论里点名——这类 PR 需要把关人对冷更单独确认。见
  `docs/dev-rules/mobile-development.md`。
- **协议兼容**：`cindy-protocol` 升级、device-link／relay／隧道 payload、IPC allowlist
  等跨端 wire protocol 的向后兼容性。见 `docs/dev-rules/protocol-and-submodules.md`。
- **system prompt 与 Agent 行为**：进入模型 system 段的提示词、tool／MCP 暴露、
  usage 计量。见 `docs/dev-rules/maker-core-and-agent-behavior.md`。
- **插件沙箱**：`.cindy` 运行时的权限、能力 slot、网络／凭证／文件交接。见
  `docs/dev-rules/plugin-security-and-authoring.md`。
- **存量插件兼容（红线，优先级等同凭证与安全）**：改了批准 receipt 的 schema／必填字段／
  落盘位置、指纹或摘要编码、manifest 校验、slot 形态、技能快照与链接命名、安装根／状态根
  路径、`.cindy` 包格式、管子协议或内置插件 id 时，必须按用户**升级后什么都不做**来判：
  已装、已批准、已启用的插件是否照旧可用。新增必填字段或新校验只有拒绝分支、没有从旧版
  授权事实 backfill 的迁移路径，就是 **P1（不改不能合）**——"老数据缺新字段"是历史状态，
  不是篡改。自动迁移做不到时，必须有明确提示 + 一次性批量恢复入口（不能只留"去市场
  重装"）、不清掉用户已存的凭证与偏好、且新状态被旧版本读到不判损坏。还要看有没有基于
  旧布局 fixture 的升级用例——只测全新安装不算覆盖，这类回归只在存量数据上出现。判据见
  `docs/dev-rules/plugin-security-and-authoring.md` 第 5 节与 Review 清单 6.6。
- **UI 双模式**：新增或修改的界面必须同时实现 Light 与 Dark，颜色走语义 token；
  只适配一种模式的硬编码或条件补丁视为未完成。见 `docs/design-rules/DESIGN.md`。
- **跨平台**：macOS 与 Windows 的路径、进程、文件系统差异。
- **测试**：是否通过 skip、删除或弱化断言制造通过。

## 5. 评审环境的已知限制

- `cindy-protocol` submodule **未** checkout，该目录下的文件读不到。不要据此推断
  文件缺失或引用失效。
- 只 checkout 了 PR 的 merge ref 与最近 100 条历史，更早的 `git log`／`git blame`
  会不完整。
- 依赖未安装，无法运行测试或构建；结论只能来自静态阅读。

拿不准的地方，宁可不报，也不要用推测填空——上报前先把相关源文件读到能确认为止。

## 6. 评论语言

用中文写评论，与仓库文档保持一致；PR 正文为英文时用英文。
