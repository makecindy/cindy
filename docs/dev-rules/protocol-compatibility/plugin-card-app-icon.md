# 插件卡片的 App 图标位（`data-ghost-icon`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

卡片净化器在 `span` / `div` 上放行 `data-ghost-icon`，值只认 `GHOST_CARD_ICONS` 登记的名字（目前是 `settings`）。
renderer 把这个位置的内容换成 App 里同名的 Lucide 图标；旧客户端会丢掉属性，照常显示插件写在里面的兜底图形。
只影响电脑端的卡片画面，不改手机投影、握手、relay、服务端或数据库。回归入口：`cardSanitizer.test.ts`。
