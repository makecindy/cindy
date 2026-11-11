import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

// Execute the actual SessionView send callback. The composer clears on click, so an
// ordinary send must reach the store (which shows the bubble first) before the
// vendor readiness check waits on main; the check then runs as the store's
// beforeEnqueue and its rejection rolls the bubble back.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSend' &&
      node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('SessionView send callback missing');
const code = ts.transpileModule('(' + callback.getText(source) + ')', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(options: { proceed: boolean; remoteDeviceId?: string | null; rebalance?: boolean }) {
  const order: string[] = [];
  const auth = vi.fn(async () => {
    order.push('auth');
    return { proceed: options.proceed };
  });
  const recordRebalance = vi.fn(async () => { order.push('rebalance'); });
  let storeOpts: { beforeEnqueue?: () => Promise<boolean>; onInputCreated?: (id: string) => void } | undefined;
  const storeSend = vi.fn(async (...args: unknown[]) => {
    order.push('store');
    storeOpts = args[7] as typeof storeOpts;
    storeOpts?.onInputCreated?.('client-1');
    return storeOpts?.beforeEnqueue ? await storeOpts.beforeEnqueue() : true;
  });
  const send = runInNewContext(code, {
    readOnly: false, cindyMakeInputLocked: false, invalidateHistoryRecoveryNavigation: vi.fn(),
    remoteDeviceId: options.remoteDeviceId ?? null, displayAgentKind: 'claude-code', isCodex: false,
    agentSwitchIntent: null, vendorAuthGate: { checkAndConfirm: auth },
    session: { source: 'user', status: 'active', workingDir: '/repo' }, sessionId: 'session-1',
    folderPickerOpen: false, sessionHandoffPreparing: false, isOrcaLeadSession: () => false,
    isRunningRef: { current: false }, confirmRebalance: vi.fn(), t: (key: string) => key,
    offerSessionRebalance: async () => (options.rebalance ? recordRebalance : undefined),
    botChatIdentity: null, readSendFollowCancelGeneration: () => 0, requestFollowLatest: vi.fn(),
    sendMessage: storeSend, steerMessage: storeSend,
    dispatchDeferredUiAssignment: async () => undefined,
  });
  return { send, auth, storeSend, recordRebalance, order, getStoreOpts: () => storeOpts };
}

it.each(['queue', 'steer'] as const)(
  'hands an ordinary %s send to the store before checking vendor readiness', async (deliveryMode) => {
    const { send, order, storeSend } = setup({ proceed: true, rebalance: true });
    await expect(send('hello', 'model', '', 'ask', undefined, undefined, {
      literalText: true, deliveryMode,
    })).resolves.toBe(true);
    expect(storeSend).toHaveBeenCalledOnce();
    // Steer joins the running turn, so it never offers an account rebalance.
    expect(order).toEqual(deliveryMode === 'steer' ? ['store', 'auth'] : ['store', 'auth', 'rebalance']);
  });

it('rejects through beforeEnqueue so the store rolls the bubble back and the composer restores', async () => {
  const { send, order, recordRebalance } = setup({ proceed: false, rebalance: true });
  await expect(send('hello', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(false);
  expect(order).toEqual(['store', 'auth']);
  expect(recordRebalance).not.toHaveBeenCalled();
});

it('leaves device-link sends to the task computer without a renderer check', async () => {
  const { send, auth, getStoreOpts } = setup({ proceed: false, remoteDeviceId: 'device-1' });
  await expect(send('hello', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(true);
  expect(auth).not.toHaveBeenCalled();
  expect(getStoreOpts()?.beforeEnqueue).toBeUndefined();
});
