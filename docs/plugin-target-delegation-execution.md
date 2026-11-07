# 最小插件上传与伙伴执行接口（未发布）

本分支收敛旧凭据桥接 WIP，仅保留动态鉴权票据上传和伙伴范围委派。
扫码授权、SDK、凭据保存、飞书状态与产物业务由插件管理；不新增设置页授权端点。

## 上传

Node 在真实 cancelWithCall RPC 内捕获 bindHostServices()，调用
 authenticatedFetch({url,method:'POST',uploadDir:{token,fileField:'file',fields:{}}}, 'Bearer …')。
只消费原插件/调用的一次性票据，Host 覆盖 callId；只允许声明域名，不重定向或重放。
调用结束即中止上传，令牌不经页面、模型或日志。

## 伙伴执行

agent.delegation 依赖 tasks + targets 且需要独立批准。targets.capabilities 的 execution
仅在真实 Auto 审核接线完成后为 true。send 的 delegation.task 是业务范围，不冒充主人原话。
伙伴原权限、Ask/Plan 和显式权限上限不被提升。

受理返回稳定 executionId、原 target/taskId/requestKey。targets.get 只读取本插件请求键，
保留 pending/accepted/cancelled 投递事实。自然 settled 来源是原 inputClientId 的终态事件，
保存 instanceId/generation/outcome/outputMessageId；不能从 session idle 或最终文字推断。
恢复中的错误不结算；原输入的自动恢复终态仍关联原键。没有终态证据时保留未知，不重发。
取消不停止别人的工作，只有确认原输入已结束才返回 settled。

## 交付证据

源码及单测不代表正式版支持。0.1.120 的实际安装包不含这些新入口。
本轮未操作现有 needs_input/循环队列，未执行真实飞书闭环，未发布或替换客户端。
构建、测试及 PR 证据由本任务交付消息列出；正式版日期仍取决于上游维护者审核和发布。
