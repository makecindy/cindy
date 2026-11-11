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

其他 AI 工具历史的 `scan_importable_sessions`、`get_session_import_status`、`import_sessions` 对插件统一返回 `UNSUPPORTED_CAPABILITY`，即使已批准 `control` 或 `history`。扫描和状态查询会触发宿主既有的中断导入恢复，因此本入口不将它们作为只读查询开放；Agent 和设置页保留原行为。

底层管子消息为 `{type:'host-tool-request',server,tool,args}`。身份由宿主从逻辑页或 Node 私有通道核验，不接受参数中的 `pluginId`、`sessionId` 或账号作为调用方身份。旧宿主和未提供此能力的执行宿主应按不支持处理。

## 定时任务与应用设置

`scheduler` 组直接复用 `cindy_scheduler` 的完整管理工具：`schedule_create`、`schedule_update`、
`schedule_pause`、`schedule_resume`、`schedule_delete`、`schedule_run_now` 与 `schedule_list_runs`。
参数和执行位置沿用原工具；插件没有当前任务，不能用 `bindToCurrentSession:true`，
需要绑定时显式传 `targetSessionId`。运行记录由 `schedule_list_runs({scheduleId})` 读取。
删除及其它由宿主判为逐次确认的调用须等待原生确认；回执不明时先查询，不自动重试写操作。

没有已批准 `node` 能力的插件，不支持提交或修改脚本、前置命令，以及运行或恢复已有脚本或前置命令的调度，
统一返回 `UNSUPPORTED_CAPABILITY`，不提供额外确认放行。更新时也检查任务实际配置，不能通过只改 `recurring` 等字段重新激活脚本。
普通调度的更新、运行与恢复复用主干 `expectedSchedule` 执行点检查：读后配置被另一处改动时按原不匹配结果拒绝，重新读取后再决定操作。
普通定时任务的读改不受影响。已有 `node` 批准的插件沿用原共享风险规则；Agent 的工具分类与权限档保持原行为。

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
持有任务操作授权（admission）的调用任务不能修改自身 `permission_mode`，包括同时修改模型的混合请求：写入任何字段前返回 `UNSUPPORTED_CAPABILITY`。插件没有任务身份，不受此自身限制；无 admission 的任务、修改其他任务及仅改模型的路径保持原行为。

插件用 `send_to_session` 继续明确任务、或用 `steer_session({session_id,message})` 在本机插话时，宿主记录插件来源，
不会借用任务身份，也不会继承别的任务权限档。收件任务继续使用它当前的权限与 Plan 状态，界面标签和模型来源说明同源。
`send_to_session` 支持 `deviceId::sessionId`；派发前协商 `pluginCaller:1`，旧电脑缺少该能力时返回 `REMOTE_UNSUPPORTED`，不发送正文。
来源标识为 `deviceId::pluginId`，仅用于来源展示；排队执行仍由既有一次性派发回执复核账号、安装、批准与原参数。

## 完整历史与附件

`list_teammates({device:'all',limit:100})` 分页枚举伙伴目录（含隐藏、暂停和归档），返回 `teammates`。
用 `list_teammates({device,teammate_id,limit:100})` 分页读取该伙伴保存的任务关系，返回 `relationships`。
两种查询的 `limit` 默认 100、最多 1000；`hasMore:true` 时带回 `nextCursor` 继续同一电脑、同一过滤条件，直到结束。
跨设备聚合按各电脑的游标分别翻页；伙伴 id 不加电脑前缀，关系中的任务 id 使用返回的 `deviceId::sessionId`。
本机目录包含隐藏和归档伙伴；远程目录沿用来源宿主既有的远程伙伴可见范围，在分页前过滤并在返回时复核，不扩大远程管理权限。
`list_sessions` 包含隐藏任务，并在隐藏时返回 `hiddenAt`。普通任务、独立对话、伙伴私聊、话题和渠道专线均以数据库里实际保存的来源和关系为准。未查到的电脑保留错误与 `partial`，不据此认定任务不存在。

`get_chat_history`、`search_chat_history` 与 `get_task_digest` 沿用原工具。需要原生可导入任务包时使用 `export_session`，不必自行组装历史。

`read_session_attachment` 只覆盖已有宿主授权的本机媒体和交接引用：Cindy 管理的聊天媒体、已授予当前插件的 grant / deposit，以及已有的 handoff 回执。历史消息 JSON 的 `files.path`、绝对路径或旧文件直读 URL 不构成授权，返回 `UNSUPPORTED_CAPABILITY`；跨电脑任务也返回此错误，不发起远程查询或传输。
`attachment_index` 从 0 开始，沿用先图片、后普通文件的历史位置；普通文件位置不能直接取源，须使用已有 `attachment_ref`：

