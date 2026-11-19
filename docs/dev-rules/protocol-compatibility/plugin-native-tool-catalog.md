# 原生工具目录宿主入口

`cindy_helper` 增量提供 `get_session_tool_catalog` / `set_session_tool_catalog`，
Agent 与插件复用同一 registry。插件沿现有 `control` 组、整体安装批准和真实调用身份进入，
不新增 manifest、receipt、IPC channel、授权存储或补批。添加 MCP 另外复用原 `node` 安装声明。

请求传明确本机任务、原生方法和参数；仅操作已有运行实例。Claude SDK 与 Pi ExtensionAPI
运行时探测，不支持的引擎／方法明确返回 `UNSUPPORTED_CAPABILITY`。Codex 复用已有
thread-scoped MCP 读取，可选透传 `inputSchema`，旧消费方可忽略该增量字段。
不回传 MCP 配置与凭据；添加仅接 HTTP/SSE，不启动继承 harness 环境的 stdio 进程。

没有调用时不查询目录、不发 RPC／IPC、不装逐工具监听。Pi 复用原有受 nonce 绑定的
bridge command 请求和回执，沿原超时／finally 清理，不新增通道、缓存、监听、队列或持久化。
配置效果由原生引擎持有，不在 Cindy 构造多插件合并、自动回滚或重放。

只在 Desktop 本机装配；Node Host、SSH 和跨电脑调用没有实现时明确不支持。
不改变 device-link wire payload；没有新跨端能力，自建中转无需同步适配。
旧宿主缺工具时插件按不支持处理，存量插件原批准和运行保持。

作者接口与支持表见[随包手册](../../../apps/desktop/resources/system-skills/cindy-plugin-creator/references/plugin-native-tool-catalog.md)。
