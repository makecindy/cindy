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
- 插件批准并启用后，入口默认显示。用户可以在插件详情关闭“显示在左侧导航”；这只隐藏
  导航入口，不停用插件，也不关闭 tool、network、panel 或后台能力；
- 主视图与 panel 共用同一 Ghost WebView 沙箱：零 Node、零通用 preload、每插件专属
  partition、CSP 和导航守门不变。`mainView` 本身不附赠联网、文件、凭证或其它能力；
- 页面需要电子脑逻辑时仍先 `fetch('/wake')`，通信和媒体协议与 §5 完全相同。插件停用、
  卸载或失去批准后，Host 会卸载页面并退出该路由。
