/** Owner-scoped native runtime readiness. No account identities or credentials are stored here. */
let zcodeConnected = false;

export function setZCodeNativeConnected(connected: boolean): void {
  zcodeConnected = connected;
}

export function isNativeAgentConnected(providerId: string): boolean {
  return providerId === 'zcode-native' && zcodeConnected;
}

/** The click belongs to the displayed owner even when initial discovery is still pending. */
export async function connectNativeAgentForOwner(ops: {
  assertCurrent(): void;
  waitForDiscovery(): Promise<void>;
  authorize(): void;
  refresh(): Promise<{ connected: boolean; errorReason?: string }>;
}): Promise<void> {
  ops.assertCurrent();
  await ops.waitForDiscovery();
  ops.assertCurrent();
  ops.authorize();
  const result = await ops.refresh();
  ops.assertCurrent();
  if (!result.connected) throw new Error(result.errorReason ?? 'ZCODE_CONNECTION_UNAVAILABLE');
}
