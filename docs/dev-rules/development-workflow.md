# 开发工作流：worktree、提 PR 与 Review

> **状态**：权威开发规则（authoritative）
> **读取时机**：在 Cindy 内嵌的 worktree 会话里工作、准备提交或直推、做 code review，
> 或决定开发中得到的知识该写到哪里之前

本文细化根 [`../../AGENTS.md`](../../AGENTS.md) 的「通用工作流程」「Git 与交付」两节，补上
worktree 会话契约、直推 `main` 的额外门禁、review 严重度口径与项目知识归属，不重复根文件
已有的通用流程。

## 1. Dogfooding：在本仓 worktree 会话里工作

Cindy 创建或重建托管 worktree 时，会尽力向 Git 本地 `info/exclude` 追加所用托管目录的
根级排除规则，避免基础仓库的未跟踪扫描进入这些目录。保留已有规则，不修改项目
`.gitignore`，不影响已跟踪文件；写入失败不阻止创建或恢复。不扫描、排除任意第三方目录。
实现见 `apps/desktop/src/main/worktree/managedWorktreeExclude.ts`。

如果你是 Cindy 内嵌的 agent，且 cwd 位于 `<baseRepo>/.cindy-worktrees/<name>`（或迁移前的
`.xdt-worktrees/<name>`）下（会话级 git worktree），遵守以下契约：

- **先等 checkout 完成再确认依赖**：worktree 创建返回时后台完整 checkout 可能仍在进行；
  跑任何 `pnpm` 命令前先确认 `package.json` 存在且 `git status` 干净。worktree 与 baseRepo
  共享 `.git` 但**不共享 `node_modules`**，缺失就先 `pnpm install`（首次可能数分钟，注意
  命令超时）。
- **你的编辑对运行中的 app 无效**：Vite HMR 只 watch 启动 dev 实例的那个 checkout，
  worktree 下的改动既不热更也不随重启生效。「改了没反应」不是 bug。开发过程中的增量验证在本
  worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；**提交前仍须完成
  第 2 节的提交前验证**。需要运行时验证时，在本 worktree 用
  `pnpm restart:desktop:remote -- --isolated=@worktree` 起一个属于本 worktree 的独立实例
  （不会停掉宿主，也不与其他 checkout 抢默认 `dev` 沙箱），成功以
  `DESKTOP_DEV_VERDICT=ready` 为准，细则见 [`desktop-development.md`](desktop-development.md)。
