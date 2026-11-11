/**
 * 已下线的智能通讯录电脑间同步通道（功能已迁为 `cindy-contacts` 插件，插件同步走
 * `pluginSyncProtocol.ts`）。旧版 Cindy 仍可能发来该通道的帧，接收端直接丢弃；
 * 通道名保留，不得复用给新功能。
 */
export const RETIRED_CONTACTS_SYNC_CHANNEL = "device-link:contacts:sync:v1";
