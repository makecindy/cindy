import type { HookProvider, TaskDispatchPayload } from '@cindy/slack-hook-protocol';

/** Shared lane classification for dispatch, archive and background results. */
export function providerForExternalKey(externalKey: string): HookProvider | null {
  if (externalKey.startsWith('telegram:')) return 'telegram';
  if (externalKey.startsWith('x:')) return 'x';
  // Official Feishu / Lark lanes: feishu:dm:… and feishu:topic:…; Lark shares the prefix.
  if (externalKey.startsWith('feishu:')) return 'feishu';
  if (
    externalKey.startsWith('slack:') ||
    externalKey.startsWith('team-slack:') ||
    // Pre-prefix Slack channel and DM lanes remain supported.
    /^[A-Z][A-Z0-9]*:[A-Z][A-Z0-9]*:\d+(?:\.\d+)?$/.test(externalKey) ||
    /^dm:(?:[A-Z][A-Z0-9]*:){1,2}g\d+$/.test(externalKey)
  ) return 'slack';
  return null;
}

/**
 * App and sender of an official Feishu / Lark lane:
 *   feishu:dm:<appId>:<openId>:g<n>
 *   feishu:topic:<appId>:<chatId>:<rootMessageId>:<openId>:g<n>
 * The service is shared by many organizations' apps, so a dispatch is only
 * accepted for the app and Feishu user of this device's confirmed binding.
 * Any other shape returns null so callers fail closed.
 */
export function feishuLaneIdentityOf(externalKey: string): { appId: string; openId: string } | null {
  const parts = externalKey.split(':');
  if (parts[0] !== 'feishu' || !/^g\d+$/.test(parts[parts.length - 1] ?? '')) return null;
  const fields = parts.slice(2, -1);
  const expected = parts[1] === 'dm' ? 2 : parts[1] === 'topic' ? 4 : 0;
  if (expected === 0 || fields.length !== expected || fields.some((field) => field.length === 0)) {
    return null;
  }
  return { appId: fields[0]!, openId: fields[expected - 1]! };
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
