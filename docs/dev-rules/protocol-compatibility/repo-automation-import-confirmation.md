# 仓库自动任务导入确认（2026-11-01）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

同账号 invoke 新增 `maker:project-automation:pending-imports`，返回已知项目目录的待导入配置。
既有 `reconcile` 参数可选追加 `approvedHash`，返回值可选追加 `pendingImport`；未提供匹配当前
文件内容的 hash 时只预览，不创建、修改或删除自动任务。推送新增 `import-required` 分支，
原 `reconciled` 分支不变。旧控制端不会确认新宿主的导入，须在新版 Desktop 查看确认；
新控制端连接旧宿主时发现接口不可用，不伪造待导入内容，旧宿主仍保持旧版行为，安全修复须升级执行电脑。
Mobile 暂无此确认界面；已保存任务及 Agent 工具的授权流程不变。无数据库迁移或新增持久授权记录。
官方及自建中转沿用通用 invoke／push 转发，没有帧、鉴权或重连协议变化，无需修改中转内核。
