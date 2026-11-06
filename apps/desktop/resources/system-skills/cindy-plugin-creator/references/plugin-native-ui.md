# 插件原生界面扩展

此接口正在开发，尚未发布。不要把开发分支上的代码当作当前安装版支持的证明。
新增 API 随 Cindy 宿主一起提供，不需要安装 SDK、加载 helper 或维护独立版本。

## 声明

```json
{
  "ui": {
    "version": 1,
    "contributions": [
      { "id": "output-format", "point": "composer.tools", "scope": "session" }
    ]
  }
}
```

`ui` 是原生位置的贡献声明，与 `mcpApps.ui` 的交互页面分开。
贡献 ID 在一个实际安装实例内唯一。未知版本和扩展字段保留为数据，未知位置不装载。
已识别的 v1 会校验结构、重复 ID 和长度；`contributions` 可以省略。
当前启用 `composer.tools`、`session.header.actions`、`session.statusbar`（任务范围），以及
`message.actions`、`turn.footer`（消息范围，回合末绑定原用户消息）。位置和范围不匹配时该贡献不可用，
不会退回成更宽的任务权限，也不影响原工具。
`message.body`（消息范围）和 `tool.body`（工具范围）用于自定义记录展示，见下文。

## 多个独立自绘视图

`ui.tabViews` 登记可打开的包内 HTML 页面。Cindy 为每个视图提供独立页签，页面内部内容由插件实现。
注册不会自动打开或加载页面，不新增窗口边缘插槽。

```json
{
  "ui": {
    "version": 1,
    "tabViews": [
      { "id": "build-log", "title": "构建日志", "scope": "session", "page": "views/build-log.html" },
      { "id": "result-preview", "title": "结果预览", "scope": "global", "page": "views/result-preview.html" }
    ]
  }
}
```

最多 64 个声明；ID 为 1–64 个字母、数字、`_`、`-`，在 `tabViews` 中唯一；标题最长 160 字符。
page 必须是包内安全相对 HTML 路径，文件真实存在，沿原页面的单文件 4 MiB 上限。
`global` 不随任务切换；`session` 归属触发入口的真实本机任务。scope 不授予额外数据权限。
安装或更新时进入原能力说明，不新增逐视图确认。原 `mainView`、`panel`、`taskView` 声明和放置记忆保持原意。

逻辑页先检测 `(await cindy.ui.capabilities()).tabViews === true`，然后从现有贡献动作或命令返回：

```js
return { status: 'completed', openView: { id: 'build-log', params: { buildId: 'example-17' } } };
```

只可打开本实例已声明的视图。相同视图和归属复用原页签，不同视图可同时存在、分别关闭。
页签组、拖动、大小调整、关闭、最大化和弹出／返回复用 Cindy 现有布局；首次打开沿原默认落点，
之后使用用户的放置。插件不提供新位置、强制尺寸、任意 URL 或另一个实例／窗口的身份。
参数最多 16 项，值为字符串、有限数值、布尔值或字符串数组，总预算 32 KiB；
单字符串最长 16000 字符，数组最多 64 个字符串、每项最长 1024 字符。
参数只保留在当前页签内存，不写 URL、数据库、日志或放置偏好；重启恢复布局时不重放定位。
后一次操作优先，迟到结果不会覆盖新定位；未知结果不自动重试。

页面使用 Host 注入的窄接口，无需 import 或安装 SDK：

```js
const view = window.cindy.ui.view;
const show = snapshot => {
  // snapshot: { id, scope, params, generation, visible }
  document.querySelector('#item').textContent = String(snapshot.params.buildId ?? '未指定');
};
const off = view.onChanged(show);
show(await view.read());
window.addEventListener('pagehide', off, { once: true });
```

`read()` 取得本次挂载的最新快照，`onChanged` 通知后续定位及可见性；返回函数取消订阅。
切换同组页签沿原保活行为，不因隐藏重建；真正关闭、停用、卸载、换源或账号变化使旧桥失效。
滚动、筛选、未提交输入和业务数据由插件管理。同插件业务通信使用下面的标准浏览器通道；
此桥不提供任意 Cindy 数据查询，消息／工具 ID 作为定位值也不附赠读取权限。
独立视图仅暴露 `cindy.ui.view`，不提供逻辑页的通用管子或其他 Host 能力。

### 页面与本插件后台通信

独立页签与本插件逻辑页同源，并使用同一实际安装实例、账号和批准代次的 Electron 分区。
页面可以直接使用标准 `BroadcastChannel` 双向收发业务请求、结果及更新消息，
与原 panel／mainView／taskView 的方式相同，无需新增 Host RPC 或 SDK。
例如在逻辑页已经就绪时：

