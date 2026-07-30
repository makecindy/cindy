/**
 * @cindy/mcps
 *
 * Reusable MCP server factories plus provider helpers. Hosts inject their own
 * auth, storage, media, and transport adapters instead of this package reaching
 * back into a concrete desktop app.
 */

export const VERSION = '0.0.0';

export * from './types.js';
export * from './providers.js';

// feishu/ OpenAPI MCP 模块已于 2026-07-22 整体退役:能力早已迁入插件
// xd-feishu(2026-07-16 摘壳),其直通面生成器 + vendored OpenAPI 数据源也已
// 迁入独立插件包。活着的飞书 bot 走 lizi_feishuBot*
// + @cindy/@cindy/im,与本已删模块无关。

export * from './cindy_feishuBotMcpServer.js';
export * from './cindy_wechatMcpServer.js';
export * from './cindy_feishuBotToolRegistry.js';

export * from './cindy_schedulerMcpServer.js';
export * from './cindy_schedulerToolRegistry.js';
export * from './scheduler/index.js';

export * from './cindy_sshMcpServer.js';
export * from './ssh/registry.js';
export * from './ssh/index.js';

export * from './lizi_xdtHelperMcpServer.js';
export * from './lizi_xdtHelperToolRegistry.js';
export * from './xdt-helper/index.js';

export * from './orca/index.js';

export * from './session-context.js';

export * from './lsp/index.js';

export * from './android/index.js';
export * from './browser/index.js';
export * from './computer/index.js';

export * from './contacts/approval.js';
