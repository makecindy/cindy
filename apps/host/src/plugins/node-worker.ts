import { Socket } from 'node:net';
import { createPluginControlPipe } from '../../../desktop/src/main/cindy-brain/nodeRuntimePipe.js';
import { runNodeRuntimeWorker, type NodeWorkerParentPort } from '../../../desktop/src/main/cindy-brain/nodeRuntimeWorkerProcess.js';

const listeners = new Set<(event: { data: unknown }) => void>();
// A separate inherited descriptor, not process.send or an exposed IPC emitter.
const pipe = createPluginControlPipe(new Socket({ fd: 3, readable: true, writable: true }),
  message => { for (const listener of listeners) listener({ data: message }); },
  () => { process.exitCode = 1; process.exit(); });
const parentPort: NodeWorkerParentPort = {
  postMessage: pipe.send,
  on: (_event, listener) => { listeners.add(listener); },
};
runNodeRuntimeWorker(parentPort, process.argv[2], process.argv.slice(3));
