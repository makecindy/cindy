## 4.20 一级主视图(mainView 能力)

插件需要一个从 Cindy 左侧导航进入的完整页面时，直接声明 `mainView`：

```json
{
  "schemaVersion": 3,
  "minCindyVersion": "1.2.3",
  "mainView": {
    "title": "工作台",
    "icon": "puzzle",
    "html": "main-view.html"
  }
}
```

- `mainView.html` 必须是包内安全相对路径且文件真实存在；`title` 可省略，省略时
  回退插件 `name`。声明过基础 title 后，locale 文件可用
  `"mainView": { "title": "Workspace" }` 翻译；没有基础 title 时不要声明该翻译；
- `mainView.icon` 可省略，省略时使用 `puzzle`。它只控制主视图的左侧导航入口，不会
  替代或修改根级 `icon` 品牌图片。可用值与 Cindy 系统图标名完全一致：
  `puzzle`、`globe`、`code`、`folder`、`database`、`chart-column`、
  `image`、`message-circle`、`calendar-days`；不接受别名、任意图标名或图片路径；
- `mainView.preferredIcon` 可选，用于侧栏、自定义导航与新增页签菜单。支持上述图标以及
  `tablet-smartphone`、`contact-round`、`podcast`、`workflow`。客户端不认识首选名称时使用
  `mainView.icon`，两项都省略时使用拼图。插件品牌图仍由根级 `icon` 指定。
- `mainView.open` 可省略(缺省 `page`:左侧导航入口点开后撑满内容区)。`sidebar` =
  作为不跟对话的页签放进聊天区某一边的页签组(`side`:`left` / `right` / `top` /
  `bottom`,缺省 right;其它 open 值下声明 side 拒装);`window` = 弹成独立 OS 窗口。
  这只是**默认**:用户把页签拖到别的边、弹出或合并回来之后,主机记住用户的放置,
  左侧导航入口此后按用户的位置打开,直到用户在插件详情页「恢复默认位置」;
- **同一视图缺省单实例**:主机保证你的主视图同一时刻只活在一个地方——用户进整页时
  侧栏 / 独立窗口里的页签会被收掉,页签出现时整页让位。两份同一界面各自保存整份数据
  会互相覆盖,这条兜底让你不必自己做多视图防覆盖。只有自己已处理好多视图一致性(共享
  写入方 / 保存带版本号 / BroadcastChannel 同步)的插件才声明 `"multiple": true` 放开;
- `mainView` 与 `panel` 是两种独立 UI 贡献项。可以让两者指向同一 HTML，但必须分别
  声明；主视图不接受 position、宽度或 systemButtons；
- **主题与壁纸画布**：主视图在整页、侧栏和独立窗口中都跟随所在宿主的主题与壁纸状态。
  壁纸开启时，Host 注入 `html, body { background-color: transparent !important; }`，
  覆盖普通文档底色，让宿主壁纸透出；关闭时移除该覆盖，恢复主题底色基线。
  主视图的底色注入只写 `background-color`，保留作者的 `background-image`、尺寸与平铺设置；
  自绘背景图仍会绘制在宿主壁纸之上。主题 token 不会变透明，输入框、卡片、弹窗等子元素
  仍使用各自的主题表面色。需要承载不透明内容时，在对应内容容器上使用主题 token，
  不依赖 `html` / `body` 的普通背景色；避免用全页不透明容器遮住壁纸。
  该壁纸覆盖仅适用于 `mainView`，不改变独立 `panel` 或插件设置页的底色行为；
- 插件批准并启用后，入口默认显示。用户可以在插件详情关闭“显示在左侧导航”；这只隐藏
  导航入口，不停用插件，也不关闭 tool、network、panel 或后台能力；
- 主视图与 panel 共用同一 Ghost WebView 沙箱：零 Node、零通用 preload、每插件专属
  partition、CSP 和导航守门不变。`mainView` 本身不附赠联网、文件、凭证或其它能力；
- 页面需要电子脑逻辑时仍先 `fetch('/wake')`，通信和媒体协议与 §5 完全相同。插件停用、
  卸载或失去批准后，Host 会卸载页面并退出该路由。

### 嵌入本机服务页面

桌面插件可为主视图声明一个已运行的本机服务入口。用 `mainView.html` 提供包内回退页，
用 `mainView.localServiceUrl` 声明固定地址。例如：

```json
"mainView": {
  "title": "Service Dashboard",
  "html": "fallback.html",
  "localServiceUrl": "http://127.0.0.1:41237/dashboard"
}
```

地址使用字面的 `127.0.0.1`、HTTP 和显式非默认端口，并包含路径。安装或更新时，用户在运行
服务的 Cindy Desktop 上确认完整入口地址。旧版 Cindy、缺少新批准的安装以及从远程控制端
完成的首装均显示包内回退页。地址变更需要重新确认，宿主不会为插件启动服务。

主视图照常从左侧导航和右侧栏入口打开。本机页面在插件实例和账号专属的内存分区运行。
HTTP 导航、子帧、资源请求及 WebSocket 仅限批准的 IP 和端口。弹窗、下载、Worker 及浏览器权限请求会被拒绝。
Cindy 提供 `color-scheme` 和现有语义颜色变量，页面自行选择如何使用，例如
`body { background: var(--surface); color: var(--text-primary); }`。

本机页面不接收 Cindy 页面桥或目录。需要目录的插件可在另一个包内页面显式使用目录上下文接口，
并由插件自己的逻辑处理结果。声明固定本机页面不需要目录权限、Node、预览或网络权限。
