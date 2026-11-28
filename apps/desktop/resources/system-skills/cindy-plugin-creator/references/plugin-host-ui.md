## 插件界面扩展：具名页面、原生入口和宿主操作

按 §0a 核验执行宿主源码包含 `mcpApps.host` 和 `open-resource`。
本章新增入口用于 Desktop 本机。旧工具卡片的手机/远程查看和旧 panel/mainView/taskView 保持原契约。

复杂页面继续使用官方 MCP Apps `App`、资源、主题、CSP 和销毁协议。
业务仍由原 `main.js` 执行，不另起 MCP 服务，不为打开页面伪造工具调用。

### 标题、全屏与可用尺寸

右侧栏页签（含分离窗口）、入口旁弹层、`sidebar.section` 不重复显示卡片标题；加载与重试在页面区域。
来源由宿主安装记录决定，例外来源只在入口/页签悬停提示中显示，页面不能通过改名隐藏来源。
`message.body`、`tool.body`、`settings.section` 仍有紧凑标题栏。
桌面有标题栏且已就绪的页面默认有全屏按钮，前提是 App 的 `availableDisplayModes` 支持 fullscreen；手机只有 inline。
对话卡片的资源可声明 `mcpApps.ui.resources[].initialHeight`，值须为有限数字（例如 `240`），单位为 CSS px。宿主将超出范围的值限制到 80–720。同宽时宿主优先使用本机记住的高度，页面就绪后仍需上报实际尺寸。
资源可声明 `hostFullscreenButton: false` 隐藏该按钮（缺省 true），只影响宿主按钮，不禁止 `app.requestDisplayMode({mode:"fullscreen"})`。
该字段映射为资源 `_meta["cindy/host-fullscreen-button"]`，自定义 MCP 可直接提供此扩展。
旧宿主的资源解析保留并忽略该字段，不会拒装；要依赖按钮隐藏行为时，核验实际发布版本并填写对应 `minCindyVersion`，不要猜版本号。

页签与全屏收到固定 `hostContext.containerDimensions: {width,height}`，页面铺满可用区域；
尺寸变化走原 host-context 更新。页面应处理自身滚动，不要使用 `overflow:hidden` 截掉长内容。
对话、弹层和折叠区仍是 `{width,maxHeight}` 内容高度模式；不要把这两种模式混作同一种自动增高布局。

### 声明与打开

```json
{
  "mcpApps": {
    "ui": {
      "resources": [{ "uri": "ui://board", "file": "ui/board.html" }],
      "tools": {}
    },
    "host": {
      "views": [{ "id": "board", "title": "任务工作台", "resourceUri": "ui://board", "scope": "task" }],
      "contributions": [{ "id": "open", "title": "打开工作台", "position": "composer.toolbar", "view": "board" }],
      "capabilities": ["context", "draft"]
    }
  }
}
```

这是清单片段；其余身份字段仍按 [manifest](plugin-manifest.md) 填写。
页面只需引用 `mcpApps.ui.resources`，允许 `tools:{}`。`scope` 缺省为 `global`，不借台前任务；
`task` 页面只能从真实本机任务打开。已安装并启用插件声明的页面和命令可从插件详情、任务标题栏菜单进入。
同实例、视图和任务再次打开会聚焦已有页签；更新输入不重建页面。

Desktop 侧栏中的具名页面占满页签可用空间，`hostContext.containerDimensions` 提供实际 `width` 和 `height`，并随侧栏调整更新；页面应按容器尺寸自适应。侧栏复用外层页签标题，不重复显示「标题 · MCP App」。对话内的工具卡片仍按内容测高，不能把侧栏高度契约套用于卡片或弹层。

`composer.toolbar` 的按钮会在标题前展示已安装插件的专属图标（如提供）；沿用包内 `icon` 声明，不需要额外权限。

原生按钮可额外声明 `presentation:"popover"`，在入口旁打开同一 MCP App 资源；缺省仍打开侧栏页签。
仅适用于 `composer.header/composer.toolbar/session.header/statusbar/workdir.menu/message.actions/turn.footer` 的页面按钮；
正文位置与更多菜单保持各自承载方式。页面在弹层打开后才加载，关闭、入口离开视口或区域隐藏即释放。
弹层方式在安装/更新时随声明展示，不需要为入口单独授权。例：
`{"id":"quick","title":"快捷面板","position":"composer.toolbar","view":"board","presentation":"popover"}`。

