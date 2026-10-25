import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
export type ProviderOwnerSession = {dataOwnerId: string | null; generation: number};
export function createProviderOwnerGuards(deps: {currentOwnerSession?(): ProviderOwnerSession}) {
  const captureProviderOwnerSession = () => deps.currentOwnerSession?.();
  const providerMutationOwnerMatches = (
    ownerAtIngress: { dataOwnerId: string | null; generation: number } | undefined,
  ): boolean => {
    if (!deps.currentOwnerSession || !ownerAtIngress) return true;
    const current = deps.currentOwnerSession();
    return (
      current.dataOwnerId === ownerAtIngress.dataOwnerId &&
      current.generation === ownerAtIngress.generation
    );
  };
  const assertProviderMutationOwner = (
    ownerAtIngress: { dataOwnerId: string | null; generation: number } | undefined,
    message = 'active account changed during provider mutation',
  ): void => {
    if (!providerMutationOwnerMatches(ownerAtIngress)) {
      throwIpcError('INTERNAL', message);
    }
  };
  const assertRequestedProviderOwner = (
    requestedDataOwnerId: string | null,
    requestedOwnerGeneration: number,
  ): void => {
    const current = deps.currentOwnerSession?.();
    if (
      current &&
      (current.dataOwnerId !== requestedDataOwnerId ||
        current.generation !== requestedOwnerGeneration)
    ) {
      throwIpcError('INTERNAL', 'active account changed during provider mutation');
    }
  };

return {captureProviderOwnerSession, providerMutationOwnerMatches, assertProviderMutationOwner, assertRequestedProviderOwner};
}
