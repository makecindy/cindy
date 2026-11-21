import { constants, promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { AntigravityCommandExit } from '@cindy/maker-core';

const NATIVE_CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const NATIVE_RECEIPT_FILE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/i;
const MAX_RECEIPT_BYTES = 128 * 1024;
const MAX_PENDING_RECEIPTS = 64;

// ACP 1.5.x can omit the native background command notification. The local
// CLI writes the same notification to its conversation mailbox, with both the
// native task ID and the original tool call ID. Other records are ignored.
export function parseAntigravityCommandExit(
  receipt: unknown,
  conversationId: string,
  filename: string,
): AntigravityCommandExit | undefined {
  if (!receipt || typeof receipt !== 'object') return;
  const entry = receipt as {
    id?: unknown;
    recipient?: unknown;
    sender?: unknown;
    content?: unknown;
    sourceMetadata?: { tool?: { conversationId?: unknown; stepIndex?: unknown; toolCall?: { name?: unknown; id?: unknown } } };
  };
  const source = entry.sourceMetadata?.tool;
  const tool = source?.toolCall;
  const stepIndex = source?.stepIndex;
  if (entry.id !== filename.slice(0, -'.json'.length) || entry.recipient !== conversationId ||
      source?.conversationId !== conversationId || typeof stepIndex !== 'number' ||
      !Number.isSafeInteger(stepIndex) || stepIndex < 0 || tool?.name !== 'run_command' ||
      typeof tool.id !== 'string' || !tool.id || typeof entry.content !== 'string') return;
  const taskId = `${conversationId}/task-${stepIndex}`;
  if (entry.sender !== taskId) return;
  const prefix = `Task id "${taskId}" `;
  if (!entry.content.startsWith(prefix)) return;
  const header = entry.content.slice(prefix.length).split('\n', 1)[0].trimEnd();
  if (!/^(?:finished|failed|was canceled)(?: with result:)?$/.test(header)) return;
  return { taskId, toolUseId: tool.id };
}

export function watchAntigravityCommandExits(
  geminiDir: string,
  conversationId: string,
  onExit: (exit: AntigravityCommandExit) => void,
): () => void {
  const controller = new AbortController();
  if (NATIVE_CONVERSATION_ID.test(conversationId)) {
    void observeMailbox(geminiDir, conversationId, controller.signal, onExit).catch(() => {
      // A missing or incompatible mailbox leaves ACP activity tracking in use.
      controller.abort();
    });
  }
  return () => controller.abort();
}

async function observeMailbox(
  geminiDir: string,
  conversationId: string,
  signal: AbortSignal,
  onExit: (exit: AntigravityCommandExit) => void,
): Promise<void> {
  const profile = await fs.realpath(geminiDir);
  const stateDir = path.join(profile, 'antigravity-cli', 'brain', conversationId, '.system_generated');
  const mailbox = path.join(stateDir, 'messages');
  if (await fs.realpath(stateDir) !== stateDir || signal.aborted) return;

  let mailboxWatcher: FSWatcher | undefined;
  let opening = false;
  const pending = new Set<string>();
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const name of pending) {
        if (signal.aborted) break;
        pending.delete(name);
        const receipt = await readReceipt(path.join(mailbox, name));
        if (signal.aborted) break;
        const exit = parseAntigravityCommandExit(receipt, conversationId, name);
        if (exit) onExit(exit);
      }
    } finally {
      draining = false;
    }
  };
  const enqueue = (name: string | null) => {
    if (name && NATIVE_RECEIPT_FILE.test(name) && pending.size < MAX_PENDING_RECEIPTS) {
      pending.add(name);
      void drain();
    }
  };
  const attachMailbox = async () => {
    if (mailboxWatcher || opening || signal.aborted) return;
    opening = true;
    try {
      if (await fs.realpath(mailbox) !== mailbox || signal.aborted) return;
      const child = watch(mailbox, { persistent: false, signal }, (_event, name) => enqueue(name));
      mailboxWatcher = child;
      child.on('error', () => { child.close(); mailboxWatcher = undefined; });

      // Register the watch before looking at existing files to cover a receipt
      // written while the watch was opening. Do not scan a full conversation.
      let count = 0;
      const directory = await fs.opendir(mailbox);
      for await (const entry of directory) {
        if (signal.aborted || count++ >= MAX_PENDING_RECEIPTS) break;
        if (entry.isFile()) enqueue(entry.name);
      }
    } catch {
      // In new conversations the CLI can create its mailbox at the first exit.
    } finally {
      opening = false;
    }
  };
  const parent = watch(stateDir, { persistent: false, signal }, (_event, name) => {
    if (name === 'messages' || name === null) void attachMailbox();
  });
  parent.on('error', () => parent.close());
  await attachMailbox();
}

async function readReceipt(file: string): Promise<unknown> {
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECEIPT_BYTES) return;
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead === stat.size) return JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    // Partial writes, renames and unreadable files do not prove an exit.
  }
}
