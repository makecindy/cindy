## 4.0.3a 只读 Agent 模型目录

设置页、panel、mainView 和电子脑均可 GET 同源 `/agent-models`。无参时返回本机已连接且可用于新任务的模型，并追加 `locations:[{agentDeviceId,name}]`（同账号其他电脑与生效中的供应商分享，不含本机；读不到位置时省略该字段）。可选查询参数只有 `agent_device_id`：带上后只投影那台位置允许远程调用的来源，响应回显 `agentDeviceId`。同一模型在不同来源下是多项。
返回 `{ok:true,models:[{id,name,agent,providerId,providerName,efforts,defaultEffort,visible,...展示字段}],agentDeviceId?,locations?,supportsRemoteRoutes?}`。
新版 Host 还在每项附带与 Cindy 模型选择器同源的**可选展示字段**（不需要权限，旧 Host 缺这些字段时照原样显示）：
`description`（选择器里的模型说明，跟随 Cindy 界面语言；没有说明时省略）、`icon`（目录图标 id，已知值
`claude`/`anthropic`、`codex`/`openai`/`gpt`、`cindy`/`xd`，大小写不敏感；缺省或未知时改用供应商标）、
`group`（厂商分组 id）、`contextWindow`（tokens）、`supportsFastMode`（布尔，新版恒有）、
`supportsUltrafastMode:true`（仅可用 Ultrafast 时出现）、`effortDisplayNames`（模型专属档位显示名，多数模型没有）、
`logoKind`（供应商标种类）。它们只用于展示，不是路由或能力判据；执行前 Host 仍按真实路由核验 Fast 与档位。
无参时 visible 跟随当前账号模型选择器；带参时 visible 用模型目录默认值，不套本机开关。建议默认显示可见项，隐藏项由用户展开。旧 Host 缺这些字段时兼容原列表。
新版无参响应带 `supportsRemoteRoutes:true`，表示统一选择器与 `will-start-task` 裁决都支持
可选 `agentDeviceId`（同账号电脑或 `share:<shareId>`；省略为插件执行电脑）。没有这个标志时，
路由插件只提供本机选项，不能向旧 Host 回传远程配置：旧 Host 可能忽略来源而误用同名本机模型。
每项为独立的模型×框架×来源；空 efforts 与 null defaultEffort 表示未声明，不得猜测。
不代表远程 SSH 目录。读取不调用模型、不触发凭证认领或上游发现，不返回凭证、账号 identity 或 endpoint；不需要新增 manifest 权限。
格式非法、重复参数、空或超过 128 字符的设备 ID，或其他查询参数返回 400。格式合法但那台离线、未知或没开远程控制时返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目。旧 Host 带任何参数都返回 400；旧 Host 可能返回 404，插件应明确提示升级；503 时提供重试。运行前再次核验选定来源。

## 4.0.3b 宿主统一模型选择器

### 桌面插件页面：在按钮旁展开

桌面 settings、panel、mainView 与 taskView 页面可使用 Host 注入的最小页面桥：

```js
button.addEventListener('click', async () => {
  if (typeof window.cindyUI?.pickModel !== 'function') {
    // 旧 Host 或手机／远程控制页面：走原有 pickModel 业务频道（见下文），不要自画名单。
    return;
  }
  const { x, y, width, height } = button.getBoundingClientRect();
  const result = await window.cindyUI.pickModel({
    anchor: { x, y, width, height },
    // initial: savedRoute,
    // allowRemote: false, // 默认 true；只能消费本机配置的调用方须显式关闭。
  });
  if (result.ok) savedRoute = result.route; // 完整保存，包括可选 agentDeviceId。
});
```