```js
// main.js：pluginData 是插件自己的数据访问代码。
const channel = new BroadcastChannel('my-plugin-data');
channel.onmessage = async ({ data }) => {
  if (data?.type !== 'load') return;
  const result = await pluginData.load(data.itemId);
  channel.postMessage({ type: 'loaded', requestId: data.requestId, data: result });
};
// 插件自己的数据变化时，也可以主动广播：
channel.postMessage({ type: 'updated', itemId: 'item-1' });
```

```js
// 视图脚本：renderItem / refreshItem 同样由插件实现。
const channel = new BroadcastChannel('my-plugin-data');
channel.onmessage = ({ data }) => {
  if (data.type === 'loaded') renderItem(data.data);
  if (data.type === 'updated') refreshItem(data.itemId);
};
channel.postMessage({ type: 'load', requestId: crypto.randomUUID(), itemId: 'item-1' });
window.addEventListener('pagehide', () => channel.close(), { once: true });
```

两段代码分别位于逻辑页和视图脚本。频道名、消息格式、请求配对、多视图过滤、
订阅和业务错误均由插件定义。逻辑页按需启动时，沿用 [panel 的 `/wake` 与就绪接待方式](plugin-panels.md)，
不能假定广播会缓存给尚未监听的页面，也不自动重放未知结果的写操作。
不同账号或实际安装实例不共享此频道。访问网络、文件或 Cindy 数据仍由后台走已有获准能力，
消息中的对象 ID 不会获得额外权限。临时贡献页面使用隔离 iframe，通信方式见下文的 `invoke()`，
不能假定它与独立页签共享 BroadcastChannel。

### 自绘页面的职责边界

Cindy 提供通用视图注册、布局承载、必要的上下文／通信及隔离和生命周期管理。
页面内容、组件、交互、业务逻辑和数据来源由插件实现，不受原生贡献控件种类限制。
视频、图表和编辑器只是插件可能实现的页面内容，不对应新的 Cindy 业务接口，
也不要求把业务资源打进插件包或先交给 Cindy 管理。

网络、文件和宿主数据访问沿用现有插件的授权与隔离机制；视图注册本身不扩权。
当前页面 CSP 和分区网络规则仍会限制外部媒体及远程 iframe，不能把“已注册视图”
宣传为任意网站或资源都可直接加载。具体来源按对应能力及浏览器限制处理，
不因一个示例跑通就认定所有资源场景已经支持。

脚本使用包内 `.js` 文件并通过 `<script src="page.js"></script>` 加载；
内联脚本和 `onclick` 不通过现有 CSP。页面自己的数据和同插件通信沿用既有方式，
不借本批定位桥引入业务副本或新的资源服务。

业务 `completed`、页签打开与页面收到参数是分别确认的结果。贡献隔离页的 `invoke()` 回执可包含
`navigation: { tab: 'opened' | 'unavailable' | 'superseded', page: 'received' | 'unconfirmed' }`；
`received` 表示公开页面接口已收到参数，业务条目的查找和渲染仍由插件负责。
同一动作同时返回 edit 时，先按原草稿版本规则处理编辑，再导航；导航失败不重放编辑或业务动作。

## 逻辑页接口

逻辑页将通过已有 `cindy` 桥提供 `cindy.ui`。公开类型入口为
`@cindy/maker-shared/plugin-ui`；插件运行时不必 import 此包。

```js
if (cindy.ui) {
  const capabilities = await cindy.ui.capabilities();
  if (capabilities.points.includes('composer.tools')) {
    cindy.ui.contribute('output-format', {
      render(context) {
        return {
          controls: [{ id: 'format', kind: 'select', label: 'Format',
            value: 'plain', options: [{ value: 'plain', label: 'Plain' }], actionId: 'set-format' }],
          blocks: [],
          actions: [{ id: 'set-format', label: 'Change format' }],
          fallbackMarkdown: 'Format: Plain'
        };
      },
      async onAction({ actionId, values, context }) {
        // 在插件自己的业务所有者处完成写入并获得确认后返回 completed。
        return { status: 'completed' };
      }
    });
  }
}
// 工具始终使用原有注册入口；缺少 ui 时只跳过界面增强。
```

render 只返回公开内容；viewId、revision、实际实例及查看端绑定由宿主管理。
最初的控件为 button、select、status，内容块支持 markdown。内容总量限 32 KiB，
控件、动作、内容块各最多 16 项。控件引用已声明的动作，无法表达任意 HTML 或脚本。
同一位置按声明顺序最多显示 64 个视图，聚合内容预算为 256 KiB；不扩大远程帧上限。
必需控件不被查看端支持时禁用该视图的动作，保留 fallbackMarkdown；不能删字段后继续提交。

