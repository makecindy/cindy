// The desktop's modelMismatchBroadcaster: its core (modelMismatchBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// Bound before the core's code runs; this module's imports are the ones modelMismatchBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { patchMessageAgentMeta } from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.desktop.js';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  patchMessageAgentMeta: (...args) => patchMessageAgentMeta(...args),
  enqueueDurableWrite: (label, fn) => enqueueDurableWrite(label, fn),
});

export * from './modelMismatchBroadcasterCore.js';
