## 4.24 随包浏览器扩展(browserExtension 能力)

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
  浏览器。在插件详情页明确选择执行端；多个同名副本不会被静默混用。
  只做翻译/字幕通道的扩展不要声明它。

这也是插件提供宿主浏览器服务的现有接入点。Agent、Cindy 的界面和已批准 `agent.hostTools:['browser']`
的其他插件使用同一用户所选执行端。扩展提供者不需要声明 browser 工具组来提供服务；
该组只批准作为调用方使用宿主工具。选择由主窗口详情页完成，插件不能替用户调用激活操作。
停用或更新执行端会关闭旧桥接、作废在途请求；不会悄悄切到另一实例或沿用其配对。

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
- **原生桥按实例和注册名管理**：已批准且声明 `node` 的插件可使用 `nativeHost`。
  程序在沙箱外以当前系统用户运行，安装确认展示注册名与扩展 ID。同名注册被其它实例
  使用时，须在主窗口确认切换；两份插件的配对和私有数据独立。local 不隔离插件自行
  管理的外部目录、设备或其它系统资源，作者应明确管理这些资源的归属。
- **作业一次送达**:已送达的作业不会重投;结果 `execution` 为 `unknown` 时要让 Agent 核对
  页面,不能当成功或未执行报告。
- **宿主代码不认识你**:桥接只按声明工作,不会为某个插件写特例;需要线协议之外的能力,先提
  Cindy 改动,不要在扩展里绕过。
- **向下兼容**:旧宿主没有这个槽,会以 `[INVALID_PARAMS]` 拒绝这个管子类型;插件必须保留
  自带接线进程的降级路径(或明确提示升级 Cindy),不能让已装用户的功能消失。
