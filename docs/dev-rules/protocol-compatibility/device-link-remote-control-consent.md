# 请求开启远程控制（2026-11-10，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

新增同账号 `push` channel `device-link:remote-control-consent`，沿现有加密／签名消息通道，
不依赖 `link-open` 或远控开关。payload 为 `{version:1,kind:"request",id,purpose,ttlMs}`
或 `{version:1,kind:"result",id,result}`。请求 ID 为随机 UUID，目的最长 500 字符。`ttlMs` 是发送方声明的相对寿命（正数，接收端取其与 45 秒的较小值），
接收端按本机时钟计时，不使用发送方的绝对时间戳，因此不受两台电脑时差影响；缺少数字 `ttlMs`
的请求帧会被丢弃。
接收端仅接受在线、非手机、非撤权、非跨账号设备；本机原生确认框明确说明开启持续有效的
远控设置。弹窗必须挂到本机主窗口（macOS 无父窗口时不响应取消）；主窗口不可用则失败，
不退回无父窗口弹窗。用途和设备名称移除控制／方向字符、压成单行，最多显示 200 字符。
过期结算独立于原生弹窗回调，关闭弹窗并释放接收位，不等用户再点击。远端消息不能代替
点击确认，写入在原设置写锁内再次验证请求仍有效。设置生效通过本机
`device-link:control-enabled-changed` 通知设置页；初次读取的旧快照不能覆盖新通知。

请求不执行工作、不授予单次文件权限，也不修改普通 invoke/link-open 的门禁。每台电脑
同时只显示一个确认框，同一来源一分钟内不重复弹窗；重复 ID 丢弃。断线、退出或切换账号
取消当前等待；迟到、过期、不同来源的回执不恢复任务。工具最多等 47 秒，返回 enabled、
declined、expired、busy、failed、unavailable 或 no_response；只有 enabled 可继续原操作。
无响应不能断言是旧版，需同时考虑不可达；不自动重复授权请求。

旧客户端忽略新增 push，不开启设置；新客户端最终返回 no_response。官方和已部署自建中转
均透传既有 push，CONTROL_KINDS 的 link-open/invoke 门禁不变，无需升级中转或修改服务端。
共享客户端新增关闭链路后的此 channel 透传项，未扩大 invoke allowlist。手机任务的 Agent
运行在 Desktop 时使用该电脑的同一工具入口；本次不在手机添加原生授权框，目标限电脑。
验证覆盖共享客户端、relay 单测，以及真实自建中转加入／签名／重连；互通中确认远控关闭时
请求 push 可送达，而同目标普通 invoke 仍报 REMOTE_DISABLED。实际账号跨电脑和各平台原生
窗口效果需另行验收，不能把本地互通当作线上发布。
