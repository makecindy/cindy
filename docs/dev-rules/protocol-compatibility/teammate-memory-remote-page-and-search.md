# 伙伴记忆远程页面与资源内搜索

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

伙伴设置主资源（声明 `form` 的控制端）追加 `memories` list 块，入口指向 `settings:<botId>/memory`；
原 `memory` 表单（开关与 USER.md）不变。列表页按类别输出多个 `list` 块：块 `title` 为类别名，`data.count`
为该类条数，条目追加可选 `subtitle`（正文开头）与 `timestamp`（毫秒）。详情页
`settings:<botId>/memory/<entry>` 由 `entry` 表单（标题、正文）与 `remove` 动作组成，revision 即该条
`updatedAt`，动作经既有 `bindResource` 绑定该值；主机服务在存储锁内再次核对。`entry` 取文件名去掉
`.md`，拼出的 id 超过 160 字符时改为 `h<12 位摘要>`。记忆已不存在时回 registry `NOT_FOUND`，其余 provider
失败仍按既有边界显示为 `INTERNAL`，控制端据复读判断冲突，不依赖错误码。

`maker:remote-resources:get` 请求可选携带 `query`（同 list，最长 1000 字符，空串等同未传）。新增可移植
原语 `search`：主机只对声明 `search` 的控制端输出该块（`data.query`、`data.placeholder`），控制端仅在看到
该块后带 `query` 重读同一资源。旧控制端不声明也不传 `query`，列表页原样可用；旧主机忽略 `query`，也不
提供记忆页面，新手机显示原有升级提示。未新增 channel、relay 类型、allowlist、权限、数据库迁移或
Mobile 原生 fingerprint 输入，服务端无需改动。

任务迁移业务通道的 `move-project` action 在任务所属宿主复用项目移动校验与更新，
仅接受任务 ID 和明确的目录（null 表示移到对话）。不开放远程 sessions 原始 patch；
旧宿主拒绝未知 action，不回退到控制端本机执行。