```js
const result = await cindy.host.call('cindy_helper', 'read_session_attachment', {
  session_id: selectedSessionId, message_id: selectedMessageId, attachment_index: 0
});
```

文本结果中的 `base64` 为本段字节，每次最多 64 KiB；`name`、`mimeType`、`size` 与 `sha256` 描述整份附件。`nextOffset` 非空时继续传 `offset:nextOffset`，媒体带回 `mediaHash`，普通文件带回原 `attachment_ref`，直到返回 null；保留同一组任务、消息和附件序号。两类续读都从已有 grant / 交接副本按范围读取，不重复读取来源、入仓或对整份文件重算摘要。普通文件的摘要标识原交接内容，组装完成后必须核对 SHA-256；交接副本被编辑或校验不符时丢弃本次组装，使用既有授权交接流程重新取得。不能混合不同版本的分块，也不能把正文里的路径或链接当成附件传入。

媒体复用既有聊天附件账本或当前插件的 grant / deposit，返回 `mediaHash`；不把孤立媒体或其他插件的作品当作公共附件。普通文件仅读取已有的 7 天 handoff 交接副本，回执也可交给现有 `upload.handoff`，本工具不凭历史路径创建副本。插件逻辑页和 Node 都只得到引用、元数据与分块字节，不得到宿主绝对路径。回执过期返回 `HANDOFF_UNAVAILABLE`，通过既有交接流程重新取得；账号、安装或批准变化使读取失效。

## 原生任务包导入导出

`history` 组的 `export_session` 与 `control` 组的 `import_session` 同时供 Agent 和插件调用，均使用
`prompt-each-time`，沿用宿主现有权限流程。只处理本机；跨电脑仍使用原有任务迁移功能。

```js
const exported = await cindy.host.call('cindy_helper', 'export_session', {
  session_id: selectedSessionId, exclude_media: false
});
// 解析 MCP 文本结果中的 attachment_ref，再交给已有文件上传/读取流程，或原生导入：
const imported = await cindy.host.call('cindy_helper', 'import_session', {
  attachment_ref: selectedFileRef, overwrite: false
});
```

导出复用原生 `.cshare` 打包器，包含可见历史、可用媒体、原生续做记录与适用的协同关系；原生导入也兼容旧
`.xdtshare`。文件默认不加密，可能含敏感任务内容；不会自动上传。运行中的任务可能缺最后一轮。
`fidelity`、`missing_transcript_count`、`media_missing`、`media_dropped` 和 `orca_workers` 如实描述打包结果。
原生超限返回 `status: 'oversize'`，不产生文件；可显式选择 `exclude_media:true` 再导出。

插件导出返回本实例的 `attachment_ref`、`name`、`size`、`sha256`，不返回宿主文件路径。复用既有 handoff
的 7 天生命周期、单文件 64 MiB 和每实例 512 MiB / 200 文件配额；引用可用于已有 `upload.handoff` 与
`read_session_attachment`。插件导入只接本实例已有 `attachment_ref`，例如此前用户通过 `ghost_call.attachments`
交出的文件，或本实例的导出结果。插件不能提交 `output_path`、`file_path` 或 `working_dir`，也不能借引用读取其他实例的文件。
导入从既有 handoff 的同一安全句柄读取并核对原始 SHA-256，再把已核对字节交给原生解析器；副本被编辑后须重新交接。

Agent 导出可传 `output_path`，缺省使用原生保存对话框；成功返回 `file_path`。Agent 导入传 `file_path`，
项目任务还可传 `working_dir` 和 `use_worktree`；相对路径按调用任务的本机工作目录解析，SSH 路径不支持。
导入复用原生校验、事务、资源补偿和通知，默认不覆盖；`overwrite:true` 表示按原生规则替换冲突任务，须明确有此意图。

加密包，或未提供目标目录的项目包，会打开同一个原生导入向导，由主人填写密码或选择目录。
此时返回 `status: 'awaiting_user'` 和 `reason`，不代表已导入；向导里的目录、模型、worktree 与覆盖选择以主人实际填写为准。
工具不收密码、不代替主人确认。直接导入完成才返回 `status: 'imported'`、`session_id`、`fidelity`、`notes` 和 `orca_workers`。
引用失效返回 `HANDOFF_UNAVAILABLE`；冲突返回 `SHARE_CONFLICT`，不会自动覆盖或重试。结果不明时先查任务历史，避免重复导入。
