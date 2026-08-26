# project-context

Agent-maintained project knowledge layer. Commit-driven, markdown + frontmatter, generic CLI.

本文档同时维护使用方式、架构边界与当前限制。

> **Status**: MVP (v0.1)。MVP 范围见本文档底部"Limitations"。

---

## 这是什么

每次开新 agent session 时，agent 都要重新 grep 项目结构来理解代码。`project-context` 把这层"项目知识"持久化下来 —— 跟着 git commit 增量演进，**agent 自己维护**，新 session 启动时按需注入。

核心概念：

- **modules**：跟 package / 目录对齐的骨架知识（一份 .md / 一个包）
- **concerns**：跨包的横向关注（IPC、agent lifecycle 等，由 agent 在 update 时提议；MVP 阶段不自动建）
- **manifest.yaml**：索引文件，反查"哪些知识覆盖某文件"用
- **stale 标记**：知识过期时打标，等下次任务用到时按需 refresh（JIT，Phase 2）
- **auto_update flag**：frontmatter 里设 `auto_update: false` 可冻结某个 module 不被自动维护

---

## 安装 / 运行方式

### 在本仓库内（开发态）

`project-context` 是 monorepo 内的 workspace 包，不需要独立安装。直接：

```bash
# 1. 安装依赖（仓库根）
pnpm install

# 2. 编译
pnpm --filter project-context build

# 3. 跑 CLI（仓库根，绝对路径）
node packages/project-context/dist/cli.js <command>
```

### 通过 pnpm exec（任意 workspace 子目录都能跑）

```bash
pnpm --filter project-context exec project-context <command>
```

### 通过 npx（包发布或全局装之后）

未来发布到 npm 后：

```bash
# 全局装
pnpm install -g project-context
project-context <command>

# 或者按需 npx
npx project-context <command>
```

### 项目内 devDep（推荐生产部署方式）

```bash
pnpm add -D project-context
# package.json 里就有 bin shim 了：
node_modules/.bin/project-context <command>
# 或 pnpm 脚本里：
# "scripts": { "kctx": "project-context update" }
```

### 开发模式（不需要每次 build）

```bash
pnpm --filter project-context dev   # tsx watch src/cli.ts
```

> **依赖项**：Node ≥ 18，且**仓库必须是 git**。MVP 强制要求；非 git 项目报错退出。

---

## Quick Start（3 步跑通）

```bash
# 1) 初始化：扫描 monorepo / pnpm workspace，给每个有源码的 package 建一份空壳 .md
node packages/project-context/dist/cli.js init

# 2) 看产出
ls .cindy/project-knowledge/modules/
cat .cindy/project-knowledge/manifest.yaml

# 3) 模拟有 diff 时的 dry-run（不调 LLM、只算映射）
node packages/project-context/dist/cli.js update --since HEAD~5 --check-only

# 4) 反查"改了某个文件影响哪些知识"
node packages/project-context/dist/cli.js query --files packages/maker-core/src/agents/base-agent.ts
```

---

## Commands

### `init [--bootstrap] [--prune]`

扫描仓库、按 package manager 约定建 `modules/` 骨架。**幂等**：已存在的 .md 不覆盖。

发现优先级：
1. `.cindy/project-knowledge/config.yaml` 的 `module_roots`（显式）
2. `pnpm-workspace.yaml` 的 `packages` 字段
3. `package.json` 的 `workspaces` 字段
4. 都找不到 → 报错让你写 config.yaml

每个候选目录会过一道**源码启发式**：目录里没有任何 `.ts/.js/.go/.rs/.py/.html/.css/...` 等源码后缀就跳过（用来排除 `*-bin` 这种纯二进制镜像包）。

**选项：**

| Flag | 作用 |
|---|---|
| `--bootstrap` | 跑一次"全工程扫一遍 + LLM 提议跨切关注"。**MVP 占位，暂未真跑**，会输出黄色提示 |
| `--prune` | 把 orphan 模块（discovery 不再发现的 .md）从 disk 删掉。默认只**报告**不删 |

**典型输出：**

```
project-context init
  repo root: D:/work/cindy
  discovered modules: 8
  created: 8, skipped: 0
    + apps--desktop
    + apps--landing-page
    + ...
  wrote default .cindy/project-knowledge/config.yaml
  manifest: .cindy/project-knowledge/manifest.yaml
```

### `update [--since <ref>] [--check-only]`

