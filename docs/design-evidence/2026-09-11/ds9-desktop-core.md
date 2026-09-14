# DS-9 · Desktop 核心界面本地验收

实施与视觉基线 `f8aaae334f6f316d2780df362557a6c9f3c6a4dc`，分支 `ds/9-desktop-core-ui`，macOS Electron，2026-09-11。提交准备已同步主干到 `f9ce362377`，DS-9 文件无冲突。用户已通过整体视觉验收，并明确授权提交 PR、免本地双审；保留必要自查与验证。本文随 DS-9 交付，合并状态以 PR 为准。

## 实现与依据

- `chatChrome.ts` 为现有聊天组件提供正文/代码排版、图标动作、焦点和动效；`activityRowChrome.ts` 继续承接活动行。消费 DS-8 的标准尺度与原局部颜色，保留用户与助手各自的覆盖，不另建主题系统。
- MessageActionBar 统一图标按钮的胶囊框、Tip 和焦点，键盘进入时操作栏可见；保留普通任务/伙伴的动作集合、顺序与异步状态。Markdown 代码复制复用 Tip；图片和视频可以通过 Enter/Space 打开，关闭后焦点返回触发处；音频、音效、文件与预览动作共用呈现。
- Permission 先在实际组件中提供现状与候选，由用户正式选择“允许一次突出、保持中性、沿用当前密度”，再接标准 Button 并保留 `perm-allow-*` / `perm-code-*` / `chat-input-*`。长规则受列宽约束，键帽仍按既有规则；不发明风险等级。
- 正式依据：DESIGN §4 的 DS-9 条目、§5 可见层圆角、§14 交互与动效；design-decision-log 的 2026-09-11 决定；design-governance §10 / §12。本批未更改消息存储/协议、Diff 分析与虚拟滚动算法、媒体协议/存储、权限语义或生命周期、全局 Button 默认、插件基座或 Mobile。

## 证据与工程检查

图片、脚本与日志存于项目负责人桌面主计划目录的 `附件/DS-9/`，不入 Git，尚无公开附件 URL。真实组件受控样本与实际路由分别标注，不以样张代替整页或真实账号联调。

| 验证 | 结果与边界 |
| --- | --- |
| 首轮组件回归 | 5 文件 / 44 用例通过：消息操作、图片错误恢复和新增键盘打开、推理文本、Diff 横滚与完整内容预览 |
| 授权/主题/代码运行矩阵 | `runtime-matrix.json` 35 项通过；11 内置主题 × 常规字号/窄栏大字号，授权动作边界、按钮和键帽；提交禁用/失败恢复、快捷键载荷、推理展开记忆、工具内容；局部/全局/并存主题覆盖与自定义 radius |
| 真 Worker 与大段 Diff | 在同一 Electron 中比较基线原 DiffView 与候选：1,800 行源文本、3,600 行差异，真实 Worker 请求/回复，DOM 可见行约 48；冷/再次展开、横滚与代码字号上限均记录。时间是本机观测，不设虚构固定性能门槛 |
| 系统剪贴板 | 实际 copy 操作后核系统剪贴板；消息原文与 80,010 字工具预览完整复制，未将 DOM 截断视图当原文 |
| 实际聊天与跨入口 | `full-route.json` 7 项通过：实际 localDb 历史读取、流式追加时旧选区/节点保留、完成态落库后刷新重入，以及文件/Bots/自动化/设置路由。初始 62 条固定历史；流式走已有测试事件入口，不发起模型请求。空 Bots/自动化列表不能证明真实伙伴或调度运行通过 |
| 媒体与生成文件 | `media-runtime.json` 5 项通过：音乐/音效实际播放，图片/视频键盘预览，生成文件真实 stat/read 与 TextLightbox；`final-interactions.json` 再补图片/视频关闭焦点返回和 More 菜单键盘/鼠标 4 项。媒体用测试资源；远端下载与真实生成服务不由本地样本证明 |
| 必要工程门禁 | 最终 `pnpm test:unit:related` 退出 0：runner 529 pass / 1 存量 skip，Desktop 相关单测通过（27.7s）；Desktop / Token 类型检查、Token 生成新鲜度、49 surface inventory、颜色增量、i18n/术语与 `git diff --check` 均通过。日志在下方索引；用户原有 ui-showcase 颜色报告和 18 项既有 proposed 术语未改，不作为新增违规 |

## 测试入口与复核记录

安全包装启动的隔离实例 `CindyGlobal-dev2-ds9`，PID 91259，Global/passive，`pnpm desktop:whoami --all` 核对 source MATCH / ready。实际任务为 **DS-9 视觉测试 · 聊天与附件**（`b19330ce-d384-4ecc-956c-355cd9d99325`）。窗口顶部的临时测试栏提供聊天、授权、附件、四种亮暗主题和字号切换；授权按钮只记录受控选择。“收起测试栏”卸载样本并恢复内存主题/字号，实际任务仍在。此入口只从仓外 `visual-test-entry.js` 注入隔离 renderer，不属于产品 diff；刷新后可按同目录 `eval.cjs` 重新装载。

