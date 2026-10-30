## 4.23 随包浏览器扩展(browserExtension 能力)

插件随包携带一个 Chrome / Edge 扩展(翻译、字幕、页面读取之类"住在用户浏览器里"的功能)时,
由 **Cindy 承接扩展的连接**:配对、身份绑定、作业分发、结果按预算截断都在宿主,插件
不再自带接线进程。在身份卡声明:

```json
"browserExtension": {
  "protocol": "cindy-browser-extension/3",
  "extensionIds": ["dmbhhhdijpeaibfeocdcjhfefkgpkeef"],
  "nativeHost": { "name": "com.example.browser", "binary": "native-host/bin" },
  "pageControl": true
}
```

- `extensionIds` 是全部知情面:只有这些扩展能连上宿主桥接(商店版、Edge 版、开发版各一条),
  装入时逐条展示并钉死;新增 id 要发新版本并重新确认权限。
- `nativeHost` 可选:首次配对用的 Native Messaging host。宿主把 `<binary>/<platform>-<arch>/`
  下的二进制复制到本机私有目录并向各浏览器注册;二进制由你随包提供并签名。
- `pageControl: true` 表示扩展实现**页面控制契约**(tabs / navigate / snapshot / extract / act),
  用户在设置 →「自动操作」选「我的浏览器」后,Agent 的 `browser` 工具会经它操作用户正在用的
  浏览器。目前只有官方 Cindy Chrome 的声明生效,其它插件声明了也不会接管「我的浏览器」。
  只做翻译/字幕通道的扩展不要声明它。

运行期两条管子:

```js
// 插件 → 宿主:向扩展投递作业、推送配对身份、回传转交结果
let status;
try {
  status = await cindy.send({ type: 'browser-extension-request', kind: 'status' });
} catch (err) {
  // 只有旧宿主会拒绝这个管子类型([INVALID_PARAMS] 未知的管子消息类型):回落到你自己的
  // 接线进程,并记住。不要把拒绝当作已连接。其它异常(超时等)不回落,下次再探测。
  if (!String(err?.message).includes('[INVALID_PARAMS]')) throw err;
}
// 新宿主也会返回 errorCode(HOST_NOT_READY、PERMISSION_DENIED 等):这表示宿主有这个槽,
// 只是暂时不可用。不要据此回落,也不要缓存结果,下次再探测。
await cindy.send({ type: 'browser-extension-request', kind: 'setTrustedClients', clients: paired });
// 宿主没有保存过你的配对身份时,启动后会发来事件
// { type: 'event', name: 'browser-extension-policy-request' }:收到后立即推送配对身份。
const result = await cindy.send({
  type: 'browser-extension-request',
  kind: 'act',
  action: 'extract',
  payload,
});

// 宿主 → 插件:扩展发起的请求(翻译、字幕…)转交给你处理
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'event' || msg.name !== 'browser-extension-relay') return;
  const { id, clientId, request } = msg;
  await cindy.send({
    type: 'browser-extension-request',
    kind: 'relayProgress',
    id,
    progress: { stage: 'model' },
  });
  const result = await handle(
    clientId,
    request,
    async () =>
      (await cindy.send({ type: 'browser-extension-request', kind: 'relayActive', id })).active ===
      true,
  );
  await cindy.send({ type: 'browser-extension-request', kind: 'relayResult', id, result });
});
```

规则与红线:

- **不设站点名单**:「我的浏览器」与 Cindy 专用浏览器一样,读取与交互不按网站限制,本机、私网与
  单段内网主机名和公网网站一样可访问;安全交给任务的权限档位与自动审核(2026-10-30 决定)。
  旧插件推送的 `setPolicy` 照常应答但不生效。
- **`nativeHost` 只给官方 Cindy Chrome**:Native Messaging 程序在插件沙箱外运行,且同一账号的
  所有 Cindy 共用一份注册,宿主只为官方 Cindy Chrome(`my-browser`,名称
  `com.makecindy.browser`,并声明了 Node 程序)安装它。其它插件声明了也只开桥接,扩展需要手动
  配对。
- **作业一次送达**:已送达的作业不会重投;结果 `execution` 为 `unknown` 时要让 Agent 核对
  页面,不能当成功或未执行报告。
- **宿主代码不认识你**:桥接只按声明工作,不会为某个插件写特例;需要线协议之外的能力,先提
  Cindy 改动,不要在扩展里绕过。
- **向下兼容**:旧宿主没有这个槽,会以 `[INVALID_PARAMS]` 拒绝这个管子类型;插件必须保留
  自带接线进程的降级路径(或明确提示升级 Cindy),不能让已装用户的功能消失。
