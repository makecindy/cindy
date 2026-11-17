// The desktop's sessionSpendBroadcaster: its core (sessionSpendBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// Bound before the core's code runs; this module's imports are the ones sessionSpendBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
});

export * from './sessionSpendBroadcasterCore.js';
