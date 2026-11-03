## 4.0.3a 只读 Agent 模型目录

设置页、panel、mainView 和电子脑均可 GET 同源 `/agent-models`。无参时返回本机已连接且可用于新任务的模型，并追加 `locations:[{agentDeviceId,name}]`（同账号其他电脑与生效中的供应商分享，不含本机；读不到位置时省略该字段）。可选查询参数只有 `agent_device_id`：带上后只投影那台位置允许远程调用的来源，响应回显 `agentDeviceId`。同一模型在不同来源下是多项。
返回 `{ok:true,models:[{id,name,agent,providerId,providerName,efforts,defaultEffort,visible}],agentDeviceId?,locations?}`。
无参时 visible 跟随当前账号模型选择器；带参时 visible 用模型目录默认值，不套本机开关。建议默认显示可见项，隐藏项由用户展开。旧 Host 缺这些字段时兼容原列表。
每项为独立的模型×框架×来源；空 efforts 与 null defaultEffort 表示未声明，不得猜测。
不代表远程 SSH 目录。读取不调用模型、不触发凭证认领或上游发现，不返回凭证、账号 identity 或 endpoint；不需要新增 manifest 权限。
格式非法、重复参数、空或超过 128 字符的设备 ID，或其他查询参数返回 400。格式合法但那台离线、未知或没开远程控制时返回 503 且 `errorCode` 为 `NOT_AVAILABLE`，响应里没有本机条目。旧 Host 带任何参数都返回 400；旧 Host 可能返回 404，插件应明确提示升级；503 时提供重试。运行前再次核验选定来源。

## 4.0.3b 宿主统一模型选择器（新增接口，尚未发布）

不想自行绘制选模界面时，电子脑调用 `cindy.pickModel(options?)`。
Host 打开与 Cindy 共用的模型选择器，用户确认后返回完整配置；取消、关闭页面或超时不返回配置。
不需要新增 manifest 权限，不改应用默认、插件默认或现有任务，不调用模型。

```js
if (typeof cindy.pickModel !== 'function') {
  // 当前 Host 不支持，请提示用户升级；不要改为维护一份硬编码名单。
  return;
}
const selected = await cindy.pickModel({
  // initial: savedRoute, // 可选，必须是下面的完整 route
  ...(msg.mobilePageId ? { mobilePageId: msg.mobilePageId } : {}),
});
if (selected.ok) {
  // 自行保存 selected.route；创建普通任务时可原样作为 cindy.tasks.create 的 route。
  // 任务创建和执行仍需 agent.tasks 的正常批准，选模本身不授予执行权限。
}
```

成功：`{ok:true,route:{agentKind,providerId,model,effort,fastMode}}`。
`agentKind` 为 `cc | codex | pi`，`effort` 为空串表示未指定，
`fastMode` 为布尔值或 `"ultrafast"`。保留完整组合，不根据模型名重新猜来源或引擎。
失败：`{ok:false,errorCode,message}`；`CANCELLED` 表示本次选择已取消，
`BUSY` / `RATE_LIMITED` 表示已有选择器或请求过频，`UNAVAILABLE` 表示没有可用宿主页面，
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

该端点仅接受 `initial`，只支持 POST、无查询参数。旧 Host 404 时提示升级，
503 时提示稍后重试；正常受理的取消与错误使用上述结构化结果。
手机与远程桌面设置页通过业务频道交给电子脑调用 `pickModel`，必须原样转交 Host 附加的
`mobilePageId`，选择器才会显示在发起操作的设备，并读取插件执行电脑的目录。
不要把 `mobilePageId` 存成全局最近设备；不传时只在插件运行电脑打开。
同一 Host 同时只有一个插件选模请求，等待上限 90 秒；不要后台循环弹窗或自动重试取消。
窗口、页面、连接、账号或安装版本变化后，旧回执不能交给替代实例。
此接口不选择执行电脑或 SSH 工作区，也不提供凭证、endpoint 或完整 ProviderView。
依赖此接口的插件应在接口正式发布后填入实际的首个 `minCindyVersion`，并保留运行时能力检查。
