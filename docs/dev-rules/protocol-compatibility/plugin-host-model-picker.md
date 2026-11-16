# 插件宿主模型选择器（新增接口，尚未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`PluginPagePoll` 新增可选 `modelPickers`，Host 绑定原插件安装与页面，手机及远程桌面
设置页使用执行电脑的统一模型目录，只把用户确认的完整 route 通过原页面回传。
远程设置的密封命令增量为 `answer-model-picker`；原有命令、权限、安装批准与账号凭证合同不变。
未更新的控制端忽略可选字段，Host 在 90 秒后取消；新插件检查 `cindy.pickModel` 是否存在，
不把目录读取或选模当成执行授权。两端都更新后才具备原生选模回执，不需要服务端变更。
新增 Renderer IPC 仅本机宿主使用，不进入 device-link 通用 invoke/push 白名单；跨设备
复用既有插件页面资源与密封设置链。正文详见 [插件规则](../plugin-security-and-authoring.md#宿主统一模型选择器新增接口尚未发布)。

模型选择成功配置与 `will-start-task` 路由新增可选 `agentDeviceId`，省略维持旧本机配置。
选择请求新增可选 `allowRemote`，仅显式 true 时列远程/分享来源并接受远程答案，已有调用方默认保持本机。
新 Host 在 `/agent-models` 无参响应声明 `supportsRemoteRoutes:true`，路由插件仅在有此标志时
允许保存/回传远程来源；旧控制端无法识别带来源的答案时拒绝，不静默丢字段。
手机原生插件页与远程 Desktop 设置控制端在既有 `open:<surface>` / `settings:open` 的 input
可选声明 `modelPickerRemoteSources:true`；Host 将能力绑定到该页面租约。只有实际支持来源选择
与回传的控制端才声明；旧 Host 忽略该字段，旧控制端缺省为不支持。带 `agentDeviceId` 的 initial
在投递前要求此能力，否则以既有 `UNAVAILABLE` 返回升级提示，避免旧控制端去掉来源后把本机
同名模型当成用户确认。新版控制端仍可显式选回本机；不带远程初值的旧本机选模行为不变。
手机与远程设置页沿现有请求/回执携带来源，不新增 channel、权限或中转帧；自建中转仍按原
通用 payload 转发，无需同步修改。来源授权在执行端用既有供应商目录和创建任务校验重验。
