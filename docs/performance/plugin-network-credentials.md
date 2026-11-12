# 插件网络与凭证能力的性能边界

本 PR 叠加在 #9825，只覆盖第 23 项网络扩展与第 25 项凭证委派。
文件、终端、存储和服务目录的性能证据仍以 [#9825 自查](plugin-platform-services.md) 为准。

| 热点 | 未使用时的开销 | 启用后的上限 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| 启动与注册 | 网络服务构造空 map/set；不建立 socket、timer、扫描或后台进程。地址纯导出只复用既有 net-policy，不导入 undici；存在静态模块求值。 | 首次实际请求才打开连接。 | `networkConnections.ts` 构造/`create()`，`networkOriginPolicy.ts`，`browser-control-runtime/src/shim/network-address.ts`。 | 无新增启动 IO 或资源创建；整客户端冷启动未实测，不声称绝对零分配。 |
| 每次 host.call | 与 #9825 相比 `hostToolSlot`、宿主 provider 查找和公共授权层无改动。网络不用该入口增加分支。 | 沿用原 receipt 实时读取。 | 相对 base 的 `hostToolSlot.ts` / `taskCapability.ts` 无 diff；网络另走既有 fetch 及私有网络消息。 | 不在工具调用热路径加入缓存、await 或安装扫描。 |
| 请求传输检查 | 没有请求不执行；HTTPS/WSS 同步返回，不调用地址分类器。 | 每个 HTTP 明文跳、每个 WS 握手做一次同步地址分类，不查 DNS、不建缓存、timer 或状态机。 | `networkSlot.test.ts` 的 plaintext 初始/重定向矩阵和 WS 矩阵；`ghostNetworkTransportRejection()`。 | 公网与普通主机名明文直接拒绝；WS 不跟随重定向。 |
| 凭证注入 | 非命中来源不读凭证；普通密钥仍只作原单次 vault 读取，非标记时不解析引用。 | 凭证只走 HTTPS/WSS；引用每次复核精确来源/目标 owner、安装与声明，不枚举全部插件。 | `networkSlot.test.ts` 的 origin transport、ordinary-key 短路与撤回用例；`ghostSavedCredentials.test.ts`。 | HTTP/WS 的匹配凭证在读取原始值前拒绝，无明文例外。 |
| 流式 HTTP / WS | 没有连接不建 timer/socket；仅保留空容器。 | 每插件 4 条连接，每连接 1 MiB/256 事件 ring；read 最多 128 KiB、等待最多 20 秒、最多 4 个等待者；闲置 5 分钟关闭。 | `networkConnections.ts` 的 `create/append/handle/touch`；`networkSlot.test.ts` 缓冲缺口和到期回收用例。 | 接收是有界丢旧 ring，不向传输层暂停读取；缺口明确 resetRequired，不能当作无损流。 |
| WS 背压 | 未连接不执行。 | 握手 30 秒、禁压缩、接收单帧 64 KiB；发送在 bufferedAmount 超过 1 MiB 时拒绝，最多再容纳一个 64 KiB 消息。 | `networkConnections.ts:openWebSocket/handle`，生产帧与撤回回归。 | 有界缓冲，不队列重发，不自动重连。 |
| Node 私有桥 | 未发网络请求不分配 pending、timer 或请求计数。 | 8 个 pending；序列化最多 2 Mi JSON 字符；普通操作 60 秒，fetch 传输兜底 360 秒，实际普通/媒体网络超时仍为原 30/120 秒及 60/300 秒上限。 | `nodeHostServicesClient.test.ts` 最大帧、90 秒媒体回执及兜底；`nodeRuntimeBroker.test.ts` 网络请求计入活跃工作矩阵。 | 超限发送前拒绝；等待网络时不空闲杀 Worker，结算后恢复原回收。 |
| 凭证目录 UI | 未声明相应凭证的详情组件同步返回，不挂 controls effect 或 IPC；组件仍在详情页懒加载块。 | 打开/显式刷新才列可选来源；一次用户选择走原生确认和变更锁，迟到结果按 owner 丢弃。 | `GhostAccountReuseSection.tsx`，`GhostPluginDetailSections.test.tsx` 的选择、撤回及 owner 切换用例。 | 无常驻订阅、轮询或后台同步。普通密钥不新增引用扫描。 |
| 共享存储与服务注册 | 相对 base 无新增 provider、KV 扫描或消费者订阅；凭证仍由原 vault/connection 管理。 | 引用只存原 vault 的派生键，不另建数据存储或授权账本。 | `ghostSavedCredentials.ts`、`ghostOauthAccounts.ts`，普通密钥/来源撤回回归。 | 不引入通用凭证体系或跨调用授权缓存。 |
| 常驻资源和 Device Link | 无连接不建新计时器；不新增跨设备轮询、Device Link 帧或确认流。 | 每活跃网络连接有闲置 timer，长读有短期 timer；停用、owner/安装变化和 Host 退出关闭。 | `disposeGhost/disposeAll` 和取消、撤回用例；device-link packages 相对 base 无 diff。 | 不对整客户端空闲 CPU/RSS 作实测结论；跨设备继续沿用原协议预算。 |
| renderer bundle | 账号复用 UI 保留原详情页懒加载位置。 | 没有新 renderer entry 或后台服务。 | 历史 [A/B 脚本](plugin-platform-services-renderer.mjs) 与 [数据](plugin-platform-services-renderer.json)。 | 数字来自拆分前 fa54 基线，不能代表本 PR 相对 #9825 的增量；当前 delta 未实测。 |

安全与兼容：声明的早拦截在 Desktop/Host 共用的 GhostManager 安装、更新和随包批准入口；
强制边界在每次实际请求与每一跳。协议解析保持零运行依赖，renderer/Mobile 不做地址分类。
内网若使用普通主机名，必须改用 HTTPS；明文连接不能使用 Host 注入的自备密钥或引用凭证。
这不改变旧域名的 HTTPS:443、原 OAuth 账号、旧 receipt、安装布局或普通 Node 绑定。

验证：运行时规则先复现 12 个失败，修正后网络/OAuth 两文件 173 项通过（1.87 秒）；
安装/更新原有 342 项与新增 7 项共 349 项通过（已有单文件 10.38 秒，含真实 ZIP/文件 IO）。
新增安装规则用例独立筛选 6 项 1.74 秒，批准失败另单独复现；没有新建测试文件或真实等待。
真实 TLS、第三方 OAuth/PAT 与跨平台原生输入未进行人工端到端验证。
