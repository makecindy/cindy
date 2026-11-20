// The desktop's usageBroadcaster: its core (usageBroadcasterCore.ts, shared with the Node Host), with the desktop
// functions it imported before bound to its ports (usageBroadcastPorts.ts), each resolved when called.
// The core calls no port while its module loads (export * evaluates it before the binding below runs);
// each port is resolved when it is called. This module's imports are the ones usageBroadcaster.ts had.
import { BrowserWindow } from 'electron';
import { isTrustedAppRendererWindow } from './security/trustedAppRenderer.js';
import { getGatewayModelPricing } from './usage/modelPricing';
import { bindUsageBroadcastPorts } from './usageBroadcastPorts.js';

bindUsageBroadcastPorts({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  isTrustedAppRendererWindow: (win) => isTrustedAppRendererWindow(win as Electron.BrowserWindow),
  getGatewayModelPricing: (...args) => getGatewayModelPricing(...args),
});

export * from './usageBroadcasterCore.js';
