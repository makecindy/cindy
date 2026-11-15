# 设置入口与目标电脑

`get_settings_link` 从桌面设置页共用的 `maker-shared/settings-tabs` 生成
`cindy://settings-link/<page>?device=<deviceId>`，可带 `query`（设置搜索）和 `section`
（已有设置搜索项）。链接只表示导航，不提交配置、凭证或业务操作；未知页、重复参数、
额外命令和缺失设备均拒绝。设置链接不能证明账号已连接或原任务已完成。

桌面聊天渲染可点击引用并标出目标电脑，同机进入原生设置页，异机向目标发送
`maker:settings:navigate`，目标重新验证自己的 deviceId 后经既有 deep-link 队列打开页面。
返回 `{ok:true,deviceId}` 只确认导航请求已排入目标界面，不确认配置或登录完成。
控制端收到匹配回执才打开既有远程桌面；手机复用同一顺序。请求不重试、不自动修改配置。
设置搜索 query 交给原搜索索引，未命中会展示无结果，不推断不存在的连接器。

新 channel 为 append-only，仅桌面 Electron 注册；同账号设备沿用 Device Link
原有权限与通道 allowlist，不加入共享访客或供应商分享白名单，不改变 relay 帧。
自建中转透明转发既有 invoke/result，无新 kind、鉴权或握手字段，无需同步服务端。
旧目标或无桌面 Host 不支持此 channel 时显示不可用，不在控制端打开同名本地设置。
新链接使用独立的 settings-link 路径，避免旧桌面把带 device 的 providers 链接误开成本机设置。旧查看端不认识新链接时可能只显示文字或无法打开；须升级查看端。旧的不带 device 的
providers / builtin-tools / im-bot 深链保持原行为，不据此宣称它们已支持跨设备导航。

手机当前通过远程画面操作桌面设置，不把整个桌面设置伪装成手机原生表单。
插件缺少或失效的授权先用已发现的真实插件身份调用 `connect_account`，直接展示已有
原生卡片中的连接按钮；只有宿主报告没有支持的配置动作时，才退回设置链接或插件已声明
的登录方式。不用普通消息按钮模拟授权，不猜测 Slack 等服务是否已安装或可连接。
桌面、手机及远程端复用各自已有的原生授权入口和能力限制；点击后是否完成仍以宿主回执
为准，其完成和原任务恢复由原授权流程负责。
通用设置导航不新增自动续跑或“已设置完成”状态。

实现：`packages/maker-shared/src/settingsNavigation.ts`、Desktop
`main/settingsNavigationIpc.ts`、`renderer/components/chat/SettingsLinkChip.tsx`、Mobile
`src/session/SettingsLinkSpan.tsx`。回归覆盖共享解析与回执、Helper 实际工具、Main IPC、
preload 冷热启动、桌面引用导航和手机点击。真实跨设备远程画面需单独验收。
