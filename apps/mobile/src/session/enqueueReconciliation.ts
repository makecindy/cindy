import { isInFlightDeviceLinkError } from '@cindy/device-link';
import { formatRemoteError } from '@/device-link/remoteStatus';

export function enqueueMayHaveReachedHost(error: unknown): boolean {
  if (isInFlightDeviceLinkError(error)) return true;
  return (error as { code?: unknown } | null)?.code === 'INVOKE_TIMEOUT' || formatRemoteError(error).includes('INVOKE_TIMEOUT');
}
export async function reconcileEnqueueFailure(
  input: { error: unknown; readAuthoritativeAcceptance(): Promise<boolean> },
): Promise<'accepted' | 'rejected' | 'unknown'> {
  try {
    if (await input.readAuthoritativeAcceptance()) return 'accepted';
  } catch {}
  return enqueueMayHaveReachedHost(input.error) ? 'unknown' : 'rejected';
}
