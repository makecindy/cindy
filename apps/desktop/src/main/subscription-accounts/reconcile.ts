/** Recover missing pool provenance from the actual native history, never from a default guess. */
export async function reconcileLegacySubscriptionAccount(deps: {
  owner(): string;
  read(): Promise<{ nativeId: string | null; providerId: string | null; eligible: boolean } | null>;
  provider(): string | undefined;
  binding(key: string): string | undefined;
  account(nativeId: string): Promise<string | undefined>;
  available(accountId: string): boolean;
  record(providerId: string, accountId: string, nativeId: string): Promise<void>;
  normalize(providerId: string): Promise<void>;
}): Promise<void> {
  const owner = deps.owner();
  const assertOwner = () => { if (deps.owner() !== owner) throw new Error('Subscription account owner changed'); };
  const row = await deps.read();
  assertOwner();
  if (!row?.eligible || !row.nativeId) return;
  const provider = deps.provider();
  if (!provider) return;
  const task = deps.binding('task');
  const native = deps.binding(row.nativeId);
  if (task && native && task !== native) throw new Error('The task subscription account changed');
  const existing = native ?? task;
  const account = existing ?? await deps.account(row.nativeId);
  assertOwner();
  if (!account || !deps.available(account)) return;
  const latest = await deps.read();
  assertOwner();
  if (!latest?.eligible || latest.nativeId !== row.nativeId || latest.providerId !== row.providerId
    || deps.provider() !== provider || deps.binding('task') !== task || deps.binding(row.nativeId) !== native)
    throw new Error('The task subscription account changed');
  if (!row.providerId) {
    await deps.normalize(provider); // Remember the proven applied route before clearing a legacy SDK id.
    assertOwner();
  }
  if (!task || !native) {
    await deps.record(provider, account, row.nativeId);
    assertOwner();
  }
}
