## 9. 兼容性与常见拒装原因

插件开发不应受当前客户端能力注册进度限制。未知顶层能力、对象扩展字段、能力动作
与订阅事件保留为声明，不因此阻断发布或安装，也不因此获得执行权限。
插件必须检查所需接口是否存在并处理不支持响应：可选功能局部降级，必要能力缺失时
提示升级，不影响其它可用功能；权限拒绝、账号失效和网络错误不能当作不支持绕过。
`minCindyVersion` 是兼容声明与分发依据，不是运行时能力探测；手动安装、旧版
或其它分发渠道仍可能让不适配客户端安装插件，不能省略上述兼容处理。
旧客户端已有拒装逻辑无法追改；整体协议格式变化仍受 schemaVersion 校验。

- `id` 不合法(大写/下划线/超长)· 声明了 command 但没有 tools · command 与已装插件撞名
  · **未声明 command**:不拒装,但插件页"使用"按钮禁用,用户无法通过插件页一键启用
    或用 $command 点名;AI 工具调用不受影响(见 §2 说明)
- `tools` 为空 · panel 详单缺少实际形态(既没有 html，也不是有效的 tab/停靠配置)
- mainView.html 文件缺失/路径不安全、icon 不在系统图标白名单、open 不是 page / sidebar /
  window、side 不是四条边之一或在 open 非 sidebar 时声明、multiple 不是字面量 true
- settingsHtml 路径不合法/文件不在包里 · settingsHeight 越界(160–800)或没配 settingsHtml 单独声明
- panel.systemButtons 格式错(不是对象、已知键的值非布尔,或 position:"tab" 时声明——插件页内面板没有标准头)
- keywords(已废弃字段,旧包兼容保留,新插件别写)有单字词 · kind 写了但不是 "chip"(可省略) · schemaVersion 不是 3 · 缺 minCindyVersion
- cindy 详单格式错(已知类目的动作不是合法标识、空数组或重复动作)
- agent 详单格式错(background / errand / schedule 存在但不是 true；基础点击触发请写 `agent: {}`)
  · `hiddenTasks` 不是布尔值,或写了 `hiddenTasks: true` 却没有 `tasks: true`
- node 详单格式错(entry 不是包内 CommonJS .js/.cjs、protocol 不在 json-rpc-stdio / mcp-stdio、
  resident 又写 idleTimeoutSeconds)；未知 command/args/shell/env 只保留，不传给进程启动器
- id 用了 `cindy-` 前缀(平台保留,正式版用户通道拒装)。`filo-` / `xd-` 只是普通名称，不授予官方资格
- ghost.json 声明了 namespace(包括 null)。namespace 由可信交付及 Host 安装事实决定，作者不能自报
- 企业发布遵循当前服务端准入。S1 或 S2 尚未开启时仍保留旧认领和前缀命名流程，不能把收到 namespace 当作自由命名已开放
- network 详单格式错(hosts 缺失/裸 TLD/IP/带端口/通配不在最左、secret 缺 inject、
  inject.format 没有 {value} 占位、inject.header 用了 Host/Cookie 等协议关键头、
  inject.hosts 不是 hosts 声明条目的子集、
  secret.source 不是 "user"/"login-email"/"oauth"/"gh-cli"/"oidc-token"、
  source:"login-email" 或 source:"oidc-token" 声明了 url 或 exchange、
  source:"gh-cli" 不是官方 cindy-github、注入形态不是 api.github.com 的
  Authorization Bearer、或声明了 exchange、
  声明了 user 凭证但没声明 settingsHtml、遗留 input 字段值不是 "ghost")
- exchange 声明格式错(url 非 https/域名不在 hosts 白名单、bodyFormat 不是恰含一个
  {value}、contentType 不在白名单、tokenPath 不是点分路径、ttlSeconds 越界)
- oauth 声明格式错(source:"oauth" 缺 oauth 详单或反之、与 exchange 同时声明(互斥)、
  authorizeUrl/tokenUrl 非 https 或域名不在 hosts 白名单、scopes 条目含空白/重复、
  extraAuthorizeParams 覆写保留参数(client_id/redirect_uri/state/code_challenge 等)、
  redirectPort 不是 1024–65535 整数、tokenBroker 没同时声明 redirectPort 或与 clientSecret 同时声明、
  clientIdAlternatives 没与 clientId + tokenBroker 成套或包含重复/非法 ID、
  当前安装来源或组织身份无权使用 tokenBroker、brokerBounce 没和 tokenBroker +
  redirectPort 成套声明或路径不是 / 开头的站内绝对路径)
- connections 声明格式错(超 2 条、key 撞 secrets 的 key 或声明内重复、label 缺失/超 64 字、
  inject 缺失/format 没有 {value}/header 用了协议关键头、**声明了 inject.hosts**(连接
  凭证恒只注入对应连接自身地址,不接受收窄/扩张)、maxConnections 不是 1–8 整数、
  声明了 connections 但没声明 settingsHtml(没人收地址和 token)、hosts 与 connections
  双双缺席(静态域名与动态连接至少有其一))
