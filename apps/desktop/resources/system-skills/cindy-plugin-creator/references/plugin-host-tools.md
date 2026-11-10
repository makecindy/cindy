# 插件调用宿主工具 cindy.host.call

插件可直接调用普通任务中 Agent 使用的宿主工具。宿主复用相同的工具处理器、数据范围和风险规则；插件没有当前任务，不借用其它任务身份。此接口与仅管理本插件所建任务的 `cindy.tasks` 分别声明。

## 声明与批准

```json
"agent": { "hostTools": ["history", "control", "scheduler"] }
```

| 组 | 服务 | 用途 |
| --- | --- | --- |
| `history` | `cindy_helper` | 任务列表、历史与搜索 |
| `control` | `cindy_helper` | 任务运行与管理 |
| `handoff` | `cindy_helper` | 工具目录中归属此组的协作能力 |
| `settings` | `cindy_helper` | 应用设置与运行配置 |
| `scheduler` | `cindy_scheduler` | 定时任务管理 |

每组在安装、更新确认和详情页各列一行权限。新增组需要批准；移除组立即收权。旧安装记录不会自动获得新能力，首次调用可请求宿主确认。用户拒绝后由详情页手动重试，插件不要循环请求。未知组按 Manifest v3 原样保存，当前宿主不授权。

## 调用与结果

逻辑页与随包 Node 工作进程使用同名接口：

```js
const result = await cindy.host.call('cindy_helper', 'list_sessions', { limit: 10 });
const schedules = await cindy.host.call('cindy_scheduler', 'schedule_list', {});
// archive_sessions 的参数和风险判定与 Agent 工具一致。
const archived = await cindy.host.call('cindy_helper', 'archive_sessions', {
  session_ids: [selectedSessionId]
});
```

返回值是原始 MCP 工具结果，包括 `content`、`isError` 和工具提供的其它字段；不添加 `data` 包装。可解析文本内容中的 JSON，但须先检查错误。接口不存在时提示宿主不支持；不要改用插件读写宿主文件。

依赖当前任务的工具必须显式传其目标参数（例如 `session_id` 或 `target_session_id`，以工具参数定义为准）。省略时保留 `NO_SESSION_CONTEXT` 等原工具错误；宿主不会替插件挑选任务。参数、设备寻址与返回结构均沿用对应 Agent 工具，可查该版本的 `list_tools` / `tool_schema`。插件能见的范围与普通用户任务一致，包含工具本身支持的跨设备范围。

组批准后，`auto-approve` 工具直接执行；其余工具由宿主原生确认展示插件名、工具和参数，仅允许本次调用。取消、窗口不可用、账号切换、安装更新、停用或卸载均使旧请求失效。插件没有可继承的任务权限档，不能要求永久允许高风险操作。

本入口仅支持上述两项服务的已声明组。插件管理（`ghost_*` 等）、主人代输入或 `ask_owner`、应用更新和反馈不开放。Node 子进程不提供此 API；应由声明的插件 Node 工作进程调用。

底层管子消息为 `{type:'host-tool-request',server,tool,args}`。身份由宿主从逻辑页或 Node 私有通道核验，不接受参数中的 `pluginId`、`sessionId` 或账号作为调用方身份。旧宿主和未提供此能力的执行宿主应按不支持处理。

## 定时任务与应用设置

`scheduler` 组直接复用 `cindy_scheduler` 的完整管理工具：`schedule_create`、`schedule_update`、
`schedule_pause`、`schedule_resume`、`schedule_delete`、`schedule_run_now` 与 `schedule_list_runs`。
参数和执行位置沿用原工具；插件没有当前任务，不能用 `bindToCurrentSession:true`，
需要绑定时显式传 `targetSessionId`。运行记录由 `schedule_list_runs({scheduleId})` 读取。
删除及其它由宿主判为逐次确认的调用须等待原生确认；回执不明时先查询，不自动重试写操作。

`settings` 组使用 `list_app_settings` 发现分类，再用 `get_app_settings({section})` 读取当前值和修改 schema，
最后调用 `update_app_settings({section,patch})`。省略的字段保持原值，写入复用设置页的保存与生效路径；
秘密值不返回，也不能通过此工具提交密码或密钥。插件自己的偏好设置仍由插件设置界面管理。

## 删除、分叉与检查点

