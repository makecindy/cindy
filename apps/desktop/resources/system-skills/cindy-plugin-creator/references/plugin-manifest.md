## 2. ghost.json 身份卡

```json
{
  "schemaVersion": 3,
  "id": "my-ghost",            // 小写字母/数字/连字符,1–32 位,全局唯一
  "name": "我的插件",           // 展示名
  "description": "一句话说清这个插件是干嘛的(给人看:插件详情页)",  // 1–300 字
  "whenToUse": "需要生成图片、插画、配图、修图、P 图、改图时找我",  // 1–300 字,给模型看:进 agent 会话的插件花名册,是"用户不点名时 AI 能不能想起你"的关键。写成场景枚举,可反复调优;花名册会折叠连续空白,异常数据会截断;缺省时花名册回落用 description
  "icon": "assets/icon.png",   // 建议:插件图标(包内相对路径;扩展名限 png/jpg/jpeg/webp/gif,不收 svg——svg 可携带脚本,虽经 <img> 渲染不执行,仍不给这个面)。不配则面板与消息身份头显示默认拼图占位符;官方插件仓惯例放 assets/icon.png
  "locales": {                 // 可选:插件只跟随宿主语言;不支持/缺失语言固定回退 en
    "en": "locales/en.json",
    "zh-CN": "locales/zh-CN.json",
    "ja": "locales/ja.json",
    "ko": "locales/ko.json"
  },
  "version": "1.0.0",
  "releaseNotes": "新增图片编辑工具。", // 可选；更新说明要求见 §7.3
  "minCindyVersion": "1.2.3", // 示例；v3 必填:本插件实际依赖的首个 Cindy 正式版本(SemVer)
  "entry": "main.js",          // 电子脑入口(kind 字段已无需填写:插件只有芯片一种形态,缺省即 chip;写了也只认 "chip")
  "launch": "on-demand",       // 可选:电子脑启动模式。on-demand(缺省)=被需要才拉起;resident=唤醒即常驻(详情页会如实标注"常驻运行",绝大多数插件不需要,仅订阅型/需秒响应的场景用)
  "command": "画图",            // 推荐:用户 $画图 显式点名(与已装插件查重,冲突拒装)。
  // 注意:不声明 command 时,插件页"使用"按钮将处于禁用状态——用户无法通过插件页
  // 一键启用/唤起插件,也不能用 $command 显式点名;但 AI 的工具发现与调用不受影响
  // (仅检查插件启用状态与 tools 声明)。除非你的插件完全靠 panel 或 subscribe 驱动,
  // 否则请始终声明一个 command。
  "tools": [ /* 见 §3；下方 open_view 必须在此声明 */ ],
  // 可选交互页面，完整示例见 §4.23；需要 minCindyVersion >= 0.1.122-beta
  "mcpApps": { "ui": {
    "resources": [{ "uri": "ui://records/v1", "file": "ui/page.html" }],
    "tools": { "open_view": { "resourceUri": "ui://records/v1" } }
  } },
  "cindy": { "image": ["generate", "edit"] },   // 直接声明能力及详单,见下
  // 类目按需申请:image / video 的动作是 "generate" | "edit";media 只有
  // "deposit"(把你手里的媒体字节寄存进总仓换指纹,见 §4.0.1);
  // text 只有 "oneshot";search 只有 "web"(Cindy 托管公网搜索)。每条都会
  // 在插件详情的能力清单里单独列给用户看。
  "panel": { "title": "面板标题", "html": "panel.html", "position": "left",
             "minWidth": 240, "defaultFraction": 0.24,
             "systemButtons": { "maximize": false } },
  // panel.position:面板显示形态。left(缺省)/ right / top / bottom = 右侧栏常驻面板:
  // 启用后自动成为聊天区对应边页签组里一个不跟对话的全局页签(切任务保留、可最大化、
  // 可弹成独立窗口、用户可拖到任何一边或关闭;用户放置过后主机记住用户的位置,
  // 你的声明只是首次出现时的默认);"tab" = 插件页内的独占面板(用户在插件页点插件卡的
  // 「使用」打开,离开插件页即关闭;同一时刻至多一个;此形态没有拖缝宽度,声明 minWidth /
  // defaultFraction 会被拒装,请移除)。minWidth / defaultFraction 仍可声明(兼容),当前
  // 页签组宿主不消费。
  // panel.systemButtons(可选):历史字段,保留兼容、当前不生效(右侧栏页签的
  // 关闭 / 最大化 / 弹出按钮由主机统一提供);position:"tab" 时声明本字段拒装
  // 一级主视图是独立能力，见 §4.20。使用时直接声明：
  // "mainView": { "title": "工作台", "icon": "puzzle", "html": "main-view.html" }
  // 跟对话的任务页(§4.22):页签存在每个任务自己的右侧栏里,随任务切换
  // "taskView": { "title": "模拟器", "html": "task.html" }
  // 可选 "open": "page"(缺省,撑满内容区)/ "sidebar"(作为页签进聊天区某一边,配 "side":
  // left / right / top / bottom)/ "window"(弹成独立窗口);只是左侧导航入口的默认打开方式,
  // 用户拖过 / 弹过后以用户的放置为准。可选 "multiple": true 允许同一视图同时开在多处。
  "settingsHtml": "settings.html",  // 可选:设置页「自定义设置区」自绘界面(见 §4.8;声明了用户填的凭证时仍必填,用于长期管理/替换/清除;调用前缺失时主机也会在统一 Setup 卡内联收单,见 §4.7)
  "showTaskPreferences": true,     // 可选:是否显示宿主「模型与任务」卡,缺省/true 显示,false 隐藏;见 §4.8
  "settingsHeight": 360             // 可选:固定高度 px(160–800);缺省 = 随内容自适应(矮内容真收矮,高至 800);内容会动态增减时才声明,避免抖动
}
```

