# 设置中的引擎更新准备

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Desktop 新增本机 `update-harness-prepare` IPC（Claude Code/Codex、用户看到的目标版本），
只供可信应用顶层 renderer 在重启确认前准备下载，不暴露到 device-link allowlist。
原 `update-harness-relaunch` 追加可选 `preparedVersion`：宿主只接受本轮准备成功的目标，
下次启动只消费缓存，避免确认期间清单变化又触发启动下载。省略参数的旧设置入口仍写
原 scoped 修复标记，回复保持兼容。应用更新 IPC、手机与设备间 wire protocol 不变；后台归档只放新缓存目录，旧客户端
忽略它，不改变原安装目录、凭证、数据库或持久偏好。
