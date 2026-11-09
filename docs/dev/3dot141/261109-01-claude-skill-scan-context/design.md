# Claude Skill 扫描上下文统一设计

> 状态：设计稿
> 背景：PR #8961（已关闭）在实现「Claude Code 插件 Skill 展示」时，连续六轮 review 指向同一个根因。

---

## 1. 问题

Cindy 的 `/` 菜单和技能管理页需要列出「这次会话能调用哪些 Skill / 插件 Skill」。当前实现由扫描器**自己推断**配置目录与项目上下文，而会话实际使用什么，是由另外几处决定的：

| 决定方 | 位置 |
|---|---|
| 本地默认账号 | 无（默认 `~/.claude`） |
| 本地非默认订阅账号 | `apps/desktop/src/main/maker-host/auth-adapters.ts:723` |
| SSH 远端会话 | `packages/maker-cc-manager/src/remote-claude-env.ts:94-99` |
| 项目级作用域 | 项目根下的 `.claude/settings.json` + 安装记录 |

推断一旦和实际不一致，菜单就会同时**漏掉真能用的**和**显示用不了的**。

---

## 2. 现状：六种表现

| # | 场景 | 运行时读 | 扫描读 | 状态 |
|---|---|---|---|---|
| 1 | SSH 远程主机 | `~/.xdt-server/v1/claude-home` | `~/.claude` | #9184 |
| 2 | 非默认 Claude 订阅账号 | 该账号 `configDir` | `~/.claude` | 未开 issue |
| 3 | project / local scope 插件 | 项目内 `.claude` | 只扫 user scope | #9207 |
| 3a | 多项目并存 | 各自项目 | 只能取一个根 | #9207 |
| 3b | 条目归属 | 项目 | 被标成 `global` | #9207 |
| 3c | 项目 settings 覆盖 | 三层合并 | 只看用户层 | #9207 |
| 4 | 远端串行探测（性能） | — | — | ✅ 已修（8 路并发） |
| 5 | Windows 路径大小写 | 大小写不敏感 | `path.resolve` 精确比较 | #9207 |
| 6 | cwd 与 Git 根不同 | 从 cwd 向上找根 | 直接用 cwd | #9207 |

**根因只有一个**：扫描边界没有接收「会话实际的配置目录 + 项目上下文」，而是自己猜。

---

## 3. 已有的解析能力（可直接复用）

### 3.1 本机配置目录

```ts
// apps/desktop/src/main/remote-agent/controller/projectFiles.ts:274
export function claudeConfigDir(env = process.env, home = os.homedir()): string {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR
    : path.join(home, '.claude');
}
```

### 3.2 非默认账号的配置目录

```ts
// apps/desktop/src/main/subscription-accounts/store.ts:108
export function readBoundClaudeConfigDir(sdkSessionId: string): string | undefined {
  const binding = readAccountBinding(`native:${sdkSessionId}`, 'anthropic');
  return binding && binding.accountId !== 'default'
    ? accountDirectory('anthropic', binding.accountId)
    : undefined;
}
```

已有调用方：`fork.ts`、`rewind.ts`、`nativeHistoryStorage.ts`、`sessionShareExport.ts`。

`sdkSessionId` 可从 `sessionMeta.sdkSessionId` 取得（`maker.ts` 持久化）。

### 3.3 SSH 远端的配置目录

```ts
// packages/maker-cc-manager/src/remote-claude-env.ts:94
export function ensureRemoteClaudeConfigDir(remoteHomeDir = os.homedir()): string
// → <remoteHome>/.xdt-server/v1/claude-home
```

### 3.4 Git 根

`packages/maker-core/src/agents/claude-code/customization-scanner.ts` 的 `scanClaudeRuntimeSkills` 已有「从 cwd 向上找最近 Git 根」的实现，可直接提取复用。

---

## 4. 设计

### 4.1 统一上下文对象

