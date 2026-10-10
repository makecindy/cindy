# 协同扩展：Worker 在另一台电脑运行

> 状态：产品决策已定（2026-10-09，见 §5），分三步实现，不是产品规则。
> 三步均已实现，待验收：运行设备侧支持与 schema、Lead 侧编排与 Agent 工具、协同面板界面。
> 协议见 `docs/dev-rules/protocol-compatibility.md`「协同远端 Worker」，运行时契约见
> `docs/dev-rules/orca-team-architecture.md`「远端 Worker」。界面首版只在本机 Lead 上提供「运行设备」；
> 被远程控制的 Lead 仍可由它自己的 Agent 经 `execution_device_id` 创建；SSH 主机上的 Lead 不支持。
> 来源讨论：issue #5620「远程控制功能疑问」→ 跨设备派活。

## 1. 结论

跨设备派活不再单独做一套「委托」，改为扩展协同（Orca）：**Lead 留在发起的电脑，单个 Worker
可以指定在同账号的另一台电脑上运行**。Worker 的任务、工作目录、命令和文件都在那台电脑；
团队、派活记录与回报仍归 Lead 所在的电脑。

这样可直接复用协同已有的派活、自动回报、排队、打断、完成判定和协同面板，用户只需理解一套协同。

交互原型：`docs/design-previews/cross-device-delegation/index.html`（协同面板版）。
此前「独立委托」的两版原型（聊天派发、输入框选设备）已被本方案取代，不入库。

## 2. 现状核对

| 问题                                         | 现状                                                                                                                                         | 依据                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Worker 能否指定其他主机或电脑                | 不能。Worker 一律继承 Lead 的位置                                                                                                            | `orcaWorkerCreationService.ts` 的 `OrcaLeadSessionSnapshot` 与 worker 创建参数 |
| SSH 远端                                     | Worker 继承 Lead 的 `remoteHostId`，在同一台远端主机运行                                                                                     | `orca-team-architecture.md`                                                    |
| 远程控制（device-link）                      | Lead、Worker、团队全部在被控端，控制端只是镜像                                                                                               | 同上                                                                           |
| `create_worker` 的 `working_dir`             | 只能选「Worker 所在主机」，即 Lead 所在的机器                                                                                                | 同上                                                                           |
| 已有的「远程 Agent」                         | 只借用另一台电脑的 Agent 程序、登录与供应商；**命令与文件仍在本机**。Worker 继承 Lead 的 `agentDeviceId`，不能单独指定                       | `protocol-compatibility.md`「远程 Agent」；`orcaWorkerCreationService.ts`      |
| 被控的电脑能否同时控制另一台                 | 能。远程 Agent 就是 A 作为发起方驱动 B；当前开发会话即为实例：XD-PC 被手机控制，同时把 Agent 放在另一台电脑运行                              | `apps/desktop/src/main/remote-agent/controller/`                               |
| 在另一台电脑新建任务、发消息、订阅事件的通道 | 已在同账号 allowlist：`maker:create-session`、`maker:send`、`maker:abort-session`、`maker:input:*`、`maker:event`、`maker:mark-orca-role` 等 | `packages/device-link/src/allowlist.ts`                                        |

> 2026-10-10 更新：上表「Worker 继承 Lead 的 `agentDeviceId`，不能单独指定」已改变。用户裁决远程供应商的使用和
> 表现与本机供应商一致，Worker 的 Agent 位置(远程供应商)可以单独指定、缺省跟 Lead；运行设备 Worker 仍与之互斥。
> 现行规则见 [`dev-rules/orca-team-architecture.md`](dev-rules/orca-team-architecture.md)「Worker 的 Agent 位置」。

**需要分清两个概念**，界面文案必须区分：

- **Agent 所在电脑**（已有）：模型与登录在那台，干活还在本机。
- **Worker 运行设备**（本方案新增）：整个 Worker 任务在那台运行，包括目录、命令和文件。

本方案首版不允许两者叠加。

## 3. 用户看到的行为

### 3.1 创建

- **手动创建**：协同面板的「创建 Worker」卡增加「运行设备」，默认「这台电脑」。列表只显示
  同账号、在线、已开启「允许远程控制」且版本支持的电脑；版本过旧的显示为不可选，并提示更新。