`schemaVersion: 3` 必须填写 `minCindyVersion`。它写本插件实际依赖的首个 Cindy
正式版本；Manifest schema 本身没有统一的 Cindy 版本下限。不要为了使用某项既有能力随意抬高版本。
官方市场会优先向旧客户端投影最近的兼容历史版本，没有兼容版本时不展示该插件。
Desktop 信任来源已经完成的版本选择，不再按 `minCindyVersion` 追加筛选或确认弹窗；
用户主动导入的本地包、以及用户添加的自定义市场也遵循同一安装策略。这个字段仍必须
准确填写：它供发布服务选择兼容 release，也记录插件真实依赖的首个 Host 版本。

`mcpApps.ui` 声明页面资源与工具可见性，完整写法见[§4.23](plugin-interactive-pages.md)。

### whenToUse:只写发现线索,不写使用规则

在作者契约里,`whenToUse` 是专门给模型做插件发现与判断的唯一字段;
`description` 给人看(插件详情页),不要拿它兼任模型路由说明。
`whenToUse` 最多 300 字符,花名册会完整展示有效内容,折叠连续空白并对异常数据做防御性截断。花名册命中已知 `ghost_id` 时用
`ghost_info` 精准现查单条;未命中或需要全量实时回查时用 `ghost_list`。两者都返回完整
`CindyGhostInfo`,取得信息后再按任务交叉读取 Manual 与插件工具目录,信息足够即可调用。
未声明 `whenToUse` 时宿主会用 `description` 兼容回落,但高质量插件
必须单独写好 `whenToUse`,不要依赖回落。

只写用户意图、业务对象和常见说法的**场景枚举**,回答"什么情况下应该想到这个插件"。
禁止塞入"必须/不得"式行为规则、工具调用顺序、参数协议、错误码与重试策略。
单个工具怎么调用放进工具及参数 `description`;同一类别内、紧贴当前工具集合与参数的
动态规则放进 §3.5 的 **`list_tools(category)` RULES**;多工具组合、跨类别完整流程、
长期稳定的共同原则与深入用法放进 §3.6 的 Manual。不要在三处复制同一份规则。

反例(错把使用规则塞进发现面):

```json
"whenToUse": "管理项目时找我;必须先调用 list_tools(category=project),再调用 call_tool;遇到 INVALID_ARGS 不得改用其它工具"
```

改正版(只保留场景枚举):

```json
"whenToUse": "需要查询、创建或更新项目、任务、成员、迭代与发布状态时找我"
```

## 2.1 本地化资源(locales)

插件语言**只跟随 Cindy 宿主当前语言**。不要读取 `navigator.language`、操作系统语言或
浏览器偏好，也不要在插件内保存另一份语言选择。宿主当前支持
`zh-CN / en / ja / ko`；插件没提供宿主当前语言时固定使用英文，因此只要声明
`locales` 就必须提供 `en`。

