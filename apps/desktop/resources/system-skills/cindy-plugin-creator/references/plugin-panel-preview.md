## 4.15 面板预览(preview 能力)

部署预览、本地 dev server、控制台面板这类"给用户看个网页"的需求,声明
`preview.hosts` 白名单(见 §2),运行期请主机在右侧栏内置浏览器开标签:

```js
const opened = await cindy.preview({
  url: 'https://demo.example.dev/build/123',
  sessionId: ctx?.session_id            // 可选:落到哪个会话的右侧栏;缺省当前会话
});
if (!opened.ok) console.warn(opened.errorCode, opened.message);
```

规则与红线:

- URL 必须命中装入时钉死的 `preview.hosts` 白名单:只收 https(http 仅限
  localhost / 127.0.0.1 本地开发),不收 URL 内嵌凭证;范围外回 URL_NOT_ALLOWED,
  **改白名单只能发新版本；市场安装会自动更新，本地包需重新导入新版**;
- 同一插件两次打开最小间隔 5 秒(RATE_LIMITED)——预览是"结果亮相",不是刷屏
  通道;
- 每次打开,宿主都会弹带你身份头的提示("xxx 打开了一个预览页面"),用户永远
  知道页面是谁开的;
- 标签开在用户自己的右侧栏浏览器里,关不关、看不看由用户决定。
