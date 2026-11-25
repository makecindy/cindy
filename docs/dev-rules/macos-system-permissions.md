# Mac 客户端的系统权限

核对基线为 macOS 27.3 beta 2（26C5047e，2026-11-22）。以下列出 Cindy Desktop、随包原生助手及手机操作 Mac 时实际经过的入口。外部插件自己的申请流程由各插件维护。

## 从「去授权」到可用

在 Mac 上点「去授权」后，由实际执行功能的应用发起系统请求。系统当场允许时直接使用；仍缺授权时，打开相应的隐私设置。设置链接能送达系统，最后显示的页面、申请应用是否已列出、是否需要用户选择 App 或重新打开，都由 macOS 决定。远程桌面的「在访达中显示」可定位这次运行的 Cindy；个人版和正式版同名时尤其有用。手机可以唤起被控 Mac 上的 Cindy 引导，系统确认须在那台 Mac 上完成。

27.3 beta 2 把普通应用控制其他 App 的设置与辅助技术分开。若看到 **System & App Protection Override**，先选发起请求的应用，再选它获准控制的目标 App。系统也可能允许按次询问，或只开放指定受保护文件夹。升级前的已有授权会保留；旧版或获系统认可的应用可能继续显示旧界面。[Apple 开发者公告](https://developer.apple.com/news/?id=oqng0zjk) · [Apple 的用户操作说明](https://support.apple.com/en-us/149699)

本次在 27.3 beta 2 按系统设置窗口与页标题核验了实际落点。已有 Wi‑Fi 子窗口打开时，普通跳转成功返回，界面却停在 Wi‑Fi。远程桌面第一次跳转后仍缺权限，会提供「在新窗口打开」，同一轮引导每项最多另开一窗，保留原窗口。独立窗口实测直达录屏、App 控制、文件与文件夹、麦克风和输入监控。从独立窗口冷启动时，「完全磁盘访问权限」的常用链接和「本地网络」的扩展链接在该构建落到「隐私与安全性」首页，需再选择对应项目。打开正确页面与系统允许某项操作是两次独立验证。

Apple 开发者技术支持还提到该 beta 可能有影响事件发送权限（PostEvent）的系统问题。遇到录屏正常、键鼠预检仍失败的情形，保留真实状态，并在后续系统构建复验。[Apple DTS 对输入监控与事件发送的说明](https://developer.apple.com/forums/thread/857997)

### 只允许部分 App 时的实测行为

2026-11-24 在 27.3 beta 2（26C5047e）上，用独立签名的测试 App 只允许控制「文本编辑」（At Any Time）和「备忘录」（Ask First），Cindy 自己的整机授权保持不变。结果如下，后续系统构建按同一方法复验：

| 检查 | 部分授权时的结果 |
| --- | --- |
| `AXIsProcessTrusted()` | 为真。只要允许了任意一个 App 就为真，不能据此判断是否整机授权 |
| `AXIsProcessTrustedWithOptions` 加 `kAXTrustedCheckOptionTargetBundleIdentifier` | 按目标准确：选中的 App 为真，其余为假；目标填 `kAXTrustedCheckTargetAllApplications`（`*`）时只有整机授权为真。升级前已有的授权按整机计。两个常量不在 27.2 SDK 中，助手在运行时用 `dlsym` 取，旧系统取不到就沿用原判断 |
| `CGPreflightPostEventAccess()` | 为假 |
| 系统级（HID）发送键盘事件 | 全部被丢弃，包括发给已选中、且在最前面的 App |
| 发给指定进程（`postToPid`） | 已选中的 App 能收到按键和文字；未选中的 App 收不到，也不报错。滚轮事件发给已选中的进程也被丢弃（整机授权下同样的事件能收到）。鼠标点击能到达已选中的 App，但不会作用到控件（按钮不触发，带上窗口编号也一样），在大窗口里还可能落到别处 |
| 系统级「当前前台 App」查询（系统范围元素的 `AXFocusedApplication`） | 返回 -25204，即使已选中的 App 在最前面；改问目标 App 自己的 `AXFrontmost` 可得到正确结果 |
| 读取 AX | 已选中的 App 正常；未选中的 App 立即返回 -25211（`kAXErrorAPIDisabled`） |
| Ask First 的 App | 第一次读取立即返回 -25211，同时系统弹出「Allow … to temporarily control …?」；点「Allow Until Tomorrow」后按目标检查立即变真，重试即可读取 |
| 主动拦截的会话事件监听（`defaultTap`） | 能创建，隐私屏与离开守护不受影响；只监听的事件监听仍需「输入监控」 |

据此（部分授权只在 27.3 起生效；整机授权与旧系统仍走原来的系统级发送）：

- 远程键盘鼠标只能在整机授权下工作，设置页按「需要控制整台 Mac」说明，部分授权时单独说明原因。
- 语音输入把 Cmd+V 发给已选中的目标进程；目标未选中时在动剪贴板之前说明。
- Work Louder 的回车发给已选中的前台 App；前台 App 未选中时不发送。摇杆滚动无法按进程发送，部分授权下仍不可用。
- 代输入只作用于已选中的 App。窗口发现遇到系统明确拒绝时保留原因，发起时向 Agent 回 `TARGET_PERMISSION_DENIED`，已启动的代输入沿用 `permission`；窗口列表为空本身仍不能说明缺权限。按键与文字发给目标进程（原先截图步骤输入会回报成功、实际没有送达）；按钮与聚焦仍用 AX；点击无法送达控件，因此不发送任何鼠标事件，截图步骤的点按回 `action_failed`，单窗口实时画面只转发键盘。判断目标是否在前台改问目标 App 自己。
- 电脑操控遇到 -25211 时按「macOS 未允许控制这个 App」回给 Agent，不再当作窗口失效去重找。

同次实测另见与授权范围无关的现象：27.3 上菜单栏代理（MenuBarAgent）有一个全屏、层级 26 的窗口（承载实时活动的 `ax-center-hud-window`），程坞也有一个全屏、层级 20 的窗口。代输入判断「点击位置是否被遮挡」时会先碰到它们，因此整机授权下 main 上的截图步骤点按也回 `covered`。是否只是本机状态、以及安全上能否排除这类系统窗口，尚未结论。

### 旧版 macOS 的兼容范围

当前正式版主程序的最低系统为 macOS 12。在 macOS 12 至 27.2 上，带应用包的 CuaDriver 使用原有的拖入授权引导。没有应用包的驱动继续走自身申请流程。远程桌面需要打开设置时，先用普通窗口。用户选择另开窗口、系统拒绝时，会回到普通窗口打开同一页。录屏设置在旧系统中叫「屏幕录制」，在新系统中叫「录屏与系统录音」。

远程键鼠和语音粘贴在各版本上都会检查事件发送权限。这组 Core Graphics 接口自 macOS 10.15 可用。按正式版参数交叉编译这两个助手，Mach-O 最低部署版本均为 Intel 10.15、Apple 芯片 11.0。部署目标与自动化用例只覆盖装载要求和程序分支，各系统上的授权弹窗、已有授权升级和实际输入仍需用签名包验证。个人版的固定签名运行时另有 [Apple 芯片及 macOS 版本要求](advanced/personal-build.md)。

### 远程桌面、电脑操控和语音

| 使用场景 | 申请与恢复 | 判断依据 |
| --- | --- | --- |
| 手机或另一台电脑看 Mac 桌面 | 在被控 Mac 为当前这份 Cindy 开启「录屏与系统录音」。点授权后从采集进程请求屏幕源，系统要求重新打开时再重开。 | 采集进程的录屏状态。没有画面时仍要区分采集失败和连接失败。[远程桌面](../../apps/desktop/src/main/remote-desktop/index.ts) |
| 远程键盘与鼠标 | 为系统提示的申请应用开启 App 控制，旧系统在「辅助功能」。仅查看桌面与实际发送键鼠分别检查。关闭引导会取消待打开的设置页。 | 真实输入助手同时检查辅助功能授权与 Core Graphics 事件发送授权；检查过程不发送按键。连接期间撤权后停止输入。只允许部分 App 时系统级键鼠全部被丢弃（见上节实测），助手据 `--scope` 回 `chosen-apps`，设置页说明需要整机控制；这个原因只给本机设置页，不进设备互联回复。[输入助手](../../apps/desktop/native/remote-desktop/macos-input.swift) |
| 自动操作电脑 | 授权对象是 **CuaDriver**。27.3 起直接打开相应设置并启动驱动申请。完整引导在控制权限到位后自动打开仍缺的录屏设置。单点某项只打开那一项；等待时也可以直接切换。早期系统仍可使用拖入应用的引导。 | Cindy 从驱动重新取状态，持续检查授权。支持截屏实测的驱动还会报告画面能否采集。CuaDriver 的授权和远程桌面的授权各自独立。[驱动入口](../../apps/desktop/src/main/maker-ipc/register.ts) · [设置页面](../../apps/desktop/src/renderer/components/settings/ComputerUseSection.tsx) |
| 区域截图、录屏、代输入的单窗口画面 | 截图先尝试获取屏幕源，仍缺授权再提供打开设置。录制系统声和麦克风是独立音源。代输入的单窗口画面只允许捕获指定窗口。 | 实际截图、音轨、目标窗口分别验证。录屏许可不代表麦克风可用，能列出屏幕源也不保证每一帧都能采集。[截图](../../apps/desktop/src/main/region-screenshot/index.ts) · [单窗口采集](../../apps/desktop/src/main/input-handoff/windowCapture.ts) · [Apple 录屏说明](https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac) |
| 语音输入、说话人录入、录制麦克风 | 语音授权由实际采音的 renderer 发起。找不到设备、设备忙或不满足采集条件时显示设备提示；只有授权问题才走相应恢复入口。 | 真实音轨、系统拒绝或限制、设备故障分开处理。语音输入的正常启动直接使用录音流，避免为探测重复启动设备。[麦克风检查](../../apps/desktop/src/renderer/voice-input/startGuards.ts) · [系统状态](../../apps/desktop/src/main/voice-input/permissions.ts) |
| 全局快捷键、自动输入、外围设备 | 监听修饰键按需申请「输入监控」；把语音结果写到外部 App 需要目标控制。Work Louder 自身的 HID 设备访问与代发按键分开。 | 键盘监听走 ListenEvent。语音粘贴、外设代发按键和滚动在助手端检查 PostEvent；普通 AX 读取沿用自己的授权。只允许部分 App 时，语音粘贴按目标检查后把 Cmd+V 发给目标进程，目标未选中则回 `appNotAllowed`；外设回车同样发给已选中的前台进程，滚动不能按进程发送。开启快捷键不等于允许录音或操作其他 App。[快捷键](../../apps/desktop/native/voice-input/macos-modifier-shortcut-listener.swift) · [文本输入助手](../../apps/desktop/native/voice-input/macos-text-insertion-helper.swift) |
| 隐私屏、离开守护、锁定与解锁 | 守护使用已有输入助手的专用模式。解锁使用独立凭证助手，并校验锁屏和账户状态；密码与钥匙串授权有自己的确认。 | 守护开关、屏幕采集、全局键鼠及解锁成功各有独立结果。只有查看或守护时无需额外申请发送键鼠的权限。[守护](../../apps/desktop/src/main/remote-desktop/awayGuardService.ts) · [凭证流程](../remote-desktop-credentials.md) |

### 文件、通讯录及其他系统入口

| 使用场景 | 申请与恢复 |
| --- | --- |
| 桌面、文稿、下载 | 发现指向受保护目录的访问错误后，主进程只尝试读取该目录的一项，空目录也能判定可读。确认读取被拒才提示，三个目录都打开「文件与文件夹」；用户选择需要的目录。权限错误也可能来自文件自身的访问控制。[目录探测](../../apps/desktop/src/main/file-access/permissions.ts) |
| 使用浏览器登录状态 | 先确认是否允许使用已有登录身份。只有源资料目录或登录文件确实拒绝读取才建议打开磁盘隐私设置。系统若支持选择文件夹，选源浏览器的用户数据目录（含 `Local State` 和所用配置的子目录）。检测通信出错时保留实际读取与失败恢复，避免误导用户放开整盘。[源目录定位](../../apps/desktop/src/main/mcp-integrations/browser-real-profile/source.ts) · [实际探测](../../apps/desktop/src/main/mcp-integrations/browser-real-profile/snapshot.ts) |
| 选择文件、保存、选择工作目录 | 使用原生文件选择器处理本次选择。对桌面项目、其他受保护目录和浏览器登录资料分别按实际操作授权。[文件对话框](../../apps/desktop/src/main/bootstrap-electron.ts) |
| 通讯录和自动化 | 通讯录插件经 Apple Events 操作系统「通讯录」，Cindy 的发行包声明了通讯录和 Apple Events 两项用途。读取联系人与明确导出是插件操作。在新安装上需分别验证「自动化 → 通讯录」和通讯录数据许可；插件内请求逻辑在插件仓。[打包声明](../../apps/desktop/forge.config.ts) · [系统提示翻译](../../apps/desktop/resources/mac-permission-locales.json) |
| 局域网 | Bonjour 发现用于同账号设备间的加密直连。客户端探测实际局域网网关，为首次系统询问留出时间；再次明确被拒才打开局域网设置。设置打开期间复查，获准后通知直连重试。没有可用网关、没有同网设备和远端中继不可达要分开排查。[访问检测](../../apps/desktop/src/main/local-network/access.ts) · [恢复直连](../../apps/desktop/src/main/local-network/index.ts) · [发现入口](../../packages/agent-net/src/bonjour.ts) · [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) |
| 剪贴板 | 远程传输、点击粘贴和语音粘贴的临时保存、恢复是不同的读取时机。同步关闭时不应为了探测去读取内容。macOS 的「从其他 App 粘贴」可按应用决定，拒绝粘贴不代表远程画面或麦克风失效。[剪贴板传输](../../apps/desktop/src/main/remote-desktop/clipboardTransfer.ts) · [Apple 对粘贴行为的说明](https://developer.apple.com/documentation/appkit/nspasteboard/accessbehavior-86972) |
| 通知、实时活动、登录项 | 通知受系统通知和专注模式影响。`Notification.isSupported()` 只说明平台支持。实时活动读取自身可用状态。登录项可明确返回等待系统批准的状态，不能提前显示为已启用。[通知](../../apps/desktop/src/main/notificationService.ts) · [实时活动](../../apps/desktop/native/agent-island/live-activity/CindyAgentActivityController.swift) · [登录项](../../apps/desktop/src/main/macos-login-item.ts) |
| 内嵌网页、摄像头等媒体 | 远程采集窗口按所属页面、帧和当次采集授权校验媒体请求。普通语音输入只请求音频。审计未找到桌面核心启动时主动索取摄像头、定位、照片库、日历或提醒事项的流程；外部浏览器、插件及手机系统权限各自管理。[采集窗口授权](../../apps/desktop/src/main/remote-desktop/capturePermissions.ts) · [语音引擎](../../apps/desktop/src/renderer/voice-input/WebMicAudioEngine.ts) |

## 仍需在发行包上走查的情况

- **同名安装和升级**。在干净的 macOS 用户下并装正式版和个人版，从各自界面打开系统设置，确认系统所示申请者、访达定位和实际行为一致。再从有旧授权的版本升级，检查原授权的延续性。
- **按目标授权及按次询问**。系统接口的行为已按上节实测，语音、Work Louder 与代输入助手已用测试 App 实测。仍需用签名包走一遍：Cindy 只允许一个目标 App 时，远程桌面设置页显示需要整机控制，语音输入能写入已选中的 App、在未选中的 App 给出说明，代输入能在已选中的 App 里输入；CuaDriver 只允许部分 App 时，Agent 收到 `app_control_not_allowed`。
- **代输入的点按被系统窗口挡住**。见上节末尾：确认 27.3 上实时活动区与程坞的全屏窗口是否常驻，再决定遮挡判断如何处理。记录系统返回值和实际效果，避免用模拟按键或读取剪贴板来轮询权限。
- **有限文件访问**。仅开放一个浏览器资料目录，确认该资料可使用、另一个仍受限。分别撤销桌面、文稿和下载访问，确认引导回到正确页面。普通文件的所有者或 ACL 错误应单独处理。
- **首次拒绝和撤权**。分别检查录屏、系统声、麦克风、粘贴和键鼠；关闭引导、取消系统选择、重新插入麦克风、仅按系统提示重开 Cindy，检查状态是否恢复。对比 27.3 的系统选择器和仍用旧引导的系统。
- **其他系统服务**。通讯录导入与导出分别验证，局域网用两台真机测试，通知分别验证关闭通知和专注模式，登录项验证等待批准。真实系统弹窗、每个目标 App 的授权、旧系统及最终正式版行为须以签名包实测。
