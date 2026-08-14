import { describe, expect, it } from 'vitest';

import { routeInjectedRemoteMcpApprovalsThroughCindy } from '../remote-claude-permission-mode.js';

describe('remote Claude MCP permission mode', () => {
  it('routes OAuth Auto through Cindy when the host injected an MCP server', () => {
    const startParams: Record<string, unknown> = { permissionMode: 'auto' };

    routeInjectedRemoteMcpApprovalsThroughCindy(startParams, 1);

    expect(startParams.permissionMode).toBe('default');
  });

  it('keeps native Auto when the host did not inject an MCP server', () => {
    const startParams: Record<string, unknown> = { permissionMode: 'auto' };

    routeInjectedRemoteMcpApprovalsThroughCindy(startParams, 0);

    expect(startParams.permissionMode).toBe('auto');
  });

  it.each(['default', 'plan', 'bypassPermissions'])('does not change %s mode', (permissionMode) => {
    const startParams: Record<string, unknown> = { permissionMode };

    routeInjectedRemoteMcpApprovalsThroughCindy(startParams, 2);

    expect(startParams.permissionMode).toBe(permissionMode);
  });
});
