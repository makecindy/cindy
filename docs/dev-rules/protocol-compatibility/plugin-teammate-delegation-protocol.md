# 插件伙伴委派协议与回执（未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`targets.resolve` 增量接受 `{session:sessionId}`，与原 `{target:{kind,id}}` 互斥；返回同样的目标元数据。普通可用任务返回 task，伙伴唯一 canonical 主对话返回 bot 与伙伴 ID，其他伙伴会话返回 TARGET_UNAVAILABLE。旧调用、批准与持久数据不变；旧 Host 不支持新参数时返回 INVALID_PARAMS，不应自动改投其他目标。仅复用本机插件管子，无 device-link、官方或自建 relay 改动。

agent.delegation 为可选独立能力，依赖 tasks + targets，只有 Host 确认的
delegationCapabilityApproved 才授予；历史未知字段、旧 tasks/targets 批准不推断新授权。
缺省不改变旧权限项、批准、配置或回执摘要；已安装的历史字段保留，不因新校验停用。
新包严格校验声明，旧 receipt 缺少新可选字段照常读取。无需 schema migration。

targets.capabilities 新增只读协议发现；delegation.version=1 与 execution 就绪状态分开。
执行端接入现有 Auto 审核后才报告 execution=true；未就绪时显式 delegation 请求在预留/投递前返回
UNSUPPORTED_CAPABILITY；不得降级为普通消息或另建任务。旧 Host 无入口时不发送。
委派只允许 bot + queue，scope 最多 8000 字符并参与请求摘要，持久回执保存版本、
执行范围及原目标/批准事实。取消、撤权、换批准版本和恢复排队沿原接口复核。
执行保持真实来源并使用既有 Auto 审核；不提升伙伴权限，不包含业务插件。
作者契约见 cindy-plugin-creator/references/plugin-agent-tasks.md §4.11.7。

Node 私有上传只接受 POST + uploadDir，短期 Bearer 不进入页面管道。旧 Host 无入口则不上传；不保存新凭据，不新增设置页授权协议。
targets.get 按本插件 requestKey 查询原收据；settled 自然终态由原 inputClientId 的运行事件持久记录，取消另须确认原队列/执行结束。不开放伙伴历史。
