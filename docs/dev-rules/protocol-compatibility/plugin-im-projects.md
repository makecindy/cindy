# 插件 IM 共用项目与模型

状态：客户端增量能力，尚未发布。无服务端协议或数据库 migration。

`tasks.capabilities().imProjects === true` 后，已批准 `agent.tasks` 与 `agent.targets`
的插件可调用 `tasks.imProjects()`，获得插件宿主电脑侧栏项目与内置 `chat`。项目 ID 是
本机登记的目录，名称跟随侧栏；不枚举其他电脑的项目，不接收任意目录。
首次使用已声明但尚未批准的 targets 时，复用现有 Host 项目访问确认；拒绝、账号变更或确认失败均不授予访问。

- `tasks.create({requestKey,title,imProject})` 按共用 IM 设置创建任务。不能同时指定
  route、permissionMode、callId 或 isolatedWorkspace。创建键按项目选择签名；重试返回原任务，
  不因模型设置变化重复创建。chat 分配独立对话目录，真实项目使用该目录。
- `tasks.followImProject({taskId,expectedRevision,imProject})` 只更新插件自己空闲的任务。
  模型、供应商、远程执行来源、推理强度与权限来自官方机器人同一解析器。项目不匹配返回
  `PROJECT_MISMATCH`，由插件按自己的会话规则新建，不能搬动旧任务或混入它的历史。
  当前配置和安装批准在异步读取、模型修改、权限修改及发送时复核。Plan Mode 不被隐式关闭。
  同时换 Agent 与权限时，先完成普通空闲任务的引擎交接，再由目标 Agent 的权限写入口应用新档位，
  不让旧 Agent 拒绝只在目标引擎上存在的合法权限；交接未完成不改旧引擎权限。
- 项目关联保存在已有创建回执 JSON 的可选 `imProject` 字段；派发再次核验项目成员关系与当前
  权限上限。没有该字段的旧任务保持原行为。插件自己的任务配置卡仍启用时，其权限上限照旧生效；
  共用配置的插件可声明已有 `showTaskPreferences:false`，不删除曾保存的偏好。

## 按群聊／私聊覆盖与放宽确认（2026-11-18 增量）

`tasks.capabilities().imProjectOverrides === true` 后（同样要求已批准 `agent.targets`）：

- `tasks.imProjectConfig({imProject})` 返回 `{imProject, route, permissionMode}`，即此刻「跟随 IM」
  解析到的设置，供插件页面显示；只读，不改任务。
- `create` 与 `followImProject` 可带 `imOverride: {route?, permissionMode?, permissionGrant?}`，只在带
  `imProject` 时有效。省略的字段跟随项目；目录始终跟随项目。route 按 `create` 的完整 route 当次校验，
  不可用返回 `ROUTE_UNAVAILABLE`，不换来源。覆盖只改插件自己这个任务，不写共用配置。
- 权限与项目相同或更严时直接生效。比项目更宽时必须带 `permissionGrant`，由
  `tasks.confirmImPermission({imProject, permissionMode, conversation:{label, kind}})` 换取：Host 弹出
  Cindy 自己的确认框（`mobilePageId` 来的显示在手机上），写明插件、群聊或私聊名、项目、目标权限和项目
  当前权限，群聊附成员可控内容提醒；插件页面画不出、点不到。允许返回 `{granted:true, grant}`，拒绝
  返回 `{granted:false}`，同一时间只开一个框（`TASK_BUSY`）。不比项目宽时直接返回 `{granted:true}`，
  不弹框。插件自己的 Host 任务卡启用时，其上限照旧生效（超出返回 `PERMISSION_DENIED`，不弹框）。
  这是「完全访问只来自插件设置」的有意例外，见插件安全规则里「完全访问」一条的 2026-11-18 例外。
- 授权存在 `plugin_task_requests`（operation `imPermission`，target 为项目 id，request key 为授权 id，
  payload 只有 `permissionMode`），绑定插件实例与项目；`conversation.label` 只用于显示，不落盘。
  没有授权、授权属于别的插件或项目时返回 `CONFIRMATION_REQUIRED`。卸载时与任务回执一起标记
  `ownershipRevoked`，重装要重新确认；插件更新、迁移实例时保留。operation 是 TypeScript 枚举，
  没有数据库 migration；旧 Host 按 operation 查询，看不到这些行。
- 权限确认只读取项目身份和权限，不依赖项目默认模型可用。
- 正在使用的授权 id 写进创建回执的可选 `imPermissionGrant`；派发时任务权限不得超过项目权限与授权
  权限中更宽的那个。改回跟随项目后清除该字段。没有该字段的旧回执行为不变。
- 创建键签名不含 `imOverride`：同一键改了覆盖后重试返回原任务，不报 `IDEMPOTENCY_CONFLICT`，
  之后用 `followImProject` 应用新覆盖。

## IM 入口声明 `imEntrance`

manifest 顶层 `imEntrance: true`（需同时声明 `agent.tasks` 与 `agent.targets`；桌面与
`@cindy/plugin-protocol` 两个 manifest reader 同一规则）只影响展示：已启用的此类插件出现在
「设置 → IM 机器人」的「插件」分栏（打开插件页），「项目与模型」在没开官方机器人时也显示；本地模式
没有官方分栏时，这一块随「插件」分栏显示。不新增权限项，加上它的插件更新不产生新的安装确认；
旧 Host 把它当未知字段保留。新包继续严格校验，历史清单保留此前同名扩展的原值，界面只识别
布尔值 true 且已声明 tasks 与 targets 的插件。

账号、目录与执行位置沿用宿主所有权：远程模型只改变 Agent 执行位置，项目和任务仍属于插件宿主。
远程控制与手机页面仍经宿主原管子校验；没有新增跨端 IPC 或中转 payload。没有重连或共享连接重置。

旧 Host 不认识新方法和字段，插件必须检查能力并提示升级，不静默退回另一套模型或另一台电脑。
新 Host 不改变旧请求、旧回执指纹和批准记录；新增项目访问沿用独立 targets 批准，无存量迁移。
发布顺序为支持能力的客户端先到，插件随后启用；不能只更新插件便宣称运行态已接入。

回归入口：`taskSlot.test.ts`（协议与批准）、`pluginTaskService.test.ts`（创建回放、接续、权限与目录边界）、
`session-runner.test.ts`（未连接官方渠道时仍读取 shared 配置）。按群聊／私聊覆盖与放宽授权见
`pluginTaskService.test.ts`，卸载撤销授权见 `pluginTaskStorePagination.test.ts`，`imEntrance` 双 reader 与
权限项见 `shared/__tests__/ghost.test.ts`，设置页显示见 `HookConnectionsSection.test.tsx`。
确认框本身在 `register.ts`，暂无自动化覆盖。微信包装插件另有项目选择、旧创建回执恢复、
群隔离、归档与引用消息测试。插件外部仓与客户端各自维护，无需修改微信原生内核。
