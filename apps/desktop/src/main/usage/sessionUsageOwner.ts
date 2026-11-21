import { getActiveAppSession, getDataOwnerLifetime } from '../appSessionState.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';

const expired = () => false;

function captureAccount() {
  const { mode, dataOwnerId } = getActiveAppSession();
  const lifetime = getDataOwnerLifetime();
  return {
    mode, dataOwnerId, lifetime,
    current() {
      // The commit point advances lifetime exactly when mode or dataOwnerId changes.
      return dataOwnerId !== null && lifetime === getDataOwnerLifetime() && getCurrentDbClientUserId() === dataOwnerId;
    },
  };
}

/** A retained Session still describes its original task. A different login cannot adopt it.
 * A new send after returning to the task's account can start a fresh lifetime. */
export function bindSessionUsageAccount(onNewLifetime?: () => void) {
  let admitted = captureAccount();
  let firstGeneration = 0;
  let candidate: { generation: number; account: ReturnType<typeof captureAccount>; dispatching: boolean } | undefined;
  function admitCandidate(generation: number) {
    if (!candidate || candidate.generation !== generation || !candidate.dispatching) return;
    const account = candidate.account;
    const sameTaskOwner = admitted.dataOwnerId === null ||
      (account.mode === admitted.mode && account.dataOwnerId === admitted.dataOwnerId);
    if (sameTaskOwner && account.dataOwnerId !== null && account.lifetime === getDataOwnerLifetime()
        && account.lifetime !== admitted.lifetime) {
      admitted = account;
      firstGeneration = generation;
      onNewLifetime?.();
    }
  }
  return {
    reserve(generation: number) {
      candidate = { generation, account: captureAccount(), dispatching: false };
      return (dispatched: boolean) => {
        if (candidate?.generation !== generation) return;
        if (dispatched) admitCandidate(generation);
        candidate = undefined;
      };
    },
    dispatch(generation: number) {
      if (candidate?.generation === generation) candidate.dispatching = true;
    },
    forEvent(generation: number) {
      // Until dispatch, the provider can only be finishing the previously admitted turn.
      // Some providers produce their first real event before send() acknowledges.
      admitCandidate(generation);
      return generation < firstGeneration ? expired : admitted.current;
    },
  };
}
