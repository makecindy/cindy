# Slack MCP 工具参数别名（#8762）

`slack_call_tool` 使用可选的 `args` 传入所选工具的参数，保留 `arguments` 作为旧调用别名；
两者都提供时使用已校验的 `args`，显式空对象也优先，非法参数仍由 MCP schema 拒绝。
两者都省略时保持无参调用。桥接层继续发送 `{ name, arguments }`，不改变服务端协议。
旧调用可直接使用新客户端；修复 `args` 丢失需要升级执行工具的客户端，无需服务端配套升级。
工具定义在启动时固定，不在会话中途重排，也不改变 Slack 身份、账号访问检查或审批规则。

实现与真实 MCP 入口回归：[Slack 网关](../../../packages/lizi-mcps/src/cindy_slackMcpServer.ts)、
[网关测试](../../../packages/lizi-mcps/src/__tests__/cindy_slackMcpServer.test.ts)。