#### 输入框内联动作

`composer.header` 和 `composer.toolbar` 的原生按钮引用 `scope:"task"` 页面时可附加
`composerAction:"inline"`。按钮只在已有本机 Desktop 任务的输入框可用。工具栏按钮以
`title` 作可访问名称和提示，`icon:"sparkles"` 可选。上方按钮复用靠右单行和标题截断。
新增内联入口没有隐式可见默认值：静态入口必须在 contribution 声明 `visible:true`；
需要等待配置或按需出现的入口声明 `visible:false`，只在确有内容时发布 `{visible:true,title}`。
空配置、读取失败或移除条目时发布 `{visible:false}`，隐藏后不留空槽或空行。
隐藏仍保留按需状态需求，后续更新可以恢复显示；既有非内联控件保持原声明行为。

`composer.header` 的按钮声明 `icon` 时显示为图标按钮，未声明时显示文字。
图标名沿用原生导航图标名，并支持 `sparkles`，未知名称显示 puzzle。
图标按钮与文字按钮同高并垂直居中，`title` 保留完整悬停提示和可访问名称。
收入「更多」后在上方横向浮动栏中展开，保留图标按钮或文字按钮的原样式与顺序。
浮动栏按内容收拢宽度，达到可用宽度上限后换行；图标按钮保持无常驻背景与边框，完整名称由悬停提示和可访问名称提供。

点击才加载该页面。同一编辑器一次只运行一个动作，工具栏按钮本身显示忙碌状态。
这只改变动作的呈现方式，不限定业务类型，也不增加权限。页面可以调用本插件已声明的
`app` 可见工具，组合其已获准的模型、网络、文件等能力；只有声明 `draft` 才获得草稿接口。
`read/append/replace/replace-selection` 沿用既有语义，追加始终追加；是否去重、如何组织文本、
使用什么提示词由插件决定。客户端只负责编辑器写入、版本校验与撤销边界。
仅由此入口打开的页面会收到 `app.getHostContext().cindy.composerAction`，其中 `version:1`
表示单次动作契约，`dynamicItems:true`、`draftDocument:true`、`queuedActions:true` 分别表示动态项目、结构化草稿写入和动作排队可用。
这些标记仅用于接口探测，不授予未声明的草稿、文件或模型权限。
依赖此能力的插件应将已验证支持此接口的 Cindy 版本登记为 `minCindyVersion`。
页面缺少此标记时应等待用户从支持版本的输入框打开。兼容旧式弹层的 manifest 可保留
`presentation:"popover"`，旧宿主的弹层不会提供内联动作标记。

连接后仅尝试一次 `cindy.ui.composerAction({phase:"start"})`。只有 MCP 回执明确包含
`{started:true}` 才执行，可从 `structuredContent` 或 JSON 文本正文读取。
错误回执、异常正文、超时和断线后的重复请求都应直接结束。任务草稿仍用
`cindy.ui.draft` 的既有读取、追加和带 revision 替换，替换作为独立的编辑器撤销步骤。
动作结束时调用 `cindy.ui.composerAction({phase:"finish",status:"success"|"error",message?})`。
`message` 为最多 160 个字符的本地化状态文本，请省略草稿内容、凭证和原始错误。
完成只更新本次点击的显示。由于完成会关闭页面，无需等待回执或重试。关闭、替换或重连都会释放页面。
内联动作的草稿和模型工具仍按
页面已获准的能力及工具可见性使用。

#### 动作调度与取消

内联动作可声明 `concurrency:"queue"|"replace"`；省略和未知值沿用 `replace`。
这只是同一编辑器的执行策略，不新增工具或草稿权限，也不按插件名称或草稿写入模式猜策略。

- `queue`：连续选择不同排队动作，按点击顺序执行。待执行动作不加载页面、不读草稿或调用工具；
  前一动作成功、失败或超时后才启动下一项。正在执行或已排队的同一项目重复点击会合并，完成后可再次点击。
