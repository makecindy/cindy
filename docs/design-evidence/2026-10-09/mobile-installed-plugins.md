# 手机已装插件页面验收

## 最终设计

列表采用商店式图标与名称布局；iOS 使用原生 plain List 与常驻搜索。
详情依次展示插件身份、描述、使用入口、工具、权限摘要与 Details；配置与任务偏好提示到电脑设置。
输入框上方的插件选择器只展示图标与名称。

工具使用语义弱底色胶囊，名称前放工具图标，不显示描述，随容器宽度自然换行。
默认最多两行；有溢出才显示 Show all，展开后通过 Show less 收起。
头部图标的原生桥接容器按内容尺寸布局；原生使用按钮行给投影留出完整空间。

Host 提供真实启停、配置状态、权限声明与详情事实。旧 Host 缺字段时保持原入口，
不把缺失信息解释为无权限或已配置。配置投影不包含凭证、配置值与账号标识。
最近使用记录按账号与电脑隔离；只有实际使用才更新历史，安装时间不从通知时间推断。

## 实际验收（2026-10-10）

- iOS：专用 iPhone 17 Pro / iOS 26.5 Simulator，真实 PocketMind 插件。
  Light/Dark 检查头部图标、按钮投影、工具两行折叠、展开六个与收起。
  真实任务列表检查搜索、清空、空结果、软键盘、滚动、关闭重开。
- Android：专用 Android 14 arm64 AVD，当前任务 worktree 构建的 Debug 包。
  明确标注 Demo 的数据检查 Light/Dark、正常与窄屏宽度、工具展开收起、
  隐藏工具的 accessibility tree、新任务预填和已有任务搜索列表。
  [浅色折叠](android-collapsed-light.png) · [深色展开](android-expanded-dark.png)。
- Android 切回正常数据入口后停在登录页：真实账号、电脑联动与插件调用未验证。
  后续步骤是用户登录并连接电脑，重复详情与任务入口验收。

## 验收边界

Light/Dark 原始视觉证据来自主干同步前的 JS。同步后已重建并安装匹配基线的 iOS 原生包，
用真实 PocketMind 数据重复验收 Light 的图标、按钮投影与工具展开收起；Dark 未重复目检。
最终 review 对清理和 Android 空结果提示补充自动回归；启停与回读竞态的 62 项定向测试、
Mobile 类型检查通过，真实启停期间的断线恢复未实测。Desktop DEV 未启动。
不以 Demo 结果替代真实数据验收。iPad、旧 iOS 与 VoiceOver 未实测。
本 PR 不修改 Mobile 原生配置、依赖或 runtime fingerprint 输入。
