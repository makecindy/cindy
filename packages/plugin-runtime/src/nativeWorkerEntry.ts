import { Socket, connect } from 'node:net';
import { createRequire } from 'node:module';
import { createControlPort } from './controlPort.js';
import { startNodePluginWorker } from './nodeWorker.js';

// Deliberately not child_process IPC: plugins never receive process.send,
// process.channel, or a public process 'message' event with authorization data.
const pipeName = process.env.CINDY_NODE_CONTROL_PIPE;
delete process.env.CINDY_NODE_CONTROL_PIPE;
const channel = pipeName ? connect(pipeName) : new Socket({ fd: 3, readable: true, writable: true });
channel.once('close', () => process.exit(0));
const port = createControlPort(channel, () => process.exit(1));
if (pipeName) channel.once('connect', () => startNodePluginWorker(port, createRequire(__filename)));
else startNodePluginWorker(port, createRequire(__filename));
