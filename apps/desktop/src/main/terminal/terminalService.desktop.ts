import { onAppSessionInvalidated } from '../appSessionState.js';
import { HostTerminalService } from './hostTerminalService.js';

let service: HostTerminalService | undefined;

/** UI registration and MCP provider setup converge on this single process service. */
export function getDesktopHostTerminalService(): HostTerminalService {
  if (!service) {
    service = new HostTerminalService();
    onAppSessionInvalidated(() => service?.disposeScoped());
  }
  return service;
}
