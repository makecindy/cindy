/**
 * @cindy/device-link —— 跨设备远程控制(同账号设备互联)的协议层 + WS 客户端。
 *
 * 三部分:
 *  - protocol: envelope 协议 / 错误码 / payload 类型(desktop 双端共享;
 *    server 持有最小路由子集,见 apps/server/src/device-link/protocol.ts)
 *  - allowlist: 远程 IPC 隧道的 channel 白名单(默认拒绝制)
 *  - client: DeviceLinkClient(重连 / 心跳 / 请求配对状态机)
 */
export * from './protocol.js';
export * from './allowlist.js';
// mobile 经此引用 channel 常量:apps/mobile 不能直接依赖 @cindy/cindy-ipc
// (动 apps/mobile/package.json 依赖会改 runtime fingerprint 触发冷更),
// 而 device-link 已是 mobile 的既有依赖,借道 re-export 指纹中性。
export { IPC_CHANNELS } from '@cindy/cindy-ipc';
export * from './client.js';
export * from './transport.js';
export * from './topics.js';
export * from './attachmentOssRef.js';
export * from './contactsSyncProtocol.js';