- 最终自动化与工程日志：`final-related-tests.log`、`final-desktop-typecheck.log`、`token-typecheck.log`、`generated-check.log`、`final-inventory.log`、`colors-check.log`、`i18n-check.log`、`glossary-check.log`。
- 实际运行：`runtime-matrix.json`、`media-runtime.json`、`full-route.json`、`final-interactions.json` 及同名脚本/日志；入口图片 `visual-entry-*.png`。在此记录的本机截图由执行者核对，用户已于 2026-09-11 明确反馈“整体没问题，视觉测试通过”，当前本地候选的用户视觉验收通过。
- 失败与修复：首轮 related 发现证据链接对应文件尚未创建，随后补齐；下一轮 MessageActionBar 的 Tip 测试替身漏传外层菜单的 ref/事件，改为保留真实 Tip 后，原菜单/焦点测试及最终 related 全通过。未删除或放宽原行为断言。媒体复核中一轮受到 HMR 刷新打断、另一轮错误等待已被 gallery 消费清除的临时标记，修正测试同步和观测点后 4 项实机补验通过，未为测试改媒体业务。
- 大段 Diff 对照脚本回放时会从记录的 Git 基线临时读取原 DiffView，退出后移除该文件；交付目录中没有基线组件或演练值。不得把样本截图、首次/再次展开的本机时间或上述受控事件解释为生产端到端与全平台结论。

## 用户视觉验收（2026-09-11）

用户明确反馈：“整体没问题，视觉测试通过。”据此记录 DS-9 当前本地候选的整体视觉验收通过。用户未逐项声明平台、主题和远端场景覆盖，不将此反馈扩展为下列未测项目通过；G2 独立贡献者试用与公开附件仍单独跟踪。该次反馈只授权更新验收记录；后续提交授权另见文首与 PR 说明。

## 范围、未验证项与交接

唯一 inventory 继续登记 49 个 surface（35 Desktop、14 Mobile）。聊天与授权仍登记为 pilot，用户已确认当前本地候选整体视觉验收通过，尚未合并；静态依赖和局部回归不将其它整页升级为 migrated。Cross-entry 的 owner / 下一动作均在 inventory 维护。

- Windows/Linux、实体 IME 与原生缩放/拖窗、真实远程伙伴/断线恢复、多账号与插件授权/独立宿主、实际 Orca/调度运行未由本地场景完整验证。保留上游回归，kirozeng 安排环境，Codex 复核；2026-09-17 或 DS-10 开工前复查。
- 图表日期命中替代方案仍待设计决定；本批没有改图表或加回已删除入口。G2 独立贡献者试用、历史 69 张图片公开及 DS-6/8 平台缺口继续交 DS-10，未记为通过。
- DS-10 承接成熟呈现/合法例外样本、现有检查与维护说明、G1—G4 桌面最终验收；Mobile 后续独立启动。工程交付不等于本期设计系统目标全部通过。

整批回退本次聊天/桌面授权呈现及对应测试、说明和台账；保留 DS-8 生成链和上游业务，不回写主题文件、凭证或用户数据。测试任务只在隔离的 `CindyGlobal-dev2-ds9` 内。

## 用户要求的单人代码自查与精简（2026-09-11）

用户要求“自己 review 一遍代码和文件结构，以及有没有冗余，代码简洁”。本轮由原执行者自查 DS-9 全部改动、共用样式消费者与实际依赖，没有运行本地双审。未发现需要重拆目录、新建业务层或阻断交付的功能问题；`chatChrome.ts` 保持无运行时依赖的薄样式模块，`activityRowChrome.ts` 保留原活动行职责，没有无引用导出。

精简 5 个产品文件：两种预览窗的六处工具栏按钮共用 lightbox 样式；移除被共用 disabled 规则覆盖的局部外观分支，实际 disabled 条件保留；合并文件卡片两种外框的重复样式，保留各自宽度；去掉重复 focus/transition/cursor 声明。未改变权限、媒体/文件生命周期或用户已验收的设计选择。Electron 核对有效启用/禁用状态的 opacity/cursor/transition/radius 与清理前一致，三种文件卡片经 cn 合并后的完整类名集合相同，结果存 `self-review-style-equivalence.json`。

