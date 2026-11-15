# 普通个人的社区插件贡献

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

已安装清单可选追加只读 `publishingSource`，由 Host 既有实例记录、批准回执与安装台账重建。
它仅用于个人提审入口的来源准入，不改变列表的来源展示、安装来源、自动更新或发布权限。
缺失或无法核实来源时不开放提审；本地安装和公开安装都不会因提审或过审自动转换来源，不新增持久化关联记录。

新增独立 `/api/plugin-contributions` 和精确 `plugin-contributions:*` IPC，不改企业发布、
旧公开市场 DTO 或 device-link allowlist。两仓分别维护等价
[HTTP / DTO 契约](../../plugin-community-contribution-contract.md)。客户端使用当前个人 Access Token，
以可信 auth discovery 的 issuer 与 token sub 核对所有作者响应主体；`cn/global` 只用于选择 Host 配置，
不能当作 issuer。服务器仍做验签和 public 提交 ACL，包内作者声明不授予提交权。

prepare / PUT / commit 复用同一固定包和持久幂等键；202 仅表示处理。结果不明先查原操作；
不换包、不换键自动新建发布操作。receipt 的 uploadedPackage SHA 与实际 releaseRevision SHA 分开，
`outcome`、修订审核与市场 `available` 分开。处理历史以独立 eventId 分页，旧修订不套用当前修订结果。
Host 持久操作按账号隔离、异步结果按 owner generation 拦截；审核结果通过用户打开、刷新、前台恢复及前台定时读取同步。
本地 `review-updates` / `mark-review-read` IPC 仅供可信桌面 Renderer，不加入 device-link 白名单。
提示点复用现有作者列表和精确修订的审核记录，Main 只额外保存按账号隔离的本机已读标记；
不新增服务端通知/已读 API，不改变审核事实，不因列表查询或 AI 查询而清除提示。
旧服务器未实现接口时如实显示读取/发布失败，不试探企业或 Platform 身份，也不伪造空列表或成功。
存量插件安装、批准记录、启用状态、包格式和市场来源枚举均保持原契约；本能力需要两端更新。
