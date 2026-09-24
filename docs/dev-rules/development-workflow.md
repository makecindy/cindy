# 开发工作流：worktree、提 PR 与 Review

> **状态**：权威开发规则（authoritative）
> **读取时机**：在 Cindy 内嵌的 worktree 会话里工作、准备提交或直推、或做 code review
> 之前

本文细化根 [`../../AGENTS.md`](../../AGENTS.md) 的「通用工作流程」「Git 与交付」两节，补上
worktree 会话契约、直推 `main` 的额外门禁与 review 严重度口径，不重复根文件已有的通用
流程。

## 1. Dogfooding：在本仓 worktree 会话里工作

如果你是 Cindy 内嵌的 agent，且 cwd 位于 `<baseRepo>/.cindy-worktrees/<name>`（或迁移前的
`.xdt-worktrees/<name>`）下（会话级 git worktree），遵守以下契约：

- **先等 checkout 完成再确认依赖**：worktree 创建返回时后台完整 checkout 可能仍在进行；
  跑任何 `pnpm` 命令前先确认 `package.json` 存在且 `git status` 干净。worktree 与 baseRepo
  共享 `.git` 但**不共享 `node_modules`**，缺失就先 `pnpm install`（首次可能数分钟，注意
  命令超时）。
- **你的编辑对运行中的 app 无效**：Vite HMR 只 watch 启动 dev 实例的那个 checkout，
  worktree 下的改动既不热更也不随重启生效。「改了没反应」不是 bug。开发过程中的增量验证在本
  worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；**提交前仍须完成
  第 2 节的提交前验证**。需要运行时验证时 commit + push 后交用户（你无法重启宿主）。
- **宿主 app 日志不在你的 cwd 下**：dev 日志在启动 checkout（通常是 baseRepo）的
  `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
- **会话结束与工作区保留**：是否 commit 由用户或宿主工作流决定，不能仅因会话结束
  强制提交。会话被删除或归档时脏 worktree 会先存内容快照再删目录。**PR
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
    对所属包及受影响依赖方跑整包；纯文档不触发根级 runner 或业务单测。
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
