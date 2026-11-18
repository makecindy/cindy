// The desktop's sessionSpendBroadcaster: its core (sessionSpendBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones sessionSpendBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
});

export * from './sessionSpendBroadcasterCore.js';
