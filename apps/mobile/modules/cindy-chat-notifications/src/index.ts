import { requireOptionalNativeModule } from 'expo-modules-core';
export interface ChatNotificationsNative {
  configure(owner: string, actor: string, baseUrl: string, accessToken: string, title: string, stopLabel: string, preview: boolean, language?: string): Promise<void>;
  /** Optional for OTA compatibility with existing native packages. */
  configureNotifications?(config: { owner: string; actor: string; chatBase: string; user: string; taskBase: string; token: string; title: string; stopLabel: string; preview: boolean; language: string }): Promise<void>;
  setTaskIdentity?(user: string): Promise<void>;
  setOwner?(owner: string): Promise<void>;
  stop(): Promise<void>;
  isPaused(): Promise<boolean>;
  resume(): Promise<void>;
  setIdentity(actor: string): Promise<void>;
  setPreview(enabled: boolean): Promise<void>;
  addListener(event: 'refreshRequested', listener: () => void): { remove(): void };
}
export default requireOptionalNativeModule<ChatNotificationsNative>('CindyChatNotifications');
