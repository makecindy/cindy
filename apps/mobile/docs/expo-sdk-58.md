# Expo SDK 58 升级记录

2026-11-07：Expo 57.0.23 → 58.0.23，React Native 0.86.3 → 0.88.1，React → 19.3.0。
Expo 模块按 SDK 58 的 `bundledNativeModules.json` 对齐，锁文件和原生补丁同步迁移。

## 兼容处理

- RN 默认严格类型使用 `ViewInstance` / `TextInputInstance` 等实例类型；列表空组件、
  原生事件、SwiftUI frame 和 nullable 原生返回值按新接口处理。
- Expo File/FileHandle 的 `write`、`writeBytes`、`readBytes` 改为异步。
  需要写完再关闭文件、更新偏移或返回路径的既有调用改用同步版本；异步上传读取显式等待。
- Router RESET 现在需要完整状态。保留 `key`、`routeNames`、`routeKeySeq` 和
  `stale: false`；容器派发显式指定目标栈，避免邀请入群和远程桌面返回重置错误层级。
- RNGH 3 移除经典 Swipeable 入口。保留 2.32.0 的 MIT 授权 JS 实现于
  `src/platform/ClassicSwipeable.tsx`，使用新版原生手势处理器，维持首页侧滑行为。
- SDK 58 默认生成 UIScene 支持，移除 SDK 57 的 `enableSceneSupport` 回移开关。
- 原生补丁保留菜单对象复用、选中状态更新、WebView 选择菜单、Android 滚动取消、
  SwiftUI 延迟控制器挂载和 Simulator/DeviceHub 定位；已被上游修复的图片方向补丁移除。
- 自建 OTA 适配器锁定 expo-updates 58.0.21，迁移 iOS 更新清理和启动失败回调挂接点。
  保留上游新增的缺少启动资源错误，并在重试前清空旧回调，避免覆盖下一次启动回调。
- fingerprint 显式使用 `strict`，继续哈希被修改的原生源码，避免 SDK 58 默认
  `balanced` 只关注依赖版本而遗漏原生补丁变化。
- Desktop 保留自己的 React 版本。移动端 Vitest 与 Metro 一样解析到移动端 React；
  测试中的 React 外部 store shim 直接使用 React 自带的实现。

## 验证与交付边界

- `expo install --check`、冻结锁文件安装、Mobile / Desktop 类型检查通过。
- Mobile 完整测试：824 个文件、12,272 个用例通过。
- iOS Debug 模拟器原生编译通过；安装后全包校验 `matchesLocal: true`，开发原生指纹一致。
- iOS Release 真机 Beta 编译、签名与内置 JS bundle 校验通过，已在 iOS 27.2 iPhone
  安装并回读确认构建版本；与正式 App 并存。后续完成升级前后 9 轮进程资源采样，见
  [本地资源对比](expo-sdk-58-performance.md)；固定页面交互、完整启动时间与帧率仍未验证。
- iOS 27 iPad mini、Global 模拟数据：启动、首页侧滑、进入新任务、键盘弹出、
  输入框拖拽实测通过。此结果不代替登录、推送、真机媒体和自建 OTA 下载回退验收。
- iOS / Android 生产 Hermes bundle 导出通过；Android prebuild 通过。
- Android 原生 APK 编译未完成：本机没有可用 JDK，需在有 Java 17+ 和相应 SDK 的环境补验。
- Metro logcheck 没有 JS ERROR；新增 Reanimated 提示依赖数组在原生端被忽略。
  模拟器系统日志有缺少触感资源和 iOS 27 废弃状态栏 API 的提示，未发现崩溃报告。
- Expo Doctor 使用仓库 CocoaPods 环境后为 18/20；剩余的 Metro 层级解析和多份依赖提示来自仓库显式解析方式、跨端 React 版本及
  `file:` 本地原生模块。没有通过排除检查来隐藏提示；真实原生构建和运行单独验证。

CI fingerprint（相同 compute 入口，不混用开发安装包指纹）：

| 平台 | SDK 57 | SDK 58 |
| --- | --- | --- |
| iOS | `6773d06f955c1d46d286231cb980e56f11df0a1d` | `d84c98aeb78be89b4ed052ccd4b24d75d706fbeb` |
| Android | `12b8ee38863d82d865ff26d74e26c098df0be252` | `0496a71d29b3794903eee50e2f44943f46401ec9` |

两端都需要新原生安装包，不能把 SDK 58 bundle 推给 SDK 57 runtime。
旧安装包应继续留在其兼容更新通道，安装新包后才能接收 SDK 58 的后续更新。
此次只完成源码升级与本地验证，不包含商店、自建渠道或 OTA 发布。
