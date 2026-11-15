# 浏览器扩展桥接迁入宿主

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

随包浏览器扩展的本机桥接从插件自带的 Node 接线进程迁入宿主（`main/browser-extension/bridge.ts`）。
线协议 `cindy-browser-extension/3`（协议号 3、签名线合同 0.4.13、回环端口 18810–18819、
`/health` `/poll` `/ack` `/authorize` `/result` `/learning/*` `/native/bind`）逐字不变：已装的
扩展 0.3.x / 0.4.x 不用更新即可连到宿主；`/health` 的 `plugin` 字段改为声明插件的 id（Cindy
Chrome 仍是 `my-browser`）。Native Messaging 的注册文件布局（`<App Support>/Cindy/browser-native/`
与各浏览器 profile 的 `NativeMessagingHosts/<name>.json`）与插件时期相同，已配对用户升级后无需
重新配对。

宿主只在已装、启用且 v3 清单声明 `browserExtension` 的插件存在时启动桥接；旧版插件不声明，宿主
不占端口，插件自带接线进程照旧工作，用户升级宿主不会断连。插件新版声明后由宿主接线，插件停止
自带监听，交错更新期间两边都写同一份 Native Messaging 清单。管子新增上行 `browser-extension-request`
与下行事件 `browser-extension-relay`；旧宿主对未知上行类型返回错误，插件须按运行时能力探测降级到
自带接线进程，不得把拒绝当作已连接。Browser Use 的 `BackendKind` 新增 `user-browser`：旧设置文件
的 `kind` 原样读取，未知值仍回落 `external`；回退旧版本时该值被当作默认处理，不丢其它偏好。

站点名单已取消（2026-10-30）：线上的 `policy` 字段保留，宿主在 `/ack`、`/authorize` 与 `setPolicy`
应答里恒给「全部允许」，旧扩展照常解析；旧插件推送的 `setPolicy` 应答成功但不生效；宿主缓存文件
只保存配对，旧版本存下的名单读到即忽略。事件 `browser-extension-policy-request` 沿用原名，现在只
在没有配对缓存时用来索要配对。