最终 `pnpm test:unit:related`、Desktop typecheck、inventory 新鲜度与 `git diff --check` 通过（`self-review-related-final.log`、`self-review-typecheck.log`、`self-review-inventory-final.log`）。首轮检查发现去重复后自动台账统计过期，已由 `pnpm design:inventory` 更新后复跑通过；未弱化检查。用户此前视觉验收仍按当时反馈记录，本次精简另有等值验证，无新的用户复验声明。旧候选清单保留，自查阶段清单为仓外 `self-review-candidate-manifest.json`；当时未提交或推送，后续提交阶段另生成清单并保留此历史记录。

## 提交前验证（2026-09-11）

用户明确要求“提交 PR 吧，顺便把 commit message 写好，不用本地双审”。本次沿用单人自查，不把它记为独立双审通过。提交前将当前分支无冲突快进到主干 `f9ce362377fe81a39c216051b74b8c22fe08e702`，在包含 DS-9 的实际工作树验证，原视觉基线与截图保持历史原值。

- `pnpm test:unit:related` 通过：runner 529 pass / 1 存量 skip，Desktop 相关单测通过（31.5s）。
- Desktop、`@cindy/design-tokens` 和 Mobile typecheck 均通过；Mobile 为补充静态兼容检查，不表示手机视觉验收。
- Token `check:generated`、设计 inventory、颜色增量（`--worktree --base-ref f9ce362377`）、endpoints、i18n、brand terminology、glossary、迁移校验、scheduler guard、mobile scope 均通过；`git diff --check` 通过。
- 日志统一为仓外 `附件/DS-9/submit-*.log`；提交文件与 SHA-256 由 `submit-candidate-manifest.json` 绑定。只有 DS-9 的 31 个文件入本次提交，原有未跟踪目录不纳入。
- 本机 pr-autopilot 自动推送/盯梢部署仍引用其他用户目录，未使用该部署，也未生成虚构的审查共识、签名或注册成功回执。本次按已有明确授权走仓库原生 PR 流程；GitHub 检查结论以 PR 为准。截图仍待按治理 §6 人工上传 PR 附件，不声称公开证据已齐。

## PR 冲突与首轮 CI 跟进（2026-09-12）

草稿 [#4300](https://github.com/makecindy/cindy/pull/4300) 的首版 `c0830addf4` 已通过 verify-checks、Desktop Git integration 与 DCO，但全量 Linux/Windows 单测发现两项此前相关测试未选中的静态守卫失败；不得把提交前 related 通过解释成云端全绿。

- `typographyDiscipline`：DS-9 把既有代码字号变量和紧凑派生写法移到 `chatChrome.ts`，精确签名表仍指向原消费者。本次迁移相同签名到实际定义处，删除原文件过期登记并收紧剩余次数；不增加新字号、目录豁免或放宽扫描。
- `workGroupBlockInteraction`：旧断言在活动行文件中查找已抽出的动效字面量。本次导入真实样式常量，核活动行与共享动效同值、三角槽实际包含动效，并继续检查 duration/easing/reduced-motion。其它交互/几何断言保留。修复前两项失败可复现，修复后 2 文件 / 11 用例通过。
- Windows 首轮另有 Pi package lock 20 秒超时与浏览器 dialog 等待失败；对应 2 个测试文件在本机复跑 267 用例通过，未修改后端逻辑或放宽超时，Windows 结论仍以新 CI 为准。
- 同步主干 `98c2d8968617a5343de2d8fac912cc969775efa9`，唯一文本冲突位于 `design-inventory.md` 的生成区。主干人工决策区与共同基线一致，保留 DS-9 人工区后执行 `pnpm design:inventory`，按合并后源码重建统计；49 surfaces，未手选过期计数，也未覆盖主干新入口。
- 首轮扩大后的本机测试另发现区域环境不匹配：本地 `.env` 指定 `VITE_CINDY_AUTH_REGION=cn`，两组既有 Global 路径测试出现 9 个失败。显式设置 `VITE_CINDY_AUTH_REGION=global` 后，两文件 47 用例通过；不改本地配置文件、凭证或被测后端逻辑。
- 本轮产品呈现代码不变；使用带 DCO 的合并提交更新现有 PR，免本地双审的用户要求继续生效。截图公开与未测平台缺口保留。跟进日志存仓外 `附件/DS-9/followup-*.log`，原 CI 失败日志保留供追溯。

本轮最终提交前验证通过：`VITE_CINDY_AUTH_REGION=global pnpm test:unit:related` 退出 0，因主干共享包变化自动扩大为 Desktop 全量（149.3s）、Mobile 全量（22.9s）及相关共享包；runner 529 pass / 1 存量 skip。Desktop / Mobile / Token typecheck、Token 生成新鲜度、inventory、颜色增量、文档合同与 diff 检查均通过。明确使用 Global 测试身份仅限命令环境，不写回本地 `.env`。云端后续检查仍以 PR 最新 head 为准。