```ts
/**
 * 一次 Skill 扫描的完整输入。所有字段都由 host 侧解析，
 * 扫描器只消费，不再自行推断。
 */
export interface ClaudeSkillScanContext {
  /** 会话实际使用的 Claude 配置目录（绝对路径）。 */
  configDir: string;
  /** 项目根（Git 根）；无项目上下文时省略。 */
  projectRoot?: string;
  /** 本次扫描允许的作用域。user 恒在；project / local 由上下文决定。 */
  scopes: readonly ('user' | 'project' | 'local')[];
}
```

### 4.2 解析责任划分

```
┌─ host 侧（apps/desktop）─────────────────────────────┐
│  会话 → sdkSessionId                                  │
│    ├─ readBoundClaudeConfigDir() 非默认账号?          │
│    └─ claudeConfigDir()          默认                 │
│  cwd → Git 根（向上找 .git）                          │
│  远端 → ensureRemoteClaudeConfigDir()                 │
│                        ↓                              │
│              ClaudeSkillScanContext                   │
└────────────────────────┬─────────────────────────────┘
                         ↓ 通过 IPC / deps 注入
┌─ maker-core ───────────┴─────────────────────────────┐
│  scanClaudeSlashCommands(ctx)                         │
│  scanClaudeRuntimeSkills(ctx)                         │
│    └─ scanClaudePluginSkills(ctx)                     │
│         ├─ 读 <configDir>/plugins                     │
│         ├─ enabledPlugins = user → project → local    │
│         └─ scope 过滤 + projectRoot 匹配              │
└──────────────────────────────────────────────────────┘
```

### 4.3 扫描器签名

```ts
export function scanClaudePluginSkills(
  context: ClaudeSkillScanContext,
): ClaudePluginSkill[]
```

内部逻辑：

1. 读 `<configDir>/plugins/installed_plugins.json`
2. `enabledPlugins` 按 `scopes` 合并 settings 层级
3. 安装记录按 scope 过滤：
   - `user` → 恒包含
   - `project` / `local` → `projectPath` 与 `projectRoot` 规范化后比较
4. 路径比较统一走 `canonicalPath()`：`realpath` + Windows 小写折叠

### 4.4 路径规范化

```ts
function canonicalPath(value: string): string {
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* 缺失路径保留字面值 */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
```

覆盖问题 5（大小写）与符号链接。

---

## 5. 分阶段实施

| 阶段 | 范围 | 依赖 | 预估改动 |
|---|---|---|---|
| **A** | 本地默认账号 + user scope —— 原 PR 的收敛版 | 无 | 中（已实现，需按新签名重构） |
| **B** | 非默认订阅账号 | host 侧解析 `readBoundClaudeConfigDir` | 小 |
| **C** | SSH 远端 | 先定 #9184 的投递策略 | 大 |
| **D** | project / local scope | #9207 的五个子问题 | 大 |

**阶段 A 必须先落地**：它定义上下文对象与扫描器签名，B/C/D 都在这套接口上扩展。

---

### 阶段 A：本地默认账号 + user scope

**范围**：把已实现的插件扫描收敛到新签名上，不新增场景。

**改动点**

| 文件 | 改动 |
|---|---|
| `types/palette.ts` | `ListAgentSkillsOptions` 增加 `runtimeConfigDir?: string` |
| `agents/shared/palette-scanner.ts` | `scanClaudeSlashCommands(ctx)` 消费 `configDir`，删除 `path.join(home, '.claude')` |
| `agents/shared/claude-plugin-skills.ts` | 签名改为 `scanClaudePluginSkills(ctx)`，`configDir` 必填 |
| `agents/claude-code/customization-scanner.ts` | 同上 |
| `agents/claude-code/index.ts` | `listAgentSkills` 透传 `opts.runtimeConfigDir` |
| `maker-ipc/register.ts` | 解析 `sessionMeta.sdkSessionId` → `claudeConfigDir()`，注入 `runtimeConfigDir` |

**验收**

- 默认账号、user scope 的插件出现在 `/` 菜单与技能管理页
- 伙伴目录通过 `excludePluginSkills` 排除
- 扫描器不再出现硬编码的 `path.join(home, '.claude')`
- 上下文由 host 注入，扫描器无环境推断

---

### 阶段 B：非默认 Claude 订阅账号

