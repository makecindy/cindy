import { isInFlightDeviceLinkError } from '@cindy/device-link';

export function enqueueMayHaveReachedHost(error: unknown): boolean {
  if (isInFlightDeviceLinkError(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (error as { code?: unknown } | null)?.code === 'INVOKE_TIMEOUT' || message.includes('INVOKE_TIMEOUT');
}
export async function reconcileEnqueueFailure(
  input: { error: unknown; readAuthoritativeAcceptance(): Promise<boolean> },
): Promise<'accepted' | 'rejected' | 'unknown'> {
  try {
    if (await input.readAuthoritativeAcceptance()) return 'accepted';
  } catch {}
  return enqueueMayHaveReachedHost(input.error) ? 'unknown' : 'rejected';
}
