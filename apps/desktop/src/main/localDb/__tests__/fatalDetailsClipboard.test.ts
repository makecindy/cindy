import { afterEach, describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

import { clearIssuedClipboardText, copyTextToClipboard } from '../../textClipboard';
import { localDbFatalDetailsText } from '../../../shared/localDbFatalDetails';
import { issueLocalDbFatalDetails } from '../fatalDetailsClipboard';
import { replyToEnsureReady } from '../ensureReadyReply';

/**
 * #6870 review: the fatal screen copies `code\nmessage` through the main-process clipboard,
 * which rejects text Main did not issue. Without registration every click fell back to manual copy.
 */
const event = {} as IpcMainInvokeEvent;
const deps = () => {
  let value: string | undefined;
  return { assertTrustedSender: () => undefined, assertFocusedSender: () => undefined, write: (text: string) => { value = text; }, read: () => value };
};

describe('local-db fatal details clipboard', () => {
  afterEach(() => clearIssuedClipboardText());

  it('makes the exact details string copyable, and nothing else', async () => {
    const error = { code: 'DB_INIT_FAILED', message: 'plugin dir EPERM' };
    await expect(copyTextToClipboard(event, { text: localDbFatalDetailsText(error) }, deps())).rejects.toThrow('not issued by Main');
    issueLocalDbFatalDetails({ ready: false, error });
    await expect(copyTextToClipboard(event, { text: 'DB_INIT_FAILED\nplugin dir EPERM' }, deps())).resolves.toBeUndefined();
    await expect(copyTextToClipboard(event, { text: 'something else' }, deps())).rejects.toThrow('not issued by Main');
  });

  it('registers the details of every failed ensure-ready reply: failure, thrown error, invalid userId', async () => {
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const record = () => undefined;
    const copyable = async (text: string) => { await expect(copyTextToClipboard(event, { text }, deps())).resolves.toBeUndefined(); };

    const failed = await replyToEnsureReady('u1', { run: async () => ({ ready: false, error: { code: 'DB_CORRUPT_NO_BACKUP', message: 'bad page' } }), record, log });
    expect(failed).toMatchObject({ ready: false });
    await copyable('DB_CORRUPT_NO_BACKUP\nbad page');

    await replyToEnsureReady('u1', { run: async () => { throw new Error('boom'); }, record, log });
    await copyable('DB_INIT_FAILED\nboom');

    await replyToEnsureReady(undefined, { run: async () => ({ ready: true }), record, log });
    await copyable('DB_INIT_FAILED\ninvalid userId');
  });

  it('issues nothing for a ready result', async () => {
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await replyToEnsureReady('u1', { run: async () => ({ ready: true }), record: () => undefined, log });
    await expect(copyTextToClipboard(event, { text: 'DB_INIT_FAILED\nundefined' }, deps())).rejects.toThrow('not issued by Main');
  });
});