`control` 组的 `delete_session({session_id})` 使用宿主已有删除路径，风险规则固定为 `prompt-each-time`。
跨电脑传 `deviceId::sessionId`，复用同账号远程控制；返回 `REMOTE_RESULT_UNKNOWN` 时先查询，不能自动重发。
删除后的任务不能用 `unarchive_sessions` 恢复。插件没有当前任务；任务中的 Agent 不能删除调用任务自身。

`fork_session({session_id,message_client_id})` 使用历史消息的 `clientId`，返回新任务的 `session_id`，不自动发送消息。
user 锚点复制它之前的历史；assistant 锚点复制至下一条 user 之前，沿用界面已有的原生历史语义与限制。
`rewind_session({session_id,message_client_id,stop_if_running:false,restore_files:true})` 恢复指定 user 消息之前的历史与检查点，
风险固定为 `prompt-each-time`。只有明确要停止当前执行时才传 `stop_if_running:true`；`restore_files:false` 只回退对话。
两项支持 `deviceId::sessionId`，复用同账号远程控制。没有原生历史或检查点时返回宿主既有错误；不创建替代任务、不自动重试。
跨电脑回执未知时先查看目标状态与历史，分叉尤其不能盲目重复，否则会生成多个任务。

## 运行设置与任务消息

`get_session_runtime({session_id})` 返回 `permission_mode` 与运行设置的 `generation`。
`set_session_runtime({session_id,expected_generation,permission_mode})` 支持宿主现有权限档：
`ask` / `default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`。插件每次调用走原生确认，
变更使用界面同一提交队列、运行时更新、持久化与失败回滚；不会由插件直接写权限设置。
单独改权限保留模型和待生效路线；同时修改时先应用运行设置，成功后提交权限。`generation` 保护运行设置，权限仍按原队列提交，
模型可能等到下一次发送生效；权限档字段不替代独立的 Plan 开关。

插件用 `send_to_session` 继续明确任务、或用 `steer_session({session_id,message})` 在本机插话时，宿主记录插件来源，
不会借用任务身份，也不会继承别的任务权限档。收件任务继续使用它当前的权限与 Plan 状态，界面标签和模型来源说明同源。
`send_to_session` 支持 `deviceId::sessionId`；派发前协商 `pluginCaller:1`，旧电脑缺少该能力时返回 `REMOTE_UNSUPPORTED`，不发送正文。
来源标识为 `deviceId::pluginId`，仅用于来源展示；排队执行仍由既有一次性派发回执复核账号、安装、批准与原参数。

## 完整历史与附件

`list_teammates({device:'all'})` 枚举伙伴及其已保存的任务关系（含隐藏、暂停和归档）；`list_sessions` 包含隐藏任务，并在隐藏时返回 `hiddenAt`。普通任务、独立对话、伙伴私聊、话题和渠道专线均以数据库里实际保存的来源和关系为准。跨设备按返回的电脑分组翻页；未查到的电脑保留错误与 `partial`，不据此认定任务不存在。

`get_chat_history`、`search_chat_history` 与 `get_task_digest` 沿用原工具。完整导出由插件逐页读取历史后组装，不另设宿主导出接口。

使用 `read_session_attachment` 读取指定消息中登记的附件；`attachment_index` 从 0 开始，先图片、后普通文件：

```js
const result = await cindy.host.call('cindy_helper', 'read_session_attachment', {
  session_id: selectedSessionId, message_id: selectedMessageId, attachment_index: 0
});
```

文本结果中的 `base64` 为本段字节，每次最多 64 KiB；`name`、`mimeType`、`size` 与 `sha256` 描述整份附件。`nextOffset` 非空时继续传 `offset:nextOffset`，并带回 `attachment_ref`（若有），直到返回 null。保留同一份内容的 SHA-256，不混合不同版本的分块。不能把正文里的路径或链接当成附件传入。

媒体沿用总仓和插件媒体 grant，返回 `mediaHash`；普通文件沿用 7 天交接副本，返回 `attachment_ref`，也可交给现有 `upload.handoff`。插件逻辑页和 Node 都只得到这些引用、元数据与分块字节，不得到宿主绝对路径。回执过期返回 `HANDOFF_UNAVAILABLE`，重新从原消息取得；账号、安装或批准变化使读取失效。跨设备只在宿主内部解析原消息引用，字节走既有文件传输；旧端不支持时明确返回错误。
