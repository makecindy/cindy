# Cindy 管理的 Pi project trust 契约（#2013）

本文件定义 PR4（#2014）可消费的输入/输出契约；本 Issue 不改变 Pi 运行时行为。

## 真源与生命周期

- trust 输入只能来自 Cindy 已有、可审计的项目 approval。当前 `origin/main` 尚未提供通用 project approval store，因此实现必须通过 host 注入 `PiProjectApprovalSnapshot`，不得把 `permissionMode`、工具审批、MCP approval、插件启用状态或 Pi 用户设置解释为项目 trust。
- approval 在新建、重启、fork 或切换到新 `workingDir` 时重新求值；一个运行中的 Pi 进程使用启动时快照。撤销或失效对下一次新会话生效，不声称热卸载已加载资源。
- `workingDir` 与 git repo root 必须先做 `realpath`/规范化，host 必须同时提供可信的 `platform`（`posix` / `win32`），不得从路径字符串猜测或缺省为 POSIX。POSIX canonical bytes 只有能无损往返 UTF-8 时才可标记 `utf8-lossless`；Windows canonical path 只有能无损往返 host Unicode string 时才可标记 `utf16-lossless`。编码标记与平台不匹配、含替换字符或无法证明无损时必须标记 `unavailable`，不得用有损字符串生成 approval key。解析失败、目录消失、repo 边界变化、symlink 指向变化均 fail closed。默认作用域是 `repo-root + workingDir`；只有 approval 明确声明 `repo-root` 才能让同一仓库的多个 workingDir 共享批准。`extraDirs`、引用目录和其他 workspace root 不继承。
- 当前纯函数只在 host 明确提供 `windowsCaseComparison: ordinal-insensitive` 时对 ASCII Windows canonical path 做比较 key 的分隔符、扩展长度前缀和大小写归一化；若 host 报告 `case-sensitive`，则保留 comparison key 大小写；缺省、`unavailable` 或无法证明比较语义时统一 fail closed。比较 key 归一化不得覆盖 host 提供的 canonical I/O path，eligible 输出必须保留扩展长度前缀及尾随空格/点。`ordinal-insensitive` 下的非 ASCII Windows path 因 JavaScript Unicode folding 不等同于 Win32 ordinal comparison，也必须 fail closed 为 `unavailable`，直到 host 提供独立的 Win32 comparison identity。
- `projectKey` 为 `${canonicalRepoRoot}\0${canonicalWorkingDir}`；Windows 比较身份决定是否折叠大小写，分隔符始终归一化。approval 的 `scopeKey` 对 `repo-root` 是 canonical root，对 `working-dir` 是同样的复合 key。

## 状态与资源边界

纯函数输出的状态只有 `approved`、`unapproved`、`revoked`、`stale`、`unavailable`。文件存在或 scanner 命中只能形成资源 `discovered`，不能宣称 Pi `loaded`；`loaded` 只能由 #2011 的 `get_commands` runtime manifest 证明。

批准决策只产生 PR4 的候选输入：

- `skills`：只有调用方显式证明 `explicitSkills: true`，且在新增的 `canonicalSkillEvidence` 中为每条发现路径提供 exact `discoveredPath`/`canonicalPath` 配对的 1:1 realpath 证据并验证 canonical path 位于批准 repo root 内时，才可用单独 skill 路径装配；旧的 `canonicalSkills` 字符串数组仅为兼容保留，不能单独构成资格证据。host 必须先从 `discovered.skills` 中排除 user、`extraDirs`、引用目录和其他 workspace root，canonical evidence 不能替代该 provenance 过滤。缺少证据、配对不一致、仓库外 symlink 目标或非 canonical 路径时保持 `discovered`。eligible 输出保留 canonical I/O path，不使用 comparison key 替代。能力位只有严格的布尔 `true` 才生效，缺省或其他 truthy 值均为 false。它不代表 Pi 已经 `loaded` 这些资源；
- `settings`：只有经字段白名单投影（输出 `settingsProjection.values`）、为每条发现路径提供带 exact `discoveredPath`/`canonicalPath` 配对的 1:1 realpath evidence 并验证 canonical path 位于批准 repo root 内，且同时证明 packages/extensions 关闭时才可装配；`settingsProjection.sourcePath` 必须是 `discovered.settings` 中的原始 lexical path，成功后输出才改写为对应 canonical I/O path。缺少 evidence、配对不一致、仓库外 symlink 目标或非 canonical 路径时保持 `discovered`。本契约默认不允许原始 `.pi/settings.json`。当前白名单只允许 pinned Pi v0.83.0 的 `compaction.reserveTokens` / `compaction.keepRecentTokens` 非负安全整数；未知字段、未来新增字段、`defaultProjectTrust`、provider/auth、路径及资源加载配置均 fail closed。输出是深克隆并冻结的启动快照；`eligibleSettingsPaths` 仅为兼容字段，包含投影使用的 canonical `sourcePath`，不能把发现到的原始 settings 路径当作可装配输入；空投影保持 `discovered`。
- `packages` / `extensions`：始终 `discovered` 或 `blocked`，不得安装、加载或执行。

## 启动与隔离不变量

- 不传 `--approve`，不写用户 `~/.pi/agent/trust.json`，不设置 `defaultProjectTrust=always`；trust.json、`defaultProjectTrust` 或等效配置的装配属于 #2014。
- 不写或复用整个用户 `~/.pi/agent`，不继承 auth/provider/settings/trust/凭证。每会话 `PI_CODING_AGENT_DIR` 隔离、临时目录和并发 session 输入隔离保持不变。
- `launch` 输出固定为 `approve:false`、`writeTrustJson:false`、`inheritUserPiHome:false`、`allowPackages:false`、`allowExtensions:false`。纯函数不读配置、不写文件、不启动 Pi。
- 如果 Pi 无法同时做到“信任 skills/settings 但阻止 packages/extensions”，#2014 必须缩小为显式 skills-only，或阻断项目 settings；不得用 `--approve` 绕过。

## 与既有边界对照

- #1729：只允许 Cindy 已批准项目映射；禁止无条件 `--approve`、复用整个用户 Pi 目录与默认开放 packages/extensions。
- #1705：packages/extensions 在非 TUI 宿主下的执行与呈现契约仍未解决；本契约不重开该范围。
- #1967：隔离 `PI_CODING_AGENT_DIR` 是有意的并发/凭证边界；本契约不通过复制或链接用户 Pi home 规避隔离。
- #2030：以 Pi v0.83.0 `get_commands` 夹具作为资源发现事实基线；#2053/#2011 的 manifest 类型合入后，只需复核字段接线，不复制其未合入类型。