完整输入、配置和提交界面由插件在自己的隔离页面中实现。插件决定字段、未提交值、校验、保存和业务冲突处理；
Cindy 负责页面承载、来源与权限校验、获准调用及宿主效果，不提供统一表单模型或状态管理。
外观选择、预览／取消、定时切换和配置管理同样由插件决定；宿主只开放所需的外观读写接口。
命令只注册到已有按钮、菜单和快捷键入口；插件需要的参数页和命令界面自行实现。
随包示例只验证公开接口，不提供业务配置、事务、任务卡片或恢复框架。

## 现有底部状态栏

`session.statusbar` 把插件内容直接放进任务界面原有的底栏，位于工作目录和额度／上下文信息之间。
位置可用性跟随原底栏，不创建额外横栏或停靠面板；远端与手机沿原能力，不新增底栏透传。

```json
{ "id": "format-status", "point": "session.statusbar", "scope": "session" }
```

逻辑页仍通过 `cindy.ui.contribute('format-status', handler)` 注册内容和动作，不增加独立 API 或 SDK。
`render(context)` 在此位置的实际能力为 `button`／`status`，`pages` 和 `effects` 为空；作者按回调中的
`context.capabilities` 适配。不在底栏装载 HTML、选择器或 Markdown 内容块；空控件的 fallbackMarkdown
在这里作为单行纯文本显示。复杂内容继续使用已有页面位置。

底栏高度和字体沿原状态栏；宽度在左右原生信息之间分配，超长文本截断，悬停可查看完整内容。
不接受插件提供的固定宽高或宿主 CSS。多个贡献沿现有 order／实例／ID 顺序排列；无贡献不占空间。
点击只调用该贡献已声明的动作，更新仍使用 `invalidate({ contributionId, scope })`。插件自己持有状态；
宿主不实现计时、待办等业务。切换任务、隐藏工作区或插件失效时沿原绑定生命周期释放。

随包 `native-ui-reference` 同时演示输入区选择和底栏切换，二者读写同一份插件状态；缺少该 point
时仅跳过底栏增强，原工具照常可用。

## 在贡献中使用包内页面

声明包内 HTML，并在逻辑页用同一个 ID 注册贡献：

```json
{ "id": "custom", "point": "composer.tools", "scope": "session", "page": "ui/view.html" }
```

路径必须是打包后的相对路径，入口为 HTML；相对脚本、样式、图片和字体来自同一个插件包，
单文件不超过 4 MiB。控件位置使用 `render` 返回的第一个按钮标签、动作标签或贡献 ID 打开页面；
消息和工具展示在原记录位置承载页面。页面只在对应位置显示时加载，位置隐藏、权限失效或任务切换时释放。
页面内容与具体交互由插件实现。

页面脚本直接使用宿主注入的 `cindy.ui`：

```js
const context = await cindy.ui.read();
const capabilities = await cindy.ui.capabilities();
// 页面自己的交互决定何时调用；save 须在逻辑页 render 返回的 actions 中声明。
const result = await cindy.ui.invoke({
  actionId: 'save', values: { choice: 'example' }, data: { filters: { tags: ['one', 'two'] } }
});
// onAction 返回 { status: 'completed', data: 插件自己的 JSON 结果 }，页面读取 result.data。
```

`read()` 只返回当前绑定和已声明的数据。`invoke` 的 `values` 保留字符串、数字、布尔值或字符串数组；
可选 `data` 支持嵌套 JSON（对象、数组、字符串、有限数值、布尔值和 null），传给本插件对应贡献的
`onAction({ actionId, values, data, context })`。回调可用同名 `data` 返回业务结果，页面从 `result.data` 读取。
请求及带业务数据的返回沿用 32 KiB 消息预算；函数、DOM 对象和二进制对象不属于 JSON。
配置的保存和读取继续走插件自己的逻辑页及既有 API。Host 只校验和转送，不解释或持久化业务 `data`，
其中的字段不会变成导航、草稿修改或新的权限；这些宿主效果仍走原有显式字段和校验。
页面不直接获得逻辑页 preload、通用 IPC 或网络访问。页面不提供编辑输入草稿的 effect；
可用能力以页面的 `capabilities()` 为准。页面也可使用已声明的 `cindy.ui.appearance.read/set/reset` 和 `cindy.ui.visibility.read/set`。
页面调用返回 `completed`、`rejected` 或 `outcome-unknown`；未知结果不要自动重试。

