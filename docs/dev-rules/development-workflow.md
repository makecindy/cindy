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
  worktree 内跑 `pnpm --filter desktop typecheck` / 定向 `vitest run`；**提交前仍须通过
  第 2 节的提交前测试门禁**。需要运行时验证时 commit + push 后交用户（你无法重启宿主）。
- **宿主 app 日志不在你的 cwd 下**：dev 日志在启动 checkout（通常是 baseRepo）的
  `apps/desktop/logs/`，读日志时拼 baseRepo 的绝对路径。
- **结束前必须 commit**：会话被删除或归档时脏 worktree 会先存内容快照再删目录。**PR
  merged／closed 不等于 Cindy 会话已结束**：只要 owning session 仍 active，任何外部 Git
  cleanup 都必须跳过该 `.cindy-worktrees` / `.xdt-worktrees` 目录与本地 `cindy/*` / `xdt/*` 分支，交给
  用户显式归档／删除会话时回收；禁止手动 `git worktree remove` 造成 active session 的 cwd
  悬空。手动干活时可放 `.worktree-keep` 哨兵文件豁免自动回收。
- **stale prebundle 白屏**：给带依赖的内部包新增 export 后，运行中实例可能因 stale Vite
  prebundle 报 `does not provide an export named X` 白屏——需要受影响实例完整重启
  （re-optimize），提醒用户即可，不要误诊为自己的代码问题。

