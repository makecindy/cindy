import { createContext, useContext } from 'react';

import type { MakerVendor } from '@/lib/ccAgent.types';
import type { BotAutonomySettingsView } from '../../../shared/botAutonomy';
import type { BotLifecycleActionRequest, BotLifecycleActionResult } from '../../../shared/botLifecycle';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ConversationSearchResponse } from '../../../shared/conversationSearch';
import type { BotSkillSummary } from '../../../shared/botSkill';
import type { BotProfile, BotProfileUpdatePatch } from './botStore';

export type BotCapabilityKind = 'skill' | 'mcp' | 'toolset';
export type BotCapabilityEntry = {
  id: string;
  name: string;
  description?: string;
  available: boolean;
  personal?: boolean;
  /** Kept from the companion's setup but not present on this computer. */
  missing?: boolean;
};

type Bots = NonNullable<Window['electronAPI']['localDb']>['bots'];
// The nightly review is read on this computer only (BotNightlyLearning); a target never carries it.
export type BotRoutinesApi = Omit<Window['electronAPI']['routines'], 'nightlyLearning'>;
type VoiceApi = Window['electronAPI']['voiceConversation'];
type ImConnectionApi = Window['electronAPI']['botImConnection'];
type WechatApi = Window['electronAPI']['wechatBot'];

/**
 * The computer a teammate's settings pages read from and write to. The pages are the same components for
 * every teammate; a target supplies the calls they make. The local target wraps this computer's IPC; the
 * remote one reaches the teammate's own computer through `management:settings`
 * (`shared/botRemoteSettings.ts`), where the same services run.
 */
export interface BotSettingsTarget {
  kind: 'local' | 'remote';
  /** Device-link id of the teammate's computer (remote only). */
  deviceId?: string;
  deviceName?: string;
  /** False while the computer cannot be reached: pages keep their content and writes are refused. */
  online: boolean;
  mediaModels?: () => Promise<import('@cindy/maker-shared/teammate-media-models').TeammateMediaCatalog>;
  /** Pages whose host operations exist; the local target supports all of them. */
  pages: ReadonlySet<string>;
  profile: {
    update(botId: string, patch: BotProfileUpdatePatch): Promise<BotProfile>;
    /** Gallery / uploaded image bytes; omitted bytes open the native chooser (local only). */
    chooseAvatar(botId: string, avatarImageBase64?: string): Promise<BotProfile | null>;
    retryInvitation(botId: string): Promise<void>;
  };
  lifecycle: { run(request: BotLifecycleActionRequest): Promise<BotLifecycleActionResult> };
  /** Model defaults and engines are those of the teammate's computer. */
  useDefaultModelChain(): BotModelRoute[];
  useHiddenVendors(): MakerVendor[];
  /** Teammates on the same computer: name uniqueness and the follow-up holder's name. */
  useRoster(): ReadonlyArray<{ id: string; name: string; status?: string }>;
  memory: Bots['memory'];
  /** Core text and learned Skill actions; null when the teammate's computer is too old to offer them. */
  skills: Bots['skills'] | null;
  history: { search(body: { botId: string; query: string; limit: number }): Promise<ConversationSearchResponse> };
  capabilities: {
    /** `isCurrent` turns false once a newer load superseded this one, so it can stop before its next request. */
    load(bot: BotProfile, modelChain: BotModelRoute[], isCurrent: () => boolean): Promise<Partial<Record<BotCapabilityKind, BotCapabilityEntry[]>>>;
    /** Calls `refresh` when the catalog may have changed (runtime, MCP or profile changes). */
    watch(bot: BotProfile, refresh: () => void): () => void;
  };
  /** Messaging platforms: the connections live on the computer that stores their credentials. */
  channels: {
    im: ImConnectionApi | null;
    /** False for another computer: credentials are never typed into a remote page. */
    canEnterCredentials: boolean;
    /** Personal WeChat of the teammate's computer; null = this window's own API (local only). */
    wechat: WechatApi | null;
    /** The official X account of the teammate's computer (remote only). */
    x: {
      get(): Promise<{ available: boolean; /** Absent on older computers. */ visible?: boolean; enabled: boolean; connected: boolean; companionBotId: string | null }>;
      setCompanion(assign: boolean, expectedBotId: string | null): Promise<{ companionBotId: string | null }>;
    } | null;
  };
  voice: Pick<VoiceApi, 'models' | 'voices' | 'preference' | 'setPreference'> & {
    /** Refreshes the gateway model list before reading the catalog (a computer refreshes its own on use). */
    refreshCatalog?(): Promise<void>;
    /** Sample playback uses this window's speakers and its own voice service; absent for another computer. */
    previewApi?: VoiceApi;
  };
  /** Routines of the teammate's computer (`onChanged` fires when they change there). */
  routines: BotRoutinesApi;
  /** Host accepts a persistent independent model selection for each routine. */
  routineModels?: boolean;
  /** Host keeps a routine's session mode (persistent lane or a fresh lane per trigger). */
  routineSessionModes?: boolean;
  routineDelivery?: boolean;
  autonomy: {
    useSettings(): BotAutonomySettingsView | null;
    setSchedulerBotId(botId: string | null): Promise<void>;
    reset(): Promise<void>;
  };
}

export const BotSettingsTargetContext = createContext<BotSettingsTarget | null>(null);
/** `null` = this computer; consumers fall back to `localBotSettingsTarget`. */
export const useOptionalBotSettingsTarget = () => useContext(BotSettingsTargetContext);

export type { BotSkillSummary };
