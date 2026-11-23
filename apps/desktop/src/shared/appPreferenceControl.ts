import { z } from 'zod';
import { SUPPORTED_LOCALES } from './locale.js';
import type { DataOwnerPushStamp } from './dataOwnerPush.js';

export const APP_PREFERENCE_REQUEST = 'app-preferences:request';
export const APP_SETTINGS_CHANGED = 'app-settings:changed';
export const APP_PREFERENCE_REPLY = 'app-preferences:reply';
export const appPreferenceSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  themeFamily: z.string().min(1).max(256).optional(),
  language: z.enum(['system', ...SUPPORTED_LOCALES]).optional(),
  notifications: z.boolean().optional(),
  sendShortcut: z.enum(['enter', 'modifier-enter']).optional(),
  followUpBehavior: z.enum(['queue', 'steer']).optional(),
  webLinks: z.enum(['external', 'sidebar']).optional(),
  localLinks: z.enum(['external', 'sidebar']).optional(),
  streamFade: z.enum(['on', 'off']).optional(),
  messageNavigation: z.boolean().optional(),
  showIgnoredDirectories: z.boolean().optional(),
  homeUsageDashboard: z.boolean().optional(),
  promptRecommendations: z.boolean().optional(),
  worktreeModelNaming: z.boolean().optional(),
  sidebarPinned: z.enum(['text', 'card', 'list']).optional(),
  sidebarTasks: z.enum(['text', 'list']).optional(),
  feishuNotifications: z.boolean().optional(),
  swallowActivationClick: z.boolean().optional(),
  networkDebug: z.boolean().optional(),
});
export type AppPreferencePatch = z.infer<typeof appPreferenceSchema>;
export interface AppPreferenceRequest {
  requestId: string;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
  operation: 'get' | 'update' | 'reset' | 'model-visibility' | 'refresh-themes' | 'model-engine' | 'user-prompt' | 'model-effort';
  modelVisibility?: { target: { providerId: string; agent: 'claude-code' | 'codex' | 'pi'; modelId: string }; visible: boolean | null; defaultEnabled?: boolean };
  /** With operation `model-engine`: the engine to remember for a model, or null to follow the recommendation again; omitted to only read. */
  modelEngine?: { providerId: string; modelId: string; agent: 'cc' | 'codex' | 'pi' | null };
  /** With operation `user-prompt`: the custom instructions to save (empty clears them); omitted to only read. */
  userPrompt?: string;
  /** With operation `model-effort`: a model's remembered reasoning effort, or null to follow its default; omitted to only read. */
  modelEffort?: { agent: 'claude-code' | 'codex' | 'pi'; providerId: string; modelId: string; effort: string | null };
  patch?: AppPreferencePatch;
}
export interface AppPreferenceReply {
  requestId: string;
  ok: boolean;
  state?: Required<AppPreferencePatch>;
  themeFamilies?: string[];
  modelVisibility?: { visible: boolean; customized: boolean };
  /** Remembered engines by `providerId:modelId`. */
  modelEngines?: Record<string, 'cc' | 'codex' | 'pi'>;
  /** The saved custom instructions. */
  userPrompt?: string;
  /** Remembered reasoning effort by memory slot (`agent:providerId`, `agent:*`) and model. */
  modelEfforts?: Record<string, Record<string, string>>;
}
export interface AppPreferenceControlBridge {
  onSettingsChanged(listener: (event: { section: string; ownerStamp: DataOwnerPushStamp }) => void): () => void;
  onRequest(listener: (request: AppPreferenceRequest) => void): () => void;
  reply(reply: AppPreferenceReply): void;
}
