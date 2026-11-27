## 4.1 宿主公开上下文(request,无需额外能力声明)

电子脑需要按宿主构建身份或当前语言选择公开配置/界面文案时,走只读 request。公开字段为
`region: 'cn' | 'global'`、兼容字段 `locale: 'zh-CN' | 'en' | 'ja' | 'ko'`，以及新版宿主的可选 `uiLocale`，
不含登录态、路径、设备信息或凭证:

```js
const r = await cindy.request({ kind: 'app-context' });
// → { ok:true, context:{ region:'global', locale:'en', uiLocale:'fr' } }
```

`settingsHtml` / panel 没有 preload 桥,读取同一份上下文走同源只读端点:

```js
const r = await (await fetch('/app-context')).json();
const region = r.context.region;
const locale = r.context.uiLocale ?? r.context.locale;
```

region 只适合选择**已在 manifest 声明过**的公开配置。例如 broker OAuth
可在 `clientIdAlternatives` 列出备用 ID,再由 settingsHtml 把选中的
`clientId` 放进 `/oauth/<key>/connect` body;主机会做清单白名单复验。
不要用 region 推断用户位置、语言或数据归属。

`uiLocale ?? locale` 是插件语言的唯一事实来源。设置页、panel 和电子脑都只使用它；
不要读取 `navigator.language`。宿主切换语言时，运行中的电子脑会收到
`{ type:'host-context-changed', ok:true, context:{ region, locale, uiLocale } }`，可用
`BroadcastChannel` 通知同插件的设置页/panel 重新读取 `/app-context` 并换文案。
未运行的插件会在下次启动或页面重新装载时直接读到新语言。
`uiLocale` 支持 `zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-PT / pt-BR`。
文言界面 `zh-Hant-x-lzh` / `zh-Hans-x-lzh` 分别映射为 `zh-TW` / `zh-CN`，以匹配插件的现代中文资源。
宿主读取 manifest 的 `locales` 资源时使用同一映射，包括安装预览和已批准的清单；插件未提供对应中文资源时仍回退英文。
旧字段 `locale` 保留四语契约：这四种以外的语言会在插件边界固定映射为 `en`，保证存量插件无需改代码、
重新安装或重新授权。旧宿主不返回 `uiLocale`，新插件使用上述空值回退即可兼容。
插件自身不支持所选语言时必须选英文资源；宿主支持十语不代表第三方插件已经提供十语译文。

### 读取本机与本插件资源用量

电子脑通过同一只读 request 读取资源用量，无需额外能力声明、设置项或权限弹窗：

```js
const usage = await cindy.request({ kind: 'resource-usage' });
```

返回结构为 `GhostResourceUsageResult`，字段如下。内存单位都是字节；某项没有实测读数时
为 `null`，实测为零时保留 `0`，不以估算值补齐。

```ts
interface GhostResourceUsageResult {
  ok: true;
  capturedAt: string; // ISO 8601 采样时间
  machine: {
    memoryTotalBytes: number | null;
    memoryAvailableBytes: number | null;
    cpuBusyPercent: number | null;
    cpuLogicalCores: number | null;
    cpuLoadAverage1m: number | null;
  };
  plugin: {
    memoryBytes: number | null;
    cpuPercent: number | null;
  };
  gpu: { memoryBytes: number | null };
}
```

- `machine` 为执行插件的这台电脑：可用内存包含可回收缓存；CPU 忙碌百分比与一分钟
  平均负载是不同指标。Windows 的 `cpuLoadAverage1m` 为 `null`。
- `plugin` 只合计当前账号、当前安装实例的电子脑和同分区面板页面；同一 OS 进程只计
  一次。CPU 使用 Electron 进程百分比直接加总。进程缺少某指标时，该指标的合计为
  `null`；进程归属无法完整读取或与其他实例共用时，插件合计为 `null`。不返回进程号
  或其他插件、账号、会话的进程详情。
- `gpu.memoryBytes` 是 Cindy 所有页面共用的 GPU **进程工作集内存**，不是显存，也不
  计入 `plugin.memoryBytes`。

宿主在一秒内及采样进行中共用一次底层采样，但各插件的合计分别计算。宿主不主动
轮询；插件按自己的页面可见性和功能生命周期请求，隐藏或卸载后停止不再需要的读取。
采样期间切换账号、撤销插件、更新安装或销毁调用页时，请求会被拒绝，不交付旧读数。

`settingsHtml` / panel 没有 preload 桥，也没有 `/resource-usage` 数据端点。页面需要
读数时，可通过已有 `/wake` 唤醒自己的电子脑，再用同插件分区的 `BroadcastChannel`
与电子脑交换请求和结果。电子脑调用上面的 request；不要在面板直接调用 `cindy.request`。
宿主不识别该 `kind` 时会拒绝请求；插件应明确显示无法读取，并将自己的估算值标为估算。