- **宿主 app 日志不在你的 cwd 下**：dev 日志在启动 checkout（通常是 baseRepo）的
  `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
- **会话结束与工作区保留**：是否 commit 由用户或宿主工作流决定，不能仅因会话结束
  强制提交。会话被删除或归档时脏 worktree 会先把改动和新文件存进 Git 快照再删目录；
  被 `.gitignore` 忽略的文件（依赖、构建产物）和 worktree 内克隆／初始化的嵌套仓库不保留。**PR
  merged／closed 不等于 Cindy 会话已结束**：只要 owning session 仍 active，任何外部 Git
  cleanup 都必须跳过该 `.cindy-worktrees` / `.xdt-worktrees` 目录与本地 `cindy/*` / `xdt/*` 分支，交给
  用户显式归档／删除会话时回收；禁止手动 `git worktree remove` 造成 active session 的 cwd
  悬空。手动干活时可放 `.worktree-keep` 哨兵文件豁免自动回收。
- **stale prebundle 白屏**：给带依赖的内部包新增 export 后，运行中实例可能因 stale Vite
  prebundle 报 `does not provide an export named X` 白屏——需要受影响实例完整重启
  （re-optimize），提醒用户即可，不要误诊为自己的代码问题。

## 2. 提 PR 与直推 `main`

### 托管 worktree 不可用时的任务连续性

本机任务发送前优先按原分支和快照恢复托管 worktree。仅在确认目录缺失、且成功枚举
Git 引用后确认原分支不存在时，使用当前 owner 的
托管对话目录继续运行，保留数据库里的项目工作目录和 worktree 绑定；备用目录按任务 ID
与原工作目录的哈希定位。重启后重新优先恢复原 worktree；仍失败则复用同一备用目录，
不搬运或删除其中的文件。DB / Git 临时错误、绑定不匹配与快照冲突保留原目录重试，
不登记备用目录。同一运行期不自动切回。明确换到另一工作目录时不复用旧绑定
的备用目录。原地重建普通目录的现有行为保持不变，不把失败的 Git
worktree 建成空目录或自动切到项目根继续修改代码。

恢复说明随本轮消息传给 Agent，明确原路径、文件未恢复和当前运行位置；消息被接受
之后才消费说明。SSH 不使用本机备用目录；设备互联和手机沿用被控 Desktop 的发送链。
实现见 `apps/desktop/src/main/maker-ipc/workingDirectoryRecovery.ts` 与 `register.ts`，
回归见 `workingDirectoryRecovery.test.ts` 和 `makerSendTransaction.test.ts`。

### 提交门禁

- 本仓默认 **PR-first**：代码和文档通常从非默认分支通过 PR 进入 `main`；直推 `main` 只由
  具备 bypass 权限的维护者明确选择，并执行本节的额外门禁。
- PR 的 Title／Description 以 [`../../.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)
  为准（这次改了什么／怎么验证的／风险）；涉及 SQLite migration、system prompt、协议、
  原生层或跨平台差异时必须在「风险」里说明；涉及 UI 时必须在「UI 变化」注明引用的
  设计规范章节与约束（正本为 `docs/design-rules/DESIGN.md`）。CI 的
  `pr-design-basis` 会在 PR 变更命中 UI 路径时轻校验该字段（非空、引用了
  design-rules 文档，或「不涉及：<理由>」豁免；判定逻辑见
  `scripts/check-pr-design-basis.mjs`），但通过 CI 不代表内容合格，质量仍由
  review 把关。Reviewer 只看 Title + Description 决定要不要 review，写不清直接退回。
- **DCO 签名门禁（硬性要求）**：每个 commit 都必须带 `Signed-off-by` trailer，其中的名字
  与邮箱都要与 commit 的 author（或 committer）一致——`git commit -s`，或先跑一次
  `pnpm dco:install-hook` 装上 hook 让后续提交自动补签（正本 `.githooks/prepare-commit-msg`；
  `git commit` 本身没有自动签名的配置项，`format.signOff` 只作用于 `git format-patch` /
  `git am`）。这条对 agent 自动提交、worktree 会话内的收尾 commit 一律适用。
  - PR 上的权威门禁是 **DCO GitHub App** 的 check：它校验该 PR 的每个 commit，豁免
    merge 与 bot，不追溯历史；`.github/dco.yml` 开了 remediation commit，因此漏签也可以
    不改写历史（格式见 `CONTRIBUTING.md`）。
  - 提交前自查用 `pnpm check:dco`（`scripts/check-dco.mjs`，范围 `merge-base..head`）。
    它的判定刻意对齐 App 但**不识别 remediation commit**：本地通过则 App 必过，反之不然。
    改这个脚本时不要放宽 name／邮箱比对，否则会出现「本地绿、PR 红」。
  - 漏签不要重新造一份提交：用 `git commit --amend -s --no-edit` 或
    `git rebase --signoff <base>` 补签后 `git push --force-with-lease`。
- **提交前验证**：提交前完成与改动影响面匹配的测试，并对涉及的每个 package 运行
  `pnpm --filter <包名> run --if-present typecheck`。默认可用仓库根
  `pnpm test:unit:related` 选测；已经完成等效的定向测试与类型检查时，无须为每次 commit
  再跑一遍整仓。文档改动运行 `pnpm check:dev-docs` 等适用检查即可，不要求无关业务单测。
  - **验证目标与本机执行方式分开**：用户或宿主决定本机资源预算、并发、执行时机和是否
    跨任务排队。仓库默认值不能覆盖这些选择，也不授权启动额外测试进程、终止其它任务或
    把一次机器过载经验升级为所有贡献者的固定限制。
  - **如实记录结果**：本次改动导致的失败须修复；既有或环境故障说明证据、影响和未完成项，
    不伪造通过、不删除或放宽有效断言。需要保存未完成工作时可作 WIP commit。完整测试与
    远端必需检查仍由 CI 和合并规则保障，本地定向验证不能冒充完整 CI 通过。
  - **相关单测怎么选**：`test:unit:related` 优先使用 `upstream` 默认分支（含
    `upstream/main` / `upstream/master`），其次 `origin` 默认分支，最后才回退本地
    `main` / `master`，避免落后的个人 fork 扩大测试范围；运行前应先更新目标分支引用。
    选测包含已提交、已暂存、未暂存和未跟踪文件。同一包源码通过 Vitest `related` 选测；
    公共包源码变化时，依赖方跑整包单测。包内 `package.json`、Vitest 配置或删除文件时，
    对所属包及受影响依赖方跑整包；说明性文档不触发根级 runner 或业务单测。
    `i18n/GLOSSARY.md` 与 `docs/legal/notices/` 是有内容断言的生成产物，仍运行根级
    runner 验证，不能仅因扩展名是 Markdown／文本而跳过。
    测试调度脚本、根依赖清单／锁文件、workspace 配置、根 Vitest 配置或无法确定 Git 基准
    时仍保守选择完整单测；普通 workflow 变化只触发根级 runner 校验。
    若选测范围超出本机预算，按真实影响面执行并记录定向验证，把完整门禁交给 CI，
    不因选测器的保守回退强制占满本机。
  - **单次运行的并发默认值**：workspace runner 默认最多并行
    `min(4, os.availableParallelism())` 个普通 workspace，每个普通 Vitest workspace
    使用 1 个 worker；Mobile 使用 4 个 worker，Desktop 最多 8 个且随可用 CPU 下调。
    重型 workspace 在本次 runner 内独占；这些边界不限制其它 session。
    可用 `--workspace-concurrency=1` 调低同一次运行的 workspace 并发；需要不同 worker
    配额时，可直接调用目标包 Vitest 的 `--maxWorkers` 参数。
  - **跨 worktree 排队默认关闭**：只有主动传 `--lock` 的本地重型测试命令才参与同仓共享
    loopback TCP 锁。`--no-lock` 保留兼容，不能与 `--lock` 同时使用。直接运行 Desktop
    Vitest 也不再隐式加第二层锁。选择排队后，等待超过 15 分钟以退出码 `75` 结束，表示
    测试尚未执行；`guard` 和 CI 不参与。锁只协调同样选择 `--lock` 的进程，不能管理
    未选择排队的任务；有意统一预算时由使用者或宿主协调各入口。
  - **长测试调用**：耗时不确定的检查优先后台运行并保留进度。工具结束等待不等于测试失败，
    不因等待时间较长重复启动或终止仍在正常运行的测试；外层超时按选定范围和本机情况设置。
- **按风险追加验证**：跨模块、高风险或基础设施改动追加更广泛验证（如仓库根
  `pnpm test:all`），**最终以 CI 门禁为准**。不得通过 skip、删除或弱化测试制造通过；
  PR「怎么验证的」一节必须**如实**填写，没跑不许写已跑。
- **直推 `main` 的额外门禁**：push 前由独立 reviewer 对最终 diff 做一次对抗性 review，对照
  `docs/` 下规则找实际问题；发现 P0／P1 必须先修复并重新 review，直到没有 P0／P1。commit
  可以先创建，但 push 的必须是 review 通过的最终 commit。

### CodeQL 扫描范围与启用

`.github/codeql/codeql-config.yml` 保留默认安全查询，仅排除 Desktop、Mobile 和共享包的
独立 `*.test.ts` / `*.test.tsx` 模块及不发布的 `docs/design-previews`。不排除整个
`__tests__` / fixture / mock 目录：辅助模块可能被运行时代码引用。构建／安装脚本、vendor、
生成的运行时资源（包括 Mobile 富内容资源）仍在扫描范围内。测试执行范围不受此配置影响。

修改排除项前检查文件身份、生产导入及打包入口；不能按目录名字或体积直接排除。
在相同源码、CodeQL 版本、查询集与 runner 上对比基线和候选：确认未减少生产提取文件，
解释告警差异，并记录分析耗时、数据库大小。源码字节数的下降不能充当数据库缩小的证据。

本仓使用 CodeQL default setup。配置文件合并本身不会启用它；完成上述验证后，仅为本仓设置
`github-codeql-config-file` 属性为 `.github/codeql/codeql-config.yml`，不要设置组织级默认值，
也不必切换 advanced setup。属性需先在组织中声明为 Text 类型且不设置默认值。
首次默认分支扫描后确认配置实际载入、数据库是否低于当时 action 的 overlay 上传上限，
再由后续 PR 扫描确认缓存命中。回滚时清除本仓属性值并重新扫描，恢复原提取范围；
不要关闭 CodeQL、删查询或减少扫描语言。

参考：[GitHub default setup 配置文件](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/edit-default-setup#customizing-default-setup-with-a-configuration-file)、
[仓库属性](https://docs.github.com/en/code-security/concepts/code-scanning/repository-properties)。

## 3. Review 严重度口径

对照 `docs/` 下各规则与 `.github/PULL_REQUEST_TEMPLATE.md`（以现行内容为准，不凭记忆）：

- **核对受影响的文档**：改动改变已有行为时，结合实现和测试核对对应权威文档中的旧结论；
  发现冲突就在本次改动中修正，并在相关说明旁链接实现或测试，便于后续核对。不涉及文档
  变化的 PR 无需修改文档，也无需另写经验总结。
- **经验回写到已有依据**：纠正和排障发现说明错误或不完整时修原文；说明正确但入口遗漏时
  补入口或触发条件；能自动验证的问题优先补回归测试。一次环境故障不默认升级为长期规则。

- **P0**（不改不能合）：红线／崩溃／数据丢失／跨平台失效／安全。
- **P1**（本次必须修但不阻断流程）：明显 bug／规范违反／影响面没处理干净。
- **P2**（可选优化 / 风格偏好）：不报。

发现 P0／P1 必须先修复再合入或推送。

## 4. 项目知识放在哪里

另一位贡献者，或另一台机器上的 Agent，接手时需要知道的信息，默认属于仓库。仓库是这些信息
的维护入口；个人记忆、全局 Skill 和聊天可以指向它，不能是唯一存放处。本节只针对开发过程中
的工作知识，与 Cindy 产品自身的记忆功能无关。

| 信息 | 维护位置 |
| --- | --- |
| 实现约束、固定输入、自动判定 | 代码、配置与测试；能机判的同时落到 lint、测试或契约脚本 |
| 工程规则、环境与工具链的坑、排错结论 | `docs/dev-rules/` 对应专题；单模块的放嵌套 `AGENTS.md`；根 `AGENTS.md` 只留触发条件 |
| 产品行为裁决与理由 | `docs/product-rules/` 对应专题；跨专题的放 `core-product-principles.md` |
| 视觉、交互裁决与理由 | `docs/design-rules/`；带日期的取舍记进 `design-decision-log.md` |
| 已发生的回归、复现与验证证据 | 对应测试；任务体验类归 `docs/dev-rules/session-regressions.md`；大图和录屏挂到 issue 或 PR |
| 未完成的改进 | issue 或计划文档，写明缺口与验收条件，不只记在个人待办 |
| 个人目录、设备标识、账号偏好、凭据、私聊原文 | 本地；仓库只放脱敏后的结论 |

从聊天或本机排错里提炼时，去掉身份、绝对路径和凭据，保留可复现条件、根因、处理办法、验证
范围与仓库入口。写入前对照代码和现有文档核实现状，不把已经过期的个人记忆原样搬进来。同一条
规则只在一处维护正文，其他位置引用。

本节回答「写到哪里」，不新增「每个 PR 都要写文档」的义务：是否需要回写仍按第 3 节「核对受影响
的文档」「经验回写到已有依据」判断。