按 git diff 增量更新受影响的知识文件。

流程：
1. 拿一个文件锁（`.cindy/project-knowledge/.lock`），抢不到就跳过本次（防并发）
2. 算 `last_synced_commit..HEAD` 的 diff
3. 过 `.gitignore` + 内置 ignore + config.ignore 三层过滤
4. 反查每个改动文件覆盖的知识 ID
5. 对每个受影响的 ID：
   - **小 diff**（≤ 5 文件 且 ≤ 200 行，可在 config.yaml 调）→ 调 agent 适配器重写正文
   - **大 diff** → 标 `stale: true`，等下次任务 refresh
   - **`auto_update: false`** → 完全跳过（不重写也不标 stale）
6. 收集"未被任何知识覆盖"的改动文件，提示考虑加新 module / concern

**选项：**

| Flag | 作用 |
|---|---|
| `--since <ref>` | 覆盖 diff 起点。默认用 manifest 里 `last_synced_commit`。常用 `--since HEAD~5` 测试 |
| `--check-only` | 只打算盘不写盘：列出会更新 / 标 stale / read-only 跳过的 ID，不调 LLM 不改文件 |

**典型输出：**

```
project-context update
  diff: 4cc6490..6838258
  updated: 1, staled: 1, read-only skipped: 0, uncovered files: 1
    ~ packages--maker-core      (rewrote)
    s apps--desktop             (staled)
  uncovered files (consider adding a module/concern):
    - .gitlab-ci.env
```

> 真正调 LLM 需要本机有 `claude` CLI 在 PATH 里且已登录（详见 Adapter 节）。

### `refresh [ids...] [--all | --stale] [--check-only] [--force]`

**从当前源码重建知识正文**，不依赖 git diff。冷启动 / 历史代码补完 / 修复 stale 都用这个。

适合场景：
- **首次冷启动**：`init` 只建空骨架（TODO 占位），`refresh --all` 让 LLM 一次性把所有 module 填满
- **stale 修复**：之前 update 因 diff 太大标了 stale，跑 `refresh --stale` 集中重生
- **某模块单独刷**：只想看一个 module 的产出，`refresh packages--maker-core`

scope 三选一（互斥）：

| 用法 | 作用 |
|---|---|
| `refresh <id> [<id> ...]` | 刷指定 ID（可多个） |
| `refresh --stale` | 只刷标了 stale 的 |
| `refresh --all` | 全刷一遍 |

**选项：**

| Flag | 作用 |
|---|---|
| `--check-only` | 干跑：列出 target 不调 LLM 不写盘 |
| `--force` | 默认跳过 `auto_update: false` 的 module；加 `--force` 强制刷 |

**机制**：refresh 通过 adapter 调 `claude -p`，但**不喂 diff**。只告诉 agent："你要刷的 module 覆盖 `<covers>` 路径，请用你的 Read/Glob/Grep 工具自己探索源码，然后写新正文"。`claude` 在 headless `-p` 模式下默认带工具访问，所以可以自主爬。

**典型输出：**

```
project-context refresh
  targets: 8 (scope=all)
  [1/8] apps--desktop  refreshing...
     done (32.4s)
  [2/8] apps--landing-page  refreshing...
     done (8.1s)
  ...

  refreshed: 7, skipped: 0, failed: 1
    x packages--@cindy/mcps  claude-code adapter: timed out after 600000ms
```

**成本提醒**：
- 单个 module refresh 估算 10-30k token + ~30-90s 时间（取决于包大小）
- `refresh --all` 在 8 module 的项目上估算 100-200k token + 5-15 分钟
- 强烈建议**先跑一个 module 试水**（`refresh packages--maker-core --check-only` → 然后真跑一次 → review 输出）再决定是否 `--all`

### `query --files <list> [--format ids|paths|json]`

反查：给一组文件路径，输出覆盖它们的知识 ID。

```bash
# 单文件，默认 ids 格式
node packages/project-context/dist/cli.js query \
  --files packages/maker-core/src/agents/base-agent.ts

# 多文件 + JSON 格式
node packages/project-context/dist/cli.js query \
  --files packages/maker-core/src/agents/base-agent.ts,apps/desktop/src/main/index.ts \
  --format json

# 输出：
# {
#   "ids": ["apps--desktop", "packages--maker-core"],
#   "paths": [".../modules/apps--desktop.md", ".../modules/packages--maker-core.md"],
#   "stale": []
# }
```

**输出格式：**

