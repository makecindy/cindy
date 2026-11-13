# 插件网络与凭证能力的性能边界

本 PR 叠加在 #9825，只覆盖第 23 项网络扩展与第 25 项凭证委派。
文件、终端、存储和服务目录的性能证据仍以 [#9825 自查](plugin-platform-services.md) 为准。

| 热点 | 未使用时的开销 | 启用后的上限 | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| 启动与注册 | 网络服务构造空 map/set；不建立 socket、timer、扫描或后台进程。地址纯导出只复用既有 net-policy，不导入 undici；存在静态模块求值。 | 首次实际请求才打开连接。 | `networkConnections.ts` 构造/`create()`，`networkOriginPolicy.ts`，`browser-control-runtime/src/shim/network-address.ts`。 | 无新增启动 IO 或资源创建；整客户端冷启动未实测，不声称绝对零分配。 |
| 每次 host.call | 与 #9825 相比 `hostToolSlot`、宿主 provider 查找和公共授权层无改动。网络不用该入口增加分支。 | 沿用原 receipt 实时读取。 | 相对 base 的 `hostToolSlot.ts` / `taskCapability.ts` 无 diff；网络另走既有 fetch 及私有网络消息。 | 不在工具调用热路径加入缓存、await 或安装扫描。 |
| 请求传输检查 | 没有请求不执行；只在已有安装校验/实际请求路径使用同步地址判断。 | 每跳与 WS 握手先用既有规范化/云元数据判据检查字面量，再按原协议规则返回；无 await、DNS、缓存或 timer。 | `networkSlot.test.ts` 的 metadata 初始/重定向/WS 拒绝和普通私网/link-local 可用矩阵；`GhostManager.test.ts` 的真实检查/安装/更新拒绝及旧批准保留。 | 云元数据字面量不因 TLS 放行，其他私网范围不变；不外推整客户端 CPU/RSS。 |
| 凭证注入 | 非命中来源不读凭证；普通密钥仍只作原单次 vault 读取，非标记时不解析引用。 | 凭证只走 HTTPS/WSS；引用每次复核精确来源/目标 owner、安装与声明，不枚举全部插件。 | `networkSlot.test.ts` 的 origin transport、ordinary-key 短路与撤回用例；`ghostSavedCredentials.test.ts`。 | HTTP/WS 的匹配凭证在读取原始值前拒绝，无明文例外。 |
| 流式 HTTP / WS | 没有连接不建 timer/socket；仅保留空容器。 | HTTP 在途、WS 凭证准备与连接共享每插件 4 个名额；每连接 1 MiB/256 事件 ring；read 最多 128 KiB、等待最多 20 秒、最多 4 个等待者；闲置 5 分钟关闭。 | `networkConnections.ts` 的 `create/append/handle/touch`；`networkSlot.test.ts` 的 `shared fourth slot` 与 `WS reservation`（缺凭证、撤回、插件/owner 取消、真实连接准备失败），以及缓冲缺口/到期用例。 | WS 等待前同步预占，失败 finally 释放，成功同步交给连接计数；无队列或新定时器。接收为有界丢旧 ring，resetRequired 明说缺口。 |
| WS 背压 | 未连接不执行。 | 握手 30 秒、禁压缩、接收单帧 64 KiB；发送在 bufferedAmount 超过 1 MiB 时拒绝，最多再容纳一个 64 KiB 消息。 | `networkConnections.ts:openWebSocket/handle`，生产帧与撤回回归。 | 有界缓冲，不队列重发，不自动重连。 |
| Node 私有桥 | 未发网络请求不分配 pending、timer 或请求计数。 | 8 个 pending；序列化最多 2 Mi JSON 字符；普通操作 60 秒，fetch 传输兜底 360 秒，实际普通/媒体网络超时仍为原 30/120 秒及 60/300 秒上限。 | `nodeHostServicesClient.test.ts` 最大帧、90 秒媒体回执及兜底；`nodeRuntimeBroker.test.ts` 网络请求计入活跃工作矩阵。 | 超限发送前拒绝；等待网络时不空闲杀 Worker，结算后恢复原回收。 |
| 凭证目录 UI | 未声明相应凭证的详情组件同步返回，不挂 controls effect 或 IPC；声明后沿用原目录读取，成功读取且无来源、无已有引用时不渲染分组或整个区块；读取失败保留原错误提示与刷新。 | 打开/启停/显式刷新才列可选来源；启停以 React key 重建原控件，沿用卸载清理丢弃旧回执；一次用户选择走原生确认和变更锁，迟到结果按 owner 丢弃；停用后已有引用仍可停止使用。 | `GhostAccountReuseSection.tsx`，`GhostPluginDetailSections.test.tsx` 的 empty/available/in-use、启用与停用旧回执、失败后刷新、选择、撤回及 owner 切换用例。 | 只增加渲染前的数组过滤与启停时重建，不新增状态、锁、订阅、轮询或后台同步；普通密钥不新增引用扫描。 |
| 共享存储与服务注册 | 相对 base 无新增 provider、KV 扫描或消费者订阅；凭证仍由原 vault/connection 管理。 | 引用只存原 vault 的派生键；显式普通密钥替换/删除多一次精确派生键清除，不增加读取、扫描或普通注入开销。 | `ghostSavedCredentials.ts`、`ghostOauthAccounts.ts`、`ghostSecretsEndpoint.ts`；`clears delegated access`、旧值读取与失败写入回归。 | 不引入通用凭证体系或跨调用授权缓存；普通写入禁止保留标记，撤回不恢复旧引用。 |
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
