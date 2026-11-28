// The desktop's modelMismatchBroadcaster: its core (modelMismatchBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones modelMismatchBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { patchMessageAgentMeta } from './localDb/ipc/messages.js';
import { enqueueMessageUsageWrite } from './usage/messageUsageWrite.desktop.js';
import { messageCostDatabase } from './usage/turnUsageAdmission.js';
import { patchMessageAgentMetaWithResultRow } from './localDb/messageMutations.js';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  patchMessageAgentMeta: async (...args) => {
    const client = messageCostDatabase.getStore();
    return client ? Boolean(await patchMessageAgentMetaWithResultRow(client, ...args)) : patchMessageAgentMeta(...args);
  },
  enqueueDurableWrite: enqueueMessageUsageWrite,
});

export * from './modelMismatchBroadcasterCore.js';