- `replace`：替换当前动作并清空待执行动作。选择排队动作时，若当前运行的是互斥动作，也会先取消该互斥动作；
  只有排队动作之间顺序执行。原有未声明调度方式的内联动作保持原行为。

例：`{"id":"insert","title":"插入片段","position":"composer.header","view":"task-action","composerAction":"inline","concurrency":"queue","visible":true}`。
依赖排队的页面应检查 `hostContext.cindy.composerAction.queuedActions === true`，并登记实际验证的最低宿主版本。
每个输入框最多保留 512 个待执行动作，达到上限时宿主反馈失败，不启动额外工作。

隐藏、禁用、移除或撤权会取消对应的在途和待执行动作；切任务、编辑器失效或区域隐藏时全部释放。
仅收起「更多」不会取消已经接受的动作。执行中请使用按钮自身的忙碌状态或另行声明的状态控件，
不要通过禁用本动作来表示忙碌。无响应动作沿用工具调用的 30 分钟总时长上限，释放后继续处理下一项。

内联页面释放会取消其在途工具调用。工具调用 `oneshot_text` 时须透传收到的 `callId`，
原调用的取消会沿现有工具生命周期传到模型和模型启动等待，返回 `CANCELLED`，不采纳迟到结果。
取消是向供应商传递终止请求，不能撤回供应商已处理的内容或已产生的费用。

插件需要主动反馈时，复用已有通用入口，均由插件决定是否展示：

- 阶段、百分比或简短提示：声明 `kind:"status"` 的原生控件，使用 `cindy.ui.updateContribution`
  更新 `title/visible`；也可更新动作按钮本身的标题。工具的标准 `onprogress` 可供页面接收，
  由插件选择转换为哪些面向用户的状态，不自动把每条底层进度弹给用户。
- 成功、提醒或失败轻提示：后台声明 `notify:true`，使用既有 `cindy.send({type:'notify',text,tone})`。
  遵循通知能力的限速，不用连续 toast 刷进度。
- 需要查看详情或继续交互：显式调用 `cindy.ui.open` 打开本插件已声明的页面，或沿用原弹层入口。

例如，在 `contributions` 中声明按需出现的状态文字：

```json
{"id":"job-progress","title":"处理中","position":"composer.header","kind":"status","visible":false}
```

后台按该任务更新，结束时主动隐藏；不占用草稿，也不发送聊天消息：

```js
await cindy.ui.updateContribution('job-progress', () => ({ title: '处理中 40%', visible: true }), { sessionId });
await cindy.ui.updateContribution('job-progress', () => ({ visible: false }), { sessionId });
```

#### 动态按钮集合

在 `composer.header` 按钮上声明 `dynamicItems:true`，把它作为一组原生动作的模板。
本能力仅用于已有本机 Desktop 任务的真实输入框；新建页、临时草稿、远程任务和共享访客不展示或执行。
模板本身始终不渲染，也不预留固定槽位；每个实际项目继承该模板的 `tool` 或 `view`、静态参数与权限。
支持普通工具按钮及 `composerAction:"inline"` 的任务页面按钮。例如：

```json
{"id":"actions","title":"操作集合","position":"composer.header","view":"task-action","composerAction":"inline","dynamicItems":true,"visible":false}
```

只在有实际内容时发布 `visible:true` 与完整项目列表；项目顺序就是原生排列顺序：

```js
await cindy.ui.updateContribution('actions', () => ({ visible: true, items: [
  { id: 'first', title: '第一个操作' },
  { id: 'second', title: '第二个操作', icon: 'sparkles' },
] }), { sessionId });
// 清空后不留下模板按钮、更多按钮或间距。
await cindy.ui.updateContribution('actions', () => ({ visible: true, items: [] }), { sessionId });
```

