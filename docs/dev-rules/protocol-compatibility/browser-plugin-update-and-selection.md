# 浏览器插件更新与选择状态（2026-11-07）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`BrowserBackendHealthReason` 和 Browser Use `status.data.reason` 增加可选状态
`plugin-updating`、`plugin-selection-required`，分别说明插件更新进行中、控制端需要用户选择。
旧宿主仍返回原有 `plugin-missing`；新版设置页同时检查插件能力声明，避免把支持页面控制的插件
误报为旧版本。旧查看端遇到新原因按原有通用错误回退，不新增 IPC、权限或写入入口。
扩展桥接更新暂停期间，新作业返回 `BRIDGE_UPDATING` 和 `execution:not_executed`；已接受作业
继续沿用原有结果／超时和 `unknown` 语义，不新增重放行为，不要求浏览器扩展升级。
