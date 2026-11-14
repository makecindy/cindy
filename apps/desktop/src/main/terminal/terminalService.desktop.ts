import { onAppSessionInvalidated } from '../appSessionState.js';
import { HostTerminalService } from './hostTerminalService.js';

let service: HostTerminalService | undefined;

/** UI registration and MCP provider setup converge on this single process service. */
export function getDesktopHostTerminalService(): HostTerminalService;
export function getDesktopHostTerminalService(create: false): HostTerminalService | undefined;
export function getDesktopHostTerminalService(create = true): HostTerminalService | undefined {
  if (!service && create) {
    service = new HostTerminalService();
    onAppSessionInvalidated(() => service?.disposeScoped());
  }
  return service;
}
