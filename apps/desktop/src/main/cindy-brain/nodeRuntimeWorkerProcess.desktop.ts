/** Electron utilityProcess entry; the same worker runs in the Node launcher. */
import { runNodeRuntimeWorker, type NodeWorkerParentPort } from './nodeRuntimeWorkerProcess.js';
const parentPort = (process as unknown as { parentPort?: NodeWorkerParentPort }).parentPort;
if (!parentPort) throw new Error('Node 插件工作进程缺少 parentPort');
runNodeRuntimeWorker(parentPort, process.argv[2], process.argv.slice(3));
