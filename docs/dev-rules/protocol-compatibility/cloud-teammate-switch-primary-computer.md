# 云端伙伴：从任意电脑更换主力电脑

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

2026-11-23（#12112）：`maker:companion-cloud:caps` 的 `companionCloud` 升至 5，表示接收端能原文恢复正文超过 64 KiB 的导入技能。
向能力版本低于 5 的目标交出前，源电脑先按旧接收端规则检查本地技能正文的 UTF-8 字节数。
同步期间每轮上传前复核该轮快照，涵盖同步中途的编辑。发现超限就返回 `SKILL_TARGET_OUTDATED`，伙伴继续在源电脑运行。
回包可带首个超限技能的 `oversizedSkill: { slug, bodyBytes }`。桌面和手机展示技能名、实际正文字节数，提示更新目标电脑后重试；只有错误码时仍能提示升级。
保留历史 `TARGET_OUTDATED` 的通用语义；旧发起方不认识新码时沿既有路径显示一般失败，不改变交接结果。
小技能仍可迁往旧版，不能用整个文件大小误拒含大 frontmatter 的技能；已上传且未变化的技能同样检查。
已因该限制卡在目标电脑的伙伴，目标升级后沿现有自动接管重试恢复，不改云端归属或清理原数据。
旧源电脑交出，或旧目标在源电脑不可达时自行接管，均无法执行这项交接前检查。恢复后要迁回旧源电脑，也需先升级那台电脑。
不新增 channel、参数、帧、服务端接口或持久化字段；官方与自建中转继续透传既有能力回包，
Mobile 仍通过既有换主力流程发起请求，不改原生指纹。

2026-11-21：发起方读主力电脑版本时，`maker:companion-cloud:caps` 的请求与回包不变，只改本机对「没有回包」的解读：
设备列表显示主力电脑在线时按白名单判定：只有主力电脑回包里的版本（≥ 1），或主力电脑分发层答复的 `CHANNEL_NOT_ALLOWED`
且正文正是分发层对未知通道的原话 `channel 'maker:companion-cloud:caps' not allowed remotely`（旧版没有该通道；路由层同码的
`Encrypted transport required` 等不算）、`REMOTE_DISABLED`、`ACCESS_REVOKED`（后两项也认经中转 / 设备目录发布的同一状态）算明确答复，
后者仍记为版本 0、照旧直接接管；其余一律「不可确认」——超时、链路未就绪、`DEVICE_OFFLINE`、本机抛出的
`CHANNEL_NOT_ALLOWED`、没有错误码的异常、不认识或新增的错误码、没带版本的回包——放宽等待重试一次，仍不可确认
则给本机界面 `HOME_UNRESPONSIVE`，不自动接管。为区分「对端答复的错误」与「本机 / 中转抛出的错误」，这条探测直接读
`remoteInvoke` 的回包（保留错误正文），不经把两者合并成 `[CODE]` 文本的 `invokeDeviceValue`。只有完整且新鲜的设备目录
（非 partial、非 stale）里主力电脑那一行说离线时不探测、照旧直接接管；目录读取失败、过期、不完整或缺行都按主力电脑 ID 探测。
不新增错误码，不改变发给对端的内容。`HOME_UNRESPONSIVE` 与 `CompanionSwitchOptions.force` / `forceHomeDeviceId`
只在同一 Desktop 的 `:home-choices` / `:switch-home` 本机 IPC 中使用；`maker:companion-cloud:hand-over` 仍只转发
`whenBusy`，`force` 不进 device-link，也不进远程交出的选项解析。不新增 channel、帧或服务端接口，手机与旧版对端不受影响。

2026-11-08：`maker:companion-cloud:caps` 的 `companionCloud` 升至 4，表示接收端能运行伙伴 V2（伙伴 = 项目）。
V2 主力电脑只交给声明 ≥ 4 的目标，低于 4 返回 `TARGET_OUTDATED`（旧发起方不认识该码，按 `FAILED` 显示）；
`maker:companion-cloud:targets` 的条目新增可选 `outdated: true`（版本 1–3 的电脑仍列出、不可选），旧发起方忽略。
新增偏好键 `companion.project-rules.v1`（`{ content }`）与 `companion.automation.v1:<configId>`（`{ config, paused, originDeviceId? }`），
只由新版主力电脑上传；旧客户端的上传器不拥有这些键（不墓碑、不播种），接管时只认识自己列出的前缀，未知键忽略。
2026-11-09 追加 `companion.project-carryover.v1`（`{ content }`，项目的 `CARRYOVER.md`），同样只由新版主力电脑上传、旧客户端忽略。
记忆仍用 `companion.memory.v1:<文件>`，值格式不变，内容改为读 V2 项目记忆。不新增 channel、帧或服务端接口，
官方与自建中转透传既有回包；手机不改原生指纹。规则见 [云端伙伴](../../product-rules/cloud-companions.md) §2.1。

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
旧客户端不认识这些键，接管时忽略。（2026-11-08 起 V2 不再上传 todo／routine 键，见[「伙伴 V1 其余远程入口退役」](teammate-v1-remote-entry-retirement.md)。）镜像上传的房间消息可带 `media` 块；旧客户端按文件名显示。手机端同样不改原生指纹。