**问题**：`auth-adapters.ts:723` 在非默认账号时把 `CLAUDE_CONFIG_DIR` 指向 `account.configDir`，菜单仍扫 `~/.claude`。

**改动点**

```
register.ts（list-agent-skills handler）
  ├─ sessionMeta = await maker.getSessionMeta(sessionId)     ← 已有
  ├─ sdkSessionId = sessionMeta?.sdkSessionId
  ├─ accountDir = readBoundClaudeConfigDir(sdkSessionId)      ← 已有，返回 undefined = 默认账号
  └─ runtimeConfigDir = accountDir ?? claudeConfigDir()       ← 已有
```

`readBoundClaudeConfigDir` 位于 `apps/desktop/src/main/subscription-accounts/store.ts:108`，`claudeConfigDir` 位于 `remote-agent/controller/projectFiles.ts:274`，两者都在 desktop 侧，不需要下沉到 maker-core。

**缓存不需要处理**（实现时核对后修正）

初稿担心 `slashCommands.ts` 的 `loadPendingSkills` 会缓存跨账号结果。核对实现后确认它只合并**在途请求**：

```ts
const request = load().catch(/* … */).finally(() => {
  if (key !== null && pending.get(key) === request) pending.delete(key);
});
```

请求完成即从 Map 删除，不存在跨调用复用。因此切换账号后下一次打开菜单一定是新请求，无需 invalidate，也不需要把账号维度加进缓存键。

**验收**

- 切到非默认账号后，菜单只显示该账号安装的插件
- 切回默认账号，恢复默认账号的结果
- 默认账号的插件不在非默认账号会话里出现

**风险**

- 尚未启动的会话没有 `sdkSessionId` → 回退默认目录。这种情况菜单本就用于创建会话，可接受
- 账号绑定写入与菜单刷新存在时序差 → 以「切换后重新打开菜单才准确」为可接受行为

---

### 阶段 C：SSH 远程主机

**问题**：`cc-mgr.ts:252` 在远端把 `CLAUDE_CONFIG_DIR` 强制设为 `<remoteHome>/.xdt-server/v1/claude-home`，且 `ensureRemoteClaudeConfigDir()` 只 `mkdir`，**不投递任何内容**。结果是远端会话既没有用户的 skills 也没有插件。

**决策（#9184）：只做 C2 —— 扫描跟随运行时**

不做 C1（把 `~/.agents/skills` 投递进 claude-home），理由：

1. 投递会改变远端的隔离语义。`cc-mgr.ts:249` 的注释写明「outside the host's global `~/.claude` directory」是刻意的安全边界，投递等于在这条边界上开口。
2. 需要额外定义「投递哪些技能」的规则、幂等性（重复启动不产生嵌套链接）、以及与本地删除的同步。
3. 当前主要使用方式是「远程控制另一台 Cindy」（device link），不走这条 SSH 路径，收益有限。

因此 **C2 的定位是消除误报，不是补齐能力**：远端菜单只列 claude-home 里真实存在的内容。远端用户需要某个技能时，应在那台机器上安装。

**C2 的实现要点**

- `scanRemoteClaudeSkills` 增加 `configDir` 参数，不再硬编码 `$HOME/.claude`
- 远端路径常量目前只存在于 `packages/maker-cc-manager/src/remote-claude-env.ts:5`

```ts
const REMOTE_CLAUDE_CONFIG_SEGMENTS = ['.xdt-server', 'v1', 'claude-home'] as const;
```

maker-core 不能依赖 maker-cc-manager（依赖方向相反）。两种收敛方式：

| 方式 | 说明 |
|---|---|
| 提到 `@cindy/maker-shared` | 两包共用常量，改动最小 |
| 协议上报 | cc-manager 在握手时返回自己的 configDir，Cindy 侧缓存 |

采用常量下沉（快、无协议变动）；协议上报留作后续，届时可去掉常量耦合。

**验收**

- SSH 会话的 `/` 菜单只出现远端 claude-home 里真实存在的 skills 与插件
- 不再出现「本地装了、远端会话根本没加载」的条目
- 远端 claude-home 为空时，菜单的插件部分为空——这是正确结果，不是缺陷

**明确不做**