locale JSON 覆盖清单中已有的可本地化字段。**翻译是可选项**：提供的条目必须合法，
未提供的条目在运行时回退原 manifest 文案(通常是英文)；完整翻译(含每个工具参数
的 title / description)是高质量插件的推荐标准，但不是打包/装入门槛。工具按稳定的
tool name 对齐，协议键、工具名和参数名不翻译：

```json
{
  "name": "My Plugin",
  "description": "What this plugin does.",
  "whenToUse": "Use it when ...",
  "tools": {
    "do_thing": {
      "description": "Do the task and return the result.",
      "parameters": {
        "/properties/query": {
          "title": "Query",
          "description": "Describe what to search for."
        }
      }
    }
  },
  "panel": { "title": "Plugin panel" },
  "mainView": { "title": "Workspace" },
  "taskView": { "title": "Simulator" },
  "network": {
    "secrets": {
      "api_key": { "label": "API key", "hint": "Create one in account settings." }
    },
    "connections": {
      "instance": { "label": "Service instance", "hint": "Enter the instance URL and token." }
    }
  },
  "node": {
    "secretBindings": {
      "worker_key": { "label": "Worker key", "hint": "Used only by the local worker." }
    }
  },
  "setup": {
    "kv": {
      "default_repo": { "label": "Default repository" }
    }
  }
}
```

可翻译字段：`name`、`description`、`whenToUse`、`tools`(工具 description 与参数
文案)、`panel.title`、`mainView.title`、`taskView.title`、`network.secrets / connections`、`node.secretBindings`、
`setup` 的 kv 标签；凭证、连接、Node 凭证和 kv 项按稳定 key 对齐(提供某个 key 的
条目时 label 必填,hint 可选)。工具参数 schema 中已有的 `title / description` 用
JSON Pointer 对齐（如 `/properties/query`；根节点用空字符串 `""`），参数名、类型、
枚举和协议结构不翻译。缺译不拒绝，只回退原文；但**翻译错位仍是硬错误**——未知
key、未知字段、原清单没有的条目、类型或长度不合格、文件缺失、路径大小写与磁盘
不一致、无效 JSON 或单文件超过 64KB 都会在 Forge 打包期、内置播种期与安装期拒绝。
清单列表、详情页、Panel 标题、安装/配置提示和 Agent 工具目录都消费同一份本地化结果。

所有会作为对象索引的稳定标识——tool name、network secrets / connections key、
node secretBindings key、setup kv key——都不能使用 `__proto__`、`constructor` 或
`prototype`；这些名称是宿主保留键，打包时会直接拒绝。

