# 伙伴授权卡

## 用户行为

伙伴账号连接与插件设置共用 `PluginSetupPrompt` 的内容与表单控件。伙伴采用消息内的轻卡，
普通任务保留既有浮动设置卡和阻塞调用。没有品牌图片时省略图标，不生成字母或通用图标。
伙伴的用户消息不因插件调用而追加召唤外壳；插件已有配置页和交互成果保持原有入口。

`connect_account` 只接受宿主支持的账号或实际插件身份，不接受 Agent 自报 URL、凭证或成功
状态。目前宿主连接支持 Grok；它不是 X 授权，也不改变伙伴的模型。其它服务必须有真实适配。
插件 `ghost_call` 缺配置时同样产生此卡，立即返回 `SETUP_REQUIRED`，原插件工具尚未执行。
伙伴结束当前轮；Host 收到真实就绪状态后用既有输入队列投递隐藏续接，伙伴确认连接并继续工作。

## Grok 源码对应

参照用户仓库 `zqchris/grok-bot-0.18-reconstructed`，核对版本
`a9f633e09d49a85829b8236331b9e21f7e612634`。这是行为适配，不替换 Cindy 的 OAuth 实现。

| Grok 源码 | Cindy 对应行为 |
| --- | --- |
| `source/host/runner/tools/sand-mcp-management-tools.ts` | 发卡后返回、结束当前轮，等待授权完成通知 |
| `frontend/src/recovered/features/conversation/cards/transcript-card/connector-actions.ts` | 卡片可再次操作；reopen 仅打开内存中的当前链接，retry 重新检查并发起授权 |
| `source/shared/node/mcp/mcp-auth-watch-lifecycle.ts` | 5 秒检查、15 分钟轮询期限、单次检查 30 秒；超时保留卡与重试动作 |
| `source/host/mcp-auth/mcp-auth-wait-registry.ts` | 1 小时的完成通知回退订阅；点击卡片重新登记，发卡时间不等于 OAuth 开始时间 |
| `source/host/mcp-auth/host-mcp-auth-completion.ts` | 完成事件与轮询汇聚到同一个就绪检查，取消不续接 |
| `source/host/extensions/transcript/box-handoff-resume.ts` | 经既有输入队列唤醒原伙伴，不伪造用户消息，不重放旧工具副作用 |

OAuth 回调端口、state/PKCE 校验、凭证存储、服务端有效期和网络重试继续由 Cindy 原有
`grok-oauth-login` / `ghostOauthAccounts` / `ghostOauthFlow` 负责。
Grok 的 MCP 后端 state TTL 不能直接套给 Grok 订阅登录或所有插件。

卡片记录复用 messages 的 agentMeta 与 clientId。只保存展示与目标引用；授权 URL 只在当前
流程内存中，密钥只通过已有 trusted Desktop 提交 IPC。重启后点击旧卡重新读取当前身份和
真实配置，不恢复已失效的旧 OAuth state，也不承诺退出期间仍有回调监听。

## 兼容与已有 PR

- #4058 的插件发现、能力装配、授权继承保持独立，本改动不复制其实现。伙伴默认发现 `cindy`
  入口由公共运行时提供。插件发卡、操作和续接按当前账号、安装启停与工作目录的实时
  可见性判断；内置工具集的冻结名单不作为插件 ID 的授权清单。续接前再次核对真实配置就绪。
- #4066 的发送与各 harness 工具暴露修复不在本改动重复实现。两边无新 schema 依赖，可分别合入。
- 不修改插件 manifest、安装批准记录、凭证布局或数据库 schema；不要求存量插件重新配置。
- 手机经已有消息同步显示授权状态并可取消，授权/密钥输入仍在可信电脑端。无原生指纹变更。
- SSH Agent 不因该工具获得本机凭证；请求要求可交互的本机伙伴主任务。远端 Pi 仍可发现和调用
  实际可用插件，但缺配置时不承诺聊天授权卡或完成通知；指向可信 Desktop 的插件连接页，
  用户确认配置完成后再重试。手机控制本机伙伴仍保留原授权卡与自动续接。
- 没有修改 device-link 重试、relay 或断链恢复；故障范围是单张卡。

## 完成提交边界

续接采用固定指令，不将插件显示名拼入模型消息。先以稳定 clientId 投递续接并等待现有
输入队列快照落盘，再保存卡片终态。两步间崩溃会留下可点击恢复的非终态卡；再次提交
沿用同一 clientId，由已有消息记录与输入队列去重，不重新执行已完成的 OAuth。

卡片去重以未清空、未回退的持久消息为准；内存观察器到期不失去该关系。清空后重新请求
生成新卡，观察器到期后重新请求复用旧卡，同一账号的并发请求共用一次创建。

创建卡片使用现有 expectedClearBoundaryMs CAS；边界变化即拒绝保存并退役观察器。
续接的可见性查询移入发送锁内，rewind 提交共用该锁；查询之后以同步代次检查及入队
封住 /clear 并发窗口，不在检查与入队之间让出执行。
