# macOS 桌面小组件

Mac 上的「订阅余量」「每日用量」桌面小组件（macOS 14 起，小 / 中 / 大三种尺寸）。界面就是手机组件：
扩展编译 `apps/mobile/plugins/usage-widgets` 里除手机入口与实时活动外的 Swift 源码，平台差异在那边用
`#if os(iOS)` 隔开；Mac 专属的部分（组件入口、数据文件位置、空状态文案）在本目录的 `MacWidgetSupport.swift`。
数据和菜单栏面板、灵动岛余量、手机组件同源：主进程 `src/main/quota-overview/desktopWidgets.ts` 把余量概览投影成
手机组件读的同一份快照（`buildUsageWidgetSnapshot`），以本机为唯一一台电脑写成 `UsageWidgetStore`。

## 数据怎么到组件

- 扩展在 App Sandbox 里，读不到 App 的数据。主进程写到 `~/Library/Application Support/<应用 bundle id>/Widgets/`，
  扩展的 entitlements 只给这一个目录的只读例外（`temporary-exception.files.home-relative-path.read-only`）。
  路径按 bundle id 区分，正式版、中国大陆版、个人版各写各的。`build.mjs` 安装扩展时生成这份 entitlements，
  并把同一路径写进两个 Info.plist（App 的 `CindyDesktopWidgetDataPath`、扩展的 `CindyWidgetDataPath`）：
  没装扩展的 App 读不到这个键，就不写任何数据。
- 写完由 N-API 扩展 `cindy-desktop-widgets.node`（`DesktopWidgetsController.swift` + `addon.mm`）调
  `WidgetCenter.reloadAllTimelines()`。WidgetKit 只接受宿主 App 自己发起的刷新，所以它在 Electron 主进程里，不能放进 helper。
- 只有桌面上真的放了 Cindy 组件时才持有余量概览（同菜单栏面板的 `acquire`）：主进程每分钟用
  `WidgetCenter.getCurrentConfigurations` 查一次组件数量，WidgetKit 还没回答时保持原状。
- WidgetKit 给每个组件的刷新次数每天有限（系统不公开具体数）。每次重建都写文件，但只在显示内容变化时刷新，
  且两次刷新至少间隔 10 分钟（窗口内的最后一次变化在窗口结束时补上）；内容不变时每 45 分钟刷新一次，
  让「x 分钟前更新」不跨过组件的一小时过期线。组件自己按 15 分钟的时间线推进倒计时。
- 启动和会话失效时独立于采集持有情况清空快照并立即刷新；退出登录（概览带 `gate`）时也写成空状态，组件显示「登录 Cindy 后……」，不保留上一个账号的读数。
- 点组件打开宿主 App（不设 `widgetURL`：本机可能装了多个注册 `cindy://` 的 Cindy）。

## 构建与验证

- `build.mjs addon <out.node> <arch>`、`build.mjs extension <App.app> <arch>`，由 `forge.config.ts` 的
  prePackage / postPackage 调用；没有 macOS 14 SDK 时整段跳过，`CINDY_DESKTOP_WIDGETS=0` 可主动跳过。
  编译时导出 Swift 常量，签名前用 `appintentsmetadataprocessor` 把配置 intent／entity 元数据写入扩展的 `Contents/Resources/Metadata.appintents`。
  Intel 与 Apple 芯片都支持。扩展的入口同实时活动一样用 `-e _NSExtensionMain` 链接。
- 发布签名：`scripts/ci/lib.mjs` 重签 `CindyDesktopWidgets.appex` 时用 `--preserve-metadata=entitlements`
  保留安装时生成的 entitlements；其他扩展仍用各自固定的 entitlements 文件。
- 只改界面时，可以不打整包：把共享源码与 `MacWidgetSupport.swift`（去掉 `@main`）加一个用 `ImageRenderer`
  出图的小程序一起编译，放进带 `Assets.car`、字体和 `CindyWidgetDataPath` 的 `.app` 目录里运行，
  按 Mac 组件尺寸（约 170×170、364×170、364×382）输出浅色与深色图片检查。
- 真正放到桌面验证时，用独立 bundle id 的测试包（避免与正在运行的 Cindy 同身份），装好后
  `lsregister -f <App.app>`、`pluginkit -a <appex>`，在桌面「编辑小组件」里搜 Cindy。
