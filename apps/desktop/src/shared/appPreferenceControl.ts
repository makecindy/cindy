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
  webLinks: z.enum(['external', 'sidebar']).optional(),
  localLinks: z.enum(['external', 'sidebar']).optional(),
  streamFade: z.enum(['on', 'off']).optional(),
  messageNavigation: z.boolean().optional(),
  showIgnoredDirectories: z.boolean().optional(),
  homeUsageDashboard: z.boolean().optional(),
  promptRecommendations: z.boolean().optional(),
});
export type AppPreferencePatch = z.infer<typeof appPreferenceSchema>;
export interface AppPreferenceRequest {
  requestId: string;
  ownerStamp: DataOwnerPushStamp;
  expiresAt: number;
  operation: 'get' | 'update' | 'reset' | 'model-visibility' | 'refresh-themes';
  modelVisibility?: { target: { providerId: string; agent: 'claude-code' | 'codex' | 'pi'; modelId: string }; visible: boolean | null; defaultEnabled?: boolean };
  patch?: AppPreferencePatch;
}
export interface AppPreferenceReply {
  requestId: string;
  ok: boolean;
  state?: Required<AppPreferencePatch>;
  themeFamilies?: string[];
  modelVisibility?: { visible: boolean; customized: boolean };
}
export interface AppPreferenceControlBridge {
  onSettingsChanged(listener: (event: { section: string; ownerStamp: DataOwnerPushStamp }) => void): () => void;
  onRequest(listener: (request: AppPreferenceRequest) => void): () => void;
  reply(reply: AppPreferenceReply): void;
}
