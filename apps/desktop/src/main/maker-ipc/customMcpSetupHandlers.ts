import type { IpcMainInvokeEvent } from 'electron';
import { MCP_SETUP_INVOKE } from '../../shared/mcpSetup.js';
import {
  mcpDraftUpdateSchema,
  mcpSubmissionSchema,
  mcpCancelSchema,
  type CustomMcpSetupService,
} from '../maker-host/custom-mcp-setup-service.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export function assertMcpLocalRenderer(event: unknown): void {
  if (isDeviceLinkInvoke())
    throwIpcError('PERMISSION_DENIED', 'MCP credentials must be entered on this Desktop');
  assertTrustedAppRendererEvent(event as IpcMainInvokeEvent);
}
/** Never add these secret-bearing calls to the Device Link allowlist. */
export function registerCustomMcpSetupHandlers(
  registry: IpcHandlerRegistry,
  service: CustomMcpSetupService,
) {
  for (const channel of Object.values(MCP_SETUP_INVOKE))
    registry.handle(channel, async (event, input: unknown) => {
      assertMcpLocalRenderer(event);
      try {
        if (channel === MCP_SETUP_INVOKE.UPDATE)
          return service.update(mcpDraftUpdateSchema.parse(input));
        if (channel === MCP_SETUP_INVOKE.SUBMIT)
          return await service.submit(mcpSubmissionSchema.parse(input));
        const parsed = mcpCancelSchema.parse(input);
        if (channel === MCP_SETUP_INVOKE.ACTIVATE)
          return await service.retryActivation(parsed.requestId, parsed.expectedRevision);
        return service.cancel(parsed.requestId, parsed.expectedRevision);
      } catch {
        throwIpcError(
          'PRECONDITION_FAILED',
          'MCP setup changed or expired; reopen the configuration card',
        );
      }
    });
}
