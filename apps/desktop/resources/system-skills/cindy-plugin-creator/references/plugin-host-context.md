## 4.1 宿主公开上下文(request,无需额外能力声明)

电子脑需要按宿主构建身份或当前语言选择公开配置/界面文案时,走只读 request。当前只暴露
`region: 'cn' | 'global'` 与 `locale: 'zh-CN' | 'en' | 'ja' | 'ko'`,
不含登录态、路径、设备信息或凭证:

```js
const r = await cindy.request({ kind: 'app-context' });
// → { ok:true, context:{ region:'cn'|'global', locale:'zh-CN'|'en'|'ja'|'ko' } }
```

`settingsHtml` / panel 没有 preload 桥,读取同一份上下文走同源只读端点:

```js
const r = await (await fetch('/app-context')).json();
const region = r.context.region;
const locale = r.context.locale;
```

region 只适合选择**已在 manifest 声明过**的公开配置。例如 broker OAuth
可在 `clientIdAlternatives` 列出备用 ID,再由 settingsHtml 把选中的
`clientId` 放进 `/oauth/<key>/connect` body;主机会做清单白名单复验。
不要用 region 推断用户位置、语言或数据归属。

`locale` 是插件语言的唯一事实来源。设置页、panel 和电子脑都只使用它；
不要读取 `navigator.language`。宿主切换语言时，运行中的电子脑会收到
`{ type:'host-context-changed', ok:true, context:{ region, locale } }`，可用
`BroadcastChannel` 通知同插件的设置页/panel 重新读取 `/app-context` 并换文案。
未运行的插件会在下次启动或页面重新装载时直接读到新语言。插件协议之外的宿主语言
(当前为 `zh-TW`)会在插件边界固定映射为 `en`，保证按旧四语契约编写的存量插件
无需改代码；插件自身不支持该 locale 时也必须选英文资源。