项目字段只有 `id/title/icon/disabled/visible`，ID 唯一且不随排序改变；`visible:false` 隐藏单项。
项目不能改工具、页面、静态参数或权限。点击后将该项目 ID 作为既有 `value` 参数交给原动作；
内联页面从 `hostContext.cindy.input.value` 读取。普通工具调用会核对当前调用窗口已发布的项目，
移除、隐藏、禁用或撤权后的项目不能继续调用。沿用通用状态限制，单次列表最多 512 项，
每个模板仅占一份状态订阅，不为每个项目启动页面或增加轮询。

#### 结构化草稿写入

`cindy.ui.draft` 写入支持 `text` 或 `document` 二选一。`document` 使用读取接口返回的 Tiptap JSON
文档格式，可用于 `append/replace/replace-selection`；替换仍需起始 `revision`。
结构化写入要求当前任务已挂载可编辑的输入框，宿主用该编辑器 schema 校验，再沿原保存与撤销流程写入。
非法文档、版本冲突、锁定或已失效动作都不写；附件不属于该文档字段，继续由原输入框管理。

```js
await app.callServerTool({ name: 'cindy.ui.draft', arguments: {
  mode: 'replace', document, revision,
} });
```

插件需要保留引用、格式或其它非文本节点时，应在读取的原文档上只修改目标文字并提交完整文档。
宿主不替插件决定哪些文字需要整理，也不向模型自动发送引用元数据。文本写入及旧普通页面接口保持原有语义。
单次文本长度或结构化文档的 JSON 长度上限为 128000 字符；一次写入是一条独立撤销记录。

入口指定 `view` 或 `tool` 之一。`arguments` 为静态 JSON：页面收到 `hostContext.cindy.input`，
工具收到对应参数。`kind:"select"` 还会加入用户选择的 `value`，并须声明
`options:[{"label":"全部","value":"all"}]`。`kind:"status"` 只显示状态，不声明动作。
工具必须在 `tools[]` 声明，并在 `mcpApps.ui.tools` 开放 `app` 可见性；沿原插件执行入口及一次性来源凭据执行。
整版安装/更新批准有效且插件已启用即可使用这些声明，不另建分项授权，不走 Agent MCP 审批或调用时确认。

| position | 位置 |
| --- | --- |
| `composer.header` | 任务输入框卡片正上方，与运行状态、耗时和 token 速率同排；按声明顺序从右往左排列，文字按钮按内容取有上限的紧凑宽度，一行放不下的入口收入「更多」横向浮动栏，长标题截断并保留完整提示；无可见贡献时不占空间 |
| `composer.toolbar` | 输入框内底部工具栏 |
| `session.header` | 任务标题栏 |
| `statusbar` | 输入框下方的任务状态栏，位于目录／对话标识与用量信息之间 |
| `workdir.menu` | 本机任务输入框下方的工作目录菜单，可声明多个页面或工具动作 |
| `message.actions` | 消息操作栏 |
| `message.menu` | 消息「更多」菜单内部 |
| `turn.footer` | 已结束的 AI 消息末尾 |
| `message.body` | 消息正文的可选展示 |
| `tool.body` | 工具详情的可选展示 |
| `sidebar.navigation` | 全局导航行，收窄侧栏时显示图标 |
| `session.menu` | 任务列表右键菜单及任务标题的同一操作菜单 |
| `settings.section` | Cindy 设置页中的插件配置页面 |
| `composer.completion` | 输入 `/` 或 `@` 后的文本补全提供者 |
| `composer.attachment` | 用户新添加附件的处理提供者 |
| `sidebar.section` | 侧栏中的折叠 MCP App 分区 |
| `window.titlebar` | 窗口标题区的原生图标按钮 |

`statusbar` 等原生控件位置支持 `button`、`select` 和 `status`。需要点击打开页面或调用工具时，
声明 `kind:"button"` 并指定 `view` 或 `tool`；示例的底部「示例已就绪」按钮会打开当前任务页。

状态栏按钮默认使用与工作目录标签一致的 12 号字。`fontSize` 可设为数字 12、13 或 14，其他值沿用默认字号。

