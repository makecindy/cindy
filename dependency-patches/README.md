# 第三方依赖补丁

本目录保存 Cindy 对第三方 npm 依赖的本地补丁。根目录 `package.json` 中的
`pnpm.patchedDependencies` 会在 `pnpm install` 时让 pnpm 自动把这些改动应用到对应依赖。

这些补丁既可能是尚未进入上游版本的通用问题修复，也可能是 Cindy 所需的行为适配；
它们不是可以随意删除的临时文件，也不要通过直接编辑 `node_modules` 替代。

## 当前补丁

| 依赖 | 用途 |
| --- | --- |
| `expo-modules-core@58.0.30` | 修复 iOS 偶发闪退（`NSFastEnumerationMutation`，栈在 `-[UIViewController _recursiveUpdateContentOverlayInsetsFromParentIfNecessary]`，无 App 帧）。SwiftUI 宿主视图（`@expo/ui` 的 `Host`）挂上 / 卸下窗口时会同步 `addChild` / `removeFromParent`；而 UIKit 在状态栏或安全区变化时正遍历父控制器的子控制器，若此时有 `unstable_Immediate` 状态提交让 Fabric 当场挂载，子控制器列表就在遍历中被改动。远程桌面叠层渲染在导航栈外，它的 SwiftUI 宿主直接挂在根控制器下，画中画期间一直在。补丁让视图仍同步挂上 / 卸下，控制器的父子关系改到下一轮主线程再同步，并沿用上游对「父控制器视图不包含宿主」时跳过 containment 的判断。同一机制见 [`react-native-screens#4811`](https://github.com/software-mansion/react-native-screens/issues/4811)、[`#4168`](https://github.com/software-mansion/react-native-screens/issues/4168)。改变 iOS 原生指纹，需随冷更发版；升级 expo-modules-core 时核查上游是否已有等价修复。 |
| `expo-paste-input@0.2.2` | 优化移动端粘贴图片的处理时序，将耗时的解码、压缩和写盘移出 UI 线程，并补充加载中与失败事件。 |
| `expo-router@58.0.30` | `Stack.Toolbar.Menu` 子菜单透传 `subtitle`，让 iOS 顶栏菜单的一级行在标题下显示当前值（如「任务信息」下显示已选项）。配合下方 `react-native-screens` 补丁生效。 |
| `harmonyos-sans-sc-webfont-splitted` | 移除依赖按语言全局覆盖 `font-family` 的规则，由 Cindy 自己决定界面字体。 |
| `react-native@0.85.3` | 回移 Yoga 对 `display: none` 与 `display: contents` 测量过程的布局状态修复，避免 Fabric 布局阶段因错误的 owner 关系触发断言崩溃（上游 `6fa330693fba313a2fe1121545c1efd558b60983`、`2546ce4d8219050fcd1bf432c7c830c9fd70c9af`）。移动端 iOS 通过 `expo-build-properties` 的 `buildReactNativeFromSource` 编译该补丁，不能改回预编译 RN Core。 |
| `react-native-gesture-handler@3.3.0` | 修复 Android 手势桥接管滚动时文字子视图收不到 `ACTION_CANCEL`、抬手后仍触发长按误选的问题（[#6219](https://github.com/makecindy/cindy/issues/6219)）。`ScrollViewHook` 经 `dispatchTouchEvent` 保留系统对子视图的取消分发，保留文字选择及滚动。修改原生依赖会改变 runtime fingerprint，须重新构建并随冷更发布；升级 RNGH 时核查上游是否已有等价修复。 |
| `react-native-screens@4.30.1` | iOS 顶栏菜单支持「保持展开」的复选：原实现每次顶栏更新都先清空再重建全部 bar button，展开中的菜单必然被关掉。补丁改为只在按钮列表真正变化时才赋值，顶栏里的普通按钮与菜单按钮在配置（菜单除外）不变时都复用原对象；菜单结构不变时原地写入勾选／副标题／禁用（整份替换会让打开的子菜单退回根层），并通过系统 `updateVisibleMenu` 把这些值同步到正在显示的菜单副本；复选项点击时立即翻转勾选；子菜单支持 `subtitle`。改变 iOS 原生指纹，需随冷更发版。 |
| `react-native-uitextview@2.2.0` | 修复 iOS 长文本渲染闪烁、布局性能、文本选择与选择手柄滚动等问题，并支持自定义选择菜单操作。 |
| `react-native-webview@14.0.1` | 将 Cindy 的文本引用操作并入 iOS 系统选择菜单，同时保留复制、翻译等系统操作。 |

SDK 58 升级已移除 `expo-image-manipulator` 的 HDR 方向补丁：58.0.16 已使用上游的渲染器路径。`react-native-screens` 的子菜单副标题已由上游实现，补丁保留菜单对象复用与实时勾选；Router 仍需透传 `subtitle`。WebView 补丁另将默认泛型从 `undefined` 改为 `unknown`，避免严格类型下 props 变成 `never`。

## 维护方式

1. 升级被补丁覆盖的依赖时，先确认补丁对应的改动是否已经进入上游。
2. 若仍需保留，使用 `pnpm patch <依赖名>@<版本>` 创建可编辑副本，完成修改后执行
   `pnpm patch-commit <编辑目录> --patches-dir dependency-patches` 生成新补丁。
3. 确认 `package.json` 与 `pnpm-lock.yaml` 都引用本目录中的正确文件，并重新执行
   `pnpm install` 验证补丁可以干净应用。
4. 删除补丁前同时移除 `pnpm.patchedDependencies` 中的声明，并验证相关功能不再依赖该改动。

提交补丁时，应在代码注释或 PR 描述中记录问题背景、受影响平台，以及对应的上游 issue / PR（如有）。
