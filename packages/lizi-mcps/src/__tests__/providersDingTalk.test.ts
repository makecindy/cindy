import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiziMcpProviders } from '../providers.js';
import { runWithLiziMcpSessionContext } from '../session-context.js';

type ToolResult = { isError: boolean; content: Array<{ text: string }> };

function sendFileTool(server: unknown) {
  return (
    server as {
      _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }>;
    }
  )._registeredTools.send_file_to_user;
}

function payload(result: ToolResult) {
  return JSON.parse(result.content[0].text) as { ok: boolean; errorCode?: string; sent?: { fileName: string } };
}

describe('cindy_dingtalk provider', () => {
  let dir: string;
  let report: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dingtalk-mcp-'));
    report = path.join(dir, 'report.pdf');
    fs.writeFileSync(report, 'pdf');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(sendFile = vi.fn(async () => ({ ok: true }))) {
    const provider = createLiziMcpProviders({ dingtalkBot: { sendFile } }).find(
      (candidate) => candidate.name === 'cindy_dingtalk',
    );
    if (!provider) throw new Error('cindy_dingtalk provider missing');
    const config = provider.toClaudeSdkConfig({ agentKind: 'codex', workingDir: '', vendorOptions: {} }) as {
      instance: unknown;
    };
    const call = (vendorOptions: Record<string, unknown>, absPath: string) =>
      runWithLiziMcpSessionContext(
        { agentKind: 'codex', workingDir: dir, sessionId: 's1', vendorOptions },
        () => sendFileTool(config.instance).handler({ absPath }),
      );
    return { sendFile, call };
  }

  it('sends the file to the DingTalk chat of the current session', async () => {
    const { sendFile, call } = setup();
    const result = await call({ dingtalkChatId: 'lane-group-1', source: 'dingtalk' }, report);
    expect(payload(result)).toEqual({ ok: true, sent: { fileName: 'report.pdf' } });
    expect(sendFile).toHaveBeenCalledWith('lane-group-1', fs.realpathSync(report));
  });

  it('refuses outside DingTalk sessions instead of guessing a target', async () => {
    const { sendFile, call } = setup();
    const result = await call({ source: 'feishu', feishuChatId: 'oc_1' }, report);
    expect(result.isError).toBe(true);
    expect(payload(result).errorCode).toBe('NO_CHAT_CONTEXT');
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('validates the path before sending', async () => {
    const { sendFile, call } = setup();
    const chat = { dingtalkChatId: 'lane-1' };
    expect(payload(await call(chat, 'report.pdf')).errorCode).toBe('PATH_MUST_BE_ABSOLUTE');
    expect(payload(await call(chat, path.join(dir, 'missing.txt'))).errorCode).toBe('FILE_NOT_FOUND');
    expect(payload(await call(chat, dir)).errorCode).toBe('NOT_A_FILE');
    const empty = path.join(dir, 'empty.txt');
    fs.writeFileSync(empty, '');
    expect(payload(await call(chat, empty)).errorCode).toBe('FILE_EMPTY');
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('reports the robot transport as unsupported and other failures as unknown outcome', async () => {
    const unsupported = setup(vi.fn(async () => ({ ok: false, reason: 'UNSUPPORTED' })));
    expect(payload(await unsupported.call({ dingtalkChatId: 'lane-1' }, report)).errorCode).toBe(
      'UNSUPPORTED_TRANSPORT',
    );
    const failed = setup(vi.fn(async () => ({ ok: false, reason: 'SEND_FAIL' })));
    const result = await failed.call({ dingtalkChatId: 'lane-1' }, report);
    expect(payload(result).errorCode).toBe('SEND_FAILED');
    expect(result.content[0].text).toContain('结果未知');
  });
});