要把 Open in 放到工作目录上，在 `mcpApps.host.contributions` 声明：
`{"id":"open-in","title":"Open in","position":"workdir.menu","view":"open-in-page","presentation":"popover"}`。
`open-in-page` 是插件已声明的页面 ID。用户点目录名后可选系统文件管理器或插件操作。选择 Open in 才加载页面。
任务页面（弹层或侧栏）声明 `scope:"task"` 和 `context` 能力后，通过 `app.getHostContext().cindy.context.workingDir` 读取用户点选的目录（含当前显示的 worktree）。目录的文件操作沿用已有授权。
旧客户端忽略此位置，兼容旧版时可保留原状态栏入口。

`message.menu` 声明菜单动作，`kind` 缺省或填 `button`，引用 `view` 或 `tool`；
不在菜单内嵌选择框、状态条或任意页面。`match.roles` 可区分用户消息和 AI 消息。
例如 `{"id":"open-message","title":"打开任务页面","position":"message.menu","view":"board"}`。
菜单显示插件来源，点击沿同一已安装插件的页面/工具入口执行；只有菜单打开时才订阅该菜单项状态，关闭立即释放。

正文位置只引用页面；`match.roles/tools/plugins` 限定候选。原文默认可读，用户选择后才打开页面，
不可用时回原文。需要正文内容时声明任务页面及 `context`；内容来自已有展示投影，不另查消息数据库。
`commands` 声明 `{id,title,view|tool,arguments?,shortcut?}`，共用同一执行路径。
快捷键采用 `Mod/Meta/Ctrl/Alt/Shift+键`，服从 Cindy 原快捷键和编辑按键，冲突时不抢占。

新增导航和菜单只支持按钮形态。导航适合全局工作台；任务菜单带真实任务身份，工具参数中的
`cindy_ui.sessionId` 由 Host 填写，插件不能用静态 arguments 改写。菜单只在打开时订阅小状态。
`settings.section` 必须引用全局 view，页面使用原 AppBridge、CSP 和生命周期。
这几个位置不支持 `presentation:"popover"`。已安装版本声明的位置直接生效，不按位置记录分项批准。

`window.titlebar` 声明 `view` 或 `tool`，仅支持按钮；`icon` 使用原导航图标名，缺省为 puzzle。
按钮在主窗（含完整任务副窗）和分离侧栏窗口的原标题区内显示，提示带插件来源，沿原页面/工具入口执行。
系统窗口控件、菜单和快捷键保留原行为；没有任务时，引用任务 view 的按钮不可用。

任务列表的每行内容、内置分组和任意布局面板不开放贡献位：前者处于长列表性能路径，后者由宿主布局树管理。
插件可用全局 MCP App 和侧栏入口呈现自己的任务视图及分组，不向宿主列表逐行挂载组件。

`sidebar.section` 必须引用具名 view，默认收起；用户展开且侧栏可见时才加载页面，收起、隐藏或撤权后释放。
任务 view 只绑定实际本机任务，全局 view 不借用当前任务。分区沿原页面的主题、CSP 和小状态显隐，
不接管内置任务列表与布局树，也不支持 `presentation:"popover"`。

### 输入补全

```json
{"id":"reference","title":"业务引用","position":"composer.completion","tool":"lookup","trigger":"@"}
```

`trigger` 只接受 `/` 或 `@`，提供者必须是 app-visible 工具，不接收完整草稿。
Host 在现有输入触发状态出现后等待 200ms，传入 `{trigger,query}`，与静态 arguments 合并；
提供者使用该版本已声明的工具，最长 2 秒，不读取 Agent 的权限模式或另弹确认。
没有贡献时不安装监听或发送 IPC，普通打字不等待插件。
面板关闭、切换任务、查询或授权变化后取消/丢弃旧结果；内置命令和资源仍按原方式使用。

工具返回标准 MCP `structuredContent`，或内容为 JSON 的 text block：

```json
{"items":[{"id":"issue-1","label":"任务记录","insertText":"业务记录 #1","description":"插入引用文本"}]}
```

每个提供者最多展示前 8 项，id 在该次结果中唯一且不超过 64 字符；label 不超过 200 字符，
insertText 不超过 32768 字符，description 可选且不超过 2000 字符。
用户选择后只在原查询选区插入纯文本，不解释 HTML、不调用命令、不发送消息。

### 新添加附件的处理

