# 伙伴已读跨设备同步（2026-11-05，未发布）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

伙伴的远程资源（`teammates` 集合的 `bot` 行）在 `display` 中可选追加 `lastReadAt`，即电脑保存的已读时刻
（电脑时间，0 表示还没有）。带这个字段的电脑接受既有 `maker:remote-resources:invoke` 的 `read` 动作：
`resourceRef` 指向该伙伴，`input: { at }` 为设备实际显示到的消息时间；电脑校验伙伴可见性与账号代次，
读位只前进，且不晚于这台电脑上该私聊的最新消息，回包 `{ effects: [], lastReadAt }`。早期本机群
（`bot-groups`，非服务器群）同样在行上追加 `lastReadAt`，群详情追加 `supportsLocalReadSync: true`，
`read` 动作对本机群接受 `input: { at }`；服务器群的 `read`（`messageId`，转交 Chat Server）不变。
读位变化后电脑发出既有的远程资源变更推送，手机和其他电脑重读列表。
`read` 的 `input` 可选追加 `threadSessionId`：该伙伴的私聊话题 Session，电脑核对它属于这位伙伴、
未归档且是话题后，只推进 `thread:<Session>` 的读位（不晚于电脑当前时间，回包 `lastReadAt` 为话题读位），
不改主聊天读位；不属于该伙伴或已归档的话题返回 `NOT_FOUND`。手机只在读完话题时上报，话题未读点
目前只显示在伙伴所在电脑上，手机不新增话题未读界面。

手机与桌面控制端把 `lastReadAt` 与本地读位取较新者合并，看过后先记本地再上报；上报是否成功与本地读位
分开记录：没被电脑确认的读位在再次显示同一条回复时重发，桌面控制端另在每次名册读成功（含重连）后补发，
电脑已有更新的读位或不支持时丢弃。只有电脑声明了 `lastReadAt` 才发 `read`，旧电脑保持各端独立的本地读位，旧控制端忽略新字段。不新增 IPC 白名单、
帧、能力位或 relay 行为，官方与自建中转只透传既有 invoke／push，无需适配；不改服务端。电脑侧读位
按账号保存在 `owners/<账号>/bot-read-state.json`，本机窗口经仅限可信页面的
`local-db:bots:read-state:get` / `update` 与推送 `local-db:bots:read-state:changed` 读写，请求带
账号 id，账号切换中或不匹配时不写入。回归入口：`botRemoteResourceProvider.test.ts`、
`botReadStateStore.test.ts`、Renderer `botReadState.test.ts` 与 Mobile `remoteResourceCache.test.ts`。
