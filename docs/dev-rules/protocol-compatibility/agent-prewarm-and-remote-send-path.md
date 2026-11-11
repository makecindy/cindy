# Agent 预热与远程发送路径

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增 invoke `maker:session:prewarm(sessionId, createOpts)`，Desktop 本机 Renderer 与 device-link
控制端共用，登记在 `REMOTE_INVOKE_ALLOWLIST` 并归入后台调度档；共享任务访客不在其准入表内。
控制端在已有任务的输入框里开始输入（打字、粘贴、开始语音输入）时调用（同一任务 30 秒最多一次；模型、深度、权限、引擎、目录等设置变了立即再请求一次），`createOpts` 与下一次发送
构造的相同；被控端立即回 `{ accepted }`，在同一把会话发送锁里复用发送路径的懒创建启动 Agent，
执行字段（agentKind、model、resume、provider、权限、Agent 所在电脑）照常按数据库校正。只对来源为
user / desktop / plugin / side-chat、状态 active、非协同、Agent 在本机且非 SSH 工作区的任务生效（不要求已发送过：启动加载目录自带的设置与钩子与随后的发送相同，预热只是把时间提前）；
已有运行时、待切换引擎、已有排队输入时不做任何事。预热出来、尚未发送使用的运行时最多 2 个，
10 分钟未发送即关闭；设置变更关掉了它时，下一次请求会重新启动；任何真实发送会接管它。旧被控端返回 CHANNEL_NOT_ALLOWED，控制端静默忽略，
下一次发送照常冷启动；旧控制端不调用，行为不变。

Desktop 新建页的未发送任务：本机普通项目 / 对话草稿开始输入时，任务先建出来（`local-db:sessions:create`
带 `provisional: true`，只接受本机普通任务），出现在本机任务列表、标题随输入变化，并按上面的规则预热；
清空输入经本机专用的 `maker:session:discard-provisional` 真正删除（仍未发送且无消息才删），第一次发送前经
`maker:session:commit-provisional` 转为普通任务（发送路径也会兜底转正）。这两个 channel 不进
`REMOTE_INVOKE_ALLOWLIST`。未发送期间不推给控制端：device-link 读任务列表时过滤掉、`sessions:created` /
`sessions:patched` 不经 tap 转发，IM 项目列表与 hook 最近任务也不列出；项目 git 初始化、插件「已创建」事件与
控制端创建通知延后到转正时补做。登记表在内存里，并写一份到 userData 下的 `provisional-sessions.json`，
没删掉的残留在下次启动、账号库就绪时清理；不加数据库列，旧版本只会把残留看成普通的未发送任务。

`maker:input:enqueue` 与 `maker:input:get-projection` 的 wire 不变。Mobile 已从同一被控端的
projection 见过 `inputDeliveryVersion: 1`、并从 projection / enqueue 回包得知该任务的
`clearBoundaryMs` 时，首次发送跳过发送前的 projection，直接带该边界 enqueue；被控端仍按原规则
校验，若以 `REMOTE_OPTIMISTIC_INPUT_CLEARED` 拒绝，Mobile 撤回本地准备并按原流程查询一次
projection 后重发（被控端拒绝时尚未收下，不产生重复）。旧被控端不回 `inputDeliveryVersion`，
Mobile 始终走原流程。Mobile 学到的这些结论绑定 device-link 连接代次，重连后清空并重新确认。
没有新的 push、数据库迁移或 Mobile 原生指纹变化。
