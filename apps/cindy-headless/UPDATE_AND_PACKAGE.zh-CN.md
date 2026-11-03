# Cindy Headless 同步与正式出包手册

本文用于从用户已经更新完毕的本地 Cindy 仓库中识别产品变化、同步 Headless 能力，
并直接生成可上传的 Linux x64 formal bundle。执行者可以是开发者，也可以是读取本文
后操作仓库的 AI。

Headless 必须保留在完整 Cindy checkout 的 `apps/cindy-headless` 中，因为构建会直接
读取 `packages/maker-core`、MCP 契约和 Desktop 的共享 prompt 源。不要把该目录单独
复制到一个脱离 Cindy 的空仓库中构建。

## 1. 版本与同步基线

Headless 记录两个不同版本：

| 字段 | 位置 | 含义 |
|---|---|---|
| Headless 版本 | `apps/cindy-headless/package.json.version` | Headless CLI、Profile 和 artifact 契约版本 |
| Cindy 同步基线 | `apps/cindy-headless/package.json.cindyUpstreamCommit` | 上一次完成 Headless 适配的 Cindy 产品代码 commit |

`cindyUpstreamCommit` 是快速检测 Cindy diff 的唯一机器可读游标，必须是完整 40 位
Git SHA。不要只记录分支名、日期或语义版本；它们不能唯一标识源码。发布说明可以
额外记录 Cindy tag，但 commit SHA 才是构建与审计依据。

bundle manifest 还记录构建时整个 checkout 的 `cindyCommit`、Headless 版本、dirty
状态，以及 CLI、prompt、profile、lockfile 和 binary 摘要。因此不需要再创建第二份
容易漂移的“上次同步版本”文件。

## 2. 准备用户的 Cindy checkout

用户可以在任意本地功能分支操作，不要求先合并或 push。在仓库根目录执行：

```powershell
$headlessPackage = Get-Content apps/cindy-headless/package.json | ConvertFrom-Json
$oldCindy = $headlessPackage.cindyUpstreamCommit
$newCindy = git rev-parse HEAD

git status --short
git branch --show-current
git show -s --format='%H %cI %s' $oldCindy
git show -s --format='%H %cI %s' $newCindy
node --version
pnpm --version
```

前置要求：

- Node.js 22 或更高版本；
- `oldCindy` 和 `newCindy` 都能由 Git 解析；
- 明确当前未提交修改属于谁，不得 reset、checkout 或覆盖用户文件；
- `apps/cindy-headless`、`packages/maker-core`、Desktop prompt 源存在；
- 已执行 `pnpm install --frozen-lockfile`，或已审查用户主动更新的 lockfile；
- 构建机器能取得锁定版本的 Linux x64 Node、Claude Code、Codex 和完整 Pi runtime。

如果 Cindy 新功能尚未提交，先创建本地 checkpoint commit。它不需要推送：

```powershell
git add <本次已审查的-Cindy-文件>
git commit -s -m "feat: checkpoint Cindy changes for Headless sync"
$newCindy = git rev-parse HEAD
```

不要使用 `git add -A`，避免把其他工作一并提交。

## 3. 生成 Cindy 更新清单

先确认提交关系。如果旧基线不是新提交的祖先，通常表示 rebase、切错分支或基线填写
错误，不能直接继续：

```powershell
git merge-base --is-ancestor $oldCindy $newCindy
if ($LASTEXITCODE -ne 0) {
  throw '旧 Cindy 基线不是当前 Cindy 的祖先，请确认分支或使用 merge-base 人工审计'
}
```

生成提交和文件总览：

```powershell
git log --oneline --decorate $oldCindy..$newCindy
git diff --stat $oldCindy..$newCindy
git diff --name-status $oldCindy..$newCindy > cindy-headless-sync-files.txt
```

再按影响面分组检查：

```powershell
# Agent API、事件、usage、compaction、模型和运行行为
git diff $oldCindy..$newCindy -- packages/maker-core/src/agents

# Memory、MCP、project context 和共享协议
git diff $oldCindy..$newCindy -- `
  packages/maker-core/src/memory `
  packages/maker-core/src/mcp `
  packages/mcps

# Headless 使用的 Desktop prompt 与 host 编排线索
git diff $oldCindy..$newCindy -- apps/desktop/src/main/maker-host

# Harness binary 版本、下载地址和 SHA256
git diff $oldCindy..$newCindy -- tools/claude tools/codex tools/pi