- **Lead 创建**：`create_worker` / `create_workers` 增加可选参数 `device`，取值必须来自新增的只读
  工具或 `get_workspace_info` 返回的设备列表（设备 id），由程序校验在线状态、版本与授权，不接受
  名称模糊匹配。模型只能在已列出的设备里选，不能自行描述设备。
- 选择其他设备时，`working_dir` 指那台电脑上的目录：不填则由那台按自身设置分配任务目录；
  填写则在那台检查，不存在或不可用时报错，不换目录、不回退到本机。
- 初始任务原样发给那台的 Worker 任务。手动入口由用户书写；Lead 入口由 Lead 书写，
  与本机 Worker 一致。

### 3.2 运行中

- 协同面板的 Worker 行显示设备名与连接状态，例如「Mac mini · 运行中」。
- 点开 Worker 查看的是那台电脑上的任务，复用现有远程任务视图。
- Worker 需要授权确认时，在 Lead 所在电脑可见并可处理，沿用远程任务的确认链路；
  那台电脑本机同样能看到。
- 目标电脑上，这个任务出现在侧栏，标注「来自 XD-PC 的协同」，按 Worker 处理：
  不能再开启协同，不能复制到其他电脑；显示实际权限档（沿用 A 的 Worker 创建偏好）。
- 用户可以在目标电脑上直接给这个任务发消息，按用户插话处理，不算 Lead 派活、不产生回报。

### 3.3 回报与继续

- Worker 一轮结束后，沿用 auto-bridge：取那台任务的最后回复，作为回报送入 Lead 队列，
  Lead 被唤起后继续。Lead 忙时排队；Lead 已停止时回报保留，不自动启动。
- 「团队是否完成」沿用 Main 的待回报判据：远端 Worker 的派活同样登记待回报，
  回报送达或被丢弃后才算完成。
- 同一轮结果重复到达只送一次，以远端轮次标识去重。

### 3.4 断线与停止

| 情况                 | 行为                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| 目标电脑离线         | Worker 显示「暂时无法获取状态」，保留最后已知状态；不判失败、不重派     |
| 重新连上             | 读取远端任务实际状态与最后回复，补发缺失的回报，已送达的不重复          |
| 派活时目标离线       | 派活直接失败并告知 Lead，不排队等对方上线（首版）                       |
| `idle_worker` / 停止 | 停止远端当前轮，远端任务与记录保留                                      |
| `archive_worker`     | 归档团队里的 Worker；远端任务保留，标注协同已结束，由用户在那台自行处理 |
| 停止 Lead            | 不影响远端 Worker 运行，回报保留                                        |

## 4. 技术方案

### 4.1 归属

- 团队、Worker 记录、待回报和派活队列都在 **Lead 所在电脑**（以下称 A）。
- Worker 的任务在**运行设备**（以下称 B）上，是一条普通任务，带 `sessions.orca_remote_lead` 标记。
  不复用 `orca_role='worker'`：那会把任务从 B 的侧栏隐藏，且 B 上没有对应的 `orca_workers` 关联。
- A 以同账号控制端的身份驱动 B，与远程 Agent 的方向一致。
- 用户从手机或另一台桌面控制 A 时，仍由 A 编排；控制端只看到 A 推送的 Worker 变化，
  新增的设备字段为可选，旧控制端忽略即可。

### 4.2 复用的通道

建任务与结束协同用新增 channel(裸 `local-db:sessions:create` 不开放远程，普通
`maker:create-session` 无法写来源标记)；其余组合已有同账号 channel：

| 动作                  | 通道                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| 能力探测              | `maker:orca:remote-worker:caps`(旧版 → `CHANNEL_NOT_ALLOWED` → 显示需要更新)         |
| 在 B 创建 Worker 任务 | `maker:orca:remote-worker:open`(幂等；来源取 server 盖章的 src)                      |
| 结束协同              | `maker:orca:remote-worker:release`                                                    |
| 派活、补充            | `maker:input:enqueue`(按 `item.clientId` 幂等，`maker:input:get-projection` 查回执) |
| 打断、停止            | `maker:abort-session`                                                                |
| 运行状态与轮次结束    | 轮询 `maker:list-active`(每台设备一次，带 `isTurnRunning`)                           |
| 可选运行设备          | `maker:orca:execution-devices`(A 本机与控制端共用，只读)                              |
| 最后回复              | `local-db:history:messages`(assistant、倒序、取 1 条)                                |
| 授权确认              | 现有远程任务确认链路                                                                 |

