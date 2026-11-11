## 插件界面扩展：具名页面、原生入口和宿主操作

这是**尚未发布的新能力**。按 §0a 核验执行宿主源码包含 `mcpApps.host` 和 `open-resource`，
不要将已有 MCP Apps 的 `0.1.122-beta` 下限当成本章能力的发布版本。
正式发布插件时，填写实际包含所需能力的首个 Cindy 版本；不要猜版本号。
本章新增入口用于 Desktop 本机。旧工具卡片的手机/远程查看和旧 panel/mainView/taskView 保持原契约。

复杂页面继续使用官方 MCP Apps `App`、资源、主题、CSP 和销毁协议。
业务仍由原 `main.js` 执行，不另起 MCP 服务，不为打开页面伪造工具调用。

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
`task` 页面只能从真实本机任务打开。已批准页面和命令可从插件详情、任务标题栏菜单进入。
同实例、视图和任务再次打开会聚焦已有页签；更新输入不重建页面。

原生按钮可额外声明 `presentation:"popover"`，在入口旁打开同一 MCP App 资源；缺省仍打开侧栏页签。
仅适用于 `composer.toolbar/session.header/statusbar/message.actions/turn.footer` 的页面按钮；
正文位置与更多菜单保持各自承载方式。页面在弹层打开后才加载，关闭、入口离开视口或区域隐藏即释放。
变更为弹层会进入原批准确认，不继承旧入口的批准。例：
`{"id":"quick","title":"快捷面板","position":"composer.toolbar","view":"board","presentation":"popover"}`。

入口指定 `view` 或 `tool` 之一。`arguments` 为静态 JSON：页面收到 `hostContext.cindy.input`，
工具收到对应参数。`kind:"select"` 还会加入用户选择的 `value`，并须声明
`options:[{"label":"全部","value":"all"}]`。`kind:"status"` 只显示状态，不声明动作。
工具必须在 `tools[]` 声明，并在 `mcpApps.ui.tools` 开放 `app` 可见性；沿原审批及一次性凭据执行。

| position | 位置 |
| --- | --- |
| `composer.toolbar` | 输入框工具栏 |
| `session.header` | 任务标题栏 |
| `statusbar` | 输入框下方的任务状态栏，位于目录／对话标识与用量信息之间 |
| `message.actions` | 消息操作栏 |
| `message.menu` | 消息「更多」菜单内部 |
| `turn.footer` | 已结束的 AI 消息末尾 |
| `message.body` | 消息正文的可选展示 |
| `tool.body` | 工具详情的可选展示 |

`statusbar` 等原生控件位置支持 `button`、`select` 和 `status`。需要点击打开页面或调用工具时，
声明 `kind:"button"` 并指定 `view` 或 `tool`；示例的底部「示例已就绪」按钮会打开当前任务页。

`message.menu` 声明菜单动作，`kind` 缺省或填 `button`，引用 `view` 或 `tool`；
不在菜单内嵌选择框、状态条或任意页面。`match.roles` 可区分用户消息和 AI 消息。
例如 `{"id":"open-message","title":"打开任务页面","position":"message.menu","view":"board"}`。
菜单显示插件来源，点击沿同一页面/工具入口与批准执行；只有菜单打开时才订阅该菜单项状态，关闭立即释放。

正文位置只引用页面；`match.roles/tools/plugins` 限定候选。原文默认可读，用户选择后才打开页面，
不可用时回原文。需要正文内容时声明任务页面及 `context`；内容来自已有展示投影，不另查消息数据库。
`commands` 声明 `{id,title,view|tool,arguments?,shortcut?}`，共用同一执行路径。
快捷键采用 `Mod/Meta/Ctrl/Alt/Shift+键`，服从 Cindy 原快捷键和编辑按键，冲突时不抢占。

### 标准 SDK 与宿主能力

页面在 `connect()` 前注册 `onhostcontextchanged`，通过 `app.getHostContext()` 读取 `cindy`：

- `source:{instanceId,viewId,sessionId}`：Host 绑定的来源，全局页面的 sessionId 为 null。
- `input`：开页输入，不需要 context 权限。
- `capabilities`：实际已批准能力，用于探测支持情况。
- `context`、`selection`：仅任务页面获准 context 后提供。正文页面可含 message/tool 投影；task 为开页时的标题、目录、模型快照。
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
| 页面批准 | `cindy.ui.open({viewId,input?})`，只打开同插件已批准视图 |
| `context` | 向标准 host context 推送获准的任务/正文投影和任务区域选中文字 |
| `draft` | `cindy.ui.draft({mode:"read",revision?,offset?})` 按需完整读取；`{mode:"append"|"replace"|"replace-selection",text,revision?}` 编辑，替换整份草稿或选区须带最新 revision，冲突拒绝，不发送消息 |
| `appearance` | `cindy.ui.appearance({patch?,reset?,ifRevision?})`，沿原外观设置读写 |
| `visibility` | `cindy.ui.visibility({visible?,regions?})`，读取或修改窗口及 workspace/sidebar/header/messages/composer/tools/windowControls 的显隐 |

原工具卡片仍沿原 MCP Apps 契约。任务页面也可使用标准 `ui/message` 与 `ui/update-model-context`；
全局页面不能自行选任务发送。任务清空/归档、批准或 owner 变化后旧操作失效。
区域显隐是临时的窗口状态，停用、撤权或卸载后释放；权限提示保持可操作。

### 外观资源与正文样式

在 `mcpApps.host` 额外声明需要的字段和包内资源；每项参与批准，旧批准不会自动授予新资源：

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
字段限于 `title/value/disabled/visible`，省略字段恢复声明默认值，不能改变工具、参数、页面或权限。
需求消息含本插件的 `{id,sessionId,clientId?}`。传 `target:{sessionId,clientId?}` 精确更新对象，
省略 target 则更新该入口的实际消费者。需求不携带正文，不唤醒休眠插件，也不新增轮询或心跳。
消息和回合插槽随原消息区域进入、离开视口登记和释放状态需求，窗口隐藏时也释放；更多菜单中的入口仅在菜单打开时登记。
每个窗口最多订阅 512 个不同的原生状态目标（插件、入口、任务、消息的组合），按已挂载且活跃入口的登记顺序截取。
超出上限的入口仍按清单默认值显示、可以点击，但暂不接收实时状态；前面的入口离屏、隐藏或卸载释放需求后，后续入口自动补位。

### 完整示例

[host-ui 示例](examples/interactive-pages/host-ui/) 包含真实清单、后台和官方 SDK 页面，演示八个位置、
全局/任务视图、命令、草稿和宿主操作。示例的历史 MCP Apps 版本下限只用于源码自测；发布前按实际新版本修改，
并让用户提供图标或明确同意生成图标，不能生成占位色块。
用包含本章实现的宿主执行 `ghost_forge_pack`；安装另需用户指示。验收应覆盖新能力明确批准、旧插件无感兼容、
无候选历史消息不通信，以及关闭/撤权后停止投递。
