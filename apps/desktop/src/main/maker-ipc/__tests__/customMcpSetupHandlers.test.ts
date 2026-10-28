/** 测试价值：unit；通过真实 handler 验证秘密提交的来源守卫先于解析和副作用。
 * 最小输入为一个本机快照与假凭证；旧通用交互测试不覆盖这些窄 IPC。 */
import { beforeEach, expect, it, vi } from 'vitest';
import { registerCustomMcpSetupHandlers } from '../customMcpSetupHandlers.js';
import { MCP_SETUP_INVOKE } from '../../../shared/mcpSetup.js';
import type { CustomMcpSetupService } from '../../maker-host/custom-mcp-setup-service.js';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { IpcHarness } from './helpers/ipcHarness.js';
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (event: { sender?: { id: number } }) => {
    if (event.sender?.id !== 1) throw new Error('[PERMISSION_DENIED] Untrusted renderer');
  },
}));
const service = { update: vi.fn(), submit: vi.fn(), cancel: vi.fn(), retryActivation: vi.fn() };
let harness: IpcHarness;
beforeEach(() => {
  vi.clearAllMocks();
  harness = new IpcHarness();
  registerCustomMcpSetupHandlers(harness, service as unknown as CustomMcpSetupService);
});
it.each(Object.values(MCP_SETUP_INVOKE))(
  'rejects Device Link on %s before accepting guessed capabilities or secret input',
  async (channel) => {
    await expect(
      runDeviceLinkInvokeContext({ controllerDeviceId: 'other', channel }, () =>
        harness.invokeFrom(1, channel, {
          requestId: 'guessed',
          token: 'test-invalid-token',
          kind: 'permission',
        }),
      ),
    ).rejects.toThrow('PERMISSION_DENIED');
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  },
);
it.each(Object.values(MCP_SETUP_INVOKE))(
  'rejects an untrusted sender on %s before parsing',
  async (channel) => {
    await expect(harness.invokeFrom(2, channel, {})).rejects.toThrow('PERMISSION_DENIED');
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  },
);
it('only forwards the narrow secret submission and never reflects parsing errors or raw failures', async () => {
  const input = {
    requestId: 'desktop-only',
    expectedRevision: 1,
    submissionId: '00000000-0000-4000-8000-000000000001',
    token: 'test-invalid-token',
    headers: {},
  };
  service.submit.mockResolvedValueOnce({ status: 'saved' });
  expect(await harness.invokeFrom(1, MCP_SETUP_INVOKE.SUBMIT, input)).toEqual({ status: 'saved' });
  expect(service.submit).toHaveBeenCalledWith(input);
  try {
    await harness.invokeFrom(1, MCP_SETUP_INVOKE.SUBMIT, { ...input, url: 'test-invalid-token' });
    throw new Error('Expected rejection');
  } catch (error) {
    expect(String(error)).not.toContain(input.token);
    expect(String(error)).toContain('PRECONDITION_FAILED');
  }
  service.submit.mockRejectedValueOnce(new Error(input.token));
  await expect(harness.invokeFrom(1, MCP_SETUP_INVOKE.SUBMIT, input)).rejects.toThrow(
    'PRECONDITION_FAILED',
  );
});
