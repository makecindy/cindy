import { afterEach, describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

import { clearIssuedClipboardText, copyTextToClipboard } from '../../textClipboard';
import { localDbFatalDetailsText } from '../../../shared/localDbFatalDetails';
import { issueLocalDbFatalDetails, notifyRuntimeDbCorruption } from '../fatalDetailsClipboard';
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

    // #9555 / unit: passive readiness must preserve the runtime-corrupt error
    // so the fatal screen offers the explicit recovery action, without auto retry.
    const corrupt = await replyToEnsureReady('u1', { run: async () => {
      throw Object.assign(new Error('bad page'), { code: 'SQLITE_CORRUPT' });
    }, record, log });
    expect(corrupt).toMatchObject({ ready: false, error: { code: 'DB_RUNTIME_CORRUPT' } });
    await copyable('DB_RUNTIME_CORRUPT\nbad page');

    await replyToEnsureReady(undefined, { run: async () => ({ ready: true }), record, log });
    await copyable('DB_INIT_FAILED\ninvalid userId');
  });

  // #11401 review / unit: the actual runtime notification entry must issue
  // code-only details before a renderer can copy them; startup-only tests missed it.
  it('makes runtime-push details copyable before notifying without allowing other text', async () => {
    const stamp = { dataOwnerId: 'u1', ownerGeneration: 1 };
    let copied: Promise<void> | undefined;
    notifyRuntimeDbCorruption(stamp, received => {
      expect(received).toBe(stamp);
      copied = copyTextToClipboard(event, { text: 'DB_RUNTIME_CORRUPT' }, deps());
    });
    await expect(copied).resolves.toBeUndefined();
    await expect(copyTextToClipboard(event, { text: 'arbitrary text' }, deps())).rejects.toThrow('not issued by Main');
  });

  it('issues nothing for a ready result', async () => {
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await replyToEnsureReady('u1', { run: async () => ({ ready: true }), record: () => undefined, log });
    await expect(copyTextToClipboard(event, { text: 'DB_INIT_FAILED\nundefined' }, deps())).rejects.toThrow('not issued by Main');
  });
});
