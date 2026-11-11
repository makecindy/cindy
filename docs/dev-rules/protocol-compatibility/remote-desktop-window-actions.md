# 远程桌面窗口操作

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增可选能力 `windowActions`，只在支持的主机上发送 `windowAction`：`list` 返回有界窗口
列表，`activate` 只接受当前系统枚举的窗口 ID，`desktop` 切换临时空工作区并支持恢复。
三种操作均要求当前同账号控制 lease；撤权后的迟到回复不得暴露窗口标题或继续操作。
新手机对未声明能力的旧电脑保留原快捷键；旧手机仍可连接新电脑。本扩展只走既有业务
隧道，不新增 relay 消息类型、不修改服务端授权或协议实现。

可选能力 `workspaceNavigation` 与 `omarchyMenu` 分别声明左右桌面切换和 Omarchy 菜单。
新控制端仅在能力为真时发送 `windowAction` 的 `workspaceLeft` / `workspaceRight` /
`omarchyMenu`；缺省保留旧工具栏，不向旧主机发送新动作。旧端的 `desktop` 语义不变。
工作区切换作用于采集屏幕，菜单使用本机固定入口，所有操作沿用控制 lease 与撤权检查。