```json
{"id":"prepare","title":"整理文本附件","position":"composer.attachment","tool":"prepare_attachment","accept":{"extensions":[".txt",".md"],"mimeTypes":["text/plain"]}}
```

`accept` 至少声明一项：小写的带点扩展名，或 MIME 类型（可用 `image/*`、`*/*`）；任一匹配即调用。
仅用户本次选取、拖入或粘贴的附件进入此入口，不扫描已有草稿和消息。没有贡献时不订阅或请求。
多个匹配提供者按声明目录顺序尝试，首个 `handled:true` 结束，`handled:false` 交给下一个。

工具必须 app-visible。插件整体安装/更新批准有效且已启用时，Host 将主人本次主动添加、匹配声明的附件
直接交给同一插件实例，不再询问文件权限、不写永久 grant，也不套用 Agent 的权限档位。
本次输入来自浏览器 File 或粘贴 Blob 已有的字节，Host 校验真实大小；原生附件入口不接受绝对路径或缓存 URL 请求主机读盘。
Host 填入 `attachment:{name,size,mimeType}` 元数据；媒体复用原媒体寄存并放入 `attachments` 哈希参数；
非媒体工具须声明保留参数 `cindy_handoff_files:{type:"array"}`，
得到 `handoff:` 引用。插件不能从参数取得本机路径。字节处理仍使用原文件能力（见 `plugin-files-and-library.md` §4.10.3），
需要联网时也沿原 network 声明；此入口不增添文件或网络权限。

返回标准 MCP `structuredContent`，或含同一 JSON 的 text block：

```json
{"handled":true,"text":"写入草稿的提取文字","files":[{"type":"resource_link","uri":"handoff:<本实例引用>","name":"prepared.txt"}]}
```

`text` 与 `files` 至少一项非空。文字为纯文本、最多 128000 字符；文件沿原每次 4 个、每个 64 MiB 上限，
只接受本实例可读的 `handoff:`、`library:` 或 `cindy-media:` 链接。Host 读取真实大小、类型与字节，再放入原附件仓；
不信任插件自报路径、URL 或大小。不要把临时页面 URL 当文件引用返回。
处理期间保留原附件，成功后才将结果写回同一份草稿并替换原附件，不自动发送。
用户移除原附件、清空草稿或来源撤权后不接纳晚到结果；错误保留原附件，不自动重试。
仅支持本机输入框，远程任务、手机和共享访客不在此入口传本机文件。

### 统一插件设置

```json
{"settings":[
  {"id":"enabled","title":"启用摘要","type":"boolean","default":true},
  {"id":"limit","title":"显示条数","type":"number","default":8,"min":1,"max":20},
  {"id":"style","title":"风格","type":"string","default":"brief","options":[{"label":"简洁","value":"brief"},{"label":"详细","value":"full"}]}
]}
```

把这个片段放在 `mcpApps.host`。支持 boolean/string/number、number 的 min/max、string 的 maxLength
（默认及上限为 32768），以及同类型的有限 options。字段和约束在安装/更新确认中展示，不记录独立批准状态。
只登记普通偏好，凭证继续走 secrets / OAuth。简单字段不要求声明 MCP 页面或 UI 权限。
复杂配置用 `settings.section` 全局 view；同一 view 可被多个带不同 arguments 的配置入口复用。

Cindy 设置页展示原生字段，搜索可按插件名、字段及选项定位。Agent 使用原 app-settings 的
`plugins.<物理实例>` section 进行 list/get/update/reset。同名 root/local/企业实例分开，不能用裸插件 id 合并。
MCP App 页面可调用 `cindy.ui.settings({operation:"get"|"update"|"reset",patch?})`，Host 固定到该页面的实例。
读取返回 `state:{value,defaults,customizedKeys}`；只保存用户覆盖，恢复默认删除已登记键。
值仍为原插件 `/kv` 的同名键，不做第二份配置；未登记私有键不进入统一设置，也不会被恢复默认删除。
`/kv` 整体写入仍保留原语义，已登记字段须满足相同约束；插件读取缺失键时也应应用声明 default。

### 标准 SDK 与宿主能力

