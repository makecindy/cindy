import type { HookProvider, TaskDispatchPayload } from '@cindy/slack-hook-protocol';

/** Shared lane classification for dispatch, archive and background results. */
export function providerForExternalKey(externalKey: string): HookProvider | null {
  if (externalKey.startsWith('telegram:')) return 'telegram';
  if (externalKey.startsWith('x:')) return 'x';
  if (
    externalKey.startsWith('slack:') ||
    externalKey.startsWith('team-slack:') ||
    // Pre-prefix Slack channel and DM lanes remain supported.
    /^[A-Z][A-Z0-9]*:[A-Z][A-Z0-9]*:\d+(?:\.\d+)?$/.test(externalKey) ||
    /^dm:(?:[A-Z][A-Z0-9]*:){1,2}g\d+$/.test(externalKey)
  ) return 'slack';
  return null;
}

/** Missing source is legacy Slack only; explicit source must agree with the key. */
export function providerForTaskDispatch(
  payload: Pick<TaskDispatchPayload, 'externalKey' | 'source'>,
): HookProvider | null {
  const provider = providerForExternalKey(payload.externalKey);
  const source = payload.source?.im;
  if (source === undefined) return provider === 'slack' ? provider : null;
  return source === provider ? provider : null;
}