| `--format` | 输出 |
|---|---|
| `ids`（默认） | 每行一个 ID |
| `paths` | 每行一个 .md 绝对路径 |
| `json` | 含 `ids` / `paths` / `stale` 三个数组 |

主要给 agent harness 用：把改动文件丢进去 → 拿 .md 路径 → 拼到 system prompt。

---

## 产出物（`.cindy/project-knowledge/` 长什么样）

```
<repo-root>/.cindy/project-knowledge/
├── config.yaml          # 用户可编辑配置（init 时写默认）
├── manifest.yaml        # 索引（机器维护，可从 .md 重建）
├── .lock                # update 运行时的临时锁文件（自动清理）
├── modules/
│   ├── apps--desktop.md
│   ├── packages--maker-core.md
│   └── ...
└── concerns/            # 空目录，等 Phase 2 自动填
```

**单份 module .md 长这样：**

```markdown
---
id: packages--maker-core
type: module
covers:
  - packages/maker-core/**
depends_on: []
last_synced_commit: 4cc6490af1399d087977a3e62994264d6fe94fc1
last_synced_at: '2026-05-11T09:44:49.539Z'
stale: false
stale_reason: null
auto_update: true
schema_version: 1
---
# packages--maker-core

## 是什么
...

## 关键抽象 / 核心代码地标
...

## 模块边界
...

## 不要做的事
...

## 演进备忘
（仅追加，记录重大改动）
```

**Frontmatter 字段：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一，一般是 path 转 kebab |
| `type` | `module` \| `concern` | 决定放哪个子目录 |
| `covers` | glob[] | 反查代码 → 知识的关键 |
| `depends_on` | id[] | 注入时一跳扩展（"用 A 必带 B"，Phase 2） |
| `last_synced_commit` | sha | diff 起点 |
| `last_synced_at` | ISO time | 调试 |
| `stale` | bool | 标记是否过期 |
| `stale_reason` | string \| null | 调试，记录是哪个 commit 触发的 stale |
| `auto_update` | bool（默认 true） | 设 false 则 update 完全跳过此知识 |
| `schema_version` | int | 格式升级用 |

---

## 配置（`.cindy/project-knowledge/config.yaml`）

`init` 第一次跑时会写一份默认配置，后续手动编辑：

```yaml
# 自动发现 modules 的根路径（不写则按 package manager 约定）
module_roots:
  - packages/*
  - apps/*

# 额外 ignore（叠加在 .gitignore + 内置默认之上）
# 内置默认包括：node_modules, dist, build, *.lock, *.min.js, *.snap 等
ignore:
  - apps/some-vendored-thing

# 小 diff 阈值
small_diff_threshold:
  files: 5
  lines: 200

# Adapter
agent: claude-code              # MVP 仅支持 claude-code，未来 codex / custom
agent_options:
  timeout: 120                  # 秒，超时杀进程
  # model: opus                 # 可选，传给 claude --model
  # command: /path/to/claude    # 可选，覆盖默认 PATH 搜索
```

---

## Adapter（LLM 怎么被调）

MVP 内置一个 adapter：`claude-code`。

**机制**：在子进程里 `spawn('claude', ['-p', '--output-format', 'text'])`，prompt 通过 stdin 喂入，结果从 stdout 读出。

