# 定时任务的 Agent 运行位置（2026-10-22）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`maker:schedule:*` 读回的定时任务与写入参数新增可选 `agentDeviceId`（每次新建任务时 Agent 在哪台电脑或
分享来的供应商上运行，相对定时任务所在电脑；省略 = 本机），旧端忽略该字段。新 host 收到的写入改了
`agentKind` / `modelAgentKind` / `model` / `providerId` 却没带 `agentDeviceId` 时，把运行位置归回本机：
旧版手机端与旧版桌面远程编辑选的是任务所在电脑的目录，沿用旧位置会把那份来源派到另一台电脑。
`null` 同样表示回到本机。`cindy_scheduler` 跨电脑修改定时任务时拒绝设置 `agentDeviceId`，因为位置 id
只对定时任务所在电脑有意义。

项目自动化的 `.cindy/automations/schedules.json`（version 1）与既有 upsert 参数也保留可选
`agentDeviceId`：提升用户自动化、表单编辑和文件同步均与模型／供应商一起保存，字段删除时
清除已保存的位置。新 host 校验设备 ID 格式且要求显式模型；实际运行仍按当前账号的既有
远程／分享授权校验，不因配置文件带了设备 ID 而获得授权。旧配置省略时继续使用本机；旧客户端
不支持该字段，提升或编辑时可能丢失运行位置，远端项目自动化需使用支持此字段的客户端维护。