- 不把本地 `~/.agents/skills` 或 `~/.claude/plugins` 投递到远端
- 不在扫描器里对远端做 `realpath`（`RemoteAgentFileOps` 不提供该能力，远端路径比较走字面值归一）

---

### 阶段 D：project / local scope 插件

**五个子问题**（#9207）

| # | 问题 | 改法 |
|---|---|---|
| D1 | 多项目只取第一个根 | `scanClaudeCustomizations` 对每个 `workingDir` 独立解析 context，按 `projectRoot` 合并结果 |
| D2 | 条目被标成 `global` | `ClaudePluginSkill` 增加 `scope` 与 `projectRoot`；`readFolderSkill` 透传到 `AgentCustomization.scope / workingDir` |
| D3 | 项目 settings 层级 | `readEnabledPlugins(configDir, projectRoot)`，顺序 user → project → local |
| D4 | Windows 路径大小写 | 统一走 `canonicalPath()`（realpath + win32 小写） |
| D5 | cwd 与 Git 根不同 | 提取 `customization-scanner.ts:129` 的「向上找 `.git`」为 `resolveGitRoot(cwd)`，palette 与 SkillHub 共用 |

**D5 的现有实现**

```ts
// agents/claude-code/customization-scanner.ts:129
while (true) {
  if (fs.existsSync(path.join(current, '.git'))) break;
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
```

提取时保持行为一致：先查当前目录，再逐级向上，到根为止。

**D2 对 SkillHub 的影响**

`skillListProjection.ts` 已经按 `scope` 与 `workingDir` 做项目分组与 URL 身份，只要上游把 scope 标对，投影侧不需要改。这是阶段 D 里最容易低估的部分——需要逐条验证：

- `urlKey` 是否随 scope 变化
- `identityCounts` 去重是否区分项目
- 启停开关对项目级插件是否仍有意义（结论应与 user 一致：`managedByPlugin`）

**验收**

- 为项目 A 扫描时只出现装在 A 的插件；无关项目不出现
- SkillHub 能把项目级插件归到对应项目，而不是 Global
- 项目 settings 禁用/启用的插件与运行时一致
- Windows 上路径大小写不同仍能匹配
- 从子目录启动的会话能看到仓库根下的项目插件

**风险**

- 项目级插件在 Claude 生态里本身少见，真实用户样本少，容易过度设计
- 五个子问题互相耦合，建议按 D5 → D4 → D3 → D2 → D1 的顺序做：先保证「找得到项目根与正确路径」，再谈作用域与多项目

---

## 6. 风险与取舍

| 风险 | 说明 | 缓解 |
|---|---|---|
| 上下文传递链长 | IPC → maker → agent → scanner，任何一层漏传就退化 | 把 `configDir` 设为必填，缺失时返回空列表而不是回退 `~/.claude` —— 显示错误比不显示更糟 |
| 远端 fileOps 能力受限 | `RemoteAgentFileOps` 只有 stat/listDir/readFile，无法 realpath | 远端阶段单独定义 `canonicalPath` 的降级策略 |
| Git 根解析开销 | 每次扫描向上找 `.git` | 复用 `scanClaudeRuntimeSkills` 的现有实现，带缓存 |
| 向后兼容 | 现有调用方不传 context | 提供 `scanClaudePluginSkills(ctx)` 单签名，不保留默认参数，让编译期暴露所有调用点 |

### 明确不做

- 不为「配置目录不确定」的场景提供猜测式回退
- 不在扫描器内部读 `process.env`（env 是 host 的，不是会话的）

---

## 7. 与现有 issue 的关系

| Issue | 归属阶段 |
|---|---|
| #9184 SSH 远端配置目录 | C |
| #9207 项目级插件 | D |
| （待开）非默认账号 | B |

---

## 8. 参考

- PR #8961（已关闭，实现代码保留在分支 `feature/plugin-skills-palette` @ `845ca0ed9d`）
- `packages/maker-core/src/agents/shared/claude-plugin-skills.ts`（现有扫描实现）
- `packages/maker-core/src/agents/shared/remote-skill-scanner.ts`（远端实现 + 并发探测）
