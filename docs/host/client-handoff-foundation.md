# 后台 Host 与窗口交接地基

本层用于显式启用的开发者 Host 模式。普通 Desktop 未设置 `CINDY_HOST_API` 时，仍在
Electron 内执行任务，使用原桌面装配；不自动启动 Host、不迁移 profile、不更换更新器。
`client-migration.json` 与健康响应的 `clientHandoffReady` 保持 `false`。本层可测试窗口交接，
不代表 Host 已具备完整桌面功能，也不允许据此开启整机迁移。

## 生命周期与平台执行

- `dev-with-host` 启动或复用由 profile 管理的后台 Host。窗口或启动终端退出不停止 Host；
  停止后台仍使用已有 Host stop 命令。活着但无法验证的 Host 不会被自动替换。
- 客户端按 Host instance ID 和 profile API token 连接，地址复用不能把旧请求发到新 Host。
- 平台 WebSocket 只接收经认证的本机原生客户端，绑定账号、客户端 ID 和 PID。
  电脑控制与内嵌浏览器操作由带系统授权的窗口进程执行；后台保存任务执行状态。
- 交接先暂停新平台调用并检查在途操作、输入占用与活跃 webview。不能释放时拒绝交接，
  旧窗口可恢复。只有尚未派发的请求能等候新窗口；已经派发但断线的输入返回结果不确定，
  不自动重放。取消和账号变化会解除等待或拒绝旧结果。
- 浏览器显式切换或恢复通过原客户端释放监听、调试器和 recipe 会话，释放完成后重建执行器；
  普通传输重连保留原执行器。清理只发给曾执行该后端调用的客户端，不等待替代窗口。
- 任务关闭只清理由原客户端实际执行过的电脑会话，不排队等待替代窗口，也不清理替代窗口的会话。
  账号运行时关闭先结束平台连接，再等待任务关闭钩子，防止断连时关闭流程挂起。
- 浏览器设置的八个 `browser-backend:*` 通道在显式客户端模式下转交 Host 的同一浏览器执行器；
  保留可信 Renderer 校验，不开放 Web shim 的特权设置入口。
- 侧栏页签主体保留在 `localDb/ipc/rightSidebarTabs.ts`，`.desktop.ts` 仅装配 Electron。
  桌面 IPC 与 Host API 注入各自数据库和事件出口。
  页签记录可恢复不代表活跃网页内存可恢复，因此有活跃 webview 时仍拒绝换窗。

## 自动验证与边界

`pnpm --filter @cindy/host test` 覆盖后台身份核验、真实 loopback RPC、冻结、取消、断线、
账号隔离以及未派发请求恢复。桌面相关 Vitest 验证原电脑控制、浏览器设置、权限引导和
账号恢复行为；两端类型检查均须运行。

`apps/host/scripts/client-handoff-native.e2e.mjs` 是独立的进程级交接验收，不替代
`codex-runtime.e2e.mjs` 中已合入的发送、插话和附件验收。它使用临时 profile、假凭证和
本机模拟上游，要求显式传入 `CINDY_TEST_AGENT_BINARY`；可选 `CINDY_TEST_AGENT` 选择
已支持的原生引擎。测试实际替换客户端进程，断言任务继续、文件副作用仅一次、确认请求
在新客户端恢复且仅处理一次。GUI、Chromium、安装包等可选模式必须分别报告结果。

首次迁移、profile 写入权切换、旧客户端恢复和个人版升级命令不属于本次地基。
真实账号、真实模型服务、正式安装包、Windows、手机及整机迁移未实测时不能宣称通过。

## 尚未接通的客户端界面通道

本层的平台 RPC 是后台调用原生能力的入口，不等于已接通所有 Renderer IPC。
`maker:computer:*` 十个通道、`maker:browser:open-for-login`、`maker:browser:status`、
`update-relaunch:blocking-activity`、`update-relaunch:blocking-summary` 共十四个通道
仍仅在 `registerMakerIpcsAfterSplash` 中注册；显式客户端模式跳过该函数，因此均不可用。
普通 Desktop 仍注册原处理器。Host 通道覆盖工作需另行接线并验证，不能据此开启整机迁移。

插件扩展 relay 保留“发送返回 false 后唤醒失败”的 `PLUGIN_UNAVAILABLE` 与 warn；
发送本身抛错才返回 `PLUGIN_DELIVERY_UNKNOWN`，不重放。等待中账号变化会用旧 bridge
回 `BRIDGE_STOPPED` 结束请求，不转给新账号。能力 slot 的变更仍需维护者明确审查放行。

## 平台生命周期收敛判据

- 每代浏览器释放后，该代未派发请求永不执行，晚到结果也不能恢复该代；
  已派发副作用不重放。普通传输重连仅恢复仍存活的代次。
- 每代取消状态只由其 `AbortController` 持有，显式 dispose 先取消，再走同一个
  `cleanupSession`；gate 独占等候集合、在途计数和实际执行客户端记录。
  Desktop 独占原生后端，等待释放完成才重建。账号关闭先关平台桥，再排空请求。
- CI 安装工具的临时文件 rename 失败是外部安装故障，不与浏览器生命周期混修。

| 事件 | 等候客户端 | 已派发 | 已完成 | 已释放 |
| --- | --- | --- | --- | --- |
| attach / resume | 活代次派发一次 | 不重放 | 无影响 | 不得派发 |
| dispose / 账号关闭 | 取消并移出队列 | 取消等待；原执行器清理 | 清理原执行器 | 幂等 |
| resolve / reject | 不适用 | 复查取消、owner 和客户端；拒绝晚到结果 | 无重复结算 | 不恢复代次 |
| 断线 / 重连 | 活代次可等候；释放代次不可等候 | 结果不确定，不重放 | 保留浏览器状态 | 不恢复代次 |
| 切换 / 恢复 | 取消旧代，后续操作属于新代 | 原生释放完成后重建 | 只清理实际执行器 | 不误清替代窗口 |

对称检查覆盖 call 与 probe、未连接与冻结、释放与 bridge close、取消后 wake、
取消后 resolve/reject、重复释放及替代窗口。回归通过生产 gate 和 Host controller，
故障输入是上一轮会在 attach 后执行的已释放代次请求；不扩大迁移范围。
