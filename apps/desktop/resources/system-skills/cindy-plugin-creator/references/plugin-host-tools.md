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
| `terminal` | `cindy_helper` | 宿主管理的命令、交互终端与后台作业 |
| `files` | `cindy_helper` | 授权目录的文件操作与监听；调用 `file_request` |
| `storage` | `cindy_helper` | 本插件存储接口与每次确认的跨插件副本分享；调用 `storage_request` |
| `browser` | `cindy_browser` | 当前浏览器的统一自动操作工具 |
| `computer` | `cindy_computer` | 本机窗口、键盘和鼠标工具 |
| `ssh` | `cindy_ssh` | 已配置 SSH 连接与远程命令 |
| `docs` | `cindy_docs` | 插件私有目录内的文档生成、转换与读取 |
| `discovery` | `cindy_helper` | 查询执行宿主提供的服务与本插件的声明、批准事实 |

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

本入口仅支持表中服务的已声明组。插件管理（`ghost_*` 等）、主人代输入或 `ask_owner`、应用更新和反馈不开放。Node 子进程不提供此 API；应由声明的插件 Node 工作进程调用。

其他 AI 工具历史的 `scan_importable_sessions`、`get_session_import_status`、`import_sessions` 对插件统一返回 `UNSUPPORTED_CAPABILITY`，即使已批准 `control` 或 `history`。扫描和状态查询会触发宿主既有的中断导入恢复，因此本入口不将它们作为只读查询开放；Agent 和设置页保留原行为。

底层管子消息为 `{type:'host-tool-request',server,tool,args}`。身份由宿主从逻辑页或 Node 私有通道核验，不接受参数中的 `pluginId`、`sessionId` 或账号作为调用方身份。旧宿主和未提供此能力的执行宿主应按不支持处理。

## 查询执行宿主的能力

声明并获准 `agent.hostTools:['discovery']` 后调用：

```js
const result = await cindy.host.call('cindy_helper', 'host_services', {});
const { scope, services } = JSON.parse(result.content.find(item => item.type === 'text').text);
```

`scope:'local'` 指执行插件的电脑，`services[]` 含 `group/server/tools/available`，有工具时另有示例 `entryTool`。
不可用时 `reason` 为 `unsupported`（未提供）或 `disabled`（宿主开关关闭）；无法读取开关时为 `unavailable`。
插件调用另含每组 `declared` / `approved`；这是宿主现查的本实例事实，不接受自报身份，也不查询其他插件数据。
`entryTool` 是该服务的一个现有工具入口；目录查询不执行工具、不启动服务、不读取凭证或内部路径。
`available:true` 只说明宿主已接入且允许使用该服务；外部账号、浏览器连接、驱动安装和系统权限仍由原工具检查。
服务注册替换后目录重建，开关、声明和批准每次现查。Node Host 缺少生产调度器等服务时明确返回不可用。
普通 Agent 使用同一个 helper 工具查询服务，不附插件批准字段。查询能力不会赋予安装、停用或撤销其他插件的权限。

## 服务依赖与生命周期

`agent.hostTools` 同时说明插件使用哪些宿主服务，不再另填一份服务依赖清单。
宿主在每次 `host.call` 时解析当前 provider、开关和批准；先查 `host_services` 可以提示执行电脑缺少的服务，
实际调用仍必须处理 `HOST_NOT_READY` / `UNSUPPORTED_CAPABILITY` 和原工具错误，不能把一次发现结果当授权。
缺少某项服务不自动停用整个插件；插件可继续提供不依赖它的功能，用户也能保留设置、停用或恢复插件。

动态安装和开发迭代继续走现有 Forge 安装所选实例的流程，同版本更新亦可；不要经宿主工具入口管理其他插件。
批准版本、启用状态和账号变化使旧调用失效。逻辑页退出和 Node Worker 显式停止走各自宿主的同一资源清理入口，
释放文件监听、终端和电脑观察/驱动连接；旧电脑快照不能用于新一轮操作。
已注册的浏览器执行端继续由原 bridge 的 reconcile/prepareUpdate 接管，用户选择不被插件代码替代。
持久数据仍按原卸载、换源和作品库规则处理；运行资源退出本身不删除 KV、凭证或作品。

