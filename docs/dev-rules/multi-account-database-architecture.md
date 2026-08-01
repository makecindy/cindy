# Desktop 多账号数据库与数据所有权架构

> **状态**：架构基线（先梳理，不代表多账号功能已实现）
> **范围**：Desktop 本地数据、SQLite、凭证命名空间、Profile 生命周期与运行时隔离。
> **跟踪 Issue**：[#1266](https://github.com/makecindy/cindy/issues/1266)
> **当前结论**：本阶段不新增业务功能，不批量给现有业务表增加 `owner_id`，也不直接写
> migration；先冻结所有权边界，再按后续实现需要追加最小迁移。

## 1. 结论先行

未来多账号采用 **一个账号一个 Profile、一个 Profile 一份 Profile DB、一个 Profile 一个
独立运行时** 的模型。

- Profile 是内部隔离边界，用户界面可以只称为“账号”。
- Profile 代表一个稳定的 Data Owner / membership，不代表一次登录窗口，也不等同于
  `region`。
- Profile DB 内的业务表天然属于该 Profile，因此不需要在每张表重复保存 `owner_id`。
- 同一 Profile 的第二次启动只聚焦或复用已有运行时；同一账号不允许在两个 Profile
  运行时中同时作为 active owner。
- 多个账号同时运行通过多个 Profile 运行时完成，不通过一个主进程切换多个全局单例。
- CN / Global 仍是构建期固定维度，不能作为多账号隔离键，也不能变成用户可选项。

这意味着当前最重要的工作不是改表，而是把“数据库文件、数据库之外的持久化文件、凭证、
运行时租约”归到同一套 Profile 边界下。

## 2. 术语与边界

| 术语 | 含义 | 不是它 |
|---|---|---|
| Machine | 当前安装、当前 `userData` 根目录对应的一台机器 / 一个本地安装 | 账号、组织或服务器 membership |
| Profile | 本地稳定的账号容器；持有一个 Data Owner 的本地数据、配置与凭证命名空间 | 一次窗口、一个 renderer、一个登录请求 |
| Data Owner | 服务端确认的 membership / owner id；用于服务端权限和数据归属 | `profileId`，也不应直接作为文件名 |
| Profile DB | 一个 Profile 的 SQLite 数据库，包含该 Profile 的业务数据 | 机器级缓存或机器注册表 |
| Runtime Lease | 防止同一 Profile 被多个进程同时运行的短期租约 | 任务历史、消息或账号配置 |
| Machine Registry | 登录前即可读取的 Profile 目录与运行时协调控制面 | refresh token、业务消息 |

`profileId` 是本地生成的 opaque id；`dataOwnerId` 是服务端身份。两者必须分开，避免
“重新登录同一账号”“membership 变化”“本地 Profile 重命名”互相改写文件路径。

## 3. 现状盘点

当前 Desktop 已经是“按账号分数据库文件”的模型：

```text
<userData>/<dbFilePrefix>-<userId>.db
```

`localDb/index.ts`、`localDb/client/current.ts`、`authManager.ts`、Scheduler、Maker、
IM、Device Link 等仍是模块级单例。切账号时是 teardown 旧 owner，再打开新 DB，而不是
同一进程同时拥有多个数据库上下文。

数据库以外已经存在一部分 owner 命名空间：

```text
<userData>/owners/<hash(dataOwnerId)>/...
```

但仍有一些持久化路径直接落在 `<userData>` 根目录，例如历史 auth session、部分
Device Link 设置、layout / provider runtime 文件、媒体字节仓和旧集成缓存。它们与 SQLite
按账号分文件的语义并不完全一致，这正是未来多账号最容易串号的地方。

## 4. 目标分层

### 4.1 Machine Registry：独立小型 SQLite

选择独立 SQLite，而不是 JSON，原因是未来会同时有多个 Profile 进程，需要原子地完成：

- Profile 创建、删除、默认 Profile 与最近打开时间更新；
- 同一账号去重；
- 启动前抢占 / 释放 Profile Runtime Lease；
- 崩溃后的过期租约接管；
- 多进程并发写入不丢字段。

建议路径：

```text
<userData>/profile-registry.sqlite
```

建议逻辑表（不是本阶段要直接创建的 schema）：

```text
profiles
  profile_id TEXT PRIMARY KEY                 -- 本地 opaque UUID
  data_owner_id TEXT                          -- cloud membership；local 模式使用 `local-v1`
  auth_realm TEXT                              -- 观测到的 auth realm，仅用于校验/诊断
  display_name TEXT NOT NULL
  status TEXT NOT NULL                         -- active / signed_out / needs_login / deleting
  storage_mode TEXT NOT NULL                   -- legacy_user_db / profile_dir
  legacy_user_id TEXT                          -- 兼容旧 <prefix>-<userId>.db，迁完可为空
  created_at INTEGER NOT NULL
  last_opened_at INTEGER
  last_verified_at INTEGER

profile_runtime_leases
  profile_id TEXT PRIMARY KEY
  lease_id TEXT NOT NULL
  pid INTEGER NOT NULL
  started_at INTEGER NOT NULL
  heartbeat_at INTEGER NOT NULL

machine_meta
  key TEXT PRIMARY KEY
  value TEXT
```

约束：

- cloud Profile 对 `(auth_realm, data_owner_id)` 建唯一约束，保证一个账号只有一个本地
  Profile；local Profile 使用固定的 `LOCAL_DATA_OWNER_ID` 语义。
- Registry 不存 access token、refresh token、OAuth code、API key 或私钥。
- 不存任意用户可控绝对路径；Profile DB 路径由 `profile_id` 派生，旧库路径只通过
  `storage_mode + legacy_user_id` 兼容。
- `auth_realm` 不是账号隔离键，更不是用户可修改的区域选择；它只用于阻止跨 realm
  误用凭证和帮助诊断。

### 4.2 Profile DB：默认保持一库一 Profile

目标路径：

```text
<userData>/profiles/<profileId>/profile.db
```

在兼容阶段，已有库可以继续使用：

```text
<userData>/<dbFilePrefix>-<legacyUserId>.db
```

Registry 将该文件登记为一个 Profile 的 legacy storage，不在首次迁移时复制或重写大库。
新建的 Profile 使用 `profiles/<profileId>/profile.db`；旧 Profile 后续可单独做可回滚的
物理搬迁。

Profile DB 的规则：

1. 业务表默认都属于当前 Profile，不加重复的 `owner_id`。
2. 表间 FK 继续在同一 DB 内表达，删除和事务语义不改变。
3. 跨 Profile 的导入 / 分享必须通过显式 envelope 携带来源 Profile 与授权信息，不能
   直接把一张业务表当作跨账号共享表。
4. `DbClient` 必须绑定 `profileId` / scope key；未绑定 Profile 的查询 fail closed。
5. DB 内的 `migration_meta`、`migration_history` 仍是该 DB 的 schema 控制面，不搬到业务
   表，也不承担 Machine Registry 的职责。

跨账号实时协作不是 Profile DB 的隐式能力。未来若需要账号 A 与账号 B 共同访问同一个
任务，应单独建立 Shared Workspace / Shared Task 层和 ACL；Profile DB 只保存私有数据或
受控镜像，不能因为两个账号在同一台机器上就自动互相可见。

### 4.3 Runtime / Lease State：与业务数据分开

同一 Profile 的多个进程必须有单一 active runtime。Runtime Lease 位于 Machine Registry
或等价的机器级 broker 中，按 `profile_id` CAS + heartbeat 处理；它不应与 sessions、
messages 等业务表混在一起。

现有 `device_link_ownership` 的行为仍然需要保留，但目标是把它看成 Profile Runtime Lease，
而不是账号业务数据：

- 旧库阶段可以继续使用该表完成兼容仲裁；
- 新架构由 `profile_runtime_leases` 统一承载；
- Lease 失效只影响进程 / Device Link 连接，不删除 Profile 数据；
- 不同账号的 Profile 不共享同一行，也不互相顶号。

### 4.4 Machine Shared Cache：默认不承载用户内容

机器级缓存可以共享 agent 二进制、模型下载、插件包和明确可再生的公开缓存，但必须满足：

- 缓存本身不表达账号归属；
- 任何用户内容的归属由 Profile DB ledger / refs 表达；
- 没有 Profile 授权时，缓存命中不能直接成为可读权限；
- 共享缓存不能绕过现有安全协议与内容授权。

第一阶段不把私人媒体字节做跨 Profile 共享。这样可以保持媒体读取与 Profile DB 的权限
一致，避免“知道 hash 就能读取另一个账号媒体”的隐患。需要共享媒体时，另建机器级
cache ledger 和授权协议，不把它作为本次数据库改造的顺手优化。

## 5. Ownership Matrix

“是否需要 `owner_id`”按目标架构回答，不按当前文件布局回答：Profile DB 本身已经是
owner 边界，所以大多数行答案是“否”。

| 表 / 虚表 | 当前归属 | 目标归属 | `owner_id` 列 | 后续迁移 |
|---|---|---|---|---|
| `sessions` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `messages` / `messages_fts` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `session_pr_refs` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `session_goals` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `orca_teams` / `orca_workers` / `orca_worker_creation_reservations` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `schedules` / `schedule_runs` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `im_bindings` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `wechat_sync_state` / `wechat_inbox` / `wechat_outbox` / `wechat_file_attachments` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移；凭证与 staging 路径需按 Profile 收口 |
| `recent_workdirs` / `project_aliases` / `project_automation_consents` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `right_sidebar_tabs` / `agent_input_queue_snapshots` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `account_usage_snapshots` / `daily_spend` / `daily_model_usage` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `embedding_jobs` / `embedding_meta` / `vec_table_meta` / `chat_messages_vec_v1` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `skill_usage_sources` / `skill_usage_exposures` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移；raw transcript 路径必须按 Profile 可解析 |
| `custom_providers` / `custom_mcp_servers` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移；secret key 迁到 Profile namespace |
| `media_refs` | 当前账号 DB | Profile DB | 否 | 保持 ledger 语义；路径与协议改造另行设计 |
| `media_blobs` | 当前账号 DB 元数据；字节仓当前落在 userData 根下 | Profile DB 元数据 + Profile 私有媒体仓 | 否 | 需要单独的媒体路径兼容迁移，不能直接共享现有根目录 |
| `ghost_cards` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移 |
| `hook_group_messages` | 当前账号 DB | Profile DB | 否 | 无 schema 迁移；hook 连接配置需按 Profile 收口 |
| `device_link_ownership` | 当前账号 DB 中的单行运行时仲裁 | Runtime Lease（按 Profile） | 否 | 后续把租约抽到 Registry / broker；旧表兼容期保留 |
| `migration_meta` / `migration_history` | 当前账号 DB 控制面 | 各 Profile DB 控制面 | 否 | 保持现有 append-only 规则 |

### 5.1 特殊边界

#### 媒体

`mediaBlobs` 是内容寻址元数据，`mediaRefs` 是归属与生命周期账本。当前物理字节在
`<userData>/cindy-media`，这在多 Profile 下不应继续作为默认写入位置。第一阶段目标是
把字节仓也放进 Profile 私有目录；内容寻址仍可在同一 Profile 内去重。跨 Profile 共享
字节属于另一个“机器缓存 + 授权 ledger”问题，不能只把 `mediaBlobs` 搬到共享 DB。

#### Device Link

Device Link 的 relay 身份和本地授权都跟 Profile / Data Owner 绑定。`device_link_ownership`
不是消息数据；它的长期归属是 Runtime Lease。即使多个账号并行运行，也只能在各自 Profile
范围内仲裁，不应使用一个全局单行表把不同账号串在一起。

#### Embedding

embedding job 的 `source_id` 通常指向 message / document 等 Profile 内容；向量表和
元信息也必须跟随 Profile。机器级模型缓存可以共享，但向量结果不能共享为无 owner 的全局
数据。

#### Provider / MCP

`custom_providers` 与 `custom_mcp_servers` 继续只保存非秘密配置；API key、OAuth 凭证、
MCP token 仍走 safeStorage。未来 safeStorage 的物理 key 应以 `profileId` 命名空间隔离，
并通过兼容映射读取现有 `dataOwnerId` 命名空间，不能要求用户重新填写密钥。

## 6. 数据库之外的必须同步收口项

这部分不是本阶段的实现，但它决定多账号是否真正安全：

| 当前形态 | 目标 | 备注 |
|---|---|---|
| auth refresh session / realm 在 userData 根目录 | Registry 只保存 Profile 元数据；凭证落 safeStorage 的 Profile namespace | 不因新 Profile 覆盖旧 Profile token |
| `owners/<hash(dataOwnerId)>` | `profiles/<profileId>/...` 为 canonical；旧 owner 路径作为迁移 alias | 保留 `dataOwnerId` 作为服务端身份 |
| `device-link-settings.json` 根目录 | 每个 Profile 一份；机器级偏好与账号授权拆开 | `keepAwake` 这类机器偏好可另留 Machine 层 |
| `cindy-media/` 根目录 | Profile 私有媒体仓；可再生共享缓存另行设计 | 不能让 hash 直接跨 Profile 可读 |
| layout / provider runtime / hook / IM 辅助文件 | 按其语义明确标为 Profile 或 Machine | 不能因为“只是 JSON”就默认共享 |
| Agent / model / plugin 下载缓存 | Machine Shared Cache | 缓存命中不等于账号授权 |

此外，跨物理设备的“互相登出”不由本地 Profile DB 单独解决。服务端需要按设备 / 登录会话
维护独立 refresh-token family；普通 logout 只撤销当前 family，“退出所有设备”才撤销全部
family。客户端收到当前 family 失效时，只清理当前 Profile。

## 7. Legacy 兼容迁移顺序

迁移必须先建立边界，再搬数据；不做“一次性把所有文件移动到新目录”的大迁移。

1. **引入 Registry（不动现有 Profile DB）**：首次成功验证已有 refresh session 后，创建
   一个 Profile 记录，绑定 `dataOwnerId`，并把现有 `<prefix>-<userId>.db` 登记为
   `legacy_user_db`。用户不需要重新登录。
2. **统一 Profile Context**：运行时从 Registry 选择 Profile，`DbClient`、auth、secret
   store、Scheduler、Maker、IM、Device Link 全部接收同一个 Profile scope。
3. **新账号走新目录**：新建账号使用 `profiles/<profileId>/profile.db` 和 Profile 私有
   文件树；旧 Profile 继续读旧文件，直到对应迁移完成。
4. **按模块迁移旁路存储**：凭证、IM、hook、Device Link 授权、layout、媒体等逐项做
   可重试、可回滚、幂等迁移；每项都保留旧路径只读兼容窗口。
5. **最后再考虑物理搬迁旧 DB**：确认所有运行时与备份工具都支持新路径后，才将 legacy
   DB 改名或移动。这个动作不是多账号上线的前置条件。

任何迁移都必须满足：

- 不丢聊天、附件、Provider 配置或已有 safeStorage 凭证；
- 不因切换 Profile 删除另一个账号的 refresh token；
- 失败可重试，重复执行不产生第二份数据；
- SQLite schema 变化仍只用 Drizzle 追加 migration，并通过 `db:validate` 与 replay；
- 未合入 migration 不连接共享 userData，使用隔离数据库验证。

## 8. 暂不做的事情

- 不给 `sessions`、`messages`、`schedules` 等所有表批量加 `owner_id`。
- 不在一个主进程中把多个账号的 DB client / Scheduler / Maker 单例强行改成多租户容器。
- 不把 CN / Global 当作 Profile 维度，也不增加用户选择区域的入口。
- 不把 refresh token、OAuth 凭证、Provider key 放入 SQLite。
- 不在本阶段新增业务功能、账号切换 UI 或多账号并行启动流程。
- 不为了“统一目录”直接移动用户现有数据库或媒体文件。

## 9. 验收不变量

后续实现多账号时，至少必须保持：

1. 任意运行时只打开一个 Profile DB；DB client 的 scope 与 Profile Registry 选择一致。
2. 同一 `(auth_realm, data_owner_id)` 只有一个 Profile 记录。
3. 同一 Profile 同时最多一个 active Runtime Lease；崩溃后只能按 heartbeat / CAS 接管。
4. Profile A 的查询、凭证、媒体 URL、Device Link 事件不能在 Profile B 可见。
5. 手机 / 远程控制请求必须携带并校验目标 Profile / Data Owner 路由，不能只靠当前全局
   `currentUser` 猜测。
6. Profile DB 业务表继续保持无 `owner_id` 的单 owner 语义；跨 Profile 操作必须显式授权。
7. 旧用户升级后什么都不做，现有聊天、配置和凭证继续可用。

## 10. 本阶段交付边界

本阶段已先落下不依赖 Electron／真实用户目录的 Registry 纯模型：
`apps/desktop/src/main/profile/profileRegistryModel.ts` 负责 Profile 描述、账号唯一性、
旧库路径派生、Profile DB 路径派生和凭证字段 allow-list；对应测试位于
`apps/desktop/src/main/profile/__tests__/profileRegistryModel.test.ts`。它还不是
`profile-registry.sqlite` 的运行时实现，也不改变现有 `localDb` 打开路径。

下一步仍应为 Registry SQLite 适配器、Profile Context、Runtime Lease 和旁路文件建立单独
任务；在这些边界得到实现验证前，不应创建新的业务表或批量 migration。
