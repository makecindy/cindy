# 插件与伙伴包的十语资源（2026-10-31）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

客户端接受 `zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-PT / pt-BR` 的
插件 manifest 资源与推荐词条。旧清单无需补字段，英文回退、权限判据和批准记录不变。
`app-context` 与 `host-context-changed` 可选新增 `uiLocale`；旧字段 `locale`
仍仅返回 zh-CN / en / ja / ko，其他语言固定返回 en。新插件读取
`uiLocale ?? locale`，旧插件无需重装或重新授权；缺少资源仍回退英文。
伙伴包新增的五种拉丁语系译文同样可选，旧五语包仍可导入；切换语言只影响展示与新导入快照，
不会重写用户已有伙伴资料、例行任务授权或回执指纹。
官方插件仓发布门禁、官方 Telegram 菜单和 SkillHub 内容语言属于独立仓库，未在本次修改或验证。
没有 Device Link channel、relay、allowlist 或自建中转协议变更。