## 2. 提 PR 与直推 `main`

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
- **提交前测试门禁（硬性要求）**：无论是提 PR 还是直接 commit，提交前都必须在本地跑完
  仓库根 `pnpm test:unit:related`（只跑这次改动能影响到的单测），并对本次改动涉及的每个
  package 跑 `pnpm --filter <包名> run --if-present typecheck`（`<包名>` 用该 package 在
  `package.json` 里的 `name`，如 `desktop`、`@cindy/maker-core`；没有 `typecheck`
  script 的 package 该步自动跳过），全部通过后才允许提交；任何一项失败都不得提交，
  必须先修复。worktree 会话内的 commit 同样适用。唯一例外是**防丢数据的兜底保存**：
  宿主删除／归档会话时自动存的内容快照（见第 1 节），以及会话必须收尾、测试却来不及
  修好时的收尾 commit——后者 commit message 必须标注 `WIP`，且在门禁通过前不得
  push、不得提 PR。
  - **相关单测怎么选**：`test:unit:related` 看相对 `main` 的已提交、已暂存、未暂存和未跟踪
    文件。同一包里用 Vitest `related` 只跑会引用这些文件的测试；改了会被别的包依赖的公共
    包源码时，依赖方跑该包自己的整包单测。只改文档等非代码文件则跳过 workspace 单测。
    改到测试调度（`scripts/test-workspaces*`、`scripts/test-related.mjs`、
    `scripts/test-gate-lock.mjs`）、`package.json`、`pnpm-lock.yaml`、
    `pnpm-workspace.yaml`、各包 `vitest.config.*`、单测 CI 工作流，或算不出 git 基准时，
    打印原因并退回全量 `pnpm test:unit`。批量改产品术语仍须全量，因为有测试直接锁中文文案。
    GitHub CI 不受此影响，仍跑完整 `pnpm test:unit`。
  - **完整单测的外层超时**：默认相关门禁通常比全仓短，但一旦退回全量，`pnpm test:unit`
    正常执行仍可能超过数分钟。调用全量门禁的 agent／自动化工具不得使用 120 秒或更短的
    绝对超时；未知当前耗时时，外层兜底超时至少设为 15 分钟。工具支持后台运行或 yielded
    process handle 时优先使用该模式并短轮询进度，不要因为调用端停止等待就误判失败、杀掉
    仍在正常运行的测试或重复启动一轮。Vitest 的单测试例超时仍由各 package 配置控制，不受
    这条外层约束影响。
  - **workspace 有界并行**：`test-workspaces.mjs` 默认最多并行
    `min(4, os.availableParallelism())` 个普通 workspace；每个普通 Vitest workspace 只使用
    1 个 worker。Mobile 使用完整的 4-worker 配额；Desktop 使用基准验证过的单池最多
    8-worker 配额，低于 8 CPU 时按 `os.availableParallelism()` 自动下调。重型 workspace
    必须独占执行，避免外层并发与内部 worker 池相乘。
    排查并发相关问题时可用
    `pnpm test:unit -- --workspace-concurrency=1` 临时退回 workspace 串行；该参数只改变
    workspace 调度，不减少测试覆盖。
  - **跨 worktree 重型门禁串行**：本地运行 `unit`、`all`、`db`、`git-integration`
    tier 时，`test-workspaces.mjs` 会按 Git common-dir 获取同仓共享的 loopback TCP 锁；
    同一 clone 的后到进程会打印持有者 PID、tier 与 worktree 路径并排队，不同 clone
    互不影响。`guard` tier 和 CI／GitHub Actions 不参与。等待超过 15 分钟以退出码 `75`
    结束，表示测试尚未运行，不得当作测试失败排查；排队是正常状态，不要 kill 后重跑。
    只有明确确认资源足够且需要有意重叠时，才可追加 `--no-lock` 作为逃生口。
  - **最终门禁必须绑定冻结快照**：准备提交或提 PR 时，先完成实现与用于快速反馈的定向测试；
    由 agent／自动化主持且已安排独立 review 的工作，还必须先将 review 的 P0／P1 清零。随后
    显式暂存完整待提交集合（包括新增文件），确认没有混入无关用户改动，并以 `git write-tree`
    生成的 index tree ID 冻结快照。最终有效的受影响 package typecheck、专项数据库门禁与根
    `pnpm test:unit` 必须在由该 tree（或由它生成的临时 commit）物化出的同一干净 checkout 中
    执行；冻结前跑过的同名检查只作为快速反馈，不能充当最终凭证。未跟踪但不属于本次提交的
    用户文件可以留在作者 worktree，但不得出现在门禁 checkout，也不得在不重跑门禁的情况下
    随后加入提交。门禁启动后，任何 `git add`／`git reset` 或 index tree ID 变化都会使旧结果
    立即失效。旧快照、无退出码、被调用端终止、只看到「暂无失败输出」都不算通过，唯一有效
    凭证是该 tree ID 的全部强制检查都取得退出码 `0`。通过后再次确认待提交 index tree ID 与
    受测 tree 一致；提交时不得使用会从工作树重新选取内容的 `-a`／`--all`、`--include`／
    `--only` 或 pathspec，只按已验证 index 执行 DCO commit。commit 后、push 前还必须以
    `git rev-parse "HEAD^{tree}"` 取得最终 commit tree 并与受测 tree 精确比对；提交命令或本地 hook
    导致不一致时不得 push，回到相应 review 与门禁阶段。普通 PR 仍可按仓库既有流程先提交，再
    接受 GitHub 自动 review；本条不为所有贡献者新增提交前独立 review 硬门。
  - **最终门禁环境要可复现且与产品故障分层**：同一批并行任务可将冻结快照依次物化到一个
    已验证、无已知路径污染的专用门禁 checkout，重型门禁严格串行，不让多个 agent／worktree
    同时争抢共享锁。复用该 checkout 已安装的依赖前，当前仓库的依赖指纹必须完全一致：根及
    所有 workspace 的 `package.json`、本地 `file:` 依赖 `apps/mobile/modules/**`、
    `pnpm-lock.yaml`、`pnpm-workspace.yaml`、根 `.npmrc`、`dependency-patches/**`，
    Node／pnpm 版本与平台／架构／libc，以及根 `postinstall` 当前调用的
    `scripts/ensure-agent-binaries.mjs`、`scripts/agent-binary-cdn-fallback.mjs`、
    `scripts/shared/client-endpoint-build-env.mjs`、`scripts/fix-node-pty-perms.mjs`、
    `tools/{claude,codex,ripgrep,pi}/update.mjs`、`tools/shared/**`、各
    `tools/<kind>/latest.json` 与 `config/endpoint*.json`；还要保持会改变 postinstall 结果的
    `XDT_SKIP_AGENT_BIN_INSTALL`、`XDT_CDN_BASE_URL`、`CINDY_AUTH_REGION`，以及上游下载所用的
    `XDT_AGENTBIN_CONNECT_TIMEOUT_MS`、`XDT_AGENTBIN_STALL_TIMEOUT_MS`、
    `XDT_AGENTBIN_TOTAL_TIMEOUT_MS`、`XDT_AGENTBIN_MIN_THROUGHPUT_BPS`、
    `XDT_AGENTBIN_THROUGHPUT_WINDOW_MS`，以及 GitHub 下载认证输入 `GITHUB_TOKEN` 的有无与有效
    权限上下文一致，并确认已安装 runtime 的版本标记与对应 pin 相符。认证输入只能在进程内核验
    等价上下文，不得把 token 原文、可复用摘要或其他秘密写入指纹、日志或仓库。任一输入变化、
    无法在不泄密的前提下证明一致，或 runtime 状态无法验证，都必须重新执行
    `pnpm install`，不得复用现有 `node_modules`。普通独立 worktree 仍遵守第 1 节的独立安装
    原则。安装或运行异常必须记录它发生在
    测试启动前、fixture／worker 启动期还是断言阶段；只有取得指向具体外部原因的环境归因证据
    （如明确的外部下载失败、共享锁 holder 或资源耗尽记录）时，才能标为基础设施故障。失败用例
    在同一冻结快照的隔离复核中通过，只是继续调查顺序依赖、共享状态泄漏或环境问题的线索，
    不能单独作为基础设施归因。`beforeAll` 超时、SQLite `database is locked` 等无法证明来自环境
    的问题，仍按产品／测试失败处理。基础设施失败不得用定向测试替代根门禁；修复环境后只重跑
    冻结的最终快照，避免在尚未收口的中间版本上反复消耗全量门禁。
  - **终止外层命令后先核验进程树与锁**：调用工具返回 terminated／timeout 不等于 pnpm、
    runner 与 Vitest 子进程都已退出。不得看到外层结束就立即重跑；先按输出中的 holder PID
    和 worktree 路径核对进程树与共享锁，确认没有本任务遗留的 runner／worker 后再启动下一轮。
    若遗留进程仍在推进，应继续等待或只终止经过路径与 PID 校验的本任务进程；不得按模糊进程名
    批量结束，以免杀掉其它 agent／worktree 的测试。
- **在门禁之上按风险追加验证**：跨模块、高风险或基础设施改动追加更广泛验证（如仓库根
  `pnpm test:all`），**最终以 CI 门禁为准**。不得通过 skip、删除或弱化测试制造通过；
  PR「怎么验证的」一节必须**如实**填写，没跑不许写已跑。
- **直推 `main` 的额外门禁**：push 前由独立 reviewer 对最终 diff 做一次对抗性 review，对照
  `docs/` 下规则找实际问题；发现 P0／P1 必须先修复并重新 review，直到没有 P0／P1。commit
  可以先创建，但 push 的必须是 review 通过的最终 commit。

## 3. Review 严重度口径

对照 `docs/` 下各规则与 `.github/PULL_REQUEST_TEMPLATE.md`（以现行内容为准，不凭记忆）：

- **P0**（不改不能合）：红线／崩溃／数据丢失／跨平台失效／安全。
- **P1**（本次必须修但不阻断流程）：明显 bug／规范违反／影响面没处理干净。
- **P2**（可选优化 / 风格偏好）：不报。

发现 P0／P1 必须先修复再合入或推送。