页面在 `connect()` 前注册 `onhostcontextchanged`，通过 `app.getHostContext()` 读取 `cindy`：

- `source:{instanceId,viewId,sessionId}`：Host 绑定的来源，全局页面的 sessionId 为 null。
- `input`：开页输入，不需要 context 权限。
- `capabilities`：已安装版本声明且宿主支持的能力，用于探测支持情况。
- `context`、`selection`：仅声明 context 的任务页面提供。正文页面可含 message/tool 投影；task 为开页时的标题、目录、模型快照。
- `draft:{revision,selection}`：仅获准 draft 后提供；订阅只发版本与选区，不反复复制整份文档。
  `selection` 为当前草稿选区的 `{from,to,text}`，无选区时为 null。

草稿读取和修改均由原任务编辑器处理，独立窗口中的页面也订阅同一份草稿。
完整任务副窗使用自身编辑器的草稿，分离侧栏和弹出页签使用主窗编辑器的草稿。
读取或修改前先保存编辑器待处理的输入；旧 revision 的替换会被拒绝。
只有打开的获准任务页面订阅草稿，页面关闭即释放，连续变更合并为最新快照。
需要正文时调用 `cindy.ui.draft({mode:"read",revision?,offset?})`，返回 `{revision,chunk,nextOffset}`。
`chunk` 是编辑器文档 JSON 的一段（最多 128000 个字符），不是普通草稿字符串；从 offset 0 开始，
将返回的 nextOffset 和 revision 用于后续读取，直到 nextOffset 为 null，再拼接各 chunk 并 JSON.parse。
完整文档不截断；读取期间版本变化会拒绝旧 revision，应重新从 0 读取。仅实际读取时序列化，关闭页面释放缓存。

```js
import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: '工作台', version: '1.0.0' }, {}, { autoResize: true });
app.onhostcontextchanged = () => render(app.getHostContext());
app.onteardown = async () => ({});
await app.connect();
render(app.getHostContext());
if (app.getHostContext()?.cindy?.capabilities?.includes('draft')) {
  await app.callServerTool({ name: 'cindy.ui.draft', arguments: { mode: 'append', text: '追加内容' } });
}
```

| 能力 | 具名页面可用的工具 |
| --- | --- |
| 视图声明 | `cindy.ui.open({viewId,input?})`，只打开同插件已安装版本声明的视图 |
| `settings[]` 声明 | `cindy.ui.settings({operation:"get"|"update"|"reset",patch?})`，只操作当前实例登记字段 |
| `context` | 向标准 host context 推送获准的任务/正文投影和任务区域选中文字 |
| `draft` | `cindy.ui.draft({mode:"read",revision?,offset?})` 按需完整读取；`{mode:"append"|"replace"|"replace-selection",text,revision?}` 编辑，替换整份草稿或选区须带最新 revision，冲突拒绝，不发送消息 |
| `appearance` | `cindy.ui.appearance({patch?,reset?,ifRevision?})`，沿原外观设置读写 |
| `visibility` | `cindy.ui.visibility({visible?,regions?})`，读取或修改窗口及 workspace/sidebar/header/messages/composer/tools/windowControls 的显隐 |

原工具卡片仍沿原 MCP Apps 契约。任务页面也可使用标准 `ui/message` 与 `ui/update-model-context`；
全局页面不能自行选任务发送。任务清空/归档、批准或 owner 变化后旧操作失效。
区域显隐是临时的窗口状态，停用、撤权或卸载后释放；权限提示保持可操作。

### 外观资源与正文样式

在 `mcpApps.host` 额外声明需要的字段和包内资源；安装/更新确认展示完整声明，接受该版本即授予这些能力，不另记资源批准：

```json
{
  "capabilities": ["appearance"],
  "appearance": {
    "fields": ["uiFont", "bodyFont", "wallpaper", "theme", "reading", "contentStyle"],
    "resources": [
      { "id": "font", "kind": "font", "path": "assets/font.ttf" },
      { "id": "wallpaper", "kind": "image", "path": "assets/wallpaper.png" }
    ]
  }
}
```

