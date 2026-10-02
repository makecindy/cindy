import { expect, it, vi } from 'vitest';
import { sessionToolPolicy } from '../toolPolicy.js';
import type { ToolCallAuthorizer } from '@cindy/mcps';

it('checks actual operation and target, not just the original read tool', async () => {
  const authorize = vi.fn<ToolCallAuthorizer>(async input => input.tool === 'stop_session_turn'
    ? { ok: false, errorCode: 'TASK_OUT_OF_SCOPE', message: 'not granted' } : { ok: true });
  const policy = sessionToolPolicy({ sessionId: 'caller', server: 'cindy_helper', tool: 'diagnose_session', args: {} }, authorize, () => {});
  await expect(policy.authorize({ deviceId: 'local', operation: 'requestStop', targets: [{ deviceId: 'local', sessionId: 'foreign' }] }))
    .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  expect(authorize).toHaveBeenLastCalledWith(expect.objectContaining({ tool: 'stop_session_turn', args: { session_id: 'foreign' } }));
});

it('rechecks the original caller on each late admission', async () => {
  let revoked = false;
  const authorize: ToolCallAuthorizer = async () => revoked ? { ok: false, errorCode: 'TASK_OUT_OF_SCOPE', message: 'revoked' } : { ok: true };
  const policy = sessionToolPolicy({ sessionId: 'caller', server: 'cindy_helper', tool: 'send_to_session', args: {} }, authorize, () => {});
  const admission = { deviceId: 'local', operation: 'send' as const, targets: [{ deviceId: 'local', sessionId: 'target' }] };
  await policy.authorize(admission); revoked = true;
  await expect(policy.authorize(admission)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
});

it('requires create authorization even though the target has no sessionId yet', async () => {
  const authorize = vi.fn<ToolCallAuthorizer>(async input => input.tool === 'send_to_session' && Object.keys(input.args as object).length === 0
    ? { ok: false, errorCode: 'OWNER_TURN_REQUIRED', message: 'owner required' } : { ok: true });
  const policy = sessionToolPolicy({ sessionId: 'caller', server: 'cindy_helper', tool: 'inspect_session', args: { session_id: 'caller' } }, authorize, () => {});
  await expect(policy.authorize({ deviceId: 'local', operation: 'createRecord', targets: [] })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
});
