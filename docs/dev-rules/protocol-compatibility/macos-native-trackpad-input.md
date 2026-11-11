# macOS 原生触控板输入

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

本机聚焦的浏览器／插件页可在顶层 HTML 声明
`<meta name="cindy-native-trackpad" content="touch">`，并用 `data-cindy-trackpad`
标记接收触摸的平面元素。宿主将 AppKit 的两指位置映射为该元素的浏览器触摸事件；
鼠标位置是落指中心，两轴按触控板物理比例等比映射，按原始抬指／取消结束。
映射使用画面长边作为统一距离基准，避免竖屏窄边压缩平移；落指间距与后续位移
使用同一比例，未裁切时保持缩放比例、旋转角度和静止手指的位置，不单独加速双指中心。
触点在元素边缘停止，越界位移不累计；反向移动立即响应，不要求先退回越界距离。
不新增 preload、renderer IPC 或远程请求；插件沙箱仍为零桥，归属与聚焦检查沿用宿主。
后台窗口、第三指、页面导航、失焦会取消触摸；原生模块不可用或已有调试会话时保留原输入。
旧宿主忽略 meta／属性，继续 wheel 兼容路径；手机、Windows、Linux 不接收本机 AppKit 数据。
AppKit 鼠标位置固定使用窗口内容坐标；嵌入侧栏须先扣除宿主内对应 webview 的位置，
并分别处理宿主与 guest 缩放，再在 guest 内命中检测。独立窗口没有这个偏移，
不能单独替代开发版实际侧栏的输入验收。

`data-cindy-trackpad="contacts"` 可选整帧输入：元素收到 `cindy-trackpad` DOM
事件，`detail={phase,touches:[{id,x,y}]}`；坐标相对该元素所属 frame 的 viewport，
phase 为 begin/change/end/cancel，touches 是仍按下的全部触点。整帧原子投递，避免
Chromium 把双指拆成单指前奏及等待触摸 ACK。空属性仍投递标准 Touch/Pointer 事件；
旧宿主按旧路径工作，插件仍保留标准触摸处理。只有宿主向页面投递数据，没有反向特权桥。

contacts 在每次 begin 投递前核对原元素仍连接、仍声明 contacts，且仍是落指锚点
命中的元素（在元素所属 Document／ShadowRoot 内检测）。目标被替换、移除或遮挡时，
向旧元素发送 cancel（断开的旧元素也可接收清理），停止旧采集并重新命中；下一原生采样
可在新目标开始，不依赖再次移动鼠标。旧目标迟到的失败回复不能撤销后来的目标。
取消、释放 CDP object 完成后才 detach，沿用现有采集代次，无新队列或持久状态。

标准 Touch 路径完整结束与取消使用空 `touchPoints`。当前打包 Chromium 默认 WebTouch
路径的部分抬指使用 released IDs；仅发送剩余触点的 touchMove 不会释放缺失手指。
这与 contacts DOM 事件始终表示「全部仍按下触点」的约定不同；以真实 Electron 的
部分抬指、完整结束和取消回归核对，不能只靠 CDP mock 推断浏览器行为。

## Cindy 自己的页面（2026-11-11）

上面的路径面向 webview 访客：Main 用 CDP 在访客里命中并映射。Cindy 自己的受信页面（远程任务的
「设备画面」页签）知道自己的画面在哪，所以走更窄的一条：页面在光标位于画面上时经
`NATIVE_TRACKPAD_HOST`（`main/nativeTrackpadHost.ts`，仅本机 IPC）请求开始，Main 只把校验过的原始
双指采样交给发起的页面，页面自己映射（`renderer/features/remote-desktop/trackpadContacts.ts`）。
映射规则与本文件上面的约定逐条相同：落指中心是光标、按触控板物理比例与画面长边等比、到边即停不累计
越界。两份实现各有回归（`nativeTrackpad.test.ts`、`trackpadContacts.test.ts`），改一处必须同步另一处。
原生采集全应用只有一份，窗口失去 key 时自行结束；访客路径启动采集会顶掉这条，反之亦然——两者按光标
所在位置互斥。不新增远程请求：页面把映射后的两个触点作为设备画面租约里已有的 `touch` 输入发出。