`appearance` 控制外观字段；同时声明 `fields` 时仅开放列出的字段。
资源引用支持 `asset:<id>`、本插件已获准 Library 文件 `library:<relative path>`，以及本插件拥有的 `cindy-media://blobs/...`；
不接受任意磁盘路径或远程 URL。字体支持 TTF/OTF，字体与图片按格式和大小校验，视频壁纸可带静态 fallback。

```js
const reply = await app.callServerTool({ name: 'cindy.ui.appearance', arguments: {} });
const before = JSON.parse(reply.content.find(block => block.type === 'text').text);
await app.callServerTool({ name: 'cindy.ui.appearance', arguments: {
  ifRevision: before.revision,
  patch: {
    bodyFont: { resource: 'asset:font', size: 17 },
    wallpaper: { resource: 'asset:wallpaper', visibility: 0.3, blur: 2 },
    reading: { bodyLineHeight: 1.8, codeLineHeight: 1.5, maxWidth: 800 },
    contentStyle: { messageGap: 12, messagePadding: 8, messageRadius: 16 },
    theme: { light: { userBubble: '#f0f0f0', userText: '#202020' }, dark: { userBubble: '#303030', userText: '#eeeeee' } }
  }
} });
await app.callServerTool({ name: 'cindy.ui.appearance', arguments: { reset: ['bodyFont', 'wallpaper', 'reading', 'contentStyle', 'theme'] } });
```

读取返回原设置及 `{revision,values}`；写入另有 `application.status`：`applied` 为实际消费端确认，
`saved` 为已保存但尚未确认显示，`failed` 为未成功应用。主题分深浅色，正文样式只作用于消息区域；不接受任意 CSS。
沿原设置通知更新，不随消息重复读取；相同字体资源复用已加载字体。资源来源失效后沿原设置流程清理，避免遗留不可用字体或壁纸。

### 原生小控件按需更新

复杂页面内部状态使用标准 MCP Apps。更新原生按钮、选择框、状态文字时，在 `main.js` 使用：

```js
function publish() {
  return cindy.ui?.updateContribution('progress', () => ({ title: '已就绪', disabled: false, visible: true }));
}
cindy.onHostMessage(message => {
  if (message.type === 'ui-consumers') void publish();
});
await cindy.ping(); // 复用原握手恢复已存在的需求。
await publish();
```

`hasConsumers(id,target?)` 只读本地缓存。`updateContribution(id,build,target?)` 在无人消费时不执行 build、不发通信；
连续更新合并为最后一份完整小状态，返回 `{ok:true,observed:boolean}`。
字段为 `title/value/disabled/visible/items`，`items` 仅用于显式声明的动态按钮集合。
省略字段恢复声明默认值，不能改变工具、静态参数、页面或权限。
需求消息含本插件的 `{id,sessionId,clientId?}`。传 `target:{sessionId,clientId?}` 精确更新对象，
省略 target 则更新该入口的实际消费者。需求不携带正文，不唤醒休眠插件，也不新增轮询或心跳。
消息和回合插槽随原消息区域进入、离开视口登记和释放状态需求，窗口隐藏时也释放；更多菜单中的入口仅在菜单打开时登记。
每个窗口最多订阅 512 个不同的原生状态目标（插件、入口、任务、消息的组合），按已挂载且活跃入口的登记顺序截取。
超出上限的入口仍按清单默认值显示、可以点击，但暂不接收实时状态；前面的入口离屏、隐藏或卸载释放需求后，后续入口自动补位。

### 完整示例

[host-ui 示例](examples/interactive-pages/host-ui/) 包含真实清单、后台和官方 SDK 页面，演示原生入口、折叠侧栏、附件交接与重命名、输入补全、统一设置、
全局/任务视图、命令、草稿和宿主操作。使用示例时按 §2 填写 `minCindyVersion`，
并让用户提供图标或明确同意生成图标，不能生成占位色块。
用包含本章实现的宿主执行 `ghost_forge_pack`；安装另需用户指示。验收应覆盖安装/更新整版确认、无分项记录的已装插件能力可用、旧插件无感兼容、
无候选历史消息不通信，以及关闭/撤权后停止投递。
