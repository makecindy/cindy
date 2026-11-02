# 插件伙伴委派范围

最新实现与调用入口见 [最小接口](plugin-target-delegation-execution.md)。
本分支不包含旧 Node 凭据保存、saveMethods/settingsMethod 或设置页授权端点。
持久收据复用原 plugin_task_requests JSON payload，无数据库 schema migration。
存量插件省略 delegation 时权限、请求摘要、回执格式及批准不变；历史未知字段原样保留，
不会因新增校验停用，但也不会从旧批准推导新权限。

插件基座变更仍需白名单维护者明确 Approve 后方可合并。