v3 直接用顶层字段声明插件贡献项与自主 Host 能力，不再有 `slots`。带详单的字段是 `tools`、`cindy`、
`agent`、`panel`、`mainView`、`taskView`、`card`、`subscribe`、`network`、`node`、`preview`、
`browserExtension`、`skill`；布尔能力写成字面量 `true`：`notify`、`badge`、`confirm`、`fs`、
`library`、`deviceSync`、`sessionContext`、`pick`、`workspace`。不用的字段直接省略。
`deviceSync` 的声明与调用约定见 [§4.10.2 资料同步](plugin-files-and-library.md#4102-同账号电脑间的插件资料同步)。
邮件插件声明 `mail: true`，调用 Cindy 内置 `cindyMail.register(adapter)`
（version 1），不生成卡片 HTML、不打包公共流程；纯邮件插件不需要 `card`。
阅读邮件可声明 `mailReader:{tool,hosts}`，工具接收 `{url}` 并返回 MailMessage，默认只读。
可选 `participantPhotos:[{email,url}]` 最多 64 项，按小写邮箱精确匹配；照片 URL 仅 HTTPS，
无凭据、自定义端口。缺照片/权限时省略，不阻断阅读；旧宿主忽略。桌面回退公开头像、
企业图标和首字；头像不证明身份。正文外图仍需单独点击显示。
`mail` 只能省略或写字面量 `true`；声明 `mailReader` 时必须同时有 `mail: true`，
且 `tool` 必须指向本清单 `tools` 中的工具。协议校验与桌面安装校验都会拒绝不完整组合。
支持打开即已读时增加 `mailReader.markRead:true`，读取工具接受可选 `markRead:true`；
声明中的 `markRead` 只能省略或为字面量 `true`，`false`、字符串等其它值不合法。
仅用户主动打开时传入，AI 读取和邻近预加载不传。成功读取后只标记当前邮件，不标记整个会话或草稿。
Host 派发器会移除普通工具参数中的此标记，仅可信阅读器打开请求可注入；其它明确授权的已读操作工具不受影响。
用户主动打开链接时，Host 还可注入 `openDraft:true`（普通工具参数不能自行设置）。识别为草稿后，插件解析服务商稳定的草稿 ID，复用已有公共草稿读取/展示流程，并在邮件结果中返回 `draftId`。Host 仅在核实当前任务、插件、邮箱账号与草稿一致后，给客户端返回 `draftCallId`，打开现有编辑器。插件不能自报卡片 ID；后台读取保持只读。旧 Host 不注入此标记，旧插件忽略它，继续支持只读展示。
标记失败仍返回正文和 `markReadFailed:true`，由 Cindy 显示提示；新增 OAuth scope 不阻断已有授权的操作。
适配器提供 providerName、draftStorage（server/local）、selectAccount、readDraft、writeDraft。
通过 present 展示读回草稿，beforeTool 统一 get/send/update/delete，resolveDraft 获取最新位置。
Host 负责样式、编辑同步、发送和任务续接；同一任务同一封邮件只显示最新卡片，旧快照保留但不重复展示。插件保留凭据、MIME 和服务商请求。
插件重启后，下一次卡片编辑或工具操作会自动读回原草稿，使用 Host 卡片中上次同步的内容、卡片编辑和邮箱最新内容做三方合并；单边变化、相同变化和不重叠的文字修改自动合并，只有无法合并的修改才保留两边内容并提示具体字段。版本标记或预览地址变化本身不算冲突。适配器返回 execution:not_executed 和 stale 读回快照时可合并后重试一次，未知操作结果不能重试。发送倒计时结束时若发现实际内容变化，展示合并稿并重新倒计时。
图文适配器的 attachmentItems 可为已有图片 key 添加 contentId，表示将同一附件插入 HTML 正文；必须核验实际图片字节、保留 MIME 引用，不能重复上传或把预览 URL 写入邮件。
工具说明应要求默认展示草稿卡等用户确认；只有用户已明确确认该邮件，或有效的用户/任务指令明确授权该范围内直接发送，才不再询问。写信/回复请求、编辑及自动审批本身不代表确认。
UI 和 Agent 发送都先进入 10 秒倒计时，卡片可撤销或立即发送；beforeTool(send) 等待最终回执。
撤销后保留草稿且不得自动重试。所有发送先创建并展示草稿，再走 beforeTool(send)，不得保留直发旁路。
缺少 SDK 时只读可用，编辑/发送需更新 Cindy；不要绕开公共流程直接发送已展示草稿。

不能写 `false`。`card: {}` 与 `agent: {}` 分别表示基础聊天卡片能力和用户点击后
发起 Agent 回合；其它对象型能力必须包含该能力真正需要的详单。

v3 未识别的顶层字段会原样保留，但旧版 Cindy 不展示、不给这个未知 Host 能力、也不因此阻止安装。
当未来 Cindy 识别该字段后，它才会进入正常的能力展示与运行时守门。插件若依赖新能力，
应同时把 `minCindyVersion` 提高到首个支持版本；仅由插件包自己完成的逻辑不要发明
Host 能力字段。v2 的 `slots` 只用于存量包兼容，新插件不得再写。
当前 Agent tool-call 内，插件工具是否执行由外层 `ghost_call` 的 Agent 授权决定；
普通网络和 workdir 文件操作按上文的 `callId` 绑定复用 Agent 授权。CLI 继续由
已声明运行形态的 Node 工作进程执行，不新增未知 Host 能力或具体命令登记。

**agent 能力详单**:写 `"agent": {}` 时，默认只允许在用户真实点击你的
聊天卡片后发起一次 Agent 回合。若确实需要没有当次点击也能自动发起，写
`"agent": { "background": true }`。后台档会在插件详情中单独显示为更高风险能力，
而且仍只能使用用户曾通过点击卡片与你建立关联的会话。
要把任务交给 Agent 干并**取回结果**(而不是发进用户的会话),另写
`"agent": { "errand": true }`(可与 background 并存),见 §4.11.1;同样是详情页
单列的高风险档。
要请用户新建一条**自动化**(让插件里的内容定期自己刷新),另写
`"agent": { "schedule": true }`(可与前两项并存),见 §4.11.2。它只能打开预填好的
创建面板,任务由用户选好模型后亲手保存才存在;详情页单列一档。
用普通任务接口(§4.11.3)写 `"agent": { "tasks": true }`;需要把自己创建的任务放到后台
(不进任务列表、搜索与通知)时再加 `"hiddenTasks": true`,它必须与 `"tasks": true` 同时
出现,否则拒装;详情页单列一档。
向项目、已有任务或伙伴投递内容时另声明 `"agent": { "tasks": true, "targets": true }`（§4.11.3）。
`targets` 是独立权限，安装/更新确认单列，需 Host 显式批准；旧 tasks 批准不授予目标访问。
新包的 targets 必须是布尔值，targets:true 缺 tasks:true 时拒装。

**node 工作进程详单**(声明 node 时必写,详见 §4.12):

```json
"node": {
  "entry": "node/worker.cjs",          // 包内 CommonJS 入口，只认 .js/.cjs
  "protocol": "json-rpc-stdio",       // json-rpc-stdio / mcp-stdio
  "lifecycle": "on-demand",           // 可选:on-demand(缺省)/resident(常驻,单列高风险权限)
  "idleTimeoutSeconds": 120,           // 可选:按需档空闲关闭时间,30–3600;resident 禁写
  "entries": ["node/build.cjs"],       // 可选 ≤4 条:额外工作进程入口(每入口一个独立进程,调用时用 entry 指名,见 §4.12.1;不能与 entry / 浏览器沙箱 entry / 彼此重复)
  "childSpawn": true,                  // 可选:worker 可请宿主代启申报入口的原样 stdio 子进程(见 §4.12.4;详情页单列一行)
  "secretBindings": [{                 // 可选 1–4 条:safeStorage 持久化凭证按方法临时注入 Worker
    "key": "mail_code",                // 插件内唯一,小写字母开头,1–32 位小写/数字/下划线;禁用宿主保留键(见 §2.1)
    "label": "邮箱授权码",             // 详情页与设置页展示名
    "methods": ["mail/action"],         // 只在这些 JSON-RPC 方法中注入,每条 1–128 位
    "entry": "node/worker.cjs",         // 可选:逐字命中 node.entry/entries;缺省仅主入口
    "hint": "请填写服务商授权码",       // 可选 ≤200 字
    "url": "https://mail.example.com/settings" // 可选 https 申请页
  }]
}
```

node 详单**不接受** `command` / `args` / `shell` / `env` 或其它自造字段；
入口固定使用 Cindy 随包运行时启动，用户不需要另装 Node、CLI 或 MCP。
**不要在 worker 里用 `process.execPath` / `child_process.fork` 再生 Node 子进程**
——正式包关闭了 RunAsNode,那样生出来的不是 Node;要多进程就把入口申报进
`entries`,由主机代开。

**preview 详单**(声明 preview 时必写,详见 §4.15):

```json
"preview": {
  "hosts": ["*.example.dev", "localhost"]   // 1–4 条;语法同 network.hosts;能在右侧栏打开的预览网站白名单,详情页逐条展示
}
```

**skill 详单**(声明 skill 时必写,详见 §4.16):

```json
"skill": {
  "items": [{                       // 1–4 条
    "dir": "skills/my-skill",       // 包内技能目录,内必须有 SKILL.md
    "name": "my-skill",             // 硬规则:与 SKILL.md frontmatter name 逐字一致;小写字母/数字加单连字符分段(禁首尾/连续连字符),≤64
    "description": "……"             // 硬规则:与 SKILL.md frontmatter description 逐字一致(详情页展示的就是 Agent 读到的),1–1024 字
  }]
}
```

**manual 随包手册**(独立顶层字段,不是 slot、不是权限项,详见 §3.6):

```json
"manual": {
  "items": [{                         // 1–8 条
    "dir": "manual/getting-started", // 包内物理目录,必须有 MANUAL.md
    "name": "getting-started",        // ghost_manual path 的逻辑首段,不暴露物理 dir
    "description": "从安装到首次运行" // 一级轻量索引,1–300 字
  }]
}
```

**cindy 能力详单**:声明插件要基于哪些 Cindy Core 能力提供上层能力--只有类目和
动作,**没有任何具体模型/供应商信息**。image / video 声明同时决定该插件能否在
自己的设置页或面板读取对应类型的模型目录；生成请求仍由当前 Agent 发起。
类目与动作:`image`(`generate`=出图 / `edit`=改图)、`video`(`generate`=
文生视频 / `edit`=图生视频,参考图怎么用由 `refMode` 决定:首尾帧 1–2 张,
或多张参考图,详见 §4 的 cindy-request 视频段)、`media`(`deposit`=把手里的
媒体字节存进媒体库,§4.0.1)、`text`(`oneshot`=快问快答,§4.0.2)、
`embed`(`text`=文本转向量,§4.0.3)、`search`(`web`=Cindy 托管
公网搜索,见 §4 的 `search_web` 段)。
详单里没申请的动作,运行时点单直接被拒。`search.web` 只能由真实 tool-call
触发,还必须同时声明至少一个 `tools` 条目。旧 v2 包的 model slot/字段仍兼容，
但新插件一律使用 v3 的 `cindy` 字段。

**network 详单**(声明 network 时必写,详见 §4.7):

```json
"network": {
  "hosts": ["api.example.com", "*.weather.com"],   // 1–8 条;小写域名至少两段;通配只允许最左 "*.";详情页逐条展示给用户
  "secrets": [{                                     // 可选 0–4 条:需要用户填的凭证(你只声明名字和注入位置,值用户填、主机保管)
    "key": "api_token",                             // 小写字母开头,小写/数字/下划线,1–32;禁用宿主保留键(见 §2.1)
    "label": "Example API Token",                   // 给用户看的名称(设置页/详情页)
    "source": "user",                               // 可选:凭证值来源。"user"(缺省)=用户可在调用前的主机 Setup 卡内填写,也可在你的 settingsHtml 里长期管理/替换/清除(当前仍要求同时声明 settingsHtml,见 §4.7);"login-email"=主机登录邮箱自动派生(用户不填;声明它时不允许再写 url,见 §4.7);"oauth"=主机托管 OAuth 授权,值 = 授权换来的 access token(必须同时声明 oauth 详单,见 §4.7 与下方 oauth 字段);"gh-cli"=仅官方 cindy-github 可用,优先复用本机 gh 登录、不可用时回落同 key 的设置页 PAT;"oidc-token"=主机为当前企业 Membership 按需签发短时 Connection JWT(插件不可读取,必须显式限制 inject.hosts,固定 Authorization: Bearer {value},见 §4.7)
    "hint": "在控制台生成后粘贴",                     // 可选提示(主机 Setup 卡与 settingsHtml 都会用到)
    "url": "https://example.com/settings/keys",     // 可选:控制台/申请地址(仅 https)。调用前缺凭证时,主机 Setup 卡会在输入框旁展示本地化的「获取凭证」入口；settingsHtml 也可用 <a href> 逐字引用它,点击经主机转系统浏览器打开(见 §4.8「外链」)
    "inject": {                                     // 必填:这条凭证怎么进请求
      "header": "Authorization",                    // 注入的请求头名(Host/Cookie 等协议关键头禁用)
      "format": "Bearer {value}",                   // 恰含一个 {value} 占位,其余静态文本
      "hosts": ["api.example.com"]                  // 可选:注入范围(hosts 声明条目的子集,逐字);缺省=全部
    },
    "exchange": {                                   // 可选:key 换令牌二段式(服务要求先拿 key 换临时令牌时声明,主机照单代办,见 §4.7;与 oauth 互斥)
      "url": "https://api.example.com/token",       // 交换端点(https;域名必须命中 hosts 白名单)
      "bodyFormat": "{\"sub\":\"{value}\"}",        // POST 请求体模板,恰含一个 {value}(原始 key 落点,主机按 contentType 转义)
      "contentType": "application/json",            // 可选:application/json(缺省)/ application/x-www-form-urlencoded
      "tokenPath": "session",                       // 令牌在响应 JSON 里的点分路径(如 "data.token";值须是非空字符串)
      "ttlSeconds": 86400                           // 可选:令牌缓存秒数(60–2592000,缺省 3600)
    },
    "oauth": {                                      // source:"oauth" 时必填(其它来源禁写):主机托管 OAuth 授权详单(见 §4.7)
      "authorizeUrl": "https://accounts.example.com/authorize",  // 授权页(https;域名必须命中 hosts 白名单)
      "tokenUrl": "https://accounts.example.com/token",          // code/refresh 交换端点(https;域名必须命中 hosts)。注:个别服务商(如 xAI)的新版 consent 页不再 302 回 loopback,而是页面 JS 跨源投递授权 code——主机允许的投递来源 = authorizeUrl/tokenUrl 的 origin + hosts 白名单命中的 https 域;consent 页与授权端点不同域时,把 consent 域(如 accounts.x.ai)也声明进 hosts 即可
      "clientId": "xxx.apps.example.com",           // 可选:内置 OAuth 客户端 ID(用户零配置开箱即用;用户在设置页自填的覆盖内置,清除自填即回落)
      "clientIdAlternatives": ["xxx-global.apps.example.com"],  // 可选 ≤8 条:仅 tokenBroker 模式;插件按 app-context 选 App 时,connect 只接受默认值或这里声明的公开 ID
      "clientSecret": "xxx",                        // 可选(须与 clientId 成对):内置 client 的 secret;桌面应用的 client 凭证本非机密,纯 PKCE 服务商可省略
      "scopes": ["read.a", "write.b"],              // 可选 ≤256 条:申请的权限范围(详情页逐条展示给用户)
      "scopeDelimiter": ",",                        // 可选:authorize URL 的 scope 拼接分隔符;缺省空格(OAuth 标准),Slack 这类逗号分隔的服务商声明 ","(目前只认这一个值)
      "pkce": true,                                 // 可选:PKCE(S256)开关,缺省 true
      "extraAuthorizeParams": { "access_type": "offline", "prompt": "consent" },  // 可选 ≤8 条:服务商特有授权参数(协议保留参数禁写)
      "identity": { "url": "https://api.example.com/userinfo", "labelPath": "email", "displayTemplate": "{team} · {user}", "avatarPath": "data.avatar_thumb" },  // 可选:授权后拉一次身份端点给账号打标签(设置页"已连接为 xxx";url 域名须命中 hosts)。labelPath 应指向**唯一且稳定**字段(如邮箱 / user_id)——它是重复授权时的同身份合并判定键,选 name 这类可重名可改名字段会误合并。displayTemplate 可选:人类可读展示名模板,`{点分路径}` 占位符从同一份身份响应取值(至少一个占位符,≤200 字符),任一占位符取不到值整体降级为空、回落显示 labelPath 的值——labelPath 的稳定字段不可读(如 Slack 的 user_id)时声明它,设置页与账号工具展示的就是渲染后的名字(邮箱这类本身可读的服务商不需要)。avatarPath 可选:头像 URL 在身份响应里的点分路径(如飞书的 "data.avatar_thumb")——主机取 https 地址后**不带凭证**下载小图(仅 png/jpeg/webp/gif、≤256KB)转 data URL 存库,`/oauth` 回查里以 account.avatarDataUrl 给你的 settingsHtml 展示(<img> 直接用)。**下载仅对第一方官方插件生效**(头像地址不受 hosts 白名单约束,第三方声明合法但恒降级 null)——所以页面必须能没头像也好看(如回落姓名首字圆片)
      "redirectPort": 53682,                        // 可选:loopback 回调固定端口(1024–65535);声明 tokenBroker 时必填。服务商要求回调 URI 与注册值精确匹配(如 Atlassian)时声明,回调恒为 http://127.0.0.1:<端口>/callback;非 broker 模式缺省 = 随机端口(Google 等允许任意 loopback 端口的服务商不用声明)
      "tokenBroker": "jira",                        // 可选:三路资格:随包官方种子或受信任公开市场的官方插件(名称本身不构成资格);当前组织的服务端 organization market 包满足来源/组织/namespace/整包 sha256 绑定;或企业作者用 ghost_forge_install 明确安装到当前组织 namespace。后两路只给 Broker 与 oidc-token,不给宿主原语;手动导入与个人身份不放行。声明时必须同时声明 redirectPort;code/refresh 交换经 Cindy 服务端 broker 完成(client secret 在服务端,不随包分发),与 clientSecret 互斥;设置页不再支持自填 client
      "brokerBounce": { "path": "/example/bounce", "callbackPath": "/example/callback" }  // 可选:双地址弹跳回调(服务商后台只收 https redirect、不收 http loopback 时用)。必须与 tokenBroker、redirectPort 同时声明;报给服务商的 redirect_uri = broker 服务基地址 + path(主机运行时拼,清单不落域名),浏览器授权后由弹跳路由 302 回 http://127.0.0.1:<redirectPort><callbackPath>
    }
  }],
  "connections": [{                                 // 可选 0–2 条:多连接声明——"地址 + 凭证成对多条"(自建实例场景如 GitLab,详见 §4.7「多连接」)。声明了 connections 时 hosts 可缺省/为空(静态域名与动态连接至少有其一);声明 connections 必须同时声明 settingsHtml
    "key": "gitlab",                                // 小写字母开头,小写/数字/下划线,1–32;禁用宿主保留键;与 secrets[].key 共用命名空间,撞名拒装
    "label": "GitLab 实例",                          // 给用户看的连接类型名(1–64 字;详情页与设置页展示)
    "hint": "填实例域名与 Personal Access Token",     // 可选 ≤200 字提示(建议写进你的 settingsHtml 文案)
    "inject": { "header": "Private-Token", "format": "{value}" },  // 凭证注入形态(规则同 secrets 的 inject);**不允许**声明 inject.hosts——凭证恒只注入对应连接自身的地址,写了拒装
    "maxConnections": 4                             // 可选:每种连接可添加的地址数上限(1–8 整数,缺省 8)
  }]
}
```

**setup 就绪声明**(可选,顶层字段):回答"这个插件**用之前必须配好什么**"。用户在
插件页点「使用」或 Agent 调用你的工具时,主机按它做前置检查；没配齐就用统一设置卡
引导用户完成配置：普通 user Secret 直接在卡内填写，OAuth 在卡内发起授权，KV 与连接等
复杂配置再进入插件详情页。普通任务配齐后继续原调用；伙伴会保留独立授权卡并结束当前轮，
授权完成后由主机通知伙伴继续原工作。没有图标时不生成占位图标，插件已有配置面板与成果
UI 保留。检查、字段绑定、保存状态和恢复都在主机
代码里执行,你只声明需求,不用写卡片回调或检查逻辑,也不要在电子脑里自己重复检查。

```json
"setup": {
  "requires": [                                     // 0–8 组;组间全部满足(allOf),组内任一满足(anyOf);空数组 = 显式声明"无使用前置需求"(恒就绪,见下)
    { "anyOf": ["secret:brave_api_key", "secret:tavily_api_key"] },   // "两个 key 任一配好即可"
    { "anyOf": [{ "kv": "default_repo", "label": "默认仓库" }] }       // kv 参数用对象形态,label 必填(弹窗展示名)
  ]
}
```

- 条目三种引用:`secret:<key>`(`network.secrets` 或 `node.secretBindings` 声明的
  凭证:Node 绑定与 user 源查已保存、oauth 源查已连接账号;账号全过期时主机弹「重新连接」
  话术)、`connection:<key>`(该连接声明下至少添加一条)、
  `{ "kv": "<键名>", "label": "..." }`(你 /kv 参数里的顶层键非空且不能是宿主保留键;键名主机无先验,
  label 必填)。Node 凭证同样可参与 setup.requires。
- 引用必须逐字指向已声明的 key,悬空引用**打包期就拒**;`login-email` /
  `gh-cli` / `oidc-token` 这类 Host 派生或优先来源不允许引用(没有可靠的
  同步配置动作可引导)。kv 引用要求已声明 settingsHtml(没有设置页没人填)。
- **绝大多数插件不需要写本字段**:不声明时主机走启发式——声明过凭证/连接的插件,
  任一项配好即算就绪;什么都没声明的恒就绪。只有启发式判不准才需要显式声明,两种
  典型:"必须**同时**配 A 和 B"(多组声明)、"凭证全是**可选项**、一个不配也能用"
  (写 `"setup": { "requires": [] }` 显式声明无前置需求,主机不再用启发式拦你)。
- 检查只管**存在性**(配没配),不管有效性(key 对不对)——填错 key 仍会在真正调用时
  由主机网络层报错,你的工具逻辑照常处理失败即可。
