/**
 * Official Telegram delivery through the authenticated hook transport.
 * A durable per-operation claim precedes network I/O. Unknown outcomes never
 * resend: Telegram has no client idempotency key and a lost ACK is not failure.
 * No token, chat_id, GUI, or synthetic turn is involved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MessageOpPayload, MessageOpResultPayload } from '@cindy/slack-hook-protocol';

export interface TelegramDeliveryTarget {
  bindingId: string;
  principalId: string;
  principalName: string | null;
  externalKey: string;
  botId: string;
  botName: string | null;
}
export interface TelegramDeliveryStatus {
  connected: boolean;
  supported: boolean;
  sendEpoch?: string;
  target: TelegramDeliveryTarget | null;
  code?: string;
}
export interface TelegramDeliveryInput {
  idempotencyKey: string;
  target: TelegramDeliveryTarget;
  text: string;
  tier: 'html' | 'plain';
  sourceSha256: string;
  presentationSha256: string;
}
export interface TelegramDeliveryReceipt {
  state: 'started' | 'sent' | 'unknown' | 'not_sent';
  opId: string;
  inputSha256: string;
  target: TelegramDeliveryTarget;
  sourceSha256: string;
  presentationSha256: string;
  submittedTextSha256: string;
  requestedTier: 'html' | 'plain';
  createdAt: string;
  result?: MessageOpResultPayload;
  code?: string;
  /** Actual format comparison belongs to the caller holding the expected presentation. */
  formatVerified: false;
}
export interface TelegramDeliveryBridge {
  status(): TelegramDeliveryStatus;
  send(input: TelegramDeliveryInput): Promise<TelegramDeliveryReceipt>;
  receipt(idempotencyKey: string): TelegramDeliveryReceipt | null;
  onResult(result: MessageOpResultPayload): void;
}

/** Only previously received owner DM keys qualify; never manufacture a lane. */
export function selectTelegramDeliveryTarget(
  binding: { bindingId: string | null; principalId: string | null; principalName: string | null; scopeId: string | null; scopeName: string | null },
  keys: readonly string[],
): TelegramDeliveryTarget | null {
  if (!binding.bindingId || !binding.principalId) return null;
  const candidates = keys.flatMap(externalKey => {
    const m = /^telegram:dm:([^:]+):([^:]+):g(\d+)$/.exec(externalKey);
    return m && m[2] === binding.principalId && m[1] === binding.scopeId
      ? [{ externalKey, botId: m[1]!, generation: BigInt(m[3]!) }] : [];
  });
  if (new Set(candidates.map(c => c.botId)).size !== 1) return null;
  candidates.sort((a, b) => a.generation > b.generation ? -1 : a.generation < b.generation ? 1 : 0);
  const candidate = candidates[0];
  return candidate ? {
    bindingId: binding.bindingId, principalId: binding.principalId,
    principalName: binding.principalName, externalKey: candidate.externalKey, botId: candidate.botId, botName: binding.scopeName,
  } : null;
}

