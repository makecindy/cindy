import path from 'node:path';
import type { TelegramBehaviorConfig } from '@cindy/im';
import { normalizeTelegramBehavior, normalizeTelegramBehaviorPatch, normalizeTelegramPersona, type TelegramPersonaConfig } from '@cindy/im-runtime/channels/telegram/behavior';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';

/** Same channel settings as Desktop, stored under the signed-in owner. */
export class TerminalTelegramSettings {
  readonly ready: Promise<void>;
  private value = { behavior: normalizeTelegramBehavior({}), persona: normalizeTelegramPersona({}) };
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly file: string;
  constructor(root: string, private readonly assertCurrent: () => void) {
    this.file = path.join(root, 'telegram-settings.json');
    this.ready = this.open();
  }
  private guard() { if (this.closed) throw new Error('IM_SETTINGS_CLOSED'); this.assertCurrent(); }
  private async open() {
    this.guard();
    const bytes = await readPrivateFile(this.file); this.guard();
    if (!bytes) return;
    const raw = JSON.parse(bytes.toString()) as Record<string, unknown>;
    this.value = { behavior: normalizeTelegramBehavior(raw.behavior), persona: normalizeTelegramPersona(raw.persona) };
  }
  behavior() { this.guard(); return structuredClone(this.value.behavior); }
  persona() { this.guard(); return { ...this.value.persona }; }
  private update(patch: () => typeof this.value) {
    const result = this.pending.then(async () => {
      await this.ready; this.guard();
      const next = patch();
      await atomicPrivateWrite(this.file, JSON.stringify(next));
      this.guard(); this.value = next;
    });
    this.pending = result.catch(() => {}); return result;
  }
  async patchBehavior(patch: Partial<TelegramBehaviorConfig>) {
    await this.update(() => ({ ...this.value, behavior: normalizeTelegramBehavior({ ...this.value.behavior, ...normalizeTelegramBehaviorPatch(patch) }) }));
    return this.behavior();
  }
  async patchPersona(patch: Partial<TelegramPersonaConfig>) {
    await this.update(() => ({ ...this.value, persona: normalizeTelegramPersona({ ...this.value.persona, ...patch,
      ...(typeof patch.botName === 'string' ? { botName: patch.botName.trim() } : {}),
    }) }));
    return this.persona();
  }
  async activate(chatId: string, mode: 'mention' | 'always') {
    if (!/^-?\d+$/.test(chatId)) throw new Error('INVALID_CHAT_ID');
    await this.update(() => {
      const groupActivation = { ...this.value.behavior.groupActivation };
      if (mode === 'mention') delete groupActivation[chatId]; else groupActivation[chatId] = mode;
      return { ...this.value, behavior: { ...this.value.behavior, groupActivation } };
    });
    return this.behavior();
  }
  async close() { this.closed = true; await this.ready.catch(() => {}); await this.pending; }
}
