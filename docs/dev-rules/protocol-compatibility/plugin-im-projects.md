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

账号、目录与执行位置沿用宿主所有权：远程模型只改变 Agent 执行位置，项目和任务仍属于插件宿主。
远程控制与手机页面仍经宿主原管子校验；没有新增跨端 IPC 或中转 payload。没有重连或共享连接重置。

旧 Host 不认识新方法和字段，插件必须检查能力并提示升级，不静默退回另一套模型或另一台电脑。
新 Host 不改变旧请求、旧回执指纹和批准记录；新增项目访问沿用独立 targets 批准，无存量迁移。
发布顺序为支持能力的客户端先到，插件随后启用；不能只更新插件便宣称运行态已接入。

回归入口：`taskSlot.test.ts`（协议与批准）、`pluginTaskService.test.ts`（创建回放、接续、权限与目录边界）、
`session-runner.test.ts`（未连接官方渠道时仍读取 shared 配置）。微信包装插件另有项目选择、旧创建回执恢复、
群隔离、归档与引用消息测试。插件外部仓与客户端各自维护，无需修改微信原生内核。
