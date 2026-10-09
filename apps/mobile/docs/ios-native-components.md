# 移动端 iOS 原生组件现状

2026-09-29，按导航实验分支的实际调用代码核对（已定案回到侧边栏抽屉导航）。这里的“系统原生控件”指 UIKit / SwiftUI
控件，不把“React Native 最终也渲染 UIView”当作整页已使用系统控件的证据。

## 已使用系统组件的部分

| 用户看到的位置 | 实际实现 | 边界与源码 |
| --- | --- | --- |
| 普通页面返回、任务顶栏及工具栏 | 原生导航栈、UINavigationBar、系统 toolbar item | 标题内容可嵌入 RN；首页 / 伙伴首页的顶栏布局仍是 RN。[入口](../src/platform/chrome/SimpleStackHeader.tsx)、[任务顶栏](../src/session/SessionHeaderNativeControls.ios.tsx) |
| 设备范围、任务显示等下拉菜单 | UIMenu | 菜单是系统的；触发按钮可由调用方提供。旧包缺原生模块时有自绘回退。[入口](../src/platform/chrome/NativePullDownMenu.tsx) |
| 普通确认弹窗 | UIAlertController，经 React Native Alert 调用 | 自定义多步骤编辑不能一概算系统弹窗。[入口](../src/platform/chrome/showActionMenu.ts) |
| 设置里的开关 | SwiftUI 系统开关，经 @expo/ui 使用 | 设置分组和说明布局仍是 RN，不代表整页 Settings 原生化。[实现](../src/platform/chrome/NativeSwitch.tsx) |
| 顶栏圆形按钮、浮动新建按钮 | SwiftUI Button，原生玻璃/禁用反馈 | 保留 Cindy 业务图标，图标可以放在 RNHostView 里。首页浮动新建按钮外包一层原生形变视图：触摸由它接管（不播放按钮自身按压），按下即拉长成输入框药丸。[按钮](../src/platform/chrome/NativeChromeButton.ios.tsx)、[形变](../modules/cindy-composer-morph/ios/CindyComposerMorphModule.swift) |
| 登录页继续、Apple / SSO 等按钮 | SwiftUI Button + Cindy 的标签、品牌图案和布局 | 登录整页、手机号框、协议勾选与法律文字链接仍有自定义实现。[实现](../src/components/LoginNativeButton.ios.tsx) |
| SSO 登录窗口 | ASWebAuthenticationSession | 登录网页由认证服务提供。[调用](../src/auth/AuthContext.tsx) |
| 任务内搜索 | SwiftUI TextField、Button、原生 sheet | 与首页的搜索框不是同一个实现。[实现](../src/session/SessionSearchNative.ios.tsx) |
| 模型选择、模型设置 | 原生 Form / Section / Picker / Toggle / TextField 与原生按钮 | 业务图标、部分状态/内容由 RN 嵌入。[选择](../src/session/UnifiedModelPickerView.ios.tsx)、[设置](../src/session/ModelOptionsSheetView.ios.tsx) |
| 设备管理列表 | SwiftUI List、ListItem、SwipeActions | 与任务列表的自定义侧滑实现不同。[实现](../src/device-link/DeviceManagementList.ios.tsx) |
| 系统照片、相机、文件选择、分享 | 系统选择器 / 分享面板，经 Expo 模块调用 | 附件面板内的“最近媒体”网格不等于系统相册。[附件入口](../src/session/useMobileLocalAttachments.ts) |

## 原生容器或原生编辑核心，内容仍有定制

| 位置 | 已原生的部分 | 仍然定制的部分 |
| --- | --- | --- |
| 任务详情面板 | 系统 BottomSheet、展开档位和拖拽关闭 | RN 内容、间距和业务信息布局；不能称整页系统 Form。[实现](../src/session/SessionDetailsNative.ios.tsx) |
| 附件、伙伴等面板 | 原生 sheet；部分页面用 Form / Section / 原生按钮 | 某些资源块通过 RNHostView 嵌入 RN 内容。[公共外壳](../src/session/ComposerSheet.ios.tsx)、[伙伴内容桥](../src/session/CompanionNativeContent.ios.tsx) |
| 消息输入器 | UITextView 编辑核心与选择/撤销，原生展开控制器 | Cindy 编写的原生引用/文档逻辑、业务工具栏；外框在可用系统上用原生 GlassView。[编辑器](../src/session/ComposerNativeInput.ios.tsx)、[外框](../src/session/ComposerFrame.ios.tsx) |
| 底部动作菜单 | 自定义原生 UIViewController / UITableView + 系统 UISheetPresentationController；旧包回退系统 ActionSheetIOS | 不是每一种动作菜单都直接使用系统 UIAlertController；背景仅在 Liquid Glass 可用时透明，否则用系统分组底色。[模块](../modules/xdt-ios-action-sheet/ios/XdtIosActionSheetModule.swift) |

## 仍主要由 React Native 定制的部分

- 首页任务列表、分组与任务行；任务行侧滑使用 Reanimated 自定义交互，不是原生 List 的 SwipeActions。
- 消息、Markdown、代码、卡片等业务内容排版（某些文本/媒体内部仍调用原生视图）。
- 首页搜索框的外观与布局，是 RN TextInput 组合，不是任务内的 SwiftUI 搜索工具。
- 设置页分组、账号卡片、说明行与部分选择面板。
- 首页主菜单抽屉（侧边栏）；iOS 的 FullWindowOverlay 只是承载层，不使抽屉内容变成系统菜单。
- Android 保留现有平台实现；新建形变、药丸拉开与键盘逐帧跟随只在 iOS 生效。

以上是代码事实。真实界面还受系统版本、原生模块是否已装入、回退条件和入口影响。
导航与新建输入框的交互细节和已知未完成项见 [导航与新建输入框](./navigation-and-composer.md)。
