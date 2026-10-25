import path from 'node:path';
import { z } from 'zod';
import {
  IM_DEFAULT_SETTINGS, isImDefaultAgentKind, isImDefaultEffort,
  isImDefaultPermissionMode, isImDefaultSettingsChannel,
  type ImDefaultSettingsChannel, type ImDefaultSettings,
} from '@cindy/im-runtime/imDefaultSettings';
import {
  IM_DEFAULT_SETTINGS_DOCUMENT, normalizeDocument, mergeSettingsPatch,
  documentOverrides, settingsCustomizedKeys, cloneSettings,
} from '@cindy/im-runtime/defaultSettingsDocument';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';

const agentSettings = z.object({
  agentDeviceId: z.string().trim().min(1).max(300).nullable().optional(),
  providerId: z.string().trim().min(1).max(300).nullable(),
  model: z.string().trim().min(1).max(300),
  effort: z.custom<ImDefaultSettings['agents']['pi']['effort']>(isImDefaultEffort),
}).strict();
const patchSchema = z.object({
  agentKind: z.custom<ImDefaultSettings['agentKind']>(isImDefaultAgentKind).optional(),
  permissionMode: z.custom<ImDefaultSettings['permissionMode']>(isImDefaultPermissionMode).optional(),
  groupPermissionMode: z.custom<ImDefaultSettings['groupPermissionMode']>(isImDefaultPermissionMode).optional(),
  agents: z.object({ 'claude-code': agentSettings.optional(), codex: agentSettings.optional(), pi: agentSettings.optional() }).strict().optional(),
}).strict();

/** Sparse per-owner channel overrides, using Desktop's migration and defaults.
 * Pending writes retain their original owner and cannot enter a replacement host. */
export class TerminalImDefaults {
  readonly ready: Promise<void>;
  private document = structuredClone(IM_DEFAULT_SETTINGS_DOCUMENT);
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly file: string;
  constructor(private readonly options: {
    root: string;
    assertCurrent(): void;
    changed(channel?: ImDefaultSettingsChannel): void;
    beforeChange?(current: ImDefaultSettings, next: ImDefaultSettings, channel?: ImDefaultSettingsChannel): Promise<void>;
  }) {
    this.file = path.join(options.root, 'im-default-settings.json');
    this.ready = this.open();
  }
  private guard(channel?: ImDefaultSettingsChannel) {
    if (this.closed) throw new Error('IM_DEFAULTS_CLOSED');
    this.options.assertCurrent();
    if (channel !== undefined && !isImDefaultSettingsChannel(channel)) throw new Error('INVALID_IM_CHANNEL');
  }
  private async open() {
    this.guard();
    const raw = await readPrivateFile(this.file);
    this.guard();
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw.toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_IM_DEFAULTS');
    // Desktop's override file merges the default document before migration.
    // Sparse v3 files retain flat legacy mirrors but may omit `global`; pass
    // the same merged input so those mirrors are not mistaken for a v1 file.
    this.document = normalizeDocument({ ...structuredClone(IM_DEFAULT_SETTINGS_DOCUMENT), ...parsed });
  }
  read(channel?: ImDefaultSettingsChannel) {
    this.guard(channel);
    return cloneSettings(channel ? this.document.channels[channel] : this.document.global);
  }
  state(channel?: ImDefaultSettingsChannel) {
    const value = this.read(channel), customizedKeys = settingsCustomizedKeys(value, IM_DEFAULT_SETTINGS);
    return { value, defaults: cloneSettings(IM_DEFAULT_SETTINGS), customizedKeys, isCustomized: customizedKeys.length > 0 };
  }
  update(input: unknown, channel?: ImDefaultSettingsChannel) {
    const patch = patchSchema.parse(input);
    return this.change(channel, current => mergeSettingsPatch(current, patch));
  }
  reset(channel?: ImDefaultSettingsChannel) {
    return this.change(channel, () => cloneSettings(IM_DEFAULT_SETTINGS));
  }
  private change(channel: ImDefaultSettingsChannel | undefined, update: (current: ImDefaultSettings) => ImDefaultSettings) {
    this.guard(channel);
    const work = this.pending.then(async () => {
      await this.ready;
      this.guard(channel);
      const current = this.read(channel), next = update(current);
      await this.options.beforeChange?.(current, next, channel);
      this.guard(channel);
      const document = channel
        ? { ...this.document, channels: { ...this.document.channels, [channel]: next } }
        : { ...this.document, global: next };
      await atomicPrivateWrite(this.file, JSON.stringify(documentOverrides(document, IM_DEFAULT_SETTINGS_DOCUMENT)));
      this.guard(channel);
      this.document = document;
      this.options.changed(channel);
      return this.state(channel);
    });
    this.pending = work.catch(() => {});
    return work;
  }
  async close() {
    this.closed = true;
    await this.ready.catch(() => {});
    await this.pending;
  }
}
