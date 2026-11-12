import type { FileHostKeyStore, HostSnapshot } from '@cindy/maker-remote-ssh';

type Mismatch = NonNullable<HostSnapshot['hostKeyMismatch']>;
interface RecoveryHost {
  snapshot(): Pick<HostSnapshot, 'status' | 'hostKeyMismatch'>;
}

/** Keep confirmation tied to the locally observed endpoint and both fingerprints. */
export async function confirmHostKeyChange(options: {
  getHost: () => RecoveryHost | undefined;
  store: Pick<FileHostKeyStore, 'replace'>;
  confirm: (mismatch: Mismatch) => Promise<boolean>;
  isWindowAlive: () => boolean;
}): Promise<boolean> {
  const host = options.getHost();
  const snapshot = host?.snapshot();
  const mismatch = snapshot?.hostKeyMismatch;
  if (!host || snapshot?.status !== 'failed' || !mismatch) {
    throw new Error('Reconnect to obtain the current host key.');
  }
  if (!await options.confirm(mismatch)) return false;
  await options.store.replace(mismatch.host, mismatch.trusted, mismatch.presented, () => {
    const current = host.snapshot();
    return options.isWindowAlive() && options.getHost() === host && current.status === 'failed'
      && current.hostKeyMismatch?.host === mismatch.host
      && current.hostKeyMismatch.trusted === mismatch.trusted
      && current.hostKeyMismatch.presented === mismatch.presented;
  });
  return true;
}
