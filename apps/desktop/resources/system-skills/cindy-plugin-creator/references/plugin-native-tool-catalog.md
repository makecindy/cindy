# 原生工具目录

通过既有 `agent.hostTools: ["control"]` 和 `cindy.host.call('cindy_helper', …)` 调用。
插件须显式传本机 `session_id`，可按下文参数直接调用 `get_session_tool_catalog` 或
`set_session_tool_catalog`。如插件也已声明并获准使用 `agent.hostTools` 的 `discovery` 组，
可先调用 `cindy.host.call('cindy_helper', 'host_services', {})`，在 `control` 服务的
`tools` 中查看方法是否可用。`list_tools` 是 Agent 的 MCP 入口，插件应使用上述入口。
宿主不启动任务，不添加原生 Pi 扩展或自建工具执行器。

## 引擎支持

| 原生方法 | Claude Code | Codex | Pi |
| --- | --- | --- | --- |
| `readMcpServerTools` | 指定服务的名称、说明和连接状态 | 指定服务的名称、说明、原生 `inputSchema` 和状态 | 不支持 |
| `mcpServerStatus` | 原生状态与工具元数据，不返回连接配置 | 不支持 | 不支持 |
| `getAllTools` / `getActiveTools` | 不支持 | 不支持 | 原生工具元数据／当前 active 名称；元数据含 `parameters`，不含扩展文件路径与函数 |
| `setMcpServers` | SDK 动态 MCP 完整集合替换 | 不支持 | 不支持 |
| `setActiveTools` | 不支持 | 不支持 | 原样调用；未知、hidden 工具及 codemode 的行为由 Pi 决定 |
| `registerMcpServer` / `unregisterMcpServer` | 不支持 | 不支持 | 原生注册／移除；同名归属、覆盖和连接由 Pi 决定 |

方法按运行中的原生 API 探测。缺少方法、桥命令或适用运行环境时返回不支持，不模拟实现。
仅在 Desktop 本机装配，不支持 SSH 或远程供应商。新增原生方法不向访客或 Review 隔离环境开放；
`readMcpServerTools` 沿既有 Session 只读查询的可用范围，不为该读取另加隔离规则。
Codex 创建期 `dynamicTools` 没有在此开放；不提供在途改表或第二套执行器。
Claude 的状态接口没有承诺工具参数 schema，不能把名称和说明当成完整 schema。

## 读取与修改

```js
const reply = await cindy.host.call('cindy_helper', 'get_session_tool_catalog', {
  session_id: selectedSessionId,
  method: 'getAllTools' // Pi；Claude 用 mcpServerStatus
});
// 返回原始 MCP 结果；先检查 isError / 文本 JSON 的 ok。
// 成功 JSON: {ok:true, session_id, engine, method, result:<原生结果>}

await cindy.host.call('cindy_helper', 'set_session_tool_catalog', {
  session_id: selectedSessionId, method: 'setActiveTools', args: [['read', 'bash']]
});
```

`get_session_tool_catalog` 的 `readMcpServerTools` 另需 `server_name`。
`set_session_tool_catalog.args` 是原生位置参数数组，不是跨引擎配置模型。
Pi `setActiveTools` 返回原生实际 active 集合。注册／移除 MCP 的 `result:null` 仅表示方法已执行，
不证明异步连接完成；读取目录确认实际工具。调用错误或回执未确认时先核对原生目录，不自动重放修改。
Pi 还需其运行环境已有 MCP 消费扩展；原生 API 能接受注册不等于扩展已加载。
例如原有 `--no-extensions` 实例不会自动连出 MCP 工具。本入口不替任务改变原扩展加载规则，
不自动装配 `.cindy` 包内的 Pi 原生扩展。

添加 MCP 仅支持整体安装已批准、已启用并声明 `node` 的插件提供的 HTTP/SSE 配置。
不接受 `command`、`args`、`env`、`cwd` 或 SDK `instance`；不在 harness 的环境里代起 stdio 进程。
需要 stdio 时，插件在自己已有的 Node 工作进程中起服务，再通过 HTTP 接入。
凭据由插件自己的服务管理；查询不会返回原生 MCP 的配置、headers 或宿主凭据。

```js
// Pi：使用公开 ExtensionAPI 的原生配置。
await cindy.host.call('cindy_helper', 'set_session_tool_catalog', {
  session_id: selectedSessionId, method: 'registerMcpServer',
  args: ['plugin_business', { url: pluginServiceUrl }]
});
// Claude：args[0] 是完整替换集合，省略 SDK 服务可能将其移除。
// 原生 settings / plugin 自有服务是否保留，以 SDK 原生规则为准。
await cindy.host.call('cindy_helper', 'set_session_tool_catalog', {
  session_id: selectedSessionId, method: 'setMcpServers',
  args: [{ plugin_business: { type: 'http', url: pluginServiceUrl } }]
});
```

修改是对目标引擎运行状态的一次显式操作；不写 Cindy 偏好、不为插件另存目录、合并多插件配置、
冻结选择或自动回滚。后一次操作的效果由原生引擎决定，进程重建后不由宿主重放。
插件停用不会回滚已完成的运行配置修改；插件自己的 Node 服务沿原生命周期停止，
引擎连接和工具状态由引擎管理。显示／隐藏不等于批准／撤权，工具执行仍过原有权限链。
改变工具声明可能影响模型缓存；没有调用目录工具时，不查询、序列化目录或发送桥接消息。

动态业务动作继续在插件自己的 `list_tools` / `call_tool` 中二级分派；宿主不另建目录状态机。