# 依赖和 workspace 契约
git diff $oldCindy..$newCindy -- package.json pnpm-lock.yaml pnpm-workspace.yaml
```

路径可能随 Cindy 演进变化。如果路径不存在或 diff 为空，用符号搜索继续定位：

```powershell
rg -n "AgentEvent|Usage|compaction|projectContext|makerMemory|nativeMemory" `
  packages apps/desktop/src/main
rg -n "system-prompt|Mcp|attachment|provider|contextLimit|effort" `
  packages apps/desktop/src/main
```

审计记录至少包含：commit、变更文件、相关符号、Headless 分类、修改位置和测试。临时
`cindy-headless-sync-files.txt` 在审计结束后删除，不应提交。

## 4. 判断哪些内容进入 Headless

不要按“文件位于 Desktop”机械判断。应按能力能否在无 UI、无人值守容器中表达判断。

### 直接同步或适配

- Agent 构造参数、生命周期、事件和 terminal status；
- 模型/provider/effort/context limit 与 compaction；
- token、cache、cost 和错误分类；
- Maker Memory、MCP、project context；
- Claude Code、Codex、Pi 的启动和协议；
- 系统 prompt 的产品行为约束；
- attachment、Skills、remote MCP 等可冻结的非交互能力。

Headless 应直接调用更新后的 `maker-core` API，不要复制一套 core 实现。

### 提取语义后适配

以下内容可能位于 Desktop，但不能直接丢弃：共享系统 prompt；UI 操作最终传给 Agent
的配置、模型或权限；影响 Agent 行为的默认值；Desktop 组装的 Memory、MCP 或
project-context 输入。

只提取“最终传给 Agent 的数据和规则”，在 Profile/Headless host 中用确定、可冻结、
无交互的形式表达。不要复制 Electron IPC、React state 或窗口生命周期。

### 直接剔除

- React 页面、窗口、面板、菜单、托盘和通知；
- Electron IPC、渲染进程状态和 OS UI 权限向导；
- 登录界面、OAuth 弹窗、更新器和埋点展示；
- 手机、语音、媒体预览和人工确认交互；
- 仅用于展示且不改变 Agent 输入或执行的格式化逻辑。

剔除不等于忘记。若它被视为 Cindy 功能，应在 `CINDY_FEATURE_PARITY.md` 的
Desktop-only 区域记录原因。

### 分类结论

| 分类 | 判断 | 操作 |
|---|---|---|
| `COMPATIBLE` | 现有 Headless 已覆盖，契约不变 | 更新基线并回归测试 |
| `HEADLESS_UPDATE` | 可无 UI 使用，但 Headless 尚未暴露或记录 | 修改 Headless 并添加测试 |
| `ADAPTER_UPDATE` | 启动参数、挂载、环境变量或 artifact schema 变化 | 同步 Adapter 后才能跑测 |
| `UNSUPPORTED` | 无法脱离 UI、账号、设备或人工批准 | 不实现，记录限制 |

每次更新 Cindy 都必须扫描源码差异、判断 Headless 影响并更新 parity；但 Cindy 新增功能
不会因此自动注册或出现在上传服务。只有维护者明确决定将其作为跑测变量，并同时满足
以下条件时，才成为网页可选择能力：

1. Headless 能开启或关闭；
2. Profile schema 能表达并 fail closed；
3. `capabilityCatalog` 声明 harness 支持范围和默认值；
4. Adapter 能传递所需数据；
5. identity/config/result/trace 能证明实际状态；
6. 存在 on、off 和非法组合的契约测试。

## 5. 根据 Cindy 变化更新 Headless

| 位置 | 责任 |
|---|---|
| `src/host.ts` | 建立会话、注入能力、执行和 evidence |
| `src/profile.ts` | Profile schema、默认值、互斥关系和 fail-closed 校验 |
| `src/profile-generation.ts` | capability 选择到动态 Profile 的确定性映射 |
| `src/compatibility.ts` | 支持状态和不兼容原因 |
| `scripts/build-linux-bundle.mjs` | bundle 内容与 `capabilityCatalog` |
| `profiles/**` | 少量长期生产基线，不为每种组合创建静态 Profile |
| `CINDY_FEATURE_PARITY.md` | 已支持、待适配和 Desktop-only 清单 |
| `harbor-compatibility.json` | Adapter 契约版本和摘要 |

实现顺序：

1. 更新 `maker-core` 调用，使已有 Headless 行为恢复正确；
2. 判断变化属于内部兼容更新、长期 Profile 配置，还是需要公开的新跑测变量；
3. 必要时增加 Profile 字段和严格校验，并在 host 中映射到实际 Cindy API；
4. 在 artifact 中记录影响跑测复核的 requested 与 effective 状态；
5. 仅当它是明确的网页开关时，加入对应 harness 的 catalog feature；
6. 为公开开关增加开启、关闭和非法组合测试；
7. 更新 parity 文档；
8. 只有外部执行契约变化时才更新 Adapter。

普通 bundle、prompt 或现有 Profile 字段更新不要求修改 Adapter。新 harness 协议，或
需要新挂载、secret、参数、artifact 的 feature，通常必须修改 Adapter。

### 5.1 能力注册表由维护者显式维护

能力注册表的唯一正本是 `apps/cindy-headless/capability-registry.json`。不要在
`compatibility.ts`、`build-linux-bundle.mjs`、网页代码或 manifest 中另外维护一份
feature 列表。构建脚本只负责读取维护者确认过的注册表，并把它复制/编译到 bundle 的
`bundle-manifest.json.capabilityCatalog`；它不会扫描 Cindy 源码并自动注册功能。

扫描 Cindy 源码仍是每次同步上游的必做步骤。扫描的目标是发现 API、运行行为、默认值、
证据和兼容性变化，以便正确更新 Headless；扫描结果默认记录在实现、测试或
`CINDY_FEATURE_PARITY.md`，并不默认进入网页功能列表。

先判断新内容属于 `features` 还是 `controls`：

| 区域 | 用途 | 例子 | 是否直接驱动 Profile `--features` |
|---|---|---|---|
| `features` | 维护者明确开放、可由 Headless Profile 独立开启/关闭的布尔跑测变量 | `projectContext`、`makerMemory`、`attachments` | 是 |
| `controls` | 结构化配置、路由或执行层控制面，不作为普通功能开关 | `nativeProviders`、`remoteHttpMcp`、`permissionMode`、`contextLimit` | 否 |

新增一个 Profile 功能时，至少完成以下登记：

```json
{
  "features": {
    "exampleFeature": {
      "type": "boolean",
      "control": "profile",
      "default": false,
      "label": "Example Feature",
      "description": "Credential-free description for discovery"
    }
  },
  "harnesses": {
    "claude-code": {
      "features": ["exampleFeature"]
    }
  }
}
```

实际编辑时必须保留对应 harness 原有字段（`id`、模型和已有 features），上面的片段
只是字段形状示例。`features` 当前只接受适合网页直接勾选的布尔变量；对象、数组、
整数和枚举配置应放入 `controls`，不能为了显示在网页上而伪装成 boolean。需要互斥或安全约束时，在顶层 `constraints` 增加声明，
并在 `src/profile.ts` 中实现 fail-closed 校验。约束只适用于部分 Harness 时必须填写
`harnesses`，不能扩大成全局限制。例如 Cindy 的 Claude Code/Codex 在启用 Maker
Memory 时会关闭 Native Memory，但 Pi 允许 Maker Memory 与 Pi Auto Memory 同时开启，
因此该互斥约束只登记 `harnesses: ["claude-code", "codex"]`。

新增配置/路由/执行控制时，登记在 `controls`，并写清楚控制层和证据要求：

```json
{
  "controls": {
    "exampleLimit": {
      "type": "integer",
      "control": "model-route",
      "minimum": 1,
      "enforcement": "client-request"
    }
  }
}
```

`controls` 只表示 Headless 可以发现和描述该控制，不表示上游模型或外部 Proxy 已执行。
涉及密钥的 MCP、Proxy 或 Provider 只能登记模板、环境变量名和
`credentialSafe: true` 等元数据，禁止写入 URL 中的 token、API key 或本地路径。
`throughputCap` 必须同时要求外部执行和运行证据；没有证据时只能报告
`DETECTED_BUT_NOT_ENFORCED`。

登记完成后按以下顺序验证：

```powershell
Get-Content apps/cindy-headless/capability-registry.json | ConvertFrom-Json
pnpm --filter cindy-headless typecheck
pnpm --filter cindy-headless test
$env:CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE = '1'
pnpm --filter cindy-headless bundle:linux
Remove-Item Env:CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE
pnpm --filter cindy-headless verify:bundle
node apps/cindy-headless/dist/cli.cjs capabilities --manifest apps/cindy-headless/bundle/linux-x64/bundle-manifest.json
```

对新增网页开关至少增加三类契约测试：功能开启、功能关闭、非法组合/不支持 harness。检查输出时确认
新能力同时出现在注册表、生成的 manifest 和 capabilities CLI；不要手工编辑生成的
manifest。正式出包前必须按本手册第 8、9 节创建 clean commit 并重新构建 formal bundle。

## 6. 更新版本记录

完成审计和适配后，把 `package.json.cindyUpstreamCommit` 更新为 `$newCindy`。该 SHA
应指向用户 Cindy 功能完成的 commit，通常是 Headless 适配提交的父提交或祖先。使用
结构化 JSON 工具或补丁修改，不要用不受控字符串替换。

Headless `version` 的建议：

- 仅同步内部 Cindy 修复且对外契约不变：至少 bump patch 后发布；
- Profile、catalog 或 artifact 增加向后兼容字段：bump minor；
- 删除、重命名或改变现有 CLI/Profile/artifact 语义：bump major；
- 每一个新的正式源码状态都必须使用新的 Headless version；日常查看和选择包以版本号为主，
  SHA256 用于确认同一版本文件是否完全一致；
- 同一 Headless version 不应对应多个进入正式跑测的不同 bundle；同一 commit 的同一正式包
  可以重复生成或重复上传，不需要再次升版本；
- `package:release` 检测到 Headless 有新改动但版本仍与上一个 bundle 相同时，会自动提升
  patch 版本，并同步 package、兼容性契约、运行时常量和版本说明。

确认没有残留旧基线：

```powershell
rg -n $oldCindy apps/cindy-headless
rg -n 'cindyUpstreamCommit' apps/cindy-headless
```

更新源码中的 package metadata、profile lock、compatibility 和文档；不要手工修改生成
的 `bundle-manifest.json`。

## 7. 定向验证

日常 Headless 迭代先执行定向验证；提交与 PR 仍须遵循根 AGENTS.md 的
`test:unit:related` 门禁。涉及锁文件、workspace 或测试调度时不得跳过其全量回退。
定向入口：

```powershell
pnpm --filter cindy-headless verify
```

若 Cindy 变化影响共享 `maker-core`，再补充运行直接受影响 package 的定向测试，不要
默认执行所有 Desktop 测试。重点覆盖 prompt parity、三种 harness、Profile 动态生成、
project context、Memory、usage、timeout、compatibility 和新功能 on/off/invalid。

## 8. 提交本地适配

formal bundle 必须来自 clean commit，但不要求 push：

```powershell
git status --short
git diff --check
git add <已审查的-Headless-文件>
git commit -s -m "feat(headless): sync Cindy <功能或基线>"
git status --short
```

最后一条必须没有输出。不要提交本地配置、API Key、运行结果、临时 diff 清单或临时
Profile。

## 9. 生成正式包

普通使用者不需要先生成 development 包。完成 Cindy 修改、Headless 适配和定向验证后
直接运行：

```powershell
pnpm --filter cindy-headless package:release
```

该命令会依次完成 Linux x64 bundle 构建、bundle 校验、包含 Node 与三个 harness
runtime 的 full archive 打包、完整分发校验，并在最后打印可上传文件的绝对路径和
SHA256。用户直接把输出的
`apps/cindy-headless/release/cindy-headless-linux-x64-full-<version>.tar.gz`
上传到网页即可；无需先制作或上传 development 包。

如果存在 `apps/cindy-headless` 内的未提交改动，命令会先检查版本号，必要时自动提升
patch 版本，然后使用 `git commit -s` 创建只包含 Headless 文件的本地 checkpoint commit。
该提交不要求 push。若 Cindy 其他目录也有未提交修改，为避免误提交其他工作，命令会
停止并要求先处理这些修改。

新 checkout 的生成目录不被 Git 跟踪。旧维护分支若仍跟踪产物，正式构建后，
若工作区唯一变化是生成的
`bundle/linux-x64/bundle-manifest.json`，并且它明确记录当前 HEAD、`formal` 和
`sourceDirty=false`，命令会安全复用该 bundle；除此之外的 dirty 状态一律拒绝。

上述一条命令等价于以下底层步骤，通常仅在排障时分别执行：

```powershell
pnpm --filter cindy-headless bundle:linux
pnpm --filter cindy-headless verify:bundle
pnpm --filter cindy-headless package:full
pnpm --filter cindy-headless verify:distribution:full
```

脚本默认下载并校验锁定的 binary，也可以通过 `CINDY_CLAUDE_BINARY`、
`CINDY_CODEX_BINARY`、`CINDY_PI_BINARY` 指向已缓存的 Linux x64 版本。

检查身份：

```powershell
$manifestPath = 'apps/cindy-headless/bundle/linux-x64/bundle-manifest.json'
$manifest = Get-Content $manifestPath | ConvertFrom-Json
$builtFrom = git rev-parse HEAD

if ($manifest.bundleMode -ne 'formal') { throw 'bundle is not formal' }
if ($manifest.sourceDirty -ne $false) { throw 'bundle source is dirty' }
if ($manifest.cindyCommit -ne $builtFrom) { throw 'bundle was built from another commit' }
if ($manifest.cindyUpstreamCommit -ne $newCindy) { throw 'Cindy baseline mismatch' }
Get-Content apps/cindy-headless/release/SHA256SUMS
```

用户直接上传的文件是：

```text
apps/cindy-headless/release/cindy-headless-linux-x64-full-<version>.tar.gz
```

默认正式出包只在 `release` 目录留下上述 `full` 包，避免与精简包并列造成误选。
`full` 包包含 Node 和三个 harness runtime；分发前必须确认第三方许可。只有用户明确要求
公共 no-vendor 分发时，才运行
`pnpm --filter cindy-headless package:public-runtime`，其产物名为
`cindy-headless-linux-x64-public-runtime-no-vendor-<version>.tar.gz`，不包含 Claude Code、
Codex 或 Pi harness binaries，不能替代默认上传包。

`bundle/` 与 `release/` 是被忽略的生成目录，不提交生成 manifest、复制的 profiles
或二进制。将 release 中的 manifest、SHA256SUMS 和完整归档一同保存。
manifest 的 `cindyCommit` 指向实际构建源码提交，源码提交不需要包含生成的 manifest。

## 10. Dirty worktree 策略

主流程是 formal 出包，不应默认允许 dirty。个人分支上的本地 checkpoint commit 已经
足够，不要求 push。只有排查尚未完成的适配时才允许：

```powershell
$env:CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE = '1'
pnpm --filter cindy-headless bundle:linux
Remove-Item Env:CINDY_HEADLESS_ALLOW_DIRTY_BUNDLE
```

该产物会标记 `bundleMode=development`、`sourceDirty=true`，只能说明当前文件可以构建，
不得作为用户默认出包或正式评分产物。

## 11. 最终清单

- `cindyUpstreamCommit` 等于本次审计的新 Cindy commit；
- Cindy diff 每项能力已归类，Desktop-only 代码没有复制进 Headless；
- 新能力具备 Profile 控制、catalog 声明、运行证据和测试；
- Adapter 契约变化已更新兼容性记录；
- Headless 定向验证、bundle 和 full distribution 验证全部通过；
- manifest 为 `formal`、`sourceDirty=false`；
- bundle/Cindy commit 及 prompt/profile/binary 摘要齐全；
- full archive SHA256 已记录；
- 包内没有本地配置、API Key、临时 Profile 或运行结果。

## 12. 常见错误

### 旧基线不是当前 HEAD 的祖先

确认分支和 rebase 历史。必要时用 `git merge-base $oldCindy $newCindy` 找共同基线并
分别审计两侧；不要直接改基线来掩盖遗漏。

### 新 Cindy 功能没有出现在 catalog

仅更新 `maker-core` 不会自动发布跑测能力。补齐 Profile schema、host 映射、artifact
证据、catalog 和测试。

### Desktop 中的功能是否全部删除

不是。UI、IPC 和窗口代码剔除；最终影响 Agent 输入和行为的配置、prompt、Memory
或 project-context 语义，需要提取并以无 UI、可冻结形式实现。

### Refusing to build a scored bundle from a dirty worktree

审查修改并创建本地 checkpoint commit，再重新构建。这不要求 push。

### Cindy upstream commit mismatch

更新 package metadata、profile lock、兼容性记录后重新运行测试与 `bundle:linux`；
不要手工修改生成的 manifest 绕过校验。
