import type { PassportDictation } from '../../shared/passport';

/** Main only releases a dictation after its matching hardware confirmation. */
export async function deliverPassportDictation(
  draft: PassportDictation,
  isCurrent: () => boolean,
  send: (text: string) => Promise<boolean>,
  acknowledge: (token: string, sent: boolean) => Promise<void>,
): Promise<boolean> {
  let sent = false;
  try {
    if (isCurrent()) sent = await send(draft.text);
    return sent;
  } finally {
    await acknowledge(draft.token, sent);
  }
}
