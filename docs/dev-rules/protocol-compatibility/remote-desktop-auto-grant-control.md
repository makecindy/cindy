# 远程桌面随连接自动给操作权

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

被控端以可选能力 `autoControl` 声明（仅当本机能注入输入，即 `canControl` 为真）：`start`、`viewerDisplay`、
`restoreViewerDisplay` 与 `resolution { temporary: true }` 接受 `control: true`（只接受布尔值），被控端在同一个
请求里启动输入并以 `controlling: true` 回复，控制端不再单独发 `control`。启动输入失败（缺权限、输入不可用）
时租约照常返回且 `controlling: false`，控制端再发 `control` 取得具体错误。操作权仍由被控端持有：它决定输入
助手的启停，手机画中画后台观看照旧经 `presentation` 收回，回到前台再取回；Agent 让位仍只看实际输入。

控制端仅在能力为真时发送 `control: true`；会话层只在请求过时接受 `controlling: true` 回复。旧被控端丢弃不认识的
字段并回复 `controlling: false`，控制端按原流程补发 `control`；旧控制端不发该字段，新被控端行为不变。
Desktop 控制端主进程把带 `control: true` 的回复与 `control` 回复同样记录，用于本机剪贴板判定。

Mobile 的「仅查看」改为纯本地开关：只停止转发输入、关闭键盘与鼠标按钮，不再向被控端发 `control: false`；
被控端仍持有操作权。退出仅查看时若被控端已不再给操作权（输入失败、溢出释放、后台观看），才重新请求。
不修改 relay、服务端或 IPC allowlist；需被控端和控制端都更新才省掉这次往返。
