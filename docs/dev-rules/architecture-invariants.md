# 架构原则与不变量

> 权威工程规则。用于依赖方向、进程职责、多端执行和布局结构的设计决策。
> 约束新增和正在修改的代码，不要求为形式统一专项重构存量；布局树变换始终保持合法。

> 源码注释按 §1 包解耦、§2 main 静态依赖、§3 布局树引用本文，这三个编号不要重排。

## 用工程投入换取用户效率

技术方案以[产品原则](../product-rules/core-product-principles.md)的用户总成本为尺度：把重复操作、
等待、纠错和不必要的模型消耗消化在产品内部，不因实现方便把成本交给用户。清楚的职责和可复用
的机制让这份投入惠及每个入口。

## 1. 让能力独立于承载它的界面（package 解耦）

共享 package 独立提供能力，经初始化、配置或回调获得宿主能力，不 import Desktop Renderer
或 Main；桌面、手机和远程入口因此能复用能力，而不连带引入某个界面的进程与生命周期。

Agent 编排集中在 maker-core，Main 承担宿主能力，Renderer 表达状态和用户意图。确定的流程
与约束由代码保证，模型只判断真正需要推理的部分。依赖与信任边界见
[Electron 进程职责](electron-security-and-process-boundaries.md)，Agent 与宿主的分工见
[maker-core](maker-core-and-agent-behavior.md)。

## 2. Main 只用静态依赖

Main 只用顶层静态 import，禁止运行时动态 `import()`：依赖在打包时可见，加载时机和错误
路径不留给运行期猜测。

## 3. 把用户的选择与系统演进分开（含主界面布局树）

配置记录用户的明确选择，默认值随产品演进；恢复默认就是重新跟随当前默认。
[配置契约](configuration-and-overrides.md)定义两者的合并与迁移语义。
同理，扩展暂时不可用不意味着用户放弃它，升级也不应要求用户重做已有配置或授权；
持久数据与存量插件分别遵循[数据迁移](database-and-migrations.md)和
[插件兼容](plugin-security-and-authoring.md)的具体边界。

主界面布局体现这一区分：位置是用户偏好，面板身份是 `panelKind`，不能把“左栏／右栏”
当作业务身份。布局是用户级的全局递归 split／pane 树，不属于某个 session，
启动首帧就应呈现保存的布局，避免先画默认布局再跳变。

树中的 `chat-main` 恰好一个，始终可见、不可关闭或折叠，最小宽度 400px。
未注册、沉睡或已抽离的面板保留位置但不渲染，恢复后原位出现。
新面板通过 registry 接入标准 pane chrome 与平台顶部安全区；
折叠记忆按面板声明的 global／per-session／none 语义处理。

右侧栏的页签住在**页签组**里（`shared/layoutTree.ts` 的 `TAB_GROUP_IDS`）：右侧组沿用
`right-tabs`，左／上／下边组的 `panelKind` 是 `tab-group:<边>`，上下组与 `chat-main` 同在
一层 `chat-column` 纵向分割里。页签归属由 renderer 记（`tabGroups.ts`），边组 pane 在
组里第一次有页签时经 `ensureTabGroupPane` 插入，之后**只隐藏不删除**（组空了就按未注册
kind 隐藏）；根横排里包着 `chat-main` 的那块是唯一的弹性区域。

边组 pane 里的 webview 宿主**不能因路由切换被卸载**：卸载即销毁 webContents，回来整页
重载（#8081）。离开聊天页（设置页除外）时，在聊天页出现过的边组改为**停放**
（`setPanelKindParked`）：pane 原位保持挂载，容器 0 宽／0 高、`aria-hidden`、不画分割线、
不进份额账本，树里的 `fraction` 不动、不写布局。停放不改变其它注销条件（组空了、页签
弹到独立窗口、整栏分离、右栏窗口状态未加载仍然注销）；从未在聊天页出现过的组不挂载。
停放项与解除停放后的容器必须同 key 同类型，否则 React 会重挂载。

布局结构以 `apps/desktop/src/shared/layoutTree.ts` 为准，持久化在
`apps/desktop/src/main/layout/LayoutStore.ts`，注册在
`apps/desktop/src/renderer/panels/registry.ts` 与 `builtinPanels.tsx`。
修改布局树至少运行相关定向测试与 typecheck，命令见[桌面开发](desktop-development.md)。

## 4. 让不同入口共享事实

同一任务的状态、权限和执行结果由共同的业务入口解释。控制端呈现执行端的事实，界面上的
“已收到”不等于执行端的“已完成”。手机经 device-link 控制电脑，SSH 工作区的文件与进程在
远程主机，路径和操作都按实际执行位置解析。

重试和恢复的范围与故障范围相称：一个请求或一台控制端出故障，不拆掉其他设备正在用的共享
连接。拓扑、通道准入与恢复约束见[远程与手机适配](remote-and-mobile-adaptation.md)，跨版本
交互见[协议兼容](protocol-compatibility.md)。