选择器由 Host 绘制在对应按钮旁，复用聊天输入框的组件、供应商目录、搜索、收藏、最近使用、
模型说明、引擎、推理强度及 Fast；选中即返回，与下述居中弹窗不同，不需再点确认。
只返回完整选择配置，不返回供应商密钥、endpoint 或内部目录对象。配置与收藏编辑只影响
这次选模草稿，不改变宿主默认、现有任务或偏好，不调用模型。新页面 API 默认列出全部运行来源，
`allowRemote:false` 可显式限本机。把结果交给 `cindy.tasks` 前，先检查
`(await cindy.tasks.capabilities()).remoteRoutes === true`；旧 Host 只接受本机配置。
页面滚动、尺寸／缩放变化、导航和关闭会取消此次选择；取消保留插件原配置，不自动重试。
所有坐标相对当前顶层插件页面，使用 CSS 像素；不要传屏幕坐标或主窗口坐标。
此桥仅在本机桌面 WebView 可用，手机／远程控制页面和旧版 Host 继续走原生选模通道，
必须检查函数是否存在。返回值和错误码与下面 `cindy.pickModel` 相同。
示例源码见 `scripts/examples/plugin-model-picker/`。

不想自行绘制选模界面时，电子脑调用 `cindy.pickModel(options?)`。
Host 打开与 Cindy 共用的模型选择器，用户确认后返回完整配置；取消、关闭页面或超时不返回配置。
不需要新增 manifest 权限，不改应用默认、插件默认或现有任务，不调用模型。

```js
if (typeof cindy.pickModel !== 'function') {
  // 当前 Host 不支持，请提示用户升级；不要改为维护一份硬编码名单。
  return;
}
const selected = await cindy.pickModel({
  // allowRemote: true, // 仅能消费远程路由的调用方显式开启；默认只列插件电脑。
  // initial: savedRoute, // 可选，必须是下面的完整 route
  ...(msg.mobilePageId ? { mobilePageId: msg.mobilePageId } : {}),
});
if (selected.ok) {
  // 自行保存完整 selected.route，包括可选的运行来源 agentDeviceId。
  // tasks.capabilities().remoteRoutes === true 时，本机与远程 route 均可原样交给 tasks.create / setModel。
  // 任务创建和执行仍需 agent.tasks 的正常批准，选模本身不授予执行权限。
}
```

成功：`{ok:true,route:{agentKind,providerId,model,effort,fastMode,agentDeviceId?}}`。
`allowRemote:true` 显式开启同账号电脑与供应商分享；未传时保持本机选择，远程答案也会被拒绝。
`agentDeviceId` 相对插件执行电脑；省略表示该电脑，`share:<shareId>` 表示其收到的供应商分享。
本机、远程 Desktop 设置页与手机选择器使用同一来源语义，调用方须完整保存并回传；
来源撤销或不可用时确认失败，不回落本机同名供应商。新增的
`tasks.capabilities().remoteRoutes:true` 表示自建任务的 create、setModel、发送、结果与取消
支持此字段；缺少该标记时须显式 `allowRemote:false`，不能删掉来源后执行。
`will-start-task` 路由继续支持此字段。
`agentKind` 为 `cc | codex | pi`，`effort` 为空串表示未指定，
`fastMode` 为布尔值或 `"ultrafast"`。保留完整组合，不根据模型名重新猜来源或引擎。
失败：`{ok:false,errorCode,message}`；`CANCELLED` 表示本次选择已取消，
`BUSY` 表示已有选择器，`UNAVAILABLE` 表示没有可用宿主页面，
`PERMISSION_DENIED` 表示来源插件或账号已变化，`INVALID_REQUEST` 表示参数不合法。
用户确认时 Host 重新校验真实来源、模型、档位和 Fast；不可用时保留选择器供用户改选。

桌面插件的 settings、panel、mainView 还可直接发起同源请求：

```js
const response = await fetch('/model-picker', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ /* initial: savedRoute */ }),
});
const selected = await response.json();
```

