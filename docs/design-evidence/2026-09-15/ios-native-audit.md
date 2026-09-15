# iOS 原生化审查：任务界面及相关面板

审查对象：`dash/mobile-native-task-header` 当前未提交实现；基于源码及本轮用户走查反馈。不是 main 或已发布版本的合规结论，也不是全 App 逐屏实测。规范见 [iOS 原生界面规范](../../design-rules/ios-native-design.md)。下列优先级为改造顺序，不是安全缺陷级别。

## 优先修改

| 顺序 | 入口与源码证据 | 不符合之处／待验证项 | 建议完成标准 |
|---|---|---|---|
| 1 | [任务详情](../../../apps/mobile/src/session/SessionDetailsNative.ios.tsx)：BottomSheet → RNHostView → RN ScrollView，操作再嵌 Host / VStack | 外壳原生，但内部分组仍手工测宽、设置背景和分隔线；额外顶部 padding 修补分组间距。此前用户已观察到组间挤压与白底突兀。当前不等于完整 Form / Section | 先用系统分组布局承载管理操作，统一滚动与分组间距；用量内容按需嵌入，避免来回测宽。验收半屏、展开、大字体下无重叠及整行热区 |
| 2 | [搜索](../../../apps/mobile/src/session/SessionSearchNative.ios.tsx)：fitToContents + TextField | 固定大高度、底部 Spacer、结果预览已在代码删除；紧凑版本尚未在搜索界面重新目检。原生输入框不等于键盘交互已验收 | 先验证实际高度、软键盘、中文输入、无结果／多结果、清除和原消息定位；若仍有空白，定位容器测量而不是继续堆固定高度 |
| 3 | [模型与权限](../../../apps/mobile/src/session/ModelPickerSheet.tsx)：SheetModal + 双 SheetSurface | 高频入口仍为自绘把手、档位和二级位移动画，与新任务详情不一致 | 改为系统 sheet 内的一级／二级导航；保留供应商分段、模型路由、搜索、权限状态和返回语义，复杂数据列表不必强换小型 Form |
| 4 | [附件／上下文入口](../../../apps/mobile/src/session/ContextSheet.tsx)：SheetModal + SheetSurface | 自绘外壳仍管理遮罩、滑动与尺寸 | 原生 sheet 承载现有业务内容，验证键盘与附件选择返回；不要只换圆角和背景 |
| 5 | [消息操作](../../../apps/mobile/src/session/MessageActionSheet.tsx)、[账号切换](../../../apps/mobile/src/session/AccountSwitcherSheet.tsx) | 前者为手绘模糊动作卡及取消卡；后者为自绘 sheet 与行列表 | 消息操作按触发方式选择原生菜单／动作呈现；账号使用原生分组列表，保留切换中、禁用及身份展示。关闭完成后再执行后续呈现 |
| 6 | [Pi 分支](../../../apps/mobile/src/session/PiSessionTreeSheet.tsx) | 仍使用 SheetModal / SheetSurface，与任务详情相邻入口不一致 | 跟随通用原生面板迁移，保留树形数据、分支切换与失败状态 |

## 本轮方向已落实，但不能过度宣称

- [任务顶部](../../../apps/mobile/src/session/SessionHeaderNativeControls.ios.tsx)已有原生按钮、保留业务图标、弱玻璃标题与渐隐模糊。标题仍为自定义标签，顶部并非整个 UINavigationBar。与首页的精确中心线、长标题和 iPad 尚需对照目检。
- 详情默认 medium、可展开、去掉关闭 X；管理与搜索分组、删除独立、取消重复文件／远程桌面入口已实现。自定义操作行已有完整 contentShape，但整行点击需要运行期验证。
- [用量摘要](../../../apps/mobile/src/session/SessionUsageSummary.tsx)已去掉冗余套餐说明，来源改为名称；[任务路由](../../../apps/mobile/app/sessions/[sessionId].tsx)按当前 provider 匹配绑定账号。用量本体仍是 RN 自定义内容，这本身不是缺陷，主要问题是其容器与原生分组的整合。
- 搜索已使用原生弹层与输入控件。最后一次服务重启确认加载了当前 worktree 的新 bundle，但截图停在首页，因此不能写“紧凑搜索效果已验收”。
- 本轮没有完成 Dark、大字体、无障碍设置、软键盘及物理设备的完整走查。以上为待验收项，不能直接断言这些场景存在缺陷。

## 可复用基础与文档问题

[首页任务选项](../../../apps/mobile/src/session/SessionOptionsExpoSheet.tsx)已有原生 BottomSheet + List，以及真正关闭后的回调，可作为容器生命周期和原生动作列表的参考。不是把每个复杂列表都替换成该小型列表。

旧手机指南把模型／任务／Context 等内容面板一律限定为 SheetSurface，这会把后续修改引回自绘。本轮同步移除此冲突，补充系统几何与业务图标的边界；没有批量迁移上述存量界面。

本轮审查只修改文档。代码扫描用于确认实际组件与调用路径，不用原生组件数量计算“原生化完成率”。后续先完成任务详情与搜索这一条用户流程，再扩展到模型／权限与附件面板。


## 后续实施：输入框三步原生化

本节更新上表模型、权限和附件的现状；其余存量界面结论不变。

- 输入：新增 iOS UITextView 模块及 ComposerDocument 适配，旧原生包与 Android 保留兼容入口；默认单行，点击展开。
- 语音与工具栏：外层系统玻璃、识别文字直接进入编辑区；保留原有录音服务及手势业务逻辑。
- 附属面板：iOS 附件、模型、选项与权限使用 SwiftUI BottomSheet / Form / Section；模型搜索及选项返回在同一面板内完成。
- iPhone 17 Pro、iOS 27.0 模拟器已实际检查：中文与换行粘贴、长文本折叠及一次撤销、长稿展开与返回、默认单行与点击展开、录音开始和停止、模型搜索与配置返回、附件半屏及展开、系统照片和文件选择器。输入框 Light / Dark 均目检；附件 Dark、模型 Light 已目检。
- 未完成验证：物理设备、中文候选词组合输入、软件键盘全流程、真实语音转写、完整撤销重做组合、iPad／大字体及减少透明度。不得将组件单测等同于这些场景实测。
- 原生构建通过。新增模块要求新 iOS 安装包，无法仅靠 OTA 给旧包增加原生编辑器；旧包保留原编辑器。iOS 指纹从 `bd25fa134d852f36b23cca452de7f82baa6a73dc` 变为 `e474e6c84bec823af83a741a327e5208d09314d2`，Android 指纹不变。合并仍须遵守冷更确认规则。
