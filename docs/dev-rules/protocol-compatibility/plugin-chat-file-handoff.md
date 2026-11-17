# 插件对话文件交接（`handoff:`）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

工具参数表把 `cindy_handoff_files` 声明为数组（`{"type":"array"}`）才启用，同名的其它形态参数不受影响；未声明的工具与旧插件行为逐字不变（非媒体仍报改用 dir）。
插件收到 `args.cindy_handoff_files`，`upload` 增加三选一的 `handoff` 来源，失败码 `HANDOFF_UNAVAILABLE`；
用到它的插件需声明 `minCindyVersion: 0.1.122-beta`，旧宿主不认识该参数。
卡片记录的 `cindy/attachments` 新增 `handoff:<uuid>` 资源链接，字段沿用标准 `resource_link`，不新增
device-link 操作、字段或白名单。远程打开在执行端判定：新执行端把 `handoff:` 视为执行电脑文件，
新旧查看端都收到既有的 `MCP_APP_FILES_LOCAL_ONLY` 提示；Mobile 自带的同名检查同步认 `handoff:`。
执行端回退到旧版时不认识该前缀，不签发地址也不读字节，页面只看到名称与大小。
不可用的 `handoff:` 链接（附件列表、入参或结果中）只去掉地址、View 照常打开；Library／媒体链接仍严格拒绝，行为不变。
确认卡新增 lane `handoff`；旧版 Desktop 远程控制端不认识该 lane 不显示卡片，执行端按超时拒绝，
不放行。设置页列表与删除只走本机 IPC（`ghosts:handoff-list` / `ghosts:handoff-delete`）。
回归入口：`handoffStore.test.ts`、`ghostWorkdirGate.test.ts`、`networkSlot.test.ts`、`pluginServer.test.ts`、
`viewAuthorization.test.ts`、Mobile `mcpAppCard.test.tsx`，以及 `mcp-apps-sandbox.verify.mjs --handoff`。