## 消息与工具展示

声明 `message.body`／`message` 或 `tool.body`／`tool`，并指定 `match`。例如：

```json
{ "id": "own-result", "point": "tool.body", "scope": "tool",
  "match": { "kind": "self", "name": "preview" }, "context": ["tool.result"], "page": "ui/result.html" }
```

`self` 匹配本插件来源；`plugin` 匹配声明的实际实例 ID；`tool` 以工具名匹配工具记录。
未知来源沿用原展示。已有专用卡片保持优先；非本插件的展示或多个候选由用户选择。
原消息、工具结果和宿主状态不会被改写，用户始终可以查看原文。保存的消息／工具展示是只读的，
其中页面的 `invoke`、外观和显隐写入不可用；查看时仍可读取被允许的数据、外观和显隐状态。

`onAction` 返回 `completed`、`rejected` 或 `outcome-unknown`。
接收请求不代表业务完成。只有已知未执行才能返回 rejected；异常、外部写入回执丢失和
超时使用 outcome-unknown，不能自动重试。任一终态都结束本次界面等待。

`invalidate({ contributionId, scope })` 只使该实际实例、该贡献的精确范围失效。
没有活动视图时不创建绑定。`dispose()` 清理当前运行时的界面回调，不删除业务数据。

## 上下文与当前端草稿

在贡献中用 `context: ["session.summary", "message.content", "selection"]` 声明需要的数据，
只声明实际使用项。任务摘要含 id、title、status、可选 agentKind；消息字段只作用于当前消息。
`context.selection.text` 仅在用户显式操作时提供，不进入 render，不广播整份草稿或历史。
这些字段和草稿操作进入现有安装／更新权限摘要。

贡献用 `editor: ["append", "replace-selection"]` 声明草稿操作。在 onAction 中先检查
`context.capabilities.effects` 是否包含 `composer-edit.append` 或 `composer-edit.replace-selection`，
再返回 `{ status: "completed", edit: { operation: "append", text: "要插入的文本" } }`。
宿主只把纯文本交回发起操作的本端编辑器，不允许插件指定草稿、设备或任务，也不会自动发送。
原端核对输入版本和选区，最多应用一次；用户继续输入、离开或切账号后不会补投。
业务操作的终态和本端输入修改结果分别处理，输入修改失败不改写业务成功结果。

本批新增原生界面与草稿接口在 Desktop 本机宿主开放。远端与手机版继续使用现有插件能力，
不新增跨设备 UI 透传或草稿同步，也不要求手机与 PC 的功能、界面或输入方式一致。
插件按实际宿主能力检测和设计，插件自己的输入、配置、校验与提交继续由插件页面管理。

## 能力与版本

`capabilities()` 返回宿主的实际 point、primitive、effect 和 page 集合。
回调 context 中的能力再与当前查看端求交集，受声明、对象权限和编辑器可用性约束。
不依靠版本字符串猜接口存在，也不通过 UI 自动发送 Agent 消息。

UI 是可选增强时，`minCindyVersion` 填原工具不可缺少的基础能力实际首次支持版本；
旧宿主没有 `cindy.ui` 时继续原工具。插件强依赖新 UI 时，最低版本才指向该必需能力的
实际首发版本。首发尚未确定时不能编造版本号。官方市场依据最低版本选择兼容 Release，
没有兼容版本时不展示；本地包和自定义市场不新增安装版本闸门。

UI v1 后续扩展使用可选字段和分项能力检测；已发布的必需字段及原有含义保持。
常规测试验证新接口、现有插件和缺能力回退，不另设发布快照或独立兼容流程。

## 开发与诊断

随包示例位于 `examples/native-ui-reference/`。在独立源码目录修改文件后，重新
调用既有 `ghost_forge_pack` 打包，再使用 `ghost_forge_install` 或插件安装界面更新
所选隔离开发实例；安装／更新沿用正式确认和批准流程。不能只重启旧运行时来替代更新包。
只停止并唤醒这个插件，不重启 Cindy，也不操作其它开发实例。

Dev 构建可调用 `await __cindyGhosts.ui.inspect()`。`host` 返回声明、位置、范围、
注册原因和视图查询阶段；`subscriptions` 列出当前显示端的活动任务与位置。
未知位置会显示 `UNSUPPORTED_POINT`，范围不符显示 `SCOPE_MISMATCH`，尚未注册显示
`NOT_REGISTERED`。检查打包返回的 `warnings` 可定位相应 manifest 字段。
诊断不包含业务内容、输入值、凭据或消息正文；生产构建不挂载这个入口。
