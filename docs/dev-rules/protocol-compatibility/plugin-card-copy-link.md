# 插件卡片的复制链接按钮（`data-ghost-copy-link`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

卡片净化器只在没有 `data-ghost-action`、`data-ghost-link`、`data-ghost-task-archive` 的 `button` 上放行
`data-ghost-copy-link`，值只认整串 http/https 链接（`isGhostCardCopyLinkAllowed`），任务链接和任意文字都丢属性，
插件不能借它往用户剪贴板写命令。插件把按钮写成 `display:none`；电脑端 renderer 认得属性时把它露成 `inline-flex`，
按钮名换成 App 的「复制链接」，点击由宿主写剪贴板并提示，不派发 card-action。旧客户端丢掉属性，按钮保持隐藏。
手机投影只收动作和外链，这颗按钮不下发，手机暂无复制入口；不改握手、relay、服务端或数据库，自建中转无需升级。
回归入口：`cardSanitizer.test.ts`、`MailCardEditor.test.tsx`。
