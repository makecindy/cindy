import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearIssuedClipboardText,
  copyTextToClipboard,
  rememberIssuedClipboardText,
} from '../textClipboard';
import { MAX_CLIPBOARD_TEXT_CHARS } from '../../shared/textClipboard';
import { throwIpcError } from '../utils/ipcValidate';

const event = {} as IpcMainInvokeEvent;
const link = 'https://device-link.cindy.com.cn/provider-share/abc';
const later = () => new Date(Date.now() + 60_000).toISOString();

function harness(readBack: (written: string) => string | undefined = (written) => written) {
  let written = '';
  return {
    assertTrustedSender: vi.fn(),
    assertFocusedSender: vi.fn(),
    write: vi.fn(async (text: string) => {
      written = text;
    }),
    read: vi.fn(async () => readBack(written)),
  };
}

describe('copyTextToClipboard', () => {
  afterEach(() => {
    clearIssuedClipboardText();
  });

  it('writes the text and confirms it by reading the clipboard back', async () => {
    rememberIssuedClipboardText(link, later());
    const deps = harness();
    await copyTextToClipboard(event, { text: link }, deps);
    expect(deps.assertTrustedSender).toHaveBeenCalledWith(event);
    expect(deps.assertFocusedSender).toHaveBeenCalledWith(event);
    expect(deps.write).toHaveBeenCalledWith(link);
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it('rejects an unfocused sender before writing', async () => {
    rememberIssuedClipboardText(link, later());
    const deps = harness();
    deps.assertFocusedSender.mockImplementation(() => throwIpcError('PERMISSION_DENIED', 'Denied'));
    await expect(copyTextToClipboard(event, { text: link }, deps)).rejects.toThrow('[PERMISSION_DENIED]');
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('rejects text that Main did not issue as a share link', async () => {
    const deps = harness();
    await expect(copyTextToClipboard(event, { text: link }, deps)).rejects.toThrow('[PERMISSION_DENIED]');
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('rejects an expired issued share link', async () => {
    rememberIssuedClipboardText(link, new Date(Date.now() - 1).toISOString());
    const deps = harness();
    await expect(copyTextToClipboard(event, { text: link }, deps)).rejects.toThrow('[PERMISSION_DENIED]');
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('fails when the write resolves but the clipboard stays empty', async () => {
    rememberIssuedClipboardText(link, later());
    const deps = harness(() => '');
    await expect(copyTextToClipboard(event, { text: link }, deps)).rejects.toThrow('[INTERNAL]');
  });

  it('fails when the clipboard holds different text after the write', async () => {
    rememberIssuedClipboardText(link, later());
    const deps = harness(() => 'older clipboard text');
    await expect(copyTextToClipboard(event, { text: link }, deps)).rejects.toThrow('[INTERNAL]');
  });

  it('maps a native write error to INTERNAL without leaking its message', async () => {
    rememberIssuedClipboardText(link, later());
    const deps = harness();
    deps.write.mockRejectedValueOnce(new Error(`stdout: ${link}`));
    const error = await copyTextToClipboard(event, { text: link }, deps).catch((e: Error) => e);
    expect(String(error)).toContain('[INTERNAL]');
    expect(String(error)).not.toContain(link);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before inspecting payload or writing', async () => {
    const deps = harness();
    deps.assertTrustedSender.mockImplementation(() => throwIpcError('PERMISSION_DENIED', 'Denied'));
    await expect(copyTextToClipboard(event, null, deps)).rejects.toThrow('[PERMISSION_DENIED]');
    expect(deps.write).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { text: 1 },
    { text: '' },
    { text: 'x'.repeat(MAX_CLIPBOARD_TEXT_CHARS + 1) },
  ])('rejects invalid payload %#', async (input) => {
    const deps = harness();
    await expect(copyTextToClipboard(event, input, deps)).rejects.toThrow('[INVALID_PARAMS]');
    expect(deps.write).not.toHaveBeenCalled();
  });
});