**前置条件**：
- 本机 PATH 里有 `claude` 可执行（[Claude Code CLI](https://docs.anthropic.com/claude-code)）
- 已登录（`claude` 自带的 OAuth 凭证）—— **不需要 ANTHROPIC_API_KEY**

**失败模式**：
- `claude` 不在 PATH → 报错"`claude` CLI not found in PATH"
- 退出码非 0 → 报错并捕获 stderr
- 超时 → 杀子进程报错
- 任何失败 → 该 module 标 stale，update 继续处理后面的 ID

后续可按 `src/adapters/types.ts` 的接口增加 `codex` / `custom` adapter。

---

## 常见接入工作流

### Cindy Desktop（本仓库默认 harness，开箱即用）

Cindy Desktop 已内置自动入口：每次创建新的 Claude Code、Codex 或 Pi session 时，main 进程会探测 cwd 下是否有 `.cindy/project-knowledge/TOC.md`。存在且非空时，只把这个文件的短路径提示包成 `<project-context-toc>` wrapper；agent 在任务相关时再读取 TOC 和对应知识文件。TOC 正文不再占用每个 session 的启动上下文，缺失则 silently skip。

- **无需任何 UI 开关**：所有用户默认启用（不再走"实验功能"入口）
- **目录探测**：以 cwd 为根，命中 `.cindy/project-knowledge/TOC.md` 才触发
- **per-session 快照**：是否注入会回写到 `sessions.used_project_context` 列；老 session 维持启动时刻状态，不被后续追溯
- **可视提示**：chat footer 的 Brain icon + tooltip "项目知识库已加载"（4 语言已对齐）

注入逻辑实现：`apps/desktop/src/main/maker-ipc/projectContextInject.ts`。100KB 硬上限超出截断尾部并加 `truncated="true"` 标记。

### 自动 update：本地 git post-commit hook（推荐主路径）

仓库根的 `.git/hooks/post-commit`（手动建文件，加可执行权限）：

```bash
#!/bin/sh
# 异步、后台跑，不阻塞 commit
(node /absolute/path/to/packages/project-context/dist/cli.js update > /tmp/pctx.log 2>&1) &
```

或团队场景用 husky / lefthook 之类工具管理。

### 让 agent 启动时拿到知识：harness 集成

任何 agent harness（Claude Code、Codex CLI、Cindy、Cursor）启动新 session 前调一次：

```bash
# 收集相关文件
files=$(git diff --name-only main...HEAD | tr '\n' ',')

# 查相关 .md 路径
paths=$(node packages/project-context/dist/cli.js query --files "$files" --format paths)

# 拼到 system prompt（具体怎么拼看 harness）
for p in $paths; do
  cat "$p"
done > /tmp/system-prompt-append.md
```

### 把 update 接到 Claude Code 的 Stop hook

Claude Code 的 hooks 配置里加：

```jsonc
{
  "Stop": "node /absolute/path/to/packages/project-context/dist/cli.js update"
}
```

每次 agent 完成一轮就跑 update —— 适合 agent 频繁改代码不立即 commit 的场景。

---

## 怎么手动控制某个 module

**冻结某个 module（不让 update 改）：**

编辑 `.cindy/project-knowledge/modules/<id>.md` 的 frontmatter，加：

```yaml
auto_update: false
```

下次 update 见到这个就直接跳过（输出 `r <id> (auto_update=false)`）。

**清理 orphan：**

```bash
# 默认只报告
node packages/project-context/dist/cli.js init
# 实际删除
node packages/project-context/dist/cli.js init --prune
```

**强制重生某 module：**

```bash
# 单个
node packages/project-context/dist/cli.js refresh packages--maker-core

# 所有 stale 的
node packages/project-context/dist/cli.js refresh --stale

# 全量冷启动
node packages/project-context/dist/cli.js refresh --all
```

详见上面的 `refresh` 命令小节。

---

## Limitations（MVP 没做的）

- `init --bootstrap` 接收 flag 但暂未真扫 concerns（**注：填模块正文用 `refresh --all`，bootstrap 只是用来发现新 concerns**，Phase 2）
- `inject` 命令未单独封装（用 query 拼即可）
- 仅 `claude-code` adapter；codex / custom 待做
- `depends_on` 字段写入但 query 不做扩展（一跳）
- 没有 token budget 排序
- 没有"跨进程更稳的锁"——`.cindy/project-knowledge/.lock` 是简单文件锁，崩溃时可能残留（手动删）
- 演进备忘没有膨胀防护（Phase 3）

---

## Troubleshooting

| 症状 | 原因 / 解 |
|---|---|
| `Not inside a git repository` | 当前目录不是 git 仓库。`git init` 或换路径 |
| `Discovery returned 0 modules` | 没有 pnpm-workspace.yaml / package.json workspaces，或都没匹配。在 config.yaml 写 `module_roots` |
| `Detected go.mod / Cargo.toml` | MVP 不支持 Go/Rust 自动发现。手写 `module_roots` 即可 |
| update 输出 `another instance is running` | 上次跑挂了残留 .lock。删 `.cindy/project-knowledge/.lock` 重试 |
| update 报 `claude CLI not found` | 装 Claude Code CLI 或在 config.yaml 写 `agent_options.command` 指自定义路径 |
| init 报某个目录是 orphan 但不该是 | 该目录里全是非源码后缀。要么手动建一份 .md（init 不会覆盖），要么扩展 `SOURCE_EXTENSIONS`（src/discovery.ts） |

配置字段与当前限制以本 README 和 `src/` 实现为准。