### 4.3 A 侧改动

- **数据**：Orca Worker 记录新增 `execution_device_id`（空 = 本机）、`remote_session_id`、
  `last_bridged_message_id`、`remote_released_at`（migration 0124）。本机只留一条不跑 Agent、
  没有目录的代理任务行，承接计槽、归档与回报；旧版本读不到这些列时按本机 Worker 处理。
- **创建**：`orcaWorkerCreationService` 增加设备分支：校验设备（在线、版本、同账号、非共享访客）、
  在 B 校验目录、创建任务并标记角色。与 `remoteHostId`、`agentDeviceId` 互斥，冲突时报错。
- **派活**：`OrcaTeamService` 的会话依赖按「是否远端 Worker」分流（`orcaRemoteWorkers.ts` 的
  `wrapTeamDeps`）；accepted 回调、clientId、持久化与 `activeWorkerDispatches` 计数保持同一套，
  不另造状态机。
- **回报**：轮询发现派出的消息已进入对话且设备不在跑时，取最后一条 assistant 消息交给 auto-bridge；
  按消息 id 去重（`last_bridged_message_id`），断线重连后补报，同一条只报一次。
- **恢复**：轮询代替订阅（Main 侧没有可复用的订阅入口）；断线按 `remote-and-mobile-adaptation.md`
  的「故障半径三问」，只影响该设备上的 Worker，不重建 link、不影响其它设备和普通远控。
- **工具**：`create_worker` / `create_workers` 新增 `execution_device_id`；`get_workspace_info`
  返回 `execution_devices` 与每个 Worker 的 `execution_device`；归属校验 `resolveWorkerRef` 不变。

### 4.4 首版不支持

- 远端 Worker 主动调用 `send_to_lead`。它在 B 上，没有到 A 的 Worker 桥；只靠 auto-bridge 回报，
  与 SSH 多实例降级时一致。后续可经新 channel 补上。
- 文件交接（见 §5 决策 1）。
- 远端 Worker 与 SSH 主机、远程 Agent 混用。
- 共享任务访客创建远端 Worker。
- Mobile 作为运行设备（手机不运行 Agent）。

## 5. 已定决策（2026-10-09）

1. **文件交接不进首版。** 首版只处理运行设备上已有的文件；「本机文件交给另一台处理、成果传回」
   放到第二阶段，届时沿用此前定下的交接语义：传的是副本、校验通过才开始、成果显式列出后回传。
2. **用户在 B 上直接给 Worker 任务发消息：允许。** 按用户插话处理，不算 Lead 派活，
   不登记待回报，也不单独触发回报；回报只跟 Lead 的派活走。
3. **派活时 B 离线：直接失败。** 告知 Lead 与用户设备不可达，不排队等对方上线。
4. **权限档沿用 A 的 Worker 创建偏好**，与本机 Worker 同一套规则；B 上的任务显示实际权限档。
5. **不新增授权开关。** B 开启「允许远程控制」即可被选为运行设备；未开启的电脑不出现在列表里。

## 6. 分期

| 阶段 | 内容                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 一   | 桌面对桌面、同账号；手动与 Lead 两个入口；目录在目标电脑；auto-bridge 回报；断线对账；协同面板显示设备 |
| 二   | 文件交接与成果回传；远端 `send_to_lead`；手机控制端展示设备信息                                        |
| 三   | 视需要：派活离线排队、SSH 与设备混用                                                                   |

## 7. 实现前必读

- `docs/dev-rules/orca-team-architecture.md`
- `docs/dev-rules/protocol-compatibility.md`（远程 Agent、device-link allowlist）
- `docs/dev-rules/remote-and-mobile-adaptation.md`（故障半径三问）
- `docs/dev-rules/database-and-migrations.md`
- `docs/product-rules/task-device-migration.md`（跨电脑任务的既有口径）
- 界面改动：`docs/design-rules/DESIGN.md`；术语：`i18n/GLOSSARY.md`（「设备」「远程电脑」「Worker」「Lead」）
