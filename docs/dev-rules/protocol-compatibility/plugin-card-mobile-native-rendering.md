# 插件卡片的手机原生呈现（`plugin-card-rich`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

## 任务导航的旧端降级（2026-11-08，未发布）

卡片 button 可同时声明 `data-ghost-action` 和可选 `data-ghost-session-link`，后者只接受
导航专用 `cindy://session/<id>`，不得与输入、提交或选模动作混用。Desktop 在插件获准
`card.externalLinks` 时只接原生任务导航；旧宿主丢弃新属性，仍派发原动作。插件负责
将降级动作处理为展示正文任务链接，不能据此启动、停止或移交任务。
Mobile 读取 `plugin-results` 时追加 `plugin-card-session-links` primitive；新宿主只对
声明了它的读者将该按钮投影成已有的 url action，其他手机保留普通 action。新版手机
连接旧宿主时也走普通动作。没有新增消息类型、权限、握手、IPC 白名单或服务端接口；
官方及自建中转仍透传既有 remote-resource 请求，不需要中转升级。
回归入口：`cardSanitizer.test.ts`、`cardRemoteResource.test.ts`、`embeddedSessionNavigation.test.tsx`。

## 原生状态与控件投影

手机读取 `plugin-results` 卡片时在 `client.primitives` 里多声明 `plugin-card-rich`。只有声明了的手机，宿主才在
`plugin-card-actions` 的 `data` 里附带：动作的 `primary` / `toggle`、`live` 状态名、`prStatus`，以及归档任务按钮的 `taskArchive`（见[「PR 状态的合并就绪字段」](pr-status-merge-readiness.md)）。`prStatus`
包含状态位、插件快照，并在能查到时附上与标题栏同源的 `PrStatusResult`。这些部分的文字同时移出文本块。
指向本任务某个 GitHub PR 页面的链接动作，能查到状态时再带可选 `prState`（`open` / `draft` / `merged` / `closed`），
手机据此在卡片标题前画 App 自己的 PR 状态图标；查不到就不带，手机按中性图标显示，旧手机忽略该字段。
带名字的按钮里面的文字不进文本块；手机把文本块首行画成卡片标题，链接与标题同名时点标题打开链接。
旧手机不声明，照旧收纯文字投影；新手机连旧宿主时收不到这些字段，回到纯文字和普通按钮。
文本块对声明了 `card.externalLinks` 的插件不再插入链接地址，这对新旧手机一致，链接仍作为可点的动作下发。
ghost_call 结果新增可选布尔 `xdt_card_turn_end`（MCP 层与手机工具投影同步放行）。手机据此把卡片排到本轮回复之后；
旧手机忽略。不改握手、relay、服务端或数据库。回归入口：`cardRemoteResource.test.ts`、`messageRender.test.ts`、
`pluginCardActions.test.tsx`。
