## 4.0.3a 只读 Agent 模型目录

设置页、panel、mainView 和电子脑均可 GET 同源 `/agent-models`（不接受参数）。
返回 `{ok:true,models:[{id,name,agent,providerId,providerName,efforts,defaultEffort,visible}]}`。
visible 跟随当前账号模型选择器；建议默认显示可见项，隐藏项由用户展开。旧 Host 缺此字段时兼容原列表。
每项为独立的模型×框架×来源；空 efforts 与 null defaultEffort 表示未声明，不得猜测。
只包含本机已连接且可用于新任务的模型，不代表远程 SSH 目录。读取不调用模型、
不触发凭证认领或上游发现，不返回凭证、账号 identity 或 endpoint；不需要新增 manifest 权限。
旧 Host 可能返回 404，插件应明确提示升级；503 时提供重试。运行前再次核验选定来源。
