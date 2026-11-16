# 公共插件分享（未发布首版）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

`shareBaseUrl` 是端点清单的可选字段；缺失/空值关闭分享素材准备，不猜测域名。旧客户端忽略字段，既有市场和安装协议不变。公开 DTO `PublicPluginPresentation` v1 由两仓的 `packages/plugin-protocol` 同步维护，不含包或安装批准。

`plugin-market:prepare-share` 接受可选 `ShareOptions {includeAttribution:boolean}`，省略时匿名。Main 向构建区域固定 Share Server `POST /api/shares`，请求 `{kind:'plugin',reference,includeAttribution,region,lang,authRealm?}`。CN/Dev 是 cn/zh-CN，Global 是 global/en；Auth 权威区域随当前身份冻结，可以与构建区域不同。只有署名创建携带当前用户 Access Token，固定账号代次；仅遇到明确的 TOKEN_EXPIRED 时复用登录续期并重试一次，续期前后及请求前复核原身份，不降为匿名。匿名请求无凭证。Renderer 不持有 token、不指定用户或上游服务。

Share Server 以独立 PostgreSQL 库唯一保存分享关系；返回既有素材字段及 `shareId`、`includeAttribution`。Main 校验随机分享编号、固定同源且无查询参数的 `/s/:shareId` 与署名方式。区域语言仍由创建请求明确携带并存入记录。转发同一编号保留原署名；开关或重新分享选择另一条绑定，不修改既有记录。链接不含 source、内部身份、版本、包或批准；请求结果在切账号/资源后丢弃。

落地页、二维码和图片使用同一无参 `/s/:shareId`，资源、署名、区域和默认语言以服务器记录为准；页面显式切换语言时，合法 `lang` 仅覆盖当前页面、JSON、SVG 的展示语言，向插件服务透传，不改写原记录或创建新编号。每次检查当前公开上架及可交付资格，显示当前公开版本；作者原文保留。当前昵称头像通过 Auth 实时读取，不可用则隐藏，不把已署名绑定降为匿名。生成时身份验证失败返回错误，可重试或另选匿名分享；资料查询不可用时隐藏署名展示，不改变原署名绑定，不复用错误身份。

Share Server 在创建时保存已验签的分享者 `membershipId` 与身份权威。Auth 只读现有账号资料，不增加分享字段、记录、索引或 migration；公开资料接口使用 shareId，在固定 Share Server 回查有效分享与身份绑定后读取当前资料。分享服务端已独立提供该能力，客户端沿用现有认证与固定分享入口，不引入额外 Auth 写入或凭证存储。公开资料新增可选的内嵌栅格 `icon` 字段，两仓协议同步；缺失或无效时使用默认图标，旧服务与旧客户端均兼容。

方形 SVG 为 1080×1080，Desktop PNG 为 2160×2160，接收界限 1 MiB。素材用于人工复制/保存；网页只展示与承接，不提供发送面板工具。`cindy://plugin/:pluginId` 仍只导航，拒绝 query/fragment/安装参数，沿冷启动、登录恢复、兼容包选择和原安装批准。通用市场详情入口接受服务端解析后的当前区域 ID，再与当前可见目录核对身份及发布；新旧 ID 映射仍归 Plugin Server，分享层不新增转换。已有目录 ID 的请求仍严格绑定原条目，不能借规范化跳到其他插件。不扩 device-link 或 Mobile 能力，没有“我的分享”、移除已发署名、分享统计、转发链、平台 SDK 或资料快照。

本版分享接收限于插件页选择本机且目录正常的情况；不承接远程电脑的分享导航或断线恢复，不自动切换所选电脑。组织目录不可用时继续遵守未下发条目不读取详情的既有限制；历史或跨区域公开编号的解析也可能被该限制拒绝，本版不新增解析入口或放宽访问边界。
