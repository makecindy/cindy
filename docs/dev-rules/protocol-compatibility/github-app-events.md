# GitHub App 仓库事件、自动任务与绑定

## GitHub App 精确订阅与免计次（2026-11-10，测试）

Webhook 服务的 `GET /api/v1/github` 可选返回 `prSubscriptions: true`、`dailyQuotaExempt: true`。
前者允许 `PUT /api/v1/github/repositories` 在原 `repositories` 后追加
`pullRequests: [{repository, number}]`（最多 1,000 条，每个仓库至少一条）。字段缺省保持仓库订阅；
新客户端只向声明能力的服务器发新字段，超出数量上限也回退仓库订阅。原设备事件和 ACK 帧不变。
后者仅让内置 GitHub 通知忽略普通 Webhook 次数状态；普通地址仍保留原计数和提示。
新服务兼容旧客户端，先执行追加 migration 再更新服务，最后更新客户端；回滚服务代码保留新增表和列。
回滚客户端只会扩大为原仓库订阅，不丢弃连接。官方／自建 Device Link 协议和手机原生层均无变更。
本地回归覆盖新旧能力组合、同仓库换 PR、跨区域过滤、旧 ACK 与新变化、部分接收失败后的独立重试。

## GitHub App 自动任务与绑定（2026-11-11，测试）

自动任务 `webhookTrigger.source` 增加 `{preset:"github-app",repositories:string[]}`；引擎、Desktop
表单与 `schedule_create/update` 同步支持。App 来源修改仓库／事件范围时更换本地 endpointId，旧队列
不得进入新范围。旧调用者省略 source 时原样保留；旧执行端拒绝未知来源，不静默改成普通 GitHub Webhook。
普通 Webhook 预设和地址合同保持原样，不新增 Device Link 帧、白名单或自建中转依赖。

服务状态增补 `automationSubscriptions:true` 与支持的 `events`，客户端仅向声明能力的服务提交
`repositorySubscriptions`（必须是 repositories 子集）。整仓库订阅可没有 pullRequests；其余精确仓库
仍须有 PR 编号。旧服务不支持任意任务 App 来源，但继续支持既有 PR 跟进；旧客户端忽略新能力。
可选 `deliveryHealthy:false` 使新版客户端恢复原定时读取频率；缺省保持旧服务行为。

新连接用 `POST /api/v1/github/connect` 提交客户端 state、SHA256 codeChallenge 和仅限字面
127.0.0.1 随机端口的 redirectUri。公开回调只把 GitHub code 返回该端口，不绑定身份、不提供 code 轮询。
原客户端再带本区账号、相同设备及 verifier 请求 `/connect/complete`，成功才保存绑定并返回安装页。
新增 migration 仅追加 nullable 列；已有绑定及投递不变。未发布的旧测试客户端发起新连接会收到
`GITHUB_CLIENT_UPGRADE_REQUIRED`，须更新后重试；不能回退至仅凭 state 的绑定。
新客户端在打开浏览器前也核对返回的授权 state 与 S256；不支持客户端绑定的旧测试服务
返回 `GITHUB_CLIENT_BINDING_UNSUPPORTED`，应升级测试服务，不能把旧流程当成连接成功。
升级顺序为两区 migration、服务、客户端；回滚保留新列及既有连接，但不应重新开放旧绑定流程。
