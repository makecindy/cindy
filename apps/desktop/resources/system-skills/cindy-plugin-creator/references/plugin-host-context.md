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
