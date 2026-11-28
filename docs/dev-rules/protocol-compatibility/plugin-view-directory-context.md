# 插件页面的项目与任务目录

桌面端可选声明 `viewDirectoryContext: true` 配合 `mainView` 或 `taskView`，由用户在安装或更新时批准。
旧 Host 可以保留声明且继续显示已有页面。使用此功能的插件必须声明实际支持并验收的最低 Cindy 版本，
并能处理 `window.cindyUI.getDirectoryContext` 或 `onDirectoryContextChanged` 缺失的情况。
兼容读取保留历史未知声明，缺少相应批准记录时无目录数据。旧远程安装确认界面不授予此权限。

`getDirectoryContext(): { projectDir: string | null; workingDir: string | null } | null`。
`onDirectoryContextChanged(callback)` 在同一文档交付时调用回调，返回取消订阅函数。
项目草稿只提供 `projectDir`。本机任务提供实际 `workingDir`（包括 Git worktree），同时提供已记录的
`projectDir`，未知则为 `null`。打开时已选定备用恢复目录的任务提供实际恢复目录，仍沿用原项目归属。没有已确认的本地上下文时为 `null`。本机持有文件的任务即使使用另一台
电脑提供的 Agent，目录归属也依照任务记录。SSH、另一台电脑持有文件的任务以及访问受限目录返回空值。

送达前宿主对当前目录做一次有时限的目录探测。路径是位置数据。插件负责将它解释为自己的领域对象，文件读写、进程与联网操作仍各自经过原有权限。
路径不进入插件页地址、模型或跨端协议。插件页面切换时用当前绑定的项目或任务重建文档，使旧值离开页面。
回退宿主版本时仍可运行原插件页面，目录接口不可用，已有批准和安装数据沿用原格式。

作者契约见插件编写手册 §4.20、§4.22。
