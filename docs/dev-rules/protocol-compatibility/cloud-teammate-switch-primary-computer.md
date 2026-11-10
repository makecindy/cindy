# 云端伙伴：从任意电脑更换主力电脑

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-11-06：修复版将既有 `maker:companion-cloud:caps` 的 `companionCloud` 声明升至 3，
表示接收端已能读取伙伴大内容存储。交出方仍要求目标 ≥ 3 才允许交出仅存于该存储的值；
目标 < 3、服务器未提供存储或上传不完整时仍拒绝交出并保留原主力电脑。0.1.127 虽已实现读取，
但仍声明 2，因而会被按旧接收端处理。小内容交出、远程发起交出的 ≥ 2 门槛保持不变。
不新增 channel、参数、帧或服务端接口，官方和自建中转均透传既有能力回包；手机仍只负责发起，
不充当资料接收电脑，不改 Mobile 原生指纹。

`maker:companion-cloud:caps` 的 `companionCloud` 从 1 升到 2，新增两个同账号 device-link channel：只读的
`maker:companion-cloud:targets`（主力电脑视角下可接手的电脑）与写入的 `maker:companion-cloud:hand-over`
（`[botId, targetDeviceId, options?]`，在主力电脑上走原有交出流程；`options.whenBusy` 为 `wait` / `stop`，老主力电脑忽略；隧道超时 7 分钟），以及合并 Cindy 的 `maker:companion-cloud:merge`（`[keepBotId, fromBotIds]`，只在本机运行保留的 Cindy 时执行，隧道超时 10 分钟）和合并前请来源 Cindy 的主力电脑先同步的 `maker:companion-cloud:flush`（`[botId]`，只在本机是它的主力电脑时执行、不改主力电脑，忙碌时 `BUSY`，隧道超时 7 分钟；版本 < 2 或连不上的主力电脑不请求，合并按云端已有内容进行）。接手方仍只要求版本 ≥ 1，
所以新旧电脑之间照常能互相交出；发起方读到主力电脑版本 < 2 时不提供远程更换，提示先更新那台电脑，
不退回成直接改服务器上的主力电脑。旧发起方不知道新 channel，行为不变。两个 channel 不进共享任务访客白名单，
不改 relay 帧、服务端 schema 或 Mobile 指纹。本机 IPC `maker:companion-cloud:transfer` / `:devices` 换成
`:switch-home` / `:home-choices`，并新增 `:attachment`、`:cindy-copies`、`:merge-cindy` 与 `maker:companion-avatar:resolve`，只在同一个 Desktop 内的 preload 与 Main 之间使用。
伙伴资料快照 `companion.profile.v1` 新增可选的 `templateId`；新增偏好键 `companion.todo.v1:<id>`、`companion.routine.v1:<id>`、`companion.workbench.v1`，
旧客户端不认识这些键，接管时忽略。镜像上传的房间消息可带 `media` 块；旧客户端按文件名显示。手机端同样不改原生指纹。