该端点仅接受 `initial` 与布尔值 `allowRemote`，只支持 POST、无查询参数。旧 Host 404 时提示升级，
503 时提示稍后重试；正常受理的取消与错误使用上述结构化结果。
手机与远程桌面设置页通过业务频道交给电子脑调用 `pickModel`，必须原样转交 Host 附加的
`mobilePageId`，选择器才会显示在发起操作的设备，并读取插件执行电脑的目录。
不要把 `mobilePageId` 存成全局最近设备；不传时只在插件运行电脑打开。
带远程来源的 `initial` 还要求控制端支持来源选择与回传；Host 在页面打开时核验，旧控制端
未声明支持则返回 `{ok:false,errorCode:'UNAVAILABLE'}` 并提示更新控制端，保留原配置。
插件不得通过删掉 `initial.agentDeviceId` 重试来规避；新版控制端仍允许用户主动选回本机。
同一 Host 同时只有一个插件选模请求，等待上限 90 秒；不要后台循环弹窗或自动重试取消。
关闭或完成后可以立即再次打开，无时间冷却；旧版 Host 仍可能返回 `RATE_LIMITED`，插件应兼容。
窗口、页面、连接、账号或安装版本变化后，旧回执不能交给替代实例。
此接口可选择 Agent 运行来源，任务文件仍在任务电脑上；不选择 SSH 工作区，也不提供凭证、endpoint 或完整 ProviderView。
依赖此接口的插件仍须保留运行时能力检查。

## 4.0.3c 模型收藏与最近使用（新增接口，尚未发布）

想在自己的页面里画一份与 Cindy 一致的模型选择器（搜索、收藏、最近使用）时使用；能嵌入 Host 选择器的
桌面页面优先用 §4.0.3b，不需要本权限。身份卡需声明：

```json
"agent": { "modelPreferences": true }
```

它在安装/更新确认和插件详情里单列一行「读取并修改你的模型收藏，读取你最近使用的模型」，用户接受安装或
更新即授予；未声明（或旧版 Host 安装时不认识这项）的插件调用下列端点返回 403
`{ok:false,errorCode:'PERMISSION_DENIED'}`。设置页、panel、mainView 和电子脑都可同源请求：

- `GET /model-preferences` → `{ok:true,favorites:[{uid,providerId,modelId,agent,effort?,fast?}],recents:[{providerId,modelId,agent,effort?,fast?}]}`。
  `agent` 为 `cc | codex | pi`（与 `/agent-models` 的 `claude-code` 对应 `cc`），`effort` 是档位 key，`fast` 为
  `true` 或 `"ultrafast"`，缺省表示跟随推荐档、Fast 关闭。顺序即 Cindy 的展示顺序（最近使用为最新在前）。
  只含**这台电脑**的条目：其他电脑上的模型与别人分享给你的模型不返回。收藏里可能有当前目录已经没有的模型，
  用 `/agent-models` 按 `providerId`+`modelId`+引擎对上后再显示。
- `POST /model-preferences/favorites`，正文是一个收藏操作：`{kind:'add',item}`、
  `{kind:'update',expected,item}`（只能改 `agent`/`effort`/`fast`，不能换模型）或 `{kind:'remove',expected}`；
  `item` 不带 `uid`，`expected` 必须是刚读到的完整收藏（含 `uid`）。成功返回写入后的
  `{ok:true,favorites:[...]}`，Cindy 的模型选择器同步显示同一份收藏。重复添加同一配置不会多出一条。

收藏双向同步：Cindy 里点星，插件下次读取即可看到（没有推送，打开选择器时重新读取）。最近使用只读，
插件里选择模型**不会**记入 Cindy 的最近使用。两个端点都不收查询参数（400），方法不对返回 405，响应 no-store。
`400 INVALID_REQUEST`：正文不是合法收藏操作，或想写其他电脑／分享来的来源；`409 CONFLICT`：收藏已在别处变化
或 Cindy 拒绝了这次修改，什么都没写，重新读取后再试；`503 NOT_AVAILABLE`：Cindy 主窗口暂时答不上（启动中、
切换账号、窗口未就绪），稍后重试。旧版 Host 返回 404：此时退回只用 `/agent-models` 展示目录、不显示收藏与最近使用，
不要自己存一份「收藏」冒充 Cindy 的收藏。不返回凭证、endpoint 或账号信息；手机与远程控制页面暂不提供此端点。
依赖此接口的插件应在接口正式发布后填入实际的首个 `minCindyVersion`，并保留 404 降级。