/** A message ID alone cannot prove the bound recipient received this send. */
function stateFromResult(row: TelegramDeliveryReceipt, result: MessageOpResultPayload | null): TelegramDeliveryReceipt['state'] {
  if (!result || result.opId !== row.opId) return 'unknown';
  if (!result.ok && result.deliveryState === 'not_sent') return 'not_sent';
  return result.ok && result.deliveryState === 'sent' && /^[1-9]\d*$/.test(result.messageId ?? '') &&
    result.sentMessage?.chatId === row.target.principalId &&
    typeof result.sentMessage.text === 'string' && Array.isArray(result.sentMessage.entities) &&
    ['html', 'plain'].includes(result.sentMessage.tier) ? 'sent' : 'unknown';
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Host-owned storage, injected under the current owner's userData directory. */
export function createTelegramDeliveryBridge(deps: {
  directory: string;
  status(): TelegramDeliveryStatus;
  send(payload: MessageOpPayload): Promise<MessageOpResultPayload | null>;
}): TelegramDeliveryBridge {
  const fileFor = (key: string): string => path.join(deps.directory, hash(key) + '.json');
  function readFile(file: string): TelegramDeliveryReceipt | null {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as TelegramDeliveryReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('DELIVERY_JOURNAL_UNREADABLE');
    }
  }
  function readReceipt(file: string): TelegramDeliveryReceipt | null {
    const claim = readFile(file);
    if (!claim || claim.state === 'sent') return claim; // legacy confirmed rows
    const pending = readFile(file + '.result');
    // Read confirmed evidence last. Writers never replace/delete this file, so
    // stale result writers (including another process) cannot downgrade sent.
    const confirmed = readFile(file + '.sent');
    if (confirmed?.opId === claim.opId && confirmed.inputSha256 === claim.inputSha256 &&
        stateFromResult(claim, confirmed.result ?? null) === 'sent') return confirmed;
    return pending?.opId === claim.opId && pending.inputSha256 === claim.inputSha256 ? pending : claim;
  }
  function read(key: string): TelegramDeliveryReceipt | null { return readReceipt(fileFor(key)); }
  function saveFile(file: string, row: TelegramDeliveryReceipt): void {
    const destination = file + (row.state === 'sent' ? '.sent' : '.result');
    const tmp = destination + '.' + randomUUID() + '.tmp';
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (row.state === 'sent') {
        // Atomic, no-clobber publication of a complete success record. No lock
        // ownership can survive a process crash and block a late receipt.
        try { fs.linkSync(tmp, destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } else {
        fs.renameSync(tmp, destination);
      }
    } finally { try { fs.unlinkSync(tmp); } catch { /* rename consumed tmp */ } }
  }
  return {
    status: deps.status,
    receipt: read,
    onResult(result) {
      const match = /^telegram-delivery:[a-f0-9]{64}:([a-f0-9]{64})$/.exec(result.opId);
      if (!match) return;
      const file = path.join(deps.directory, match[1]! + '.json');
      try {
        const row = readReceipt(file);
        if (!row || row.opId !== result.opId || row.state === 'sent') return;
        row.state = stateFromResult(row, result);
        row.result = result;
        if (row.state === 'sent') delete row.code;
        saveFile(file, row);
      } catch { /* missing/torn journal remains unresolved; never send here */ }
    },
    async send(input) {
      if (!input.idempotencyKey || input.idempotencyKey.length > 200 ||
          !input.text || input.text.length > 16000 ||
          !['html', 'plain'].includes(input.tier) ||
          !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
          !/^[a-f0-9]{64}$/.test(input.presentationSha256)) throw new Error('INVALID_DELIVERY_INPUT');
      const canonicalInput = JSON.stringify([
        input.target.bindingId, input.target.principalId, input.target.externalKey,
        input.target.botId, input.text, input.tier, input.sourceSha256, input.presentationSha256,
      ]);
      const inputSha256 = hash(canonicalInput);
      const previous = read(input.idempotencyKey);
      if (previous) {
        if (previous.inputSha256 !== inputSha256) throw new Error('IDEMPOTENCY_CONFLICT');
        return previous; // including started/unknown: never replay a send
      }
      const status = deps.status();
      const target = status.target;
      if (!status.connected || !status.supported || !status.sendEpoch || !target ||
          target.bindingId !== input.target.bindingId ||
          target.principalId !== input.target.principalId ||
          target.externalKey !== input.target.externalKey ||
          target.botId !== input.target.botId) throw new Error(status.code ?? 'TARGET_CHANGED');
      const row: TelegramDeliveryReceipt = {
        state: 'started', opId: 'telegram-delivery:' + hash(target.bindingId) + ':' + hash(input.idempotencyKey),
        inputSha256, target, sourceSha256: input.sourceSha256,
        presentationSha256: input.presentationSha256,
        submittedTextSha256: hash(input.text), requestedTier: input.tier,
        createdAt: new Date().toISOString(), formatVerified: false,
      };
      fs.mkdirSync(deps.directory, { recursive: true });
      // Atomic create also excludes a second app sharing this owner profile.
      let fd: number;
      try { fd = fs.openSync(fileFor(input.idempotencyKey), 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const concurrent = read(input.idempotencyKey);
        if (!concurrent || concurrent.inputSha256 !== inputSha256) throw new Error('IDEMPOTENCY_CONFLICT');
        return concurrent;
      }
      try {
        try { fs.writeFileSync(fd, JSON.stringify(row)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      } catch (error) {
        // Only this invocation's exclusive claim can be removed, and only
        // before deps.send is reached. Existing/torn claims and failures after
        // network I/O stay fail-closed because their delivery may be unknown.
        try { fs.unlinkSync(fileFor(input.idempotencyKey)); } catch { /* retain the claim if cleanup fails */ }
        throw error;
      }
      try {
        const result = await deps.send({
          opId: row.opId, scope: { externalKey: target.externalKey },
          action: { kind: 'send', text: input.text, tier: input.tier,
            delivery: { bindingId: target.bindingId, epoch: status.sendEpoch, expiresAt: Date.now() + 30_000 } },
        });
        row.state = stateFromResult(row, result);
        if (result) row.result = result;
        if (row.state === 'unknown') row.code = 'DELIVERY_OUTCOME_UNKNOWN';
      } catch { row.state = 'unknown'; row.code = 'DELIVERY_OUTCOME_UNKNOWN'; }
      // A late receipt may already have reconciled the durable row.
      const reconciled = read(input.idempotencyKey);
      if (reconciled?.state === 'sent') return reconciled;
      saveFile(fileFor(input.idempotencyKey), row);
      return read(input.idempotencyKey) ?? row;
    },
  };
}

/** Leaf registration avoids the maker-host ↔ hook-control IPC import cycle. */
let bridge: TelegramDeliveryBridge | null = null;
export function registerTelegramDeliveryBridge(value: TelegramDeliveryBridge | null): void { bridge = value; }
export function getTelegramDeliveryBridge(): TelegramDeliveryBridge | null { return bridge; }
