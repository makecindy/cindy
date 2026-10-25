/** Electron entry retains the released utilityProcess path and worker ABI. */
import { createRequire } from 'node:module';
import { startNodePluginWorker, type ParentPortLike } from '@cindy/plugin-runtime/nodeWorker';
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) throw new Error('Node 插件工作进程缺少 parentPort');
startNodePluginWorker(parentPort, createRequire(__filename));
