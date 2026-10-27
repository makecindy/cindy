## 4.8 设置自绘(settingsHtml)+ 自定义参数存取(/kv)

需要用户配置**凭证之外**的自定义参数(开关、选项、默认风格、服务地址选择等)时,
声明 `settingsHtml`——主机在主界面侧边栏「插件」的详情页里渲染你自绘的设置界面,
以后加参数只改你自己的包,不需要主机更新:

```json
"settingsHtml": "settings.html",   // 安装目录内相对路径;打包期校验文件必须在场
"settingsHeight": 360              // 可选:固定高度 px(160–800);缺省 = 随内容自适应(矮内容真收矮),超 800 内部滚动
```

**宿主默认配置卡（可选）**：顶层 `showTaskPreferences` 只接受布尔值。
省略或设为 `true` 时，符合能力条件的插件继续显示宿主「模型与任务」卡。
声明 `"showTaskPreferences": false` 可隐藏 Desktop 和手机上的该卡，供插件在自己的设置界面提供配置。
这只是显示声明：任务 API、已有配置的读取和执行规则、权限检查均保持原样；也不会为没有相应能力的插件新增卡片。
旧客户端不识别此字段时仍显示原卡片；依赖隐藏效果的插件应使用支持此字段的客户端版本。

**渲染环境**:与面板同款沙箱页(零桥、无通用网络直连,与同插件面板/逻辑页共用浏览器存储和
`BroadcastChannel`,脚本/样式/字体/媒体/数据请求仍只认同源)。所有插件 HTML 页面
(settingsHtml、panel、mainView 与逻辑页)唯一的网络直连例外都是**HTTPS 图片资源**:
`<img src="https://…">` 与 CSS `background-image: url("https://…")` 可以直接加载
任意 HTTPS 地址。主机统一生成 CSP 并只放行 Electron 判定为 `image` 的 HTTPS 请求;
它**不会放行** `fetch()` / XHR、外部脚本、外部样式表、字体、音视频、WebSocket、
`http:` 图片或其它协议。加载远程图片会向第三方暴露网络地址及完整图片 URL,不要把密钥、
token 或用户私密数据拼进 URL。CSP 仍阻止内联脚本和 `onload` / `onerror` 等内联事件;
同包外挂 JS 的行为不变。主题变量与面板同一套(§5「主题」条的
`var(--xxx, 回退值)` 写法照用),主机注入并随换肤
自动重灌;设置区基线背景 = 宿主设置卡片色(与相邻卡片无缝),别再自己铺整页
底色。高度缺省自适应:主机在页面就绪后量内容高度,内容动态增减(展开区、
追加列表)时会自动跟随重量(内部 ResizeObserver 通知宿主再量,你无需做
任何事)。自适应模式下主机会把 html/body 高度钉为 auto、宽度收在设置卡片内
并裁掉横向溢出;同时统一给页面元素应用 box-sizing:border-box、min-width:0
和 max-width:100%,让固定宽控件也能在窄卡片中收缩。布局按"内容自然撑高 +
容器宽度自适应"来写,别用 height:100%/100vh 撑满视口(高度会追不准),也别
依赖固定宽度、横向滚动或自定义 content-box 尺寸;纵向滚动条只在内容超 800px
上限时出现,上限内高度始终贴合内容。只有想把区域高度完全钉死时才声明
settingsHeight(此时主机不注入上述响应式规则,超出部分由你的页面内部滚动)。
插件沉睡时设置区不渲染(显示沉睡提示),唤醒后可用。

**外链(前往控制台)**:设置区/面板里可以放普通同页
`<a href="https://…">`。主机会拦下导航并交给系统默认浏览器,沙箱页自身永远
不离开 `cindy-ghost://`。合法地址按以下顺序处理:

1. href 与身份卡既有 `network.secrets[].url` 或 `node.secretBindings[].url`
   **逐字一致**时直接打开(保持存量插件兼容);href 最好从声明原样复制;
2. URL 解析后的主机是 `xd.com` / `xd.cn` 根域或任意层级子域,或精确
   `workers.xd.team`,直接打开;
3. 其它合法 HTTPS 地址会显示完整规范化 URL,由用户二次确认后才打开。

非 HTTPS、畸形 URL、内嵌用户名/密码的地址一律拒绝。只支持普通同页链接:
`target="_blank"` 与 `window.open()` 不支持。页面必须持有焦点,同一插件
1s 内至多处理一次外链尝试,且同一插件同时最多一个确认框。典型用法:输入行
下方放一条 `<a class="console-link" href="…">前往控制台获取 ↗</a>`,方便用户
一键去申请 key。

**自定义参数持久化(/kv)**:每个插件有一份主机代管的 JSON 参数(每个插件一份,
互相隔离),设置页 / 面板 / 电子脑同源共用,读写都走 `fetch('/kv')`:

```js
// 读(无数据时得到 {}):
const cfg = await (await fetch('/kv')).json();
// 写(整体覆盖 last-write-wins,不做字段级合并;PUT / POST 等价):
await fetch('/kv', { method: 'PUT', body: JSON.stringify({ style: 'anime', autoRun: true }) });
```

规则:
- **路径必须写绝对的 `'/kv'`**——settingsHtml 放在子目录(如 `ui/settings.html`)时,
  相对路径 `fetch('kv')` 会解析成 `/ui/kv` 落 404;
- 值必须是 JSON **object**(数组/标量拒,400),序列化 ≤ **64KB**(超限 413);
- 写成功回 204 无 body;读永远回 200 + JSON;
- **卸下插件时清除,沉睡保留**;更新版本保留;
- 设置页与电子脑/面板同源,改完参数可用 `BroadcastChannel` 通知对方热生效
  (同一插件的面板/设置页/电子脑共用频道名,消息自带 type 字段区分来源);
- **不要在 /kv 里存任何密钥/token 明文**——凭证一律走 network.secrets 声明，
  调用前可由主机 Setup 卡内联入库，详情页管理走 settingsHtml + /secrets 只写通道
  (§4.7)，这是 review 红线;
- `/kv` 与 `/secrets`、`/oauth`、`/wake`、`/gallery`、`/media/`、`/preview/`、`/__boot__`
  一样是主机保留路径,安装目录里的同名文件会被遮蔽,起名避开。

最小骨架(**脚本必须外挂文件**——CSP 同源不放行内联 `<script>`,写了不执行;
内联 style 属性可用):

```html
<!-- settings.html:底色/字色/字体不用自己写——主机注入基线已铺好
     (背景 = 宿主设置卡片色,与相邻卡片无缝;自己再铺整页底色反而会突兀) -->
<!doctype html><meta charset="utf-8">
<body style="margin:0;padding:12px">
  <label>默认风格 <input id="style" style="background:var(--surface,#fff);color:inherit;border:1px solid var(--border-default,#e4e4e0)"></label>
  <button id="save">保存</button>
  <script src="/settings.js"></script>
</body>
```

```js
// settings.js
const $ = (s) => document.querySelector(s);
fetch('/kv').then((r) => r.json()).then((cfg) => { $('#style').value = cfg.style ?? ''; });
$('#save').onclick = async () => {
  await fetch('/kv', { method: 'PUT', body: JSON.stringify({ style: $('#style').value }) });
  new BroadcastChannel('my-ghost').postMessage({ type: 'settings-changed' });
};
```

`BroadcastChannel` 只用于让你自己的 panel / 电子脑热更新。聊天里的统一设置卡不监听
这个事件,也不需要你写任何完成回调；`/oauth`、`/kv`、`/secrets`、
`/connections` 保存成功后,主机会重新读取真实状态并自动更新卡片、继续原工具调用。
