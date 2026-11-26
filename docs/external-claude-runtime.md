# 本机独立 Claude Code 运行时（实验性）

Desktop 可为一个原生 Anthropic 订阅账号选择外部 Claude Code 程序。未配置时沿用受管程序；公司 API 网关和远程执行不使用此运行配置。当前没有新增 UI 配置入口。

## 配置与账号登记

运行配置位于本实例 `userData/external-claude-runtime.json`，不得放在仓库、项目目录或远程请求中。它不含凭据：

```json
{
  "schema": 1,
  "enabled": true,
  "accountId": "cindy-111111111111-22222222-2222-2222-2222-222222222222",
  "executablePath": "C:/external-claude/claude.exe",
  "configDir": "C:/external-claude/profile",
  "env": {
    "HTTP_PROXY": "http://127.0.0.1:17890",
    "HTTPS_PROXY": "http://127.0.0.1:17890",
    "ALL_PROXY": "http://127.0.0.1:17890",
    "NO_PROXY": "localhost,127.0.0.1,::1",
    "BROWSER": "C:/external-claude/browser.exe",
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "preflight": {
    "command": "C:/external-claude/preflight.exe",
    "args": [],
    "timeoutMs": 30000
  }
}
```

示例账号 ID 不能直接用于真实账号。采用现有 `subscription-accounts` 的 owner-scoped ID 和 placement 规则登记一个独立 provider；对应的持久账号记录必须带 `externalRuntime: "external-claude"`。配置匹配但账号未登记会被拒绝。优先新增账号和 provider，不重定向已有 `default`，避免历史会话切换凭据目录。

只有匹配的账号读取 `configDir`。普通账号目录、公司网关认证与其他引擎保持原路径。凭据由未修改的 Claude CLI 自己读取和刷新，不复制进配置文件、Renderer 或数据库。

## 启动与失败行为

- 登录、状态、用量、模型探测和实际会话共用相同运行配置。Windows 要求原生可执行文件，不能把 `.lnk` 或 `.cmd` 当作 binaryPath。
- 每次启动前运行有超时与取消支持的 preflight。它必须自行验证所要求的系统网络规则和出口，非零退出则拒绝本次启动。配置不能包含认证、上游覆盖、TLS 信任或任意进程环境字段。
- 网络环境在进程环境与最高优先级的 CLI settings 中固定；模型会话继续使用现有工作区认证覆盖检查。
- 已标记账号的配置缺失、禁用、损坏或不匹配时拒绝，不回落到受管 CLI。已经解析的外部目录也保留拒绝回退的见证，覆盖异步启动期间的配置变化；该见证不能授予授权。
- SDK Query 的重建重新执行 preflight，意外的同代额外 spawn 被拒绝。账号归属检查、停止和既有进程清理仍由原生命周期负责。
- 外部配置选择 `default` 时，无账号 capability 的本机订阅调用会被拒绝，要求显式选择已登记账号；公司网关与远程路径不读取这一限制。

账号要求是持久元数据，不能通过删除运行配置来“恢复默认”。卸载时应先停止该 provider 的会话，再通过原账号/provider管理删除或解绑它，保留其 profile 和历史资料。旧版客户端不理解该字段，不能用旧版同时读写实验实例的数据目录。

## 验证边界

自动化测试使用合成账号、假 CLI、临时目录和本地传输，不使用用户已登录的 profile 做故障注入。真实账号联调需要单独告知用户：即使只读取登录态或模型清单，也会启动真实 CLI，可能触发初始化或凭据刷新。

preflight 和进程环境不是完整网络沙箱。主程序的系统出站规则不会自动覆盖任意子进程、恶意本机转发或管理员改动；不得将这些测试描述为封号风险为零或任何环境下绝无旁路。
