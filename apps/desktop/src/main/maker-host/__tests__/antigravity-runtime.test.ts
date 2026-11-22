import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { assertVerifiedAntigravityBinary, supportsAntigravityRuntime } from '../antigravity-runtime';
import { parseAntigravityCommandExit, watchAntigravityCommandExits } from '../antigravity-command-exits.js';
import type { AntigravityCommandExit } from '@cindy/maker-core';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}));

it('admits Windows x64 and macOS arm64 installers', () => {
  expect(supportsAntigravityRuntime('win32', 'x64')).toBe(true);
  expect(supportsAntigravityRuntime('darwin', 'arm64')).toBe(true);
  expect(supportsAntigravityRuntime('linux', 'x64')).toBe(false);
});

it.runIf(supportsAntigravityRuntime())('checks the signer again when an installed CLI changes at the same path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-agy-signature-'));
  const binary = path.join(fs.realpathSync(root), process.platform === 'win32' ? 'agy.exe' : 'agy');
  const verify = vi.mocked(spawnSync);
  verify.mockReset();
  try {
    const verified = { status: 0 } as ReturnType<typeof spawnSync>;
    verify.mockReturnValueOnce(verified).mockReturnValueOnce(verified)
      .mockReturnValueOnce({ status: 1 } as ReturnType<typeof spawnSync>);
    fs.writeFileSync(binary, 'signed older version', { mode: 0o700 });
    assertVerifiedAntigravityBinary(binary);
    assertVerifiedAntigravityBinary(binary);
    expect(verify).toHaveBeenCalledTimes(1);

    fs.writeFileSync(binary, 'signed newer release with a different length');
    assertVerifiedAntigravityBinary(binary);
    expect(verify).toHaveBeenCalledTimes(2);

    fs.writeFileSync(binary, 'untrusted replacement');
    expect(() => assertVerifiedAntigravityBinary(binary)).toThrow('ANTIGRAVITY_UNVERIFIED_RUNTIME');
    expect(verify).toHaveBeenCalledTimes(3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const nativeConversation = '00000000-0000-4000-8000-000000000001';
const receiptId = '00000000-0000-4000-8000-000000000002';
const receiptFilename = `${receiptId}.json`;
const taskId = `${nativeConversation}/task-12`;
const receipt = {
  id: receiptId,
  recipient: nativeConversation,
  sender: taskId,
  content: `Task id "${taskId}" finished with result:\nCommand exited with code 1.`,
  sourceMetadata: {
    tool: { conversationId: nativeConversation, stepIndex: 12, toolCall: { name: 'run_command', id: 'call-1' } },
  },
};

// Unit, cd245937: the real CLI mailbox can prove an exit when ACP is silent.
// The receipt must match the session and sender step, independent of its output.
it('recognizes native finishes and cancellations only for the bound tool call', () => {
  const result = { taskId, toolUseId: 'call-1' };
  expect(parseAntigravityCommandExit(receipt, nativeConversation, receiptFilename)).toEqual(result);
  expect(parseAntigravityCommandExit({
    ...receipt, content: `Task id "${taskId}" was canceled with result:\nCanceled.`,
  }, nativeConversation, receiptFilename)).toEqual(result);
  expect(parseAntigravityCommandExit({
    ...receipt, sender: `${nativeConversation}/task-13`,
  }, nativeConversation, receiptFilename)).toBeUndefined();
  expect(parseAntigravityCommandExit({
    ...receipt, content: `Task id "${taskId}" is still running.\nCommand exited with code 0.`,
  }, nativeConversation, receiptFilename)).toBeUndefined();
  expect(parseAntigravityCommandExit(receipt, receiptId, receiptFilename)).toBeUndefined();
});

// Unit with a temporary native mailbox, cd245937: exercise the production
// watcher and the first receipt written when the CLI creates its mailbox.
it('observes the first exit when the native conversation creates its mailbox', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-agy-exit-'));
  const mailbox = path.join(root, 'antigravity-cli', 'brain', nativeConversation, '.system_generated', 'messages');
  await fs.promises.mkdir(path.dirname(mailbox), { recursive: true });
  let publish!: (exit: AntigravityCommandExit) => void;
  const observed = new Promise<AntigravityCommandExit>(resolve => { publish = resolve; });
  const stop = watchAntigravityCommandExits(root, nativeConversation, publish);
  try {
    await fs.promises.mkdir(mailbox);
    const pending = path.join(mailbox, `${receiptFilename}.tmp`);
    await fs.promises.writeFile(pending, JSON.stringify(receipt));
    await fs.promises.rename(pending, path.join(mailbox, receiptFilename));
    await expect(observed).resolves.toEqual({ taskId, toolUseId: 'call-1' });
  } finally {
    stop();
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
