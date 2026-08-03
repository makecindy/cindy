import { describe, expect, it, vi } from 'vitest';

import { CHATGPT_APP_URL, handleOpenChatGPTApp, openChatGPTApp } from '../chatgpt-app.js';

describe('openChatGPTApp', () => {
  it('uses the fixed ChatGPT Desktop protocol and reports success', async () => {
    const openExternal = vi.fn(async () => undefined);

    await expect(openChatGPTApp(openExternal)).resolves.toEqual({ success: true });
    expect(CHATGPT_APP_URL).toBe('codex://');
    expect(openExternal).toHaveBeenCalledWith('codex://');
  });

  it('reports failure without exposing an arbitrary renderer URL surface', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('protocol is not registered');
    });

    await expect(openChatGPTApp(openExternal)).resolves.toEqual({ success: false });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted IPC sender before opening the protocol', async () => {
    const openExternal = vi.fn(async () => undefined);
    const event = { senderFrame: 'untrusted' };

    await expect(handleOpenChatGPTApp(event, {
      assertTrustedSender: () => {
        throw new Error('untrusted sender');
      },
      openExternal,
    })).rejects.toThrow('untrusted sender');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
