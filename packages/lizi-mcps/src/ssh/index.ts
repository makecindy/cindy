/**
 * ssh/index.ts
 *
 * Bundle export for the cindy_ssh tool family. The MCP server factory
 * (cindy_sshMcpServer.ts) imports from here and registers everything in one go.
 */

export { registerSshListHostsTool } from './list_hosts.js';
export { registerSshHostStatusTool } from './host_status.js';
export { registerSshExecTool } from './exec.js';
export { registerSshAddHostTool } from './add_host.js';
export { registerSshReloadConfigTool } from './reload_config.js';

export { classifySshError, resolveHost, truncateOutput, wrapCwd } from './_shared.js';
export type { SshErrorCode } from './_shared.js';
