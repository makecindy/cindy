# 插件工具执行过程旁听

`subscribe.topics` 增量识别 `tool-execution`，旧 topic 语义保持；整包安装批准有效且启用后按声明分发，
不新增组批准、receipt 或逐次确认。旧客户端保留未知主题但不投递；服务端现有 manifest 校验保留
合法事件标识字符串（已核对本地服务端 plugin-protocol），无需同步修改服务端枚举或发版。

Desktop Host 从现有 Session AgentEvent 投影 `did-tool-execution`，Node Host 的独立 turn executor 尚未接线。data 为
`{sessionId,eventType,source?,payload,truncated?}`。事件类型仅 tool_use/tool_result/tool_result_full/
agent_task_update/error；不向旧 message 或 activity 主题混入内容，不伪造原生 progress。
投影经敏感文本脱敏与有界复制，零订阅时不读载荷、不投影、不唤醒或新增 IPC。

已运行插件也使用原 100 条缓冲和微任务边界，复用 seq/dropped，超限丢最旧；
发出前按原 owner、安装批准版本、启用状态与声明复核。旧缓冲不可继承给替代安装。
不新增 Device Link channel、relay kind、远程订阅或持久事件库，自建中转无需适配。
存量插件影响：无，无需安装或数据迁移。新能力通过原安装能力清单如实展示。

行为验证：subscriptionGateway 的零订阅、异步顺序、有界截断、热观察者背压及换版丢弃；
shared/ghost 的能力说明及旧主题兼容；plugin-protocol 的 manifest/forward-compat 测试。
作者契约见随包 plugin-tool-observation.md，明确三引擎未进入共享流的原始中间帧限制。
