# 手机触觉反馈

只在用户主动操作时提供两档短反馈：文件浏览分段选项变化使用 selection；新建任务入口（包括原生形变按钮）、创建提交、任务发送按钮以及录音真正开始采集时使用 commit。掌机语音也沿用采集开始反馈，不在按下时重复触发。侧栏菜单按钮、任务浮窗按钮打开时也使用 commit；右滑拉出任务抽屉只在松手确认展开时反馈，短拉取消／系统中断、关闭、旋转后的常驻侧栏不反馈。无滚动、流式输出或后台事件反馈。80ms 内的重复调用由原生层合并，不排队补播。反馈仅表示按键响应，不表示网络操作成功。

统一入口为 `src/platform/haptics.ts`，能力判定与播放在本地 Expo 模块 `modules/cindy-haptics` 中完成。旧包、Web、原生错误都保持静默，不阻断操作。

- iOS：`CHHapticEngine.capabilitiesForHardware().supportsHaptics` 为真且 App 在前台，才调用 与前台窗口绑定的 UIKit selection / light impact（预设完整短脉冲），由系统控制触觉策略。切换窗口与模块销毁时主动移除旧窗口上的反馈 interaction，避免窗口保留失去引用的生成器。无 AudioServices 振动回退。录音模块在自己拥有的音频会话期间允许系统触觉，释放时恢复此前值，包括远程播放已接管类别的情况（只恢复触觉标志，不停用远程播放）；保活期内重新取得会话时保留最初的标志快照；否则录音预热、采集及保活窗口会抑制发送等交互反馈。不播放录音开始音效。
- Android：API 30+、窗口有焦点、系统触觉开关开启，且 `areAllPrimitivesSupported(PRIMITIVE_TICK)` 明确为真，才播放这个原语（selection 0.35、commit 0.55）。能力未知、查询异常、旧马达直接跳过。不能仅凭系统版本、hasVibrator 或幅度控制放行；不调用传统时长／波形振动，也不使用可能降级的预设效果。

依据：[Apple 硬件能力检测](https://developer.apple.com/documentation/corehaptics/preparing-your-app-to-play-haptics)、[Android 原语支持检查](https://developer.android.com/develop/ui/views/haptics/haptics-apis)。

## 发布与验收

原生能力检测无法用现有 JS API 完成，因此 iOS 与 Android 均必须冷更；存量安装不能仅靠 OTA 获得此功能。随下一轮双端安装包发布，在升级前维持旧 runtime，不向旧包发送不匹配指纹的 OTA。

单测覆盖可选桥接缺失、能力拒绝、成功调用和同步／异步异常；不能代替真机硬件验证。发布前用支持 Core Haptics 的 iPhone、支持 TICK 原语的 Android、传统振动 Android，分别检查选择／发送手感、系统关闭触觉、快速连点与后台无反馈。模拟器无法验证手感。

原生音频设置恢复回归：在 macOS 手动运行 `node scripts/test-mobile-recording-haptics-native.mjs`。脚本编译并执行生产会话方法，以内存音频会话替身验证播放接管、保活重用、重新取得会话、重复释放和激活失败；不访问麦克风，不能代替真机音频验收。
