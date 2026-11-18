// The desktop's turnCostBroadcaster: its core (turnCostBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones turnCostBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { patchMessageAgentMetaWithResult, readPriorUserRoundCost } from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.desktop.js';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  patchMessageAgentMetaWithResult: (...args) => patchMessageAgentMetaWithResult(...args),
  readPriorUserRoundCost: (...args) => readPriorUserRoundCost(...args),
  enqueueDurableWrite: (label, fn) => enqueueDurableWrite(label, fn),
});

export * from './turnCostBroadcasterCore.js';