Node Worker 的自然退出与闲置回收继续沿用已有生命周期；宿主管理的终端作业不因一次 Worker 请求结束而重放。
执行 Host 退出后没有进程或服务自动恢复承诺，应重新查询。随包 Node/CLI 的第三方依赖按
[Node 打包规则](plugin-node-worker.md#4123-打包和生命周期红线)预先打入包，不在用户电脑另建安装器或下载可执行代码。

## 使用与提供宿主服务

四个服务复用 Agent 的同一 registry、参数校验和宿主处理器，直接传具体工具名：

```js
const status = await cindy.host.call('cindy_browser', 'browser', { action: 'status' });
const windows = await cindy.host.call('cindy_computer', 'list_windows', {});
const hosts = await cindy.host.call('cindy_ssh', 'ssh_list_hosts', {});
const document = await cindy.host.call('cindy_docs', 'make_docx', {
  outPath: 'documents/report.docx', markdown: '# Report\n\nContent'
});
```

浏览器使用用户已选择的后端；切换到「我的浏览器」、recipe、upload 等保留现有风险规则。
插件没有任务归属，选中侧边栏 `rsb-webview` 时返回 `BROWSER_RUNTIME_ACTION_FAILED` 并明确不支持；
不会借用当前界面任务。专用浏览器与「我的浏览器」仍可用，原 Agent 和 UI 行为不变。
页面中的主人私密输入保护保持生效，插件不能调用代输入确认或取得秘密。依赖真实任务的文件授权
仍须由原工具确认上下文；缺少上下文时保留其错误，不借用正在前台的任务。
电脑观察快照按插件实例保留，停用、换版或账号变化后失效。录制等文件操作和文档工具的根目录
为本插件私有文件目录；文档不能用路径参数越界。需要读取产物字节时另声明 `fs:true`，
通过 `cindy.fs({op:'read',root:'data',path:'documents/report.docx'})` 读取；不能从宿主内部路径获取其他数据。
SSH 使用当前账号已配置的连接池，沿用原连接管理和风险确认，私钥或认证值不进入插件。
每个执行 Host 必须已提供对应服务；Node Host 插件复用已有 browser 平台 provider。
Node Host 的插件 computer 调用与未装配的 scheduler、SSH 和文档服务返回
`UNSUPPORTED_CAPABILITY`，不会因 manifest 声明自行安装或启动第二套实现。

媒体生成继续使用已有 `cindy.media` / 模型目录接口；当前没有独立媒体 MCP server，
不声明不存在的 `media` 工具组。

提供浏览器实现请沿用 [`browserExtension.pageControl`](plugin-browser-extension.md)。普通插件可随包提供
扩展并实现既有页面控制契约，用户在详情页选择它作为「我的浏览器」执行端；Agent、Cindy 与其他
获准 browser 组的插件都消费相同后端。无需注册新的服务中心，不能从插件代码替用户激活自己。
停用、卸载、换版和来源变化撤销旧桥接，已有配对和用户选择按原实例保存，多个实现不静默混用。

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
合法的模型与权限组合仍可一次提交；目标运行实例不支持的权限档会在模型写入前拒绝。
若模型已应用或已延后、之后权限提交失败，结果仍为 `isError:true`，文本 JSON 的 `data.runtime`
说明 `status`、已得 `generation` 与 `fields`，`data.failed` 为 `permission_mode`，`data.original_error`
保留权限错误。该失败不表示模型未变；先用 `get_session_runtime` 核对后再决定重试，不自动回滚已成功的模型设置。
持有任务操作授权（admission）的调用任务不能修改自身 `permission_mode`，包括同时修改模型的混合请求：写入任何字段前返回 `UNSUPPORTED_CAPABILITY`。插件没有任务身份，不受此自身限制；无 admission 的任务、修改其他任务及仅改模型的路径保持原行为。

插件用 `send_to_session` 继续明确任务、或用 `steer_session({session_id,message})` 在本机插话时，宿主记录插件来源，
不会借用任务身份，也不会继承别的任务权限档。收件任务继续使用它当前的权限与 Plan 状态，界面标签和模型来源说明同源。
`send_to_session` 支持 `deviceId::sessionId`；派发前协商 `pluginCaller:1`，旧电脑缺少该能力时返回 `REMOTE_UNSUPPORTED`，不发送正文。
来源标识为 `deviceId::pluginId`，仅用于来源展示；排队执行仍由既有一次性派发回执复核账号、安装、批准与原参数。
消息已成功排队后，关闭逻辑页或 Node 正常空闲回收不取消该消息；执行、准入及返回仍要求来源有效。
实际投递继续复核账号、安装目录与批准版本、启用状态、工具组批准以及目标和原消息；停用、卸载、更新重批或账号变化仍使它失效。
宿主进程重启后沿用现有无内存守卫失效规则，不提供持久重放或恢复。

## 命令、终端和后台作业

声明 `agent.hostTools:["terminal"]` 后，逻辑页和 Node Worker 使用同一入口。启动、输入、
调整尺寸、停止和清除已退出记录每次经原宿主风险判定与确认；读取、列表不会执行新命令。
命令以用户身份在执行电脑上运行，能访问其本机文件和应用；这项能力不是文件沙箱。
宿主只传筛选后的系统路径、语言与用户配置目录环境，不继承宿主 API key、token 或 Node
启动注入变量，也不自动传任何 `node.secretBindings` 的凭证。
Agent 使用这套托管作业时，作业归属于当次真实 Session；该实例关闭即终止并回收其进程，
普通轮次结束或客户端断开不触发回收。插件自主作业仍归属安装实例，不受其他任务关闭影响。

```js
const unpack = result => {
  const value = JSON.parse(result.content.find(item => item.type === 'text').text);
  if (result.isError || !value.ok) throw new Error(value.errorCode || 'TERMINAL_FAILED');
  return value;
};
const { job } = unpack(await cindy.host.call('cindy_helper', 'terminal_start', {
  program: { command: '/bin/sh', args: ['-c', 'printf "ready\\n"'] }
}));
// Windows 请显式选用本机存在的程序；省略 program 则启动用户选定的交互 shell。
let output = unpack(await cindy.host.call('cindy_helper', 'terminal_read', { id: job.id }));
output = unpack(await cindy.host.call('cindy_helper', 'terminal_read', {
  id: job.id, cursor: output.cursor, generation: output.generation
}));
```

`terminal_start` 立即返回 `{scope:'local',job}`，job 含 id、pid、generation、执行目录、
起始时刻、尺寸、状态与退出事实。`cwd` 缺省为本插件私有文件目录；普通任务调用时为真实任务
工作目录。`program.command/args` 直接传给程序；需要 shell 语法时显式选择该 shell 及参数。
`cols/rows` 为 1–1000；`shell` 可按 `list_tools({name:'terminal_start'})` 查询可选值。

`terminal_list` 返回当前调用方的 `jobs`。`terminal_write({id,data})` 写入最多 64 KiB UTF-8
文本（换行与控制字符显式包含在 data）；`terminal_resize({id,cols,rows})` 改尺寸；
`terminal_stop({id})` 请求停止该进程，收到退出后状态才是 `exited`；
`terminal_forget({id})` 只清除已退出记录。不能以别的插件或任务的 id 越过归属。

每个调用方最多同时运行 10 个托管作业（含启动中与停止中）；超出返回
`TERMINAL_JOB_LIMIT`，`data.current/limit` 为当前数量和上限，不排队或终止已有作业。
收到退出状态才释放并发名额。已退出作业保留最近 100 条，按结束顺序回收更早的记录；
`terminal_forget` 可提前释放。这些限制不作用于界面中自行打开的终端。
运行中输出缓冲最多 256 KiB / 256 段，退出后最多 16 KiB；每次读取最多 64 KiB，`chunks` 含 sequence/data。
每个客户端独立保存 cursor/generation；相同游标可重复读取，`hasMore` 表示还有保留输出，
`resetRequired` 表示代次变化或旧输出被淘汰，不能把缺口拼成完整输出。
作业不随一次调用或读连接结束；重连用 `terminal_list` 找回。停用、更新、卸载或切账号清理
对应资源，Host 进程退出后不会自动重放命令。SSH 工作区返回 `REMOTE_TERMINAL_UNSUPPORTED`，
不把远端路径当本机路径；旧 Host 未注册这些工具时按不支持处理。

### 无界面宿主

Node Host 为逻辑页和 Node Worker 装配相同的公共入口、helper registry 与宿主终端服务。
`history` 组的本机任务列表、工作目录、历史消息与搜索复用桌面宿主的查询回调和同一账号数据库；
另一个已认证客户端读取的是这份任务数据，不创建插件专用任务副本。普通任务的来源、权限与
Plan 状态继续由共享输入协调器和任务动作检查判定，插件调用继续使用宿主核验的插件身份。
无需打开插件页面；已批准组的读取可直接执行。首次组批准与逐次确认仍须由已配对的
Cindy 客户端在宿主对话框中回答；未连接支持确认的客户端时返回拒绝，不默认同意。
详情页的重新批准沿用同一 receipt，不要求重装插件。

确认只发送给一个已认证控制端，不写入任务事件回放。断线、停用、更新或账号边界使
旧确认失效；插件应把取消作为本次未获批准，不能循环重试或伪造回答。
确认发送积压超过 1 MiB，或写入遇到背压且缓冲未排空时，同样按无法送达拒绝本次确认。
终端作业留在执行 Host，重新调用列表和续读不会再次启动程序。Node Host 当前已装配
的工具以其实际 registry 为准；执行位置、桌面集成或工具未提供时按不支持处理。
当前 Node Host 未装配生产调度器，`cindy_scheduler` 调用返回 MCP 错误
`UNSUPPORTED_CAPABILITY`，说明当前执行环境不支持此宿主服务；不会创建另一套调度任务。
`history` 的本机查询与 `terminal` 已接通，其他组须以执行 Host 的工具目录和实际回执为准。
Node Host 已提供的 `browser` 平台 provider 同时接入 Agent 与插件入口，不另建浏览器实现。
Node Host 插件的 `computer` 在创建观察 runtime、确认或驱动执行之前返回 `UNSUPPORTED_CAPABILITY`，
`host_services` 同样报告不可用：Desktop 的逐次批准身份不能从跨进程 caller 元数据重建。
不新增跨进程授权证明；Node Agent 与 Desktop 插件的电脑调用保留原路径、快照生命周期和门禁。
需要定时任务时使用已提供调度器的执行宿主，不循环重试不支持结果。

## 完整历史与附件

`list_teammates({device:'all',limit:100})` 分页枚举伙伴目录（含隐藏、暂停和归档），返回 `teammates`。
用 `list_teammates({device,teammate_id,limit:100})` 分页读取该伙伴保存的任务关系，返回 `relationships`。
两种查询的 `limit` 默认 100、最多 1000；`hasMore:true` 时带回 `nextCursor` 继续同一电脑、同一过滤条件，直到结束。
跨设备聚合按各电脑的游标分别翻页；伙伴 id 不加电脑前缀，关系中的任务 id 使用返回的 `deviceId::sessionId`。
本机目录包含隐藏和归档伙伴；远程目录沿用来源宿主既有的远程伙伴可见范围，在分页前过滤并在返回时复核，不扩大远程管理权限。
`list_sessions` 包含隐藏任务，并在隐藏时返回 `hiddenAt`。普通任务、独立对话、伙伴私聊、话题和渠道专线均以数据库里实际保存的来源和关系为准。未查到的电脑保留错误与 `partial`，不据此认定任务不存在。

`get_chat_history`、`search_chat_history` 与 `get_task_digest` 沿用原工具。完整导出由插件逐页读取历史后组装，不另设宿主导出接口。

`read_session_attachment` 只覆盖已有宿主授权的本机媒体和交接引用：Cindy 管理的聊天媒体、已授予当前插件的 grant / deposit，以及已有的 handoff 回执。历史消息 JSON 的 `files.path`、绝对路径或旧文件直读 URL 不构成授权，返回 `UNSUPPORTED_CAPABILITY`；跨电脑任务也返回此错误，不发起远程查询或传输。
`attachment_index` 从 0 开始，沿用先图片、后普通文件的历史位置；普通文件位置不能直接取源，须使用已有 `attachment_ref`：

```js
const result = await cindy.host.call('cindy_helper', 'read_session_attachment', {
  session_id: selectedSessionId, message_id: selectedMessageId, attachment_index: 0
});
```

文本结果中的 `base64` 为本段字节，每次最多 64 KiB；`name`、`mimeType`、`size` 与 `sha256` 描述整份附件。`nextOffset` 非空时继续传 `offset:nextOffset`，媒体带回 `mediaHash`，普通文件带回原 `attachment_ref`，直到返回 null；保留同一组任务、消息和附件序号。两类续读都从已有 grant / 交接副本按范围读取，不重复读取来源、入仓或对整份文件重算摘要。普通文件的摘要标识原交接内容，组装完成后必须核对 SHA-256；交接副本被编辑或校验不符时丢弃本次组装，使用既有授权交接流程重新取得。不能混合不同版本的分块，也不能把正文里的路径或链接当成附件传入。

媒体复用既有聊天附件账本或当前插件的 grant / deposit，返回 `mediaHash`；不把孤立媒体或其他插件的作品当作公共附件。普通文件仅读取已有的 7 天 handoff 交接副本，回执也可交给现有 `upload.handoff`，本工具不凭历史路径创建副本。插件逻辑页和 Node 都只得到引用、元数据与分块字节，不得到宿主绝对路径。回执过期返回 `HANDOFF_UNAVAILABLE`，通过既有交接流程重新取得；账号、安装或批准变化使读取失效。
